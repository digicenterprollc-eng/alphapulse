// Premium bar for what we sell: product files live privately in work/products/<slug>/, get a strict review,
// and are delivered as a ZIP only to paying customers (/order/<id>/download).
import fs from "node:fs";
import path from "node:path";
import { db, q, one, run, WORK } from "./db.mjs";
import { look, complete } from "./llm.mjs";
import { shoot, browserOk } from "./browser.mjs";
import { stripEmoji, countEmoji, PUBLISHABLE } from "./noemoji.mjs";
import { listFiles } from "./zipper.mjs";
import { dirMtime } from "./design.mjs";

try { db.exec("ALTER TABLE products ADD COLUMN files TEXT"); } catch {}
import { getSetting } from "./treasury.mjs";
export const PRODUCT_MIN_SCORE = 8;
const MIN = () => Number(getSetting("rule.product_min_score", 0)); // advisory by default

export function productDir(rel) {
  const clean = String(rel || "").replace(/^\/+|\/+$/g, "");
  const full = path.resolve(WORK, clean);
  if (!full.startsWith(path.join(WORK, "products") + path.sep)) throw new Error("Les fichiers d'un produit doivent être dans products/<slug>/");
  return { full, rel: path.relative(WORK, full) };
}

export async function reviewProduct(agent, { dir, promise }) {
  const { full, rel } = productDir(dir);
  const files = listFiles(full);
  if (!files.length) return `${rel}/ est vide: prépare d'abord les fichiers livrables.`;
  const size = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  if (size > 60e6) return `Trop lourd (${Math.round(size / 1e6)} Mo, max 60 Mo).`;
  let scrubbed = 0;
  for (const f of files) if (PUBLISHABLE.test(f) && fs.statSync(f).size < 3e6) { const t = fs.readFileSync(f, "utf8"); if (countEmoji(t)) { fs.writeFileSync(f, stripEmoji(t)); scrubbed++; } }
  const tree = files.map((f) => `${path.relative(full, f)} (${Math.max(1, Math.round(fs.statSync(f).size / 1024))} Ko)`).join("\n");
  let budget = 26000; const excerpts = [];
  for (const f of files.filter((f) => /\.(md|txt|csv|json|html?|css|js)$/i.test(f))) {
    if (budget <= 0) break;
    const t = fs.readFileSync(f, "utf8").slice(0, Math.min(budget, 9000)); budget -= t.length;
    excerpts.push(`=== ${path.relative(full, f)} ===\n${t}`);
  }
  const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 3).map((f) => fs.readFileSync(f));
  const html = files.find((f) => /index\.html?$/i.test(f)) || files.find((f) => /\.html?$/i.test(f));
  if (html && (await browserOk())) { try { const s = await shoot({ dir: path.dirname(html) }); imgs.unshift(s.desktop.png); } catch {} }
  const rubric = `Tu es un acheteur exigeant ET un expert produit. On va vendre ce produit numérique. Promesse commerciale: ${promise || "(non précisée)"}.
Évalue les FICHIERS réellement livrés (arborescence + extraits${imgs.length ? " + captures" : ""}). Note /10 (10 = premium, mieux que ce qui se vend 2x plus cher; 8 = premium vendable; 6 = correct mais générique; ≤5 = creux, incomplet ou trouvable gratuitement).
Critères: valeur réelle et utilité immédiate, complétude (tout ce qui est promis est présent et rempli, pas de placeholders), qualité de rédaction et de mise en forme, structure et instructions d'installation, design soigné, honnêteté (aucune fausse promesse), zéro emoji.
Réponds UNIQUEMENT en JSON: {"score": number, "verdict": "1 phrase", "manque": ["..."], "corrections": ["..."]}

ARBORESCENCE:
${tree}

EXTRAITS:
${excerpts.join("\n\n") || "(pas de fichier texte)"}`;
  const r = imgs.length ? await look(imgs, rubric, { agent: agent.id, purpose: `revue produit ${rel}` })
    : await complete("Tu réponds uniquement en JSON.", rubric, { agent: agent.id, slot: "vision", maxTokens: 2500, purpose: `revue produit ${rel}` });
  let o = {}; try { o = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch {}
  // no usable answer from the AI = no review (never record a fake 0/10)
  if (o.score === undefined || o.score === null || !Number.isFinite(Number(o.score))) return `Revue impossible : le modèle IA (${r.model || "?"}) n'a pas renvoyé de note exploitable. Rien n'a été enregistré ; réessaie plus tard.`;
  const score = Math.max(0, Math.min(10, Number(o.score)));
  run("INSERT INTO reviews(dir,score,verdict,issues,fixes,shot,mtime) VALUES(?,?,?,?,?,?,?)", rel, score, o.verdict || "", JSON.stringify(o.manque || []), JSON.stringify(o.corrections || []), "", dirMtime(full));
  return JSON.stringify({ score, verdict: o.verdict || "", vendable: score >= MIN(), manque: (o.manque || []).slice(0, 12), corrections: (o.corrections || []).slice(0, 12), emoji_retires_dans: scrubbed || undefined,
    conseil: score >= MIN() ? `Prêt: create_product(..., files_dir="${rel}")` : `Améliore les fichiers puis refais review_product (règle d'équipe: minimum ${MIN()}/10).` }, null, 1);
}

/** null when the product folder may be sold, otherwise the reason. */
export function productGate(dir) {
  const { full, rel } = productDir(dir);
  if (!listFiles(full).length) return `${rel}/ est vide.`;
  const r = one("SELECT score, mtime FROM reviews WHERE dir=? ORDER BY id DESC LIMIT 1", rel);
  if (MIN() <= 0) return null;
  if (!r) return `Fais d'abord review_product(dir="${rel}") (règle d'équipe: minimum ${MIN()}/10).`;
  if (r.mtime < dirMtime(full) - 1000) return "Les fichiers ont changé depuis la dernière revue: refais review_product.";
  if (r.score < MIN()) return `Dernière revue ${r.score}/10: règle d'équipe ≥ ${MIN()}. Améliore puis refais review_product.`;
  return null;
}
