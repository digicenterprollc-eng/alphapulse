// Competition, grades, reproduction rights, and lessons from the dead.
import { db, q, one, run, logEvent } from "./db.mjs";
import { complete } from "./llm.mjs";
import { isDead, COMPANY, getSetting, setSetting } from "./treasury.mjs";

for (const c of ["grade TEXT DEFAULT 'Stagiaire'", "points REAL DEFAULT 0"]) { try { db.exec(`ALTER TABLE agents ADD COLUMN ${c}`); } catch {} }
db.exec("CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, name TEXT, cause TEXT, text TEXT, ts TEXT DEFAULT (datetime('now')))");

export const GRADES = [["Stagiaire", 0], ["Junior", 10], ["Confirmé", 30], ["Senior", 80], ["Expert", 200], ["Partner", 500]];
export const gradeOf = (pts) => GRADES.filter(([, t]) => pts >= t).pop()[0];
export const canReproduce = (agent) => agent.role === "ceo" || ["Expert", "Partner"].includes(agent.grade);

/** Points = what an agent brings to the company: cash first, then assets the team reuses. */
export function scoreOf(id) {
  const n = (sql, ...p) => Number(one(sql, ...p)?.n || 0);
  const revenue = n("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE kind='revenue' AND agent=?", id);
  const sites = n("SELECT COUNT(*) n FROM sites WHERE agent=?", id);
  const products = n("SELECT COUNT(*) n FROM products WHERE created_by=? AND active=1", id);
  const toolUses = n("SELECT COALESCE(SUM(uses),0) n FROM custom_tools WHERE author=?", id);
  const tools = n("SELECT COUNT(*) n FROM custom_tools WHERE author=?", id);
  const skills = n("SELECT COUNT(*) n FROM skills WHERE author=?", id);
  const tasks = n("SELECT COUNT(*) n FROM tasks WHERE assignee=? AND status='done'", id);
  const recruits = n("SELECT COUNT(*) n FROM agents WHERE parent=? AND status!='dead'", id);
  const points = revenue * 10 + sites * 3 + products * 4 + tools * 2 + Math.min(toolUses, 150) * 0.5 + skills * 1.5 + tasks * 0.5 + recruits * 2;
  return { revenue, sites, products, tools, toolUses, skills, tasks, points: Math.round(points * 10) / 10 };
}

let lastScore = 0;
export function updateGrades(force = false) {
  if (!force && Date.now() - lastScore < 5 * 60000) return; lastScore = Date.now();
  for (const a of q("SELECT id, name, grade FROM agents WHERE status != 'dead'")) {
    const s = scoreOf(a.id), g = gradeOf(s.points);
    run("UPDATE agents SET points=?, grade=? WHERE id=?", s.points, g, a.id);
    if (a.grade && g !== a.grade) {
      const up = GRADES.findIndex(([x]) => x === g) > GRADES.findIndex(([x]) => x === a.grade);
      logEvent(a.id, "evolution", "grade", { from: a.grade, to: g }, `${a.name} ${up ? "est promu" : "redescend"} ${g} (${s.points} pts)`);
      run("INSERT INTO messages(from_agent,to_agent,text) VALUES('owner',?,?)", a.id, up ? `Promotion: tu passes ${g} (${s.points} points).${["Expert", "Partner"].includes(g) ? " Tu peux maintenant recruter tes propres agents avec spawn_agent (budget pris sur ta caisse)." : ""}` : `Tu redescends ${g} (${s.points} points). Ressaisis-toi.`);
    }
  }
}

export function leaderboard(limit = 8) {
  const rows = q("SELECT id, name, grade, points, dept FROM agents WHERE status != 'dead' ORDER BY points DESC, id LIMIT ?", limit);
  return rows.map((r, i) => `${i + 1}. ${r.name} (${r.dept || ""}) ${r.grade} ${r.points ?? 0} pts`).join(" · ");
}
export function lessonsForPrompt(limit = 5) {
  const rows = q("SELECT name, text FROM lessons ORDER BY id DESC LIMIT ?", limit);
  return rows.length ? rows.map((r) => `- (${r.name}) ${r.text}`).join("\n") : "";
}

/** Each dead or retired agent gets an autopsy: why it failed, written as lessons the living must apply. */
let burying = false;
export async function buryDead() {
  if (burying || isDead(COMPANY)) return; burying = true;
  try {
    const d = one("SELECT a.* FROM agents a WHERE a.status='dead' AND a.id NOT IN (SELECT agent FROM lessons) AND COALESCE(a.doing,'') != 'L''entreprise est morte.' ORDER BY a.rowid DESC LIMIT 1");
    if (!d) return;
    const ledger = q("SELECT kind, source, ROUND(SUM(amount),3) total, COUNT(*) n FROM ledger WHERE agent=? GROUP BY kind, source ORDER BY total", d.id);
    const ev = q("SELECT kind, tool, substr(output,1,220) o FROM events WHERE agent=? ORDER BY id DESC LIMIT 40", d.id).reverse();
    const tasks = q("SELECT title, status, substr(result,1,200) r FROM tasks WHERE assignee=? ORDER BY id DESC LIMIT 12", d.id);
    const r = await complete(
      "Tu es le médecin légiste de l'entreprise AlphaPulse: un agent IA vient de mourir (caisse vide, ou CEO mort parce que l'entreprise n'était pas rentable) ou d'être mis à la retraite. Analyse les faits et écris 3 leçons concrètes et actionnables pour les agents vivants (ce qu'il faut éviter, ce qu'il aurait fallu faire). Pas de blabla, pas d'emoji. Réponds UNIQUEMENT en JSON: {\"cause\":\"1 phrase\",\"lecons\":[\"...\",\"...\",\"...\"]}",
      `Agent: ${d.name} — ${d.dept} — ${d.bio}\nÉtat final: ${d.doing}\nGrade: ${d.grade} (${d.points} pts)\nComptes: ${JSON.stringify(ledger)}\nTâches: ${JSON.stringify(tasks)}\nDernières actions: ${ev.map((e) => `${e.kind}/${e.tool || ""}: ${e.o}`).join("\n")}`,
      { slot: "main", maxTokens: 700, purpose: `autopsie ${d.id}` });
    let o = {}; try { o = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch {}
    const ls = (o.lecons || []).map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 3);
    const text = ls.join(" | ") || "Aucune leçon exploitable.";
    run("INSERT INTO lessons(agent,name,cause,text) VALUES(?,?,?,?)", d.id, d.name, String(o.cause || "").slice(0, 300), text);
    logEvent("atlas", "death", "autopsie", { agent: d.id }, `${d.name} est enterré. Cause: ${o.cause || "?"} Leçons: ${text}`);
  } catch (e) { console.error("[autopsie]", e.message); }
  finally { burying = false; }
}
