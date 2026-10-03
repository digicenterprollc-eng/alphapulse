// AlphaPulse — la caisse (treasury), le grand livre (ledger), les niveaux de survie et la mort.
// Règle: chaque coût réel (IA, voix, serveur) sort de la caisse, chaque vente y entre.
// Caisse à 0 → l'entreprise (ou l'agent enfant) meurt. Cette logique n'est PAS modifiable par les agents.
import { db, q, one, run, logEvent } from "./db.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS treasury (
  id TEXT PRIMARY KEY, owner TEXT, parent TEXT, generation INTEGER DEFAULT 1, capital REAL,
  status TEXT DEFAULT 'alive', born_at TEXT DEFAULT (datetime('now')), died_at TEXT, epitaph TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, treasury TEXT, kind TEXT, amount REAL, agent TEXT,
  source TEXT, detail TEXT, ref TEXT UNIQUE, ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ledger_t ON ledger(treasury, ts);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, ts TEXT DEFAULT (datetime('now')));
`);
for (const c of ["treasury TEXT DEFAULT 'company'", "parent TEXT", "playbook TEXT", "generation INTEGER DEFAULT 1"]) {
  try { db.exec(`ALTER TABLE agents ADD COLUMN ${c}`); } catch {}
}

export const COMPANY = "company";
export const COMPANY_DEATH = "L'entreprise est morte.";
export const START_CAPITAL = Number(process.env.START_CAPITAL || 50);
const VPS_DAILY = Number(process.env.VPS_DAILY_USD || 0.3);
const EUR_USD = Number(process.env.EUR_USD || 1.08);

export const getSetting = (k, d = null) => { const r = one("SELECT value FROM settings WHERE key=?", k); return r ? r.value : d; };
export const setSetting = (k, v) => run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=datetime('now')", k, String(v));

export function ensureGenesis() {
  if (one("SELECT id FROM treasury WHERE id=?", COMPANY)) return;
  run("INSERT INTO treasury(id,owner,generation,capital) VALUES(?,?,1,?)", COMPANY, "atlas", START_CAPITAL);
  run("INSERT INTO ledger(treasury,kind,amount,source,detail,ref) VALUES(?,?,?,?,?,?)", COMPANY, "capital", START_CAPITAL, "owner", "Capital de départ — génération 1", "capital:company:1");
  logEvent("atlas", "birth", "treasury", { capital: START_CAPITAL }, `Naissance d'AlphaPulse — génération 1 — caisse ${START_CAPITAL.toFixed(2)} $`);
}

export const treasuryOf = (agentId) => one("SELECT treasury FROM agents WHERE id=?", agentId)?.treasury || COMPANY;
export const balance = (tid = COMPANY) => one("SELECT COALESCE(SUM(amount),0) b FROM ledger WHERE treasury=?", tid).b;
export const treasuryRow = (tid = COMPANY) => one("SELECT * FROM treasury WHERE id=?", tid);
export const isDead = (tid = COMPANY) => treasuryRow(tid)?.status === "dead";
export const agentDead = (agentId) => { const a = one("SELECT status, treasury FROM agents WHERE id=?", agentId); return !a || a.status === "dead" || isDead(a.treasury || COMPANY); };

export function charge(tid, amount, source, detail, agent = null, ref = null) {
  const amt = Math.abs(Number(amount) || 0);
  if (!amt) return;
  try { run("INSERT INTO ledger(treasury,kind,amount,agent,source,detail,ref) VALUES(?,?,?,?,?,?,?)", tid, "cost", -amt, agent, source, String(detail || "").slice(0, 300), ref); }
  catch (e) { if (!String(e.message).includes("UNIQUE")) throw e; return; }
  checkDeath(tid);
}
export function credit(tid, amount, kind, source, detail, agent = null, ref = null) {
  const amt = Math.abs(Number(amount) || 0);
  if (!amt) return false;
  try { run("INSERT INTO ledger(treasury,kind,amount,agent,source,detail,ref) VALUES(?,?,?,?,?,?,?)", tid, kind, amt, agent, source, String(detail || "").slice(0, 300), ref); return true; }
  catch (e) { if (String(e.message).includes("UNIQUE")) return false; throw e; }
}

export function tier(tid = COMPANY) {
  const t = treasuryRow(tid); if (!t) return "normal";
  if (t.status === "dead") return "mort";
  const b = balance(tid), cap = t.capital || START_CAPITAL;
  if (b <= 0) return "mort";
  if (b < cap * 0.1) return "critique";
  if (b < cap * 0.3) return "economie";
  return "normal";
}
export function burn(tid = COMPANY) {
  // one-off capital transfers (wallet endowments, hiring) are investments, not running costs
  const day = -one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE treasury=? AND kind='cost' AND source NOT IN ('dotation','naissance','héritage') AND ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')", tid).s;
  const week = -one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE treasury=? AND kind='cost' AND source NOT IN ('dotation','naissance','héritage') AND ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')", tid).s;
  const born = treasuryRow(tid)?.born_at;
  const ageDays = born ? Math.max(1 / 24, (Date.now() - new Date(born.replace(" ", "T") + "Z").getTime()) / 86400000) : 1;
  const perDay = Math.max(day, week / Math.min(7, Math.max(1, ageDays)));
  return { day, week, perDay };
}
export function summary(tid = COMPANY) {
  const t = treasuryRow(tid) || {}, b = balance(tid), br = burn(tid);
  const income = one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE treasury=? AND kind='revenue'", tid).s;
  const costs = -one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE treasury=? AND kind='cost'", tid).s;
  return {
    id: tid, generation: t.generation || 1, capital: t.capital || START_CAPITAL, status: t.status || "alive",
    born_at: t.born_at, died_at: t.died_at, epitaph: t.epitaph,
    balance: Math.round(b * 10000) / 10000, tier: tier(tid), burnDay: br.day, burnPerDay: br.perDay,
    runwayDays: br.perDay > 0.0001 ? b / br.perDay : null, revenue: income, costs,
  };
}
export function lineForPrompt(agentId) {
  const tid = treasuryOf(agentId), s = summary(tid);
  const who = tid === COMPANY ? "Caisse de l'entreprise" : "Ta caisse personnelle";
  const rw = s.runwayDays == null ? "inconnue" : `${s.runwayDays.toFixed(1)} jours`;
  const lvl = { normal: "normal", economie: "ÉCONOMIE (moins de shifts, modèles moins chers)", critique: "CRITIQUE (survie: seules les actions qui rapportent vite comptent)", mort: "MORT" }[s.tier];
  return `${who}: ${s.balance.toFixed(2)} $ (capital ${s.capital} $) · dépenses 24h: ${s.burnDay.toFixed(2)} $ · autonomie: ${rw} · niveau: ${lvl} · revenus encaissés: ${s.revenue.toFixed(2)} $.
RÈGLE DE SURVIE: chaque appel IA, chaque minute de voix et le serveur coûtent de l'argent réel pris dans cette caisse. Chaque vente la remplit. Si elle tombe à 0, ${tid === COMPANY ? "l'entreprise meurt et TOUTE l'équipe s'arrête définitivement" : "tu meurs et ton bureau s'éteint"}. Gagne de l'argent honnêtement, dépense intelligemment.`;
}

function checkDeath(tid) {
  const t = treasuryRow(tid); if (!t || t.status === "dead") return;
  if (balance(tid) > 0) return;
  const s = summary(tid);
  const lifeDays = t.born_at ? ((Date.now() - new Date(t.born_at.replace(" ", "T") + "Z").getTime()) / 86400000).toFixed(1) : "?";
  const epitaph = `Génération ${t.generation} — vécu ${lifeDays} jours — revenus ${s.revenue.toFixed(2)} $ — dépenses ${s.costs.toFixed(2)} $.`;
  run("UPDATE treasury SET status='dead', died_at=datetime('now'), epitaph=? WHERE id=?", epitaph, tid);
  // the company dies → every living agent dies with it (personal wallets included); a wallet dies → only its owner
  const agents = tid === COMPANY ? q("SELECT id FROM agents WHERE status != 'dead'") : q("SELECT id FROM agents WHERE treasury=? AND status != 'dead'", tid);
  for (const a of agents) {
    run("UPDATE agents SET status='dead', doing=? WHERE id=?", tid === COMPANY ? COMPANY_DEATH : "Caisse vide — mort.", a.id);
    logEvent(a.id, "death", "treasury", null, `Mort: caisse à 0. ${epitaph}`);
  }
}

// Fixed daily server cost, once per day per living treasury (children share the company server → only company pays).
export function dailyFees() {
  const t = treasuryRow(COMPANY); if (!t || t.status === "dead") return;
  const day = new Date().toISOString().slice(0, 10);
  charge(COMPANY, VPS_DAILY, "serveur", `Serveur (VPS) — ${day}`, null, `vps:${t.generation}:${day}`);
}

// Paid real sales → revenue in the seller's treasury (EUR → USD).
export function syncRevenue() {
  const sales = q(`SELECT s.id, s.paid_amount, s.amount, s.currency, s.agent, p.name FROM sales s LEFT JOIN products p ON p.id=s.product_id
                   WHERE s.status='paid' AND s.sandbox=0`);
  for (const s of sales) {
    const amt = Number(s.paid_amount ?? s.amount) || 0;
    const usd = String(s.currency || "EUR").toUpperCase() === "USD" ? amt : amt * EUR_USD;
    const tid = treasuryOf(s.agent);
    if (credit(tid, usd, "revenue", "vente", `${s.name || "produit"} — ${amt} ${s.currency}`, s.agent, `sale:${s.id}`)) {
      logEvent(s.agent || "orion", "sale", "treasury", { sale: s.id }, `Vente encaissée: ${amt} ${s.currency} (+${usd.toFixed(2)} $ en caisse)`);
    }
  }
}

// Owner-only: start a new generation after death (inherits lessons, fresh capital).
export function newGeneration(capital = START_CAPITAL) {
  const t = treasuryRow(COMPANY);
  if (t && t.status !== "dead") throw new Error("L'entreprise est encore vivante.");
  const gen = (t?.generation || 0) + 1;
  const lessons = [
    t?.epitaph || "",
    ...q("SELECT agent, key, value FROM notes ORDER BY ts DESC LIMIT 12").map((n) => `[${n.agent}] ${n.key}: ${String(n.value).slice(0, 200)}`),
    `Produits tentés: ${q("SELECT name, price FROM products").map((p) => `${p.name} (${p.price})`).join("; ") || "aucun"}`,
  ].join("\n");
  run("UPDATE treasury SET status='alive', generation=?, capital=?, born_at=datetime('now'), died_at=NULL, epitaph=NULL WHERE id=?", gen, capital, COMPANY);
  // reset the company account to the new capital (old balance is ≤ 0)
  const b = balance(COMPANY);
  if (b < 0) credit(COMPANY, -b, "reset", "owner", `Remise à zéro avant la génération ${gen}`, null, `reset:${gen}`);
  credit(COMPANY, capital, "capital", "owner", `Capital de départ — génération ${gen}`, null, `capital:company:${gen}`);
  // only those who died WITH the company come back; agents who died on their own (empty wallet, CEO failure) stay dead
  run("UPDATE agents SET status='idle', doing='Nouvelle génération', next_shift=datetime('now'), generation=? WHERE (status != 'dead' OR doing=?)", gen, COMPANY_DEATH);
  run("INSERT INTO notes(agent,key,value) VALUES('atlas','heritage',?) ON CONFLICT(agent,key) DO UPDATE SET value=excluded.value, ts=datetime('now')", `Leçons de la génération ${gen - 1} (morte):\n${lessons}`.slice(0, 1500));
  logEvent("atlas", "birth", "treasury", { capital, generation: gen }, `Renaissance — génération ${gen} — caisse ${capital.toFixed(2)} $`);
  return summary(COMPANY);
}

export function ledgerRows(limit = 120) {
  return q("SELECT id, treasury, kind, amount, agent, source, detail, ts FROM ledger ORDER BY id DESC LIMIT ?", limit);
}
export function costsBySource(tid = COMPANY) {
  return q("SELECT source, ROUND(-SUM(amount),4) total, COUNT(*) n FROM ledger WHERE treasury=? AND kind='cost' GROUP BY source ORDER BY total DESC", tid);
}
