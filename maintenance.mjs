// Routine maintenance: daily shop audit (problems go to the CEO and page owners) and cleanup of empty AI reviews.
import { one, run } from "./db.mjs";
import { getSetting, setSetting } from "./treasury.mjs";
import { auditShop, auditText } from "./siteaudit.mjs";

const msg = (to, text) => { if (one("SELECT id FROM agents WHERE id=? AND status != 'dead'", to)) { run("INSERT INTO messages(from_agent,to_agent,text) VALUES('audit',?,?)", to, text); run("UPDATE agents SET next_shift=datetime('now') WHERE id=?", to); } };

/** Reviews recorded as 0/10 because the AI gave no answer are not real reviews. */
export function cleanFailedReviews() {
  const n = run("DELETE FROM reviews WHERE score = 0 AND COALESCE(verdict,'') = ''").changes;
  if (n) console.log(`[reviews] ${n} revue(s) vide(s) supprimée(s)`);
}

/** Once a day: audit the shop like a customer would see it. */
export function dailyAudit() {
  const day = new Date().toISOString().slice(0, 10);
  if (getSetting("audit.day") === day) return; setSetting("audit.day", day);
  try {
    const r = auditShop(); console.log(`[audit] ${day} problèmes=${r.problems}`);
    if (!r.problems) return;
    const ceo = one("SELECT id FROM agents WHERE role='ceo' AND status != 'dead' LIMIT 1");
    const text = auditText(r);
    if (ceo) msg(ceo.id, `Audit automatique du jour :\n${text}\nRépartis les corrections.`);
    for (const s of r.sites) if ((s.block.length || s.warn.length) && s.agent && s.agent !== ceo?.id) msg(s.agent, `Audit automatique : ta page /${s.slug}/ a des problèmes :\n- ${[...s.block, ...s.warn].slice(0, 10).join("\n- ")}`);
  } catch (e) { console.error("[audit]", e.message); }
}
