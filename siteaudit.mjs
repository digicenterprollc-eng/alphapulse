// Shop quality audit: what a customer would hit (broken links, missing files, leaked paid files, fake "soon" pages,
// products without files...). Used before every publication (publish_site), daily by the runtime, and by the audit_shop tool.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { q, one, WORK, SITES } from "./db.mjs";
import { PUBLIC_BASE } from "./pay.mjs";
import { countEmoji } from "./noemoji.mjs";

const ARCHIVE = /\.(zip|rar|7z|tar|tgz|gz|bz2)$/i;
const SOON = /(bient[oô]t disponible|liste d['’]attente|waitlist|coming soon|pr[ée]venu (de|à|lors de) l['’]ouverture)/i;
const PLACEHOLDER = /(lorem ipsum|\bTODO\b|\bXXX\b|example\.com|\[(nom|name|prix|price)\])/i;
const SHOP_ROUTES = /^\/(_kit|_brand|_media|legal)\//;

function walk(dir, out = [], base = dir) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out, base); else out.push(path.relative(base, f));
  }
  return out;
}
const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");

/** Hashes of every file sold (so a paid file can never be published for free). */
function productHashes() {
  const set = new Map();
  for (const p of q("SELECT id, name, files FROM products WHERE files IS NOT NULL")) {
    const dir = path.join(WORK, p.files);
    for (const rel of walk(dir)) { const f = path.join(dir, rel); try { if (fs.statSync(f).size > 300) set.set(sha(f), `${p.name} (${rel})`); } catch {} }
  }
  return set;
}

/** Check a site folder before (or after) publication. slug = the slug it is (or will be) published under. */
export function checkSiteDir(dir, slug) {
  const block = [], warn = [];
  const files = walk(dir);
  const hashes = productHashes();
  const published = new Set(q("SELECT slug FROM sites").map((r) => r.slug).concat(slug));
  const products = new Map(q("SELECT id, active FROM products").map((r) => [r.id, r.active]));
  for (const rel of files) {
    const f = path.join(dir, rel);
    if (ARCHIVE.test(rel)) block.push(`archive publique « ${rel} » : un site public ne doit jamais contenir de fichier téléchargeable payant (le client le reçoit après paiement via /order).`);
    else { try { const h = sha(f); if (hashes.has(h)) block.push(`« ${rel} » est un fichier vendu (${hashes.get(h)}) : il serait gratuit pour tout le monde.`); } catch {} }
  }
  for (const rel of files.filter((x) => /\.html?$/i.test(x))) {
    const html = fs.readFileSync(path.join(dir, rel), "utf8");
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    if (!/<title>[^<]{3,}<\/title>/i.test(html)) warn.push(`${rel} : pas de <title>.`);
    if (SOON.test(text)) warn.push(`${rel} : texte « bientôt disponible / liste d'attente » alors que le paiement est actif.`);
    if (PLACEHOLDER.test(text)) warn.push(`${rel} : texte provisoire (lorem, TODO, exemple…).`);
    const em = countEmoji(text); if (em) warn.push(`${rel} : ${em} emoji (règle maison : zéro emoji).`);
    for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      let u = m[1].trim();
      if (!u || /^(mailto:|tel:|data:|javascript:|#)/i.test(u)) { if (u === "#" ) warn.push(`${rel} : lien vide (href="#").`); continue; }
      if (/^https?:\/\//i.test(u)) { if (!u.startsWith(PUBLIC_BASE)) continue; u = u.slice(PUBLIC_BASE.length) || "/"; }
      if (u.startsWith("//")) continue;
      u = u.split("#")[0].split("?")[0]; if (!u) continue;
      // resolve like the browser does from /<slug>/<dir of the page>/
      if (!u.startsWith("/")) { const relDir = path.posix.dirname(rel.split(path.sep).join("/")); u = path.posix.normalize(`/${slug}/${relDir === "." ? "" : relDir + "/"}${u}`) + (u.endsWith("/") ? "/" : ""); u = u.replace(/\/+$/, (x) => (x ? "/" : "")); }
      const buy = u.match(/^\/buy\/(p_[a-f0-9]+)\/?$/);
      if (buy) { if (!products.has(buy[1])) block.push(`${rel} : bouton d'achat vers un produit inexistant (${buy[1]}).`); else if (!products.get(buy[1])) warn.push(`${rel} : bouton d'achat vers un produit désactivé (${buy[1]}).`); continue; }
      if (u === "/" || SHOP_ROUTES.test(u) || /^\/order\//.test(u)) continue;
      const sm = u.match(/^\/([a-z0-9-]+)(\/.*)?$/);
      if (!sm || !published.has(sm[1])) { block.push(`${rel} : lien ou ressource cassé « ${m[1]} » (n'existe pas sur la boutique).`); continue; }
      const root = sm[1] === slug ? dir : path.join(SITES, sm[1]);
      let target = path.join(root, decodeURIComponent(sm[2] || "/"));
      if (!sm[2] || sm[2].endsWith("/")) target = path.join(target, "index.html");
      if (!fs.existsSync(target) && !fs.existsSync(target + ".html")) block.push(`${rel} : lien ou ressource cassé « ${m[1]} » (fichier absent).`);
    }
  }
  return { block: [...new Set(block)], warn: [...new Set(warn)] };
}

/** Full audit of the shop: every published site and every active product. */
export function auditShop() {
  const sites = q("SELECT slug, title, agent FROM sites ORDER BY slug").map((s) => ({ ...s, ...checkSiteDir(path.join(SITES, s.slug), s.slug) }));
  const products = q("SELECT * FROM products WHERE active=1").map((p) => {
    const issues = [];
    const dir = p.files ? path.join(WORK, p.files) : null;
    const list = dir ? walk(dir) : [];
    if (p.files && !list.length) issues.push("fichiers livrés absents ou dossier vide : le client paierait pour rien.");
    if (!(Number(p.price) > 0)) issues.push("prix invalide.");
    if (String(p.delivery || "").trim().length < 40) issues.push("mode d'emploi après paiement (delivery) trop court.");
    const site = p.site ? one("SELECT slug FROM sites WHERE slug=?", p.site) : null;
    if (!site) issues.push(`page de vente « ${p.site || "?"} » non publiée.`);
    else { const idx = path.join(SITES, p.site, "index.html"); if (fs.existsSync(idx) && !fs.readFileSync(idx, "utf8").includes(`/buy/${p.id}`)) issues.push("la page de vente ne contient pas le bouton /buy de ce produit."); }
    let emoji = 0; for (const rel of list) if (/\.(md|txt|html?|csv|json)$/i.test(rel)) emoji += countEmoji(fs.readFileSync(path.join(dir, rel), "utf8"));
    if (emoji) issues.push(`${emoji} emoji dans les fichiers livrés.`);
    return { id: p.id, name: p.name, price: p.price, currency: p.currency, site: p.site, files: p.files, fileCount: list.length, issues };
  });
  const problems = sites.reduce((n, s) => n + s.block.length + s.warn.length, 0) + products.reduce((n, p) => n + p.issues.length, 0);
  return { at: new Date().toISOString(), problems, sites, products };
}

export function auditText(r = auditShop()) {
  const L = [`Audit de la boutique (${r.problems} problème${r.problems > 1 ? "s" : ""}) :`];
  for (const s of r.sites) if (s.block.length || s.warn.length) L.push(`- Site /${s.slug}/ (${s.agent || "?"}) : ${[...s.block.map((x) => "BLOQUANT " + x), ...s.warn].slice(0, 12).join(" | ")}`);
  for (const p of r.products) if (p.issues.length) L.push(`- Produit ${p.name} (${p.id}) : ${p.issues.join(" | ")}`);
  if (L.length === 1) L.push("aucun problème détecté.");
  return L.join("\n");
}
