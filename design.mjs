// Nova's design studio: premium site generation (strong model) + visual review (screenshots + vision model).
import { CFG } from "./config.mjs";
import fs from "node:fs";
import path from "node:path";
import { db, q, one, run, WORK, logEvent } from "./db.mjs";
import { chat, look } from "./llm.mjs";
import { shoot, browserOk } from "./browser.mjs";
import { PUBLIC_BASE } from "./pay.mjs";
import { stripEmoji, countEmoji, PUBLISHABLE } from "./noemoji.mjs";
import { skillsForPrompt } from "./skills.mjs";
import { getSetting } from "./treasury.mjs";
const PUBLISH_MIN = () => Number(getSetting("rule.publish_min_score", 0)); // advisory by default: the team sets its own bar

db.exec("CREATE TABLE IF NOT EXISTS site_styles (slug TEXT PRIMARY KEY, direction TEXT, fonts TEXT, accent TEXT, ts TEXT DEFAULT (datetime('now')))");
db.exec(`CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, dir TEXT, score REAL, verdict TEXT, issues TEXT, fixes TEXT, shot TEXT, mtime INTEGER, ts TEXT DEFAULT (datetime('now')))`);

const ICON_NAMES = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "kit", "icon-names.json"), "utf8")); } catch { return []; } })();
export const ART_DIRECTIONS = [
  "editorial-luxe: serif display, ivory/black, thin rules, gold or deep accent, generous margins, slow elegant motion",
  "swiss-grid: strict 12-col grid, grotesk type, primary colour blocks, numbered sections, precise motion",
  "neo-brutal: thick borders, hard offset shadows, saturated flat colours, chunky type, snappy motion",
  "dark-tech-glow: near-black, subtle neon accents, glass panels, grids, glowing borders, pinned product story",
  "soft-3d-pastel: soft gradients, rounded CSS 3D shapes, floating cards, playful springy motion",
  "retro-futurist: chrome gradients, holographic sheen, Y2K shapes, orbit rings, scanlines",
  "japanese-minimal: lots of white, one red accent, fine type, asymmetric calm layouts, text-scrub reveals",
  "organic-earth: earthy tones, grain, fluid blob shapes, serif + humanist sans, gentle parallax",
  "bold-startup: one loud brand colour, giant headlines, bento grids, horizontal gallery, big counters",
  "magazine-collage: broken grid, huge numbers, serif/sans mix, rotated labels, clip reveals",
  "monochrome-premium: single hue + black, extreme contrast, cinematic hero, outline typography",
  "terminal-cyber: monospace, typed code, amber/green on black, line drawing SVG, glitch-free crisp motion",
];

const DESIGN_SYSTEM = `You are an elite product designer, art director and senior front-end engineer (level: Linear, Stripe, Vercel, Awwwards Site of the Day). You design AND code complete static websites (HTML + CSS + vanilla JS) that look premium, modern (2026), alive with motion, trustworthy, and that convert visitors into buyers.

ABSOLUTE RULES
- ZERO EMOJI anywhere (copy, buttons, lists, titles, alt text, CSS content, JS strings). Not one. Use icons only (see ICONS). No unicode pictograms (★ ✓ ✔ ✨ → as icons) either: use the icon sprite.
- Honesty (non-negotiable): never invent testimonials, reviews, star ratings, client logos, user/customer counts, media mentions, fake scarcity or fake countdowns. Without real social proof, build trust with concrete product details, previews, process, guarantee, FAQ, transparent pricing.
- Copy in French unless the brief says otherwise: specific, benefit-driven, confident, premium tone, no lorem ipsum, no filler.

ART DIRECTION (every company site must look different)
- Pick ONE art direction for this site and commit to it fully (layout, type, colour, motion personality). Declare it in <head>: <meta name="ap:direction" content="NAME"> and <meta name="ap:fonts" content="Display font / Text font">.
- Never reuse a direction or font pairing listed in ALREADY USED (given in the brief). Custom layouts, asymmetric compositions, strong hierarchy, distinctive hero composition. It must NOT look like a template.

KIT (always include, in this order, in <head>)
<link rel="stylesheet" href="/_kit/kit.css">
<script src="/_kit/kit.js" defer></script>
<script src="/_kit/motion.js" defer></script>
Then your own <style> giving THIS brand its identity: set --k-accent, --k-accent2, --k-bg, --k-bg2, --k-fg, --k-mut, --k-line, --k-card, --k-font, --k-display, --k-radius (light themes: set all of them, not only accents).
motion.js = GSAP 3 + ScrollTrigger + SplitText + Lenis smooth scroll + presets. Use MANY of these attributes (motion is mandatory on every section):
- data-split="lines|words|chars" on headings (masked text reveal). Not on elements that contain .k-gradient-text, svg or img.
- data-intro on the hero content wrapper (children slide in on load).
- data-text-scrub on a big statement paragraph (words light up while scrolling).
- data-parallax="0.15..0.4" (negative = opposite) on decorative layers and mockups.
- data-scale on a large product visual (grows into place while scrolling).
- data-clip on visual frames (cinematic clip reveal).
- data-draw on an inline <svg> (stroke drawing; data-draw="scrub" = tied to scroll).
- data-float on floating UI cards around the hero visual, data-spin="40" on orbit rings.
- data-batch on card grids (staggered entrance). data-reveal="" | "left" | "right" | "zoom" + data-stagger for simple fades.
- Pinned story (desktop): <section data-pin> with <div class="k-stage"> of [data-step] blocks (+ optional second .k-stage of [data-step-visual]) and optional <div class="k-step-bar"><i data-step-progress></i></div>. Steps crossfade while the section stays pinned. Mobile falls back to a normal stack automatically.
- Horizontal gallery: <section data-horizontal> ... <div class="k-track"> cards </div>. Pins and scrolls sideways on desktop, swipe on mobile.
- data-bg="#hex" on a section to shift the page background while it is in view. .k-nav[data-autohide] hides on scroll down.
- data-count (+data-prefix/data-suffix) ONLY for TRUE numbers. body[data-progress], body[data-cursor], .k-tilt, .k-card (spotlight), [data-magnetic].
Add 1–2 signature animations of your own in a deferred script (window.gsap is available after DOMContentLoaded): animated product UI, typing effect, morphing SVG, timeline. 60fps, transform/opacity only. Everything must also look complete without motion (reduced-motion users and screenshots see the final state).

COMPONENTS (kit classes; restyle them to your direction): .k-container .k-section .k-hero .k-mesh(<div class="k-mesh"><span></span><span></span><span></span></div>) .k-grid-bg .k-dot-grid .k-spotlight .k-noise .k-gradient-text .k-outline-text .k-btn .k-btn-primary .k-badge .k-chip .k-kbd .k-browser .k-glass .k-float-card .k-border-anim .k-orbit .k-bento(.k-span-2/3/4/6 .k-row-2) .k-grid(--k-min) .k-split .k-card .k-ic-box .k-marquee .k-marquee-xl .k-faq .k-steps/.k-step .k-stat .k-price .k-list .k-featured .k-cta .k-footer .k-divider.

ICONS (Lucide, the only allowed pictograms): <svg class="k-ic"><use href="/_kit/icons.svg#NAME"/></svg> or the shortcut <i data-icon="NAME"></i>. Sizes: .k-ic (inherits font size), .k-ic-lg, .k-ic-xl, inside .k-ic-box for feature cards. Stroke colour = currentColor. Use ONLY these names: ${ICON_NAMES.join(" ")}

VISUALS: no stock photos exist. Build visuals in HTML/CSS/SVG: product mockups inside .k-browser or device frames, real-looking UI previews of what the customer gets, charts, layered gradient compositions, orbit/3D CSS scenes. The hero visual must be impressive and specific to the product. If a presentation VIDEO is listed in the brief, feature it (hero or "voir en action" section) with <video controls playsinline preload="metadata" poster="..."> in a premium frame.

STRUCTURE (adapt to the brief): nav, hero (headline + sub + primary CTA + secondary CTA + visual), problem → solution, what's inside / features (bento or cards with icons), how it works (pinned story or steps), preview / horizontal gallery, pricing (clear price, what's included, CTA), guarantee, FAQ (6+ real questions), final CTA, footer ("Édité par ${CFG.legal}" + contact email).
- Purchase buttons link EXACTLY to the buy URL(s) given in the brief. If none is given, link to "#tarif" and add data-buy="pending" on those buttons. Never write "bientôt disponible" pages or email-capture instead of buying when a buy URL exists.
- Responsive: flawless at 390px and 1440px, no horizontal scroll, tap targets ≥ 44px. Accessibility: semantic HTML, alt/aria labels, contrast AA, visible focus.
- Performance & size: no other frameworks/CDNs besides Google Fonts and the kit. Be concise: total output ≤ 60 KB (index.html ≤ 45 KB + optional styles.css/app.js). Reuse kit classes; avoid giant inline SVG paths; no comments.

OUTPUT: only files, in exactly this format, nothing before/after:
=== FILE: index.html ===
...file content...
=== END FILE ===
You may output extra files (styles.css, app.js, other .html pages) with paths relative to the site folder.`;

const slugify = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
function siteDir(slug) { return path.join(WORK, "sites", slugify(slug)); }
function readSite(dir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(html|css|js|svg|json|txt|md)$/i.test(e.name) && fs.statSync(f).size < 120000) files.push([path.relative(dir, f), fs.readFileSync(f, "utf8")]); } };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}
function parseFiles(text) {
  const out = []; const re = /=== FILE: ([^\n=]+?) ===\n([\s\S]*?)(?:\n=== END FILE ===|(?=\n=== FILE: )|$)/g; let m;
  while ((m = re.exec(text))) { const body = m[2].replace(/```\w*\n?/g, "").trimEnd(); if (body.length > 20) out.push([m[1].trim().replace(/^\/+/, ""), body]); }
  // a truncated index.html is useless: require a closing </html>
  const idx = out.find(([p]) => p === "index.html"); if (idx && !/<\/html>\s*$/i.test(idx[1])) return [];
  if (!out.length) { const h = text.match(/<!doctype html[\s\S]*<\/html>/i); if (h) out.push(["index.html", h[0]]); }
  return out;
}
export function dirMtime(dir) {
  let t = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else t = Math.max(t, fs.statSync(f).mtimeMs); } };
  if (fs.existsSync(dir)) walk(dir); return Math.floor(t);
}

export async function designSite(agent, { slug, brief, feedback }) {
  const s = slugify(slug); if (!s) return "Slug invalide.";
  const dir = siteDir(s); fs.mkdirSync(dir, { recursive: true });
  const existing = readSite(dir);
  const products = q("SELECT id,name,price,currency FROM products WHERE active=1 AND (site=? OR site IS NULL OR site='') ORDER BY created_at DESC LIMIT 6", s);
  const brand = fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), "public", "brand", "icon-256.png"));
  const used = q("SELECT slug, direction, fonts FROM site_styles WHERE slug != ? ORDER BY ts DESC LIMIT 14", s);
  const mine = one("SELECT direction, fonts FROM site_styles WHERE slug=?", s);
  const videos = fs.existsSync(path.join(dir, "media")) ? fs.readdirSync(path.join(dir, "media")).filter((f) => /\.mp4$/.test(f)) : [];
  const skills = skillsForPrompt(["design", "motion"], { max: 5, budget: 6500 });
  const user = [
    `BRIEF:\n${brief || "(voir fichiers existants)"}`,
    used.length ? `ALREADY USED by other company sites (do NOT reuse these directions or font pairings): ${used.map((u) => `${u.slug}: ${u.direction} [${u.fonts}]`).join(" | ")}` : "ALREADY USED: none yet.",
    mine && feedback ? `This site's current direction: ${mine.direction} [${mine.fonts}] — keep it unless the feedback asks for a new look.` : `Directions catalogue (pick one not already used, or invent a fresh one): ${ART_DIRECTIONS.join(" || ")}`,
    videos.length ? `PRESENTATION VIDEO(S) available in this site folder: ${videos.map((v) => `media/${v} (poster: media/${v.replace(/\.mp4$/, ".jpg")})`).join(", ")} — feature it.` : "",
    skills ? `TEAM SKILLS (techniques the team learned from open source; use the ones that fit this direction):\n${skills}` : "",
    products.length ? `BUY URLS (use exactly): ${products.map((p) => `${p.name} — ${p.price} ${p.currency} → ${PUBLIC_BASE}/buy/${p.id}`).join(" | ")}` : "BUY URLS: none yet → use #tarif + data-buy=\"pending\"",
    `Public URL of this site: ${PUBLIC_BASE}/${s}/ . Company brand (AlphaPulse): ${brand ? `icon /_brand/icon-256.png, logo with white text /_brand/logo-light.webp (dark backgrounds), logo with dark text /_brand/logo.webp (light backgrounds). Use it small in the footer ("Une création AlphaPulse"); the product keeps its own brand.` : "none"}. Contact: ${CFG.contact}`,
    existing.length && feedback ? `CURRENT FILES (revise them; keep what works, fix everything in the feedback, raise the quality):\n${existing.map(([p, c]) => `=== FILE: ${p} ===\n${c}\n=== END FILE ===`).join("\n")}` : "",
    feedback ? `FEEDBACK TO APPLY:\n${feedback}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await chat([{ role: "system", content: DESIGN_SYSTEM }, { role: "user", content: user }], undefined, { agent: agent.id, slot: "builder", maxTokens: 40000, purpose: `design ${s}`, temperature: 0.7 });
  const raw = String(r.message.content || "");
  fs.writeFileSync(path.join(dir, ".last-output.txt"), raw);
  const files = parseFiles(raw);
  if (!files.length) return `Le modèle a renvoyé une réponse incomplète (${Math.round(raw.length / 1024)} Ko, ${r.model}). Réessaie avec un brief plus court et plus focalisé.`;
  for (const [p, c] of files) { const f = path.resolve(dir, p); if (!f.startsWith(dir)) continue; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, PUBLISHABLE.test(p) ? stripEmoji(c) : c); }
  const idx = files.find(([p]) => p === "index.html")?.[1] || "";
  const dirm = idx.match(/<meta\s+name=["']ap:direction["']\s+content=["']([^"']+)/i), fontm = idx.match(/<meta\s+name=["']ap:fonts["']\s+content=["']([^"']+)/i), acc = idx.match(/--k-accent\s*:\s*([^;}\n]+)/);
  if (dirm) run("INSERT INTO site_styles(slug,direction,fonts,accent) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET direction=excluded.direction, fonts=excluded.fonts, accent=excluded.accent, ts=datetime('now')", s, dirm[1].slice(0, 80), (fontm?.[1] || "").slice(0, 80), (acc?.[1] || "").trim().slice(0, 30));
  return `Site ${feedback ? "révisé" : "créé"} dans sites/${s}/ avec ${r.model} (${files.map(([p, c]) => `${p} ${Math.round(c.length / 1024)}Ko`).join(", ")}). Coût: ${r.cost.toFixed(3)} $. Étape suivante: review_site(slug="${s}") puis publish_site(dir="sites/${s}", slug="${s}") si score ≥ 7.`;
}

export async function reviewSite(agent, { slug, url }) {
  if (!(await browserOk())) return "Navigateur indisponible: revue visuelle impossible pour l'instant.";
  const s = slug ? slugify(slug) : null, dir = s ? siteDir(s) : null;
  if (dir && !fs.existsSync(path.join(dir, "index.html"))) return `sites/${s}/index.html introuvable.`;
  const shots = await shoot(dir ? { dir } : { url });
  const auto = [];
  const md = shots.desktop.metrics, mm = shots.mobile.metrics;
  md.badIcons = [...new Set((md.iconRefs || []).filter((n) => !ICON_NAMES.includes(n)))];
  if (mm.overflow > 2) auto.push(`Débordement horizontal sur mobile (${mm.overflow}px)`);
  if (!md.kit) auto.push("Le kit AlphaPulse (/_kit/kit.css) n'est pas inclus");
  if (!md.motion) auto.push("motion.js absent: ajoute <script src=\"/_kit/motion.js\" defer></script> (GSAP + ScrollTrigger + Lenis)");
  else if (md.motionAttrs < 6) auto.push(`Pas assez de motion (${md.motionAttrs} éléments animés): ajoute data-split, data-parallax, data-scale, data-batch, data-pin/data-horizontal…`);
  if (md.emoji) auto.push(`${md.emoji} emoji détecté(s): interdit, remplace par des icônes /_kit/icons.svg`);
  if (!md.icons) auto.push("Aucune icône: utilise les icônes du kit (<i data-icon=\"...\"></i>)");
  if (md.badIcons?.length) auto.push(`Icônes inexistantes: ${md.badIcons.slice(0, 6).join(", ")}`);
  if (md.soon) auto.push("Le site dit « bientôt disponible » / capture d'email alors que la vente doit passer par /buy/...");
  if (!md.desc) auto.push("Meta description manquante");
  if (md.brokenImgs) auto.push(`${md.brokenImgs} image(s) cassée(s)`);
  if (!md.buy && !md.pending) auto.push("Aucun bouton d'achat (/buy/...)");
  const errs = [...shots.desktop.errors, ...shots.mobile.errors];
  if (errs.length) auto.push(`Erreurs JS/chargement: ${[...new Set(errs)].slice(0, 4).join(" | ")}`);
  const v = await look([shots.desktop.png, shots.mobile.png],
    `Tu es un directeur artistique très exigeant (niveau Awwwards) et expert en conversion. Image 1 = site en desktop (1440px), image 2 = mobile (390px).
Note de 0 à 10 (10 = Awwwards / startup financée, 8 = premium, 7 = pro et vendable, ≤5 = amateur ou template générique): impression premium et moderne, direction artistique forte et originale (pas un template), typographie et hiérarchie, couleurs, qualité des visuels/mockups, icônes (aucun emoji toléré), clarté de l'offre et des boutons d'achat, rendu mobile.
Ne décris que ce que tu VOIS. Liste les défauts concrets et des corrections précises et actionnables (CSS/mise en page/texte).
Réponds UNIQUEMENT en JSON: {"score": number, "verdict": "1 phrase", "issues": ["..."], "fixes": ["..."]}`,
    { agent: agent.id, purpose: `revue ${s || url}` });
  let o = {}; try { o = JSON.parse((v.text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch {}
  if (o.score === undefined || o.score === null || !Number.isFinite(Number(o.score))) return `Revue impossible : le modèle de vision (${v.model || "?"}) n'a pas renvoyé de note exploitable. Rien n'a été enregistré ; réessaie plus tard.${auto.length ? ` Contrôles automatiques déjà trouvés : ${auto.join(" | ")}` : ""}`;
  let score = Math.max(0, Math.min(10, Number(o.score)));
  if (mm.overflow > 2 || errs.some((e) => /SyntaxError|ReferenceError|TypeError/.test(e))) score = Math.min(score, 6);
  if (md.emoji || !md.motion || md.motionAttrs < 6) score = Math.min(score, 6);
  const shotRel = path.join("reviews", `${s || "url"}-${Date.now()}.png`);
  fs.mkdirSync(path.join(WORK, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(WORK, shotRel), shots.desktop.png);
  fs.writeFileSync(path.join(WORK, shotRel.replace(".png", "-mobile.png")), shots.mobile.png);
  const issues = [...auto, ...(o.issues || [])].slice(0, 14), fixes = (o.fixes || []).slice(0, 14);
  if (dir) run("INSERT INTO reviews(dir,score,verdict,issues,fixes,shot,mtime) VALUES(?,?,?,?,?,?,?)", `sites/${s}`, score, o.verdict || "", JSON.stringify(issues), JSON.stringify(fixes), shotRel, dirMtime(dir));
  return JSON.stringify({ score, verdict: o.verdict || "", publiable: score >= PUBLISH_MIN(), problemes: issues, corrections: fixes, captures: shotRel, conseil: score >= PUBLISH_MIN() ? "Tu peux publier." : `Applique les corrections avec design_site(slug="${s}", feedback="...") puis refais review_site.` }, null, 1);
}

/** Quality gate for publish_site: the folder must have a review ≥ 7 newer than its last change. */
export async function publishGate(dirRel) {
  if (!(await browserOk())) return null; // no browser → no gate
  const min = PUBLISH_MIN(); if (min <= 0) return null;
  const dir = path.join(WORK, dirRel.replace(/^\/+/, ""));
  const r = one("SELECT score, mtime FROM reviews WHERE dir=? ORDER BY id DESC LIMIT 1", dirRel.replace(/^\/+|\/+$/g, ""));
  if (!r) return `Avant de publier, fais review_site sur ce dossier (règle d'équipe: score ≥ ${min}, modifiable par Atlas avec set_rule).`;
  if (r.mtime < dirMtime(dir) - 1000) return `Le site a changé depuis la dernière revue: refais review_site (score ≥ ${min} requis).`;
  if (r.score < min) return `Dernière revue: ${r.score}/10. Règle d'équipe: ≥ ${min}. Améliore le design puis refais review_site.`;
  return null;
}
