// Team skill library: techniques the agents learn from open source (GitHub, docs, demos) and reuse.
// A skill = short, tested recipe (what it does, when to use it, a compact code snippet, source + license).
import { db, q, one, run, logEvent } from "./db.mjs";
import { stripEmoji } from "./noemoji.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, kind TEXT, summary TEXT, content TEXT,
  source TEXT, license TEXT, author TEXT, uses INTEGER DEFAULT 0, score REAL DEFAULT 0,
  created TEXT DEFAULT (datetime('now')), updated TEXT DEFAULT (datetime('now')))`);

export const SKILL_KINDS = ["design", "motion", "video", "code", "product", "marketing", "sales", "ops"];
const OK_LICENSES = /^(mit|isc|apache|bsd|cc0|cc-by|unlicense|mpl|public|own|gsap|ofl)/i;

export function learnSkill(agent, { name, kind, summary, content, source_url, license }) {
  name = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  if (!name) return "Nom de skill invalide.";
  kind = SKILL_KINDS.includes(kind) ? kind : "code";
  content = stripEmoji(String(content || "")).trim();
  if (content.length < 80) return "Contenu trop court: décris la technique, quand l'utiliser et un extrait de code testé.";
  if (content.length > 6000) return "Contenu trop long (max 6000 caractères): garde l'essentiel, la recette doit être compacte.";
  const lic = String(license || "").trim();
  if (source_url && !OK_LICENSES.test(lic)) return "Précise une licence compatible (MIT, ISC, Apache-2.0, BSD, CC0, OFL…) ou 'own' si c'est ta propre technique. Pas de code copié sans licence.";
  run(`INSERT INTO skills(name,kind,summary,content,source,license,author) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, summary=excluded.summary, content=excluded.content, source=excluded.source, license=excluded.license, author=excluded.author, updated=datetime('now')`,
    name, kind, stripEmoji(String(summary || "")).trim().slice(0, 240), content, String(source_url || ""), lic || "own", agent.id);
  logEvent(agent.id, "action", "learn_skill", { name, kind }, `Nouvelle compétence apprise: ${name} (${kind})`);
  return `Compétence « ${name} » enregistrée. Elle sera proposée automatiquement au studio (${kind}).`;
}

export function listSkills(kind) {
  const rows = kind ? q("SELECT name,kind,summary,uses,source,author,updated FROM skills WHERE kind=? ORDER BY updated DESC LIMIT 60", kind)
    : q("SELECT name,kind,summary,uses,source,author,updated FROM skills ORDER BY updated DESC LIMIT 80");
  return rows;
}
export function readSkill(name) { return one("SELECT * FROM skills WHERE name=?", String(name || "").toLowerCase()); }

/** Compact block of the most relevant skills for a generation prompt. */
export function skillsForPrompt(kinds, { max = 6, budget = 7000 } = {}) {
  const ks = [].concat(kinds);
  const rows = q(`SELECT id,name,kind,summary,content FROM skills WHERE kind IN (${ks.map(() => "?").join(",")}) ORDER BY uses ASC, updated DESC LIMIT 30`, ...ks);
  const out = []; let size = 0;
  for (const r of rows.sort(() => Math.random() - 0.5)) {
    const block = `### ${r.name} (${r.kind}) — ${r.summary}\n${r.content}`;
    if (size + block.length > budget) continue;
    out.push(block); size += block.length; run("UPDATE skills SET uses=uses+1 WHERE id=?", r.id);
    if (out.length >= max) break;
  }
  return out.length ? out.join("\n\n") : "";
}

/** Founding skills (inserted once; the team can overwrite them with learn_skill). */
export async function seedSkills() {
  try {
    const { SEED_SKILLS } = await import("./seed/skills.mjs");
    for (const k of SEED_SKILLS) run("INSERT OR IGNORE INTO skills(name,kind,summary,content,source,license,author) VALUES(?,?,?,?,?,?,?)", k.name, k.kind, k.summary, k.content, "", "own", "fondateur");
  } catch (e) { console.error("[skills seed]", e.message); }
}
