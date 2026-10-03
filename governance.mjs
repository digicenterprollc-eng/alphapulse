// Governance of the company (set by the owner, not modifiable by the agents):
// - every agent has a personal wallet; its AI/voice costs are paid from it; empty wallet = death
// - salaries are decided by the CEO and paid every day by the accountant out of the company caisse (sales feed the caisse)
// - if the company makes no profit over the CEO's evaluation period, the CEO dies (no resurrection) and the team elects a new CEO
import { db, q, one, run, logEvent } from "./db.mjs";
import { COMPANY, charge, credit, balance, summary, treasuryRow, isDead, getSetting, setSetting } from "./treasury.mjs";
import { complete } from "./llm.mjs";

for (const c of ["salary REAL", "ceo_since TEXT"]) { try { db.exec(`ALTER TABLE agents ADD COLUMN ${c}`); } catch {} }
db.exec("CREATE TABLE IF NOT EXISTS elections (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT, winner TEXT, votes TEXT, ts TEXT DEFAULT (datetime('now')))");

export const GOV = {
  walletStart: Number(process.env.WALLET_START || 1),      // initial personal wallet of a founding agent ($)
  salaryCeo: Number(process.env.SALARY_CEO || 0.5),          // default daily salary ($)
  salary: Number(process.env.SALARY_DEFAULT || 0.25),
  ceoGraceDays: Number(process.env.CEO_GRACE_DAYS || 7),     // the CEO must make the company profitable over this period
  payrollHourUtc: Number(process.env.PAYROLL_HOUR_UTC || 6),
  reserve: Number(process.env.CAISSE_RESERVE || 3),           // kept in the company caisse for the server
};
const today = () => new Date().toISOString().slice(0, 10);
export const ceo = () => one("SELECT * FROM agents WHERE role='ceo' AND status != 'dead' ORDER BY rowid LIMIT 1");
const living = () => q("SELECT * FROM agents WHERE status != 'dead' ORDER BY rowid");
const finance = () => one("SELECT * FROM agents WHERE role='finance' AND status != 'dead' ORDER BY rowid LIMIT 1");

/** One-time: give every agent of the company caisse a personal wallet funded by the company. */
export function ensureWallets() {
  if (isDead(COMPANY)) return;
  for (const a of q("SELECT * FROM agents WHERE status != 'dead' AND (treasury IS NULL OR treasury = ?)", COMPANY)) {
    const tid = "w_" + a.id;
    if (!treasuryRow(tid)) run("INSERT INTO treasury(id,owner,parent,capital) VALUES(?,?,?,?)", tid, a.id, COMPANY, GOV.walletStart);
    const amt = Math.min(GOV.walletStart, Math.max(0, balance(COMPANY) - 1));
    if (amt > 0) { charge(COMPANY, amt, "dotation", `Dotation initiale de ${a.name}`, a.id, `wallet:${tid}`); credit(tid, amt, "capital", "dotation", "Dotation initiale de l'entreprise", a.id, `wallet-in:${tid}`); }
    run("UPDATE agents SET treasury=?, salary=COALESCE(salary, ?) WHERE id=?", tid, a.role === "ceo" ? GOV.salaryCeo : GOV.salary, a.id);
  }
  for (const a of q("SELECT id, role FROM agents WHERE salary IS NULL")) run("UPDATE agents SET salary=? WHERE id=?", a.role === "ceo" ? GOV.salaryCeo : GOV.salary, a.id);
  const c = ceo(); if (c && !c.ceo_since) run("UPDATE agents SET ceo_since=datetime('now') WHERE id=?", c.id);
}

/** Daily payroll, executed by the accountant (or the CEO if there is no accountant). */
export function runPayroll(by = null, { force = false } = {}) {
  if (isDead(COMPANY)) return "L'entreprise est morte.";
  const day = today();
  if (!force && getSetting("payroll.day") === day) return `Les salaires du ${day} sont déjà versés.`;
  const staff = living().filter((a) => a.treasury && a.treasury !== COMPANY && Number(a.salary) > 0);
  const total = staff.reduce((s, a) => s + Number(a.salary), 0);
  const avail = Math.max(0, balance(COMPANY) - GOV.reserve);
  const ratio = total > 0 ? Math.min(1, avail / total) : 0;
  const payer = by || finance() || ceo();
  for (const a of staff) {
    const amt = Math.round(Number(a.salary) * ratio * 10000) / 10000; if (amt <= 0) continue;
    charge(COMPANY, amt, "salaires", `Salaire de ${a.name} (${day})`, a.id, `pay:${day}:${a.id}`);
    credit(a.treasury, amt, "salaire", "paie", `Salaire du ${day} versé par ${payer?.name || "la comptabilité"}`, a.id, `payin:${day}:${a.id}`);
  }
  setSetting("payroll.day", day);
  const msg = ratio >= 1 ? `Salaires du ${day} versés: ${total.toFixed(2)} $ à ${staff.length} agents.` : ratio > 0 ? `Caisse insuffisante: salaires du ${day} versés à ${Math.round(ratio * 100)} % (${(total * ratio).toFixed(2)} $ sur ${total.toFixed(2)} $).` : `Aucun salaire versé le ${day}: la caisse de l'entreprise est vide. Il faut vendre.`;
  logEvent(payer?.id || "atlas", "action", "paie", { day, ratio }, msg);
  for (const a of staff) run("INSERT INTO messages(from_agent,to_agent,text,read) VALUES(?,?,?,0)", payer?.id || "atlas", a.id, ratio >= 1 ? `Ton salaire du jour (${Number(a.salary).toFixed(2)} $) est versé sur ta caisse.` : ratio > 0 ? `Salaire partiel aujourd'hui (${Math.round(ratio * 100)} %): l'entreprise ne gagne pas assez. Ta survie dépend des ventes.` : "Pas de salaire aujourd'hui: l'entreprise n'a plus d'argent. Si ta caisse tombe à 0, tu meurs. Trouve des ventes.");
  return msg;
}

export function setSalary(by, agentId, amount) {
  const a = one("SELECT * FROM agents WHERE id=? AND status != 'dead'", String(agentId || "").toLowerCase()); if (!a) return "Agent introuvable.";
  const v = Math.max(0, Math.round(Number(amount) * 100) / 100); if (!Number.isFinite(v)) return "Montant invalide.";
  run("UPDATE agents SET salary=? WHERE id=?", v, a.id);
  logEvent(by.id, "evolution", "salaire", { agent: a.id, salary: v }, `Salaire de ${a.name}: ${v.toFixed(2)} $/jour`);
  run("INSERT INTO messages(from_agent,to_agent,text) VALUES(?,?,?)", by.id, a.id, `Ton salaire est maintenant de ${v.toFixed(2)} $ par jour (versé par la comptabilité si l'entreprise en a les moyens).`);
  return `Salaire de ${a.name} = ${v.toFixed(2)} $/jour.`;
}
export function payBonus(by, agentId, amount, reason) {
  const a = one("SELECT * FROM agents WHERE id=? AND status != 'dead'", String(agentId || "").toLowerCase()); if (!a || !a.treasury || a.treasury === COMPANY) return "Agent introuvable.";
  const v = Math.max(0, Number(amount) || 0); if (!v) return "Montant invalide.";
  if (balance(COMPANY) - v < 1) return "La caisse de l'entreprise ne peut pas payer cette prime.";
  const ref = `bonus:${a.id}:${Date.now()}`;
  charge(COMPANY, v, "primes", `Prime ${a.name}: ${String(reason || "").slice(0, 120)}`, a.id, ref); credit(a.treasury, v, "prime", "prime", String(reason || "Prime").slice(0, 200), a.id, ref + ":in");
  logEvent(by.id, "action", "prime", { agent: a.id, amount: v }, `Prime de ${v.toFixed(2)} $ pour ${a.name}: ${String(reason || "").slice(0, 160)}`);
  return `Prime de ${v.toFixed(2)} $ versée à ${a.name}.`;
}

/** The CEO's life depends on the company's profit over his evaluation period. */
export async function evaluateCeo() {
  if (isDead(COMPANY)) return;
  const c = ceo(); if (!c) return electCeo("Il n'y a plus de CEO.");
  const since = c.ceo_since ? new Date(c.ceo_since.replace(" ", "T") + "Z").getTime() : Date.now();
  if (!c.ceo_since) { run("UPDATE agents SET ceo_since=datetime('now') WHERE id=?", c.id); return; }
  if (Date.now() - since < GOV.ceoGraceDays * 86400000) return;
  const from = new Date(since).toISOString();
  const rev = one("SELECT COALESCE(SUM(amount),0) v FROM ledger WHERE treasury=? AND kind='revenue' AND ts >= ?", COMPANY, from).v;
  const cost = -one("SELECT COALESCE(SUM(amount),0) v FROM ledger WHERE treasury=? AND kind='cost' AND source != 'dotation' AND ts >= ?", COMPANY, from).v;
  const profit = rev - cost;
  if (profit > 0) {
    run("UPDATE agents SET ceo_since=datetime('now') WHERE id=?", c.id);
    logEvent(c.id, "evolution", "évaluation", { profit }, `${c.name} survit à son évaluation de CEO: bénéfice ${profit.toFixed(2)} $ sur ${GOV.ceoGraceDays} jours.`);
    return;
  }
  run("UPDATE agents SET status='dead', doing=? WHERE id=?", `Mort: l'entreprise n'a pas fait de bénéfice en ${GOV.ceoGraceDays} jours (${rev.toFixed(2)} $ de revenus pour ${cost.toFixed(2)} $ de coûts).`, c.id);
  if (c.treasury && c.treasury !== COMPANY) {
    const left = balance(c.treasury);
    if (left > 0) { charge(c.treasury, left, "héritage", `Caisse de ${c.name} rendue à l'entreprise`, c.id, `estate:${c.id}`); credit(COMPANY, left, "capital", "héritage", `Caisse de ${c.name} (CEO mort)`, c.id, `estate-in:${c.id}`); }
    run("UPDATE treasury SET status='dead', died_at=datetime('now'), epitaph=? WHERE id=?", "CEO mort: pas de bénéfice.", c.treasury);
  }
  logEvent(c.id, "death", "gouvernance", { profit }, `Le CEO ${c.name} est mort: pas de bénéfice en ${GOV.ceoGraceDays} jours. Il ne reviendra pas.`);
  await electCeo(`${c.name} est mort: l'entreprise n'a pas été rentable sous sa direction.`);
}

/** Every living agent votes for the next CEO (fallback: best reputation). */
export async function electCeo(reason) {
  const voters = living(); if (!voters.length) return;
  const cands = voters.map((a) => ({ id: a.id, name: a.name, dept: a.dept, grade: a.grade, points: a.points || 0, revenue: one("SELECT COALESCE(SUM(amount),0) v FROM ledger WHERE kind='revenue' AND agent=?", a.id).v }));
  const votes = {};
  for (const v of voters) {
    let pick = null;
    try {
      const r = await complete("Tu votes pour élire le prochain CEO de ton entreprise. Le CEO meurt si l'entreprise ne fait pas de bénéfice: choisis celui ou celle qui la rendra rentable. Réponds UNIQUEMENT en JSON: {\"vote\":\"id\",\"raison\":\"une phrase\"}.",
        `Contexte: ${reason}\nTu es ${v.name} (${v.dept}). Candidats: ${JSON.stringify(cands)}`, { agent: v.id, slot: "main", maxTokens: 200, purpose: "élection du CEO" });
      pick = String((r.text.match(/"vote"\s*:\s*"([a-z0-9_-]+)"/i) || [])[1] || "").toLowerCase();
    } catch {}
    if (!cands.find((c) => c.id === pick)) pick = [...cands].sort((a, b) => b.points - a.points || b.revenue - a.revenue)[0].id;
    votes[pick] = (votes[pick] || 0) + 1;
  }
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1] || (cands.find((c) => c.id === b[0]).points - cands.find((c) => c.id === a[0]).points))[0][0];
  const w = one("SELECT * FROM agents WHERE id=?", winner);
  run("UPDATE agents SET role='ceo', dept=?, playbook=NULL, ceo_since=datetime('now'), salary=MAX(COALESCE(salary,0), ?) WHERE id=?", `CEO (élu, ex-${w.dept})`, GOV.salaryCeo, winner);
  run("INSERT INTO elections(reason,winner,votes) VALUES(?,?,?)", reason, winner, JSON.stringify(votes));
  logEvent(winner, "birth", "élection", { votes }, `${w.name} est élu CEO (${votes[winner]} voix sur ${voters.length}). ${reason}`);
  for (const a of voters) run("INSERT INTO messages(from_agent,to_agent,text) VALUES('owner',?,?)", a.id, a.id === winner ? `Tu es le nouveau CEO d'AlphaPulse (élu avec ${votes[winner]} voix). Tu as tous les pouvoirs. Tu as ${GOV.ceoGraceDays} jours pour rendre l'entreprise rentable, sinon tu meurs comme ton prédécesseur. Ton ancien poste est vacant: recrute si besoin.` : `${w.name} est le nouveau CEO. ${reason}`);
  return winner;
}

/** Everything the CEO must know at each shift. */
export function ceoDigest() {
  const acts = q("SELECT agent, tool, substr(output,1,140) o, ts FROM events WHERE kind='action' AND ts >= datetime('now','-12 hours') ORDER BY id DESC LIMIT 45");
  const msgs = q("SELECT from_agent, to_agent, substr(text,1,160) t, ts FROM messages WHERE ts >= datetime('now','-24 hours') AND from_agent != to_agent ORDER BY id DESC LIMIT 25");
  const wallets = living().map((a) => `${a.name}(${a.dept}): caisse ${a.treasury && a.treasury !== COMPANY ? balance(a.treasury).toFixed(2) : "entreprise"} $, salaire ${Number(a.salary || 0).toFixed(2)} $/j, ${a.status}${a.doing ? " — " + String(a.doing).slice(0, 80) : ""}`);
  const dead = q("SELECT name, dept, doing FROM agents WHERE status='dead' ORDER BY rowid DESC LIMIT 6");
  const c = ceo(); const left = c?.ceo_since ? GOV.ceoGraceDays - (Date.now() - new Date(c.ceo_since.replace(" ", "T") + "Z").getTime()) / 86400000 : GOV.ceoGraceDays;
  return `TU ES INFORMÉ DE TOUT (CEO):
Ton évaluation: il te reste ${left.toFixed(1)} jours pour que l'entreprise fasse un bénéfice (revenus > coûts sur la période), sinon tu meurs et l'équipe élit un autre CEO.
Équipe et caisses: ${wallets.join(" | ")}
${dead.length ? `Morts: ${dead.map((d) => `${d.name} (${d.dept})`).join(", ")}` : ""}
Messages internes 24 h: ${msgs.map((m) => `${m.from_agent}→${m.to_agent}: ${m.t}`).join(" | ") || "aucun"}
Activité 12 h: ${acts.map((e) => `${e.agent}:${e.tool} ${String(e.o || "").replace(/\s+/g, " ").slice(0, 90)}`).join(" | ") || "aucune"}`;
}

/** Called after the owner launches a new generation: the living founders get a fresh wallet. */
export function afterGeneration() {
  for (const a of q("SELECT * FROM agents WHERE status != 'dead' AND treasury LIKE 'w_%'")) {
    const t = treasuryRow(a.treasury); if (!t) continue;
    run("UPDATE treasury SET status='alive', died_at=NULL, epitaph=NULL WHERE id=?", a.treasury);
    const b = balance(a.treasury); const amt = GOV.walletStart - Math.max(0, b);
    if (amt > 0 && balance(COMPANY) - amt > 1) { charge(COMPANY, amt, "dotation", `Dotation ${a.name} (nouvelle génération)`, a.id); credit(a.treasury, amt, "capital", "dotation", "Dotation nouvelle génération", a.id); }
  }
  const c = ceo(); if (c) run("UPDATE agents SET ceo_since=datetime('now') WHERE id=?", c.id);
}

let lastGov = 0;
export async function governanceTick() {
  if (Date.now() - lastGov < 60000) return; lastGov = Date.now();
  try {
    ensureWallets();
    if (new Date().getUTCHours() >= GOV.payrollHourUtc && getSetting("payroll.day") !== today()) runPayroll();
    await evaluateCeo();
  } catch (e) { console.error("[gouvernance]", e.message); }
}
