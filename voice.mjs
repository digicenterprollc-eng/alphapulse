// Talk to an agent: owner asks a question (voice → text), the agent answers from its real activity log.
import { q, one, run, logEvent } from "./db.mjs";
import { chat } from "./llm.mjs";
import { lineForPrompt, agentDead } from "./treasury.mjs";

const ALIASES = {
  atlas: ["atlas", "ceo", "patron", "directeur", "direction", "أطلس", "اطلس", "أتلس", "اتلس", "الباطرون", "المدير"],
  nova: ["nova", "builder", "développeur", "developpeur", "production", "نوفا", "نوڤا", "المطور"],
  lyra: ["lyra", "lira", "marketing", "seo", "ليرا", "لايرا", "ليرة", "الماركتينغ", "التسويق"],
  orion: ["orion", "ventes", "vente", "commercial", "seller", "أوريون", "اوريون", "أوريان", "اوريان", "المبيعات", "البيع"],
};
export function detectAgent(text) {
  const t = String(text).toLowerCase();
  for (const [id, words] of Object.entries(ALIASES)) if (words.some((w) => new RegExp(`(^|[^a-zà-ÿ])${w}([^a-zà-ÿ]|$)`).test(t))) return id;
  return null;
}

function todayDigest(id) {
  const events = q(`SELECT kind, tool, substr(args,1,220) args, substr(output,1,260) output, error, ts FROM events
                    WHERE agent=? AND ts >= strftime('%Y-%m-%dT00:00:00','now') ORDER BY id`, id);
  const lines = events.slice(-60).map((e) => {
    if (e.kind === "thought") return `- pensée: ${e.output}`;
    if (e.kind === "shift_end") return `- fin de shift: ${e.output}`;
    if (e.kind === "action") return `- ${e.tool} ${e.args} → ${e.error ? "ERREUR " : ""}${e.output}`;
    if (e.kind === "error") return `- erreur: ${e.output}`;
    return null;
  }).filter(Boolean);
  return lines.join("\n") || "(aucune activité aujourd'hui)";
}

export function buildVoiceContext(id) {
  const a = one("SELECT * FROM agents WHERE id=?", id);
  const tasks = q("SELECT id,title,status,substr(result,1,200) result FROM tasks WHERE assignee=? ORDER BY updated_at DESC LIMIT 10", id);
  const notes = q("SELECT key,value FROM notes WHERE agent=? OR key IN ('strategie','heritage') ORDER BY ts DESC LIMIT 8", id);
  const sites = q("SELECT slug,title,visits FROM sites WHERE agent=?", id);
  const products = q("SELECT name,price,currency FROM products WHERE created_by=?", id);
  const sales = one("SELECT COUNT(*) n, COALESCE(SUM(paid_amount),0) v FROM sales WHERE agent=? AND status='paid' AND sandbox=0", id);
  return `Tu es ${a.name}, agent autonome de l'entreprise AlphaPulse (${a.role}). ${a.bio}
${lineForPrompt(id)}
${a.role === "ceo" ? `Tu es le CEO: tous les pouvoirs, tu fixes les salaires et les permissions, et tu meurs si l'entreprise ne fait pas de bénéfice pendant ta période d'évaluation.` : `Ton salaire: ${Number(a.salary || 0).toFixed(2)} $/jour, versé par la comptable si l'entreprise gagne de l'argent.`}
Statut: ${a.status}. Shifts: ${a.shifts}. Actions: ${a.actions}. En ce moment: ${a.doing || "-"}
Tâches: ${JSON.stringify(tasks)}
Notes: ${JSON.stringify(notes)}
Sites publiés: ${JSON.stringify(sites)} · Produits: ${JSON.stringify(products)} · Ventes payées: ${sales.n} (${sales.v} €)
Journal d'aujourd'hui:
${todayDigest(id)}`;
}

export async function askAgent(text, agentId, lang = "fr") {
  text = text.trim().slice(0, 1500);
  if (!text) return { error: "Question vide." };
  const id = detectAgent(text) || agentId || one("SELECT id FROM agents WHERE role='ceo' AND status != 'dead' LIMIT 1")?.id || "atlas";
  const a = one("SELECT * FROM agents WHERE id=?", id);
  if (!a) return { error: "Agent inconnu." };
  if (agentDead(id)) return { error: "MORT: cet agent est mort (caisse vide)." };
  const tasks = q("SELECT id,title,status,substr(result,1,200) result FROM tasks WHERE assignee=? ORDER BY updated_at DESC LIMIT 10", id);
  const notes = q("SELECT key,value FROM notes WHERE agent=? OR key='strategie' ORDER BY ts DESC LIMIT 8", id);
  const sites = q("SELECT slug,title,visits FROM sites WHERE agent=?", id);
  const products = q("SELECT name,price,currency FROM products WHERE created_by=?", id);
  const sales = one("SELECT COUNT(*) n, COALESCE(SUM(paid_amount),0) v FROM sales WHERE agent=? AND status='paid' AND sandbox=0", id);
  const langRule = lang === "ar"
    ? "Réponds en darija marocaine écrite en lettres arabes, phrases courtes et naturelles."
    : "Réponds en français oral, naturel, phrases courtes.";
  const sys = `Tu es ${a.name}, agent autonome de l'entreprise AlphaPulse (${a.role}). ${a.bio}
Le propriétaire, te parle à voix haute. Ta réponse sera lue par une synthèse vocale.
${langRule} Maximum 5 phrases. Pas de markdown, pas de listes, pas d'emoji.
Base-toi UNIQUEMENT sur ton journal réel ci-dessous. Si tu n'as rien fait, dis-le honnêtement. N'invente jamais de chiffres, de ventes ou de résultats.
Si le propriétaire te donne une consigne, confirme-la en une phrase.
Réponds UNIQUEMENT en JSON: {"answer":"...","instruction":"consigne à mémoriser ou null"}`;
  const ctx = `Statut: ${a.status}. Shifts: ${a.shifts}. Actions: ${a.actions}. En ce moment: ${a.doing || "-"}
Tâches: ${JSON.stringify(tasks)}
Notes: ${JSON.stringify(notes)}
Sites publiés: ${JSON.stringify(sites)} · Produits: ${JSON.stringify(products)} · Ventes payées: ${sales.n} (${sales.v} €)
Journal d'aujourd'hui:
${todayDigest(id)}

Question du propriétaire: "${text}"`;
  const res = await chat([{ role: "system", content: sys }, { role: "user", content: ctx }], undefined, { agent: id, slot: "voice", purpose: "réponse vocale", maxTokens: 800 });
  let raw = String(res.message.content || "").trim(), answer = raw, instruction = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); answer = String(o.answer || raw); instruction = o.instruction && o.instruction !== "null" ? String(o.instruction) : null; } catch {} }
  answer = answer.replace(/[*_#`>]/g, "").trim();
  logEvent(id, "inbox", "voice", { from: "owner" }, text);
  logEvent(id, "voice_reply", "voice", { to: "owner" }, answer);
  if (instruction) {
    run("INSERT INTO messages(from_agent,to_agent,text) VALUES('owner',?,?)", id, `${text}\n(consigne: ${instruction})`);
    run("UPDATE agents SET next_shift=datetime('now') WHERE id=?", id);
  }
  return { agent: id, name: a.name, answer, instruction };
}
