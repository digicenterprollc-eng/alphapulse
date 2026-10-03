// DigiCorp Office — HTTP server: public sites/checkout + private dashboard
import { CFG } from "./config.mjs";
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { q, one, run, SITES, WORK } from "./db.mjs";
import { createCheckout, handleWebhook, payMode, PUBLIC_BASE } from "./pay.mjs";
import { usedToday, dailyLimit, MODELS } from "./llm.mjs";
import { startRuntime } from "./runtime.mjs";
import { handleAuth, session } from "./auth.mjs";
import { askAgent, detectAgent } from "./voice.mjs";
import { summary, ledgerRows, costsBySource, newGeneration, COMPANY, START_CAPITAL, balance, getSetting } from "./treasury.mjs";
import { GOV, ceo as currentCeo, afterGeneration } from "./governance.mjs";
import { storeHome, legalPage, LEGAL_LINKS } from "./legal.mjs";
import { currentModels } from "./llm.mjs";
import { startLive, endLive, voiceStatus, transcribeClip, liveReady, ensureVoices } from "./voicelive.mjs";
import { channelsStatus, checkChannels, probeTelegram } from "./channels.mjs";
import { KIT_DIR } from "./browser.mjs";
import { zipDir } from "./zipper.mjs";
import { handleInternal } from "./autonomy.mjs";
import { PORTRAITS, portraitsMap, resetPortrait } from "./portraits.mjs";
import { ownerChat, ownerCode } from "./channels.mjs";

const PORT = Number(process.env.PORT || 8080);
const DASH_HOSTS = (process.env.DASH_HOST || "hq.,agent.").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
const CANON_DASH = process.env.CANON_DASH || ""; // e.g. hq.example.com
const HERE = path.dirname(new URL(import.meta.url).pathname);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".pdf": "application/pdf", ".zip": "application/zip", ".mjs": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".gif": "image/gif", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".webmanifest": "application/manifest+json" };
const send = (res, code, body, type = "text/plain; charset=utf-8", extra = {}) => { res.writeHead(code, { "Content-Type": type, ...extra }); res.end(body); };
const json = (res, obj) => send(res, 200, JSON.stringify(obj), "application/json", { "Cache-Control": "no-store" });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function page(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14151d;color:#eceef6;font:16px/1.5 system-ui,sans-serif}main{max-width:520px;padding:32px;text-align:center}a{color:#f5c86b}</style></head><body><main>${body}</main></body></html>`;
}

const ico = (n, c = "k-ic") => `<svg class="${c}" aria-hidden="true"><use href="/_kit/icons.svg#${n}"/></svg>`;
function shopPage(title, inner) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AlphaPulse</title>
<meta name="robots" content="noindex"><link rel="icon" href="/_brand/favicon-64.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/_kit/kit.css"><script src="/_kit/kit.js" defer></script><script src="/_kit/motion.js" defer></script>
<style>:root{--k-accent:#3b82f6;--k-accent2:#22d3ee;--k-bg:#05070d;--k-bg2:#0b0f1a;--k-display:"Sora",var(--k-font)}
html{background:var(--k-bg)}body{min-height:100vh;display:flex;flex-direction:column}.sp-top{padding:22px 0}.sp-top img{height:30px;width:auto}
main{flex:1;display:grid;place-items:center;padding:24px 0 64px}.sp-card{width:min(560px,100% - 32px);padding:clamp(24px,5vw,40px);position:relative}
.sp-row{display:flex;align-items:center;gap:12px;color:var(--k-mut);font-size:14px}.sp-row+.sp-row{margin-top:10px}.sp-row .k-ic{color:var(--k-accent2)}
.sp-link{display:flex;gap:8px;align-items:center;margin-top:8px;padding:10px 12px;border-radius:12px;border:1px solid var(--k-line);background:var(--k-card);font:500 13px ui-monospace,monospace;word-break:break-all}
.sp-link button{margin-left:auto;flex:none;background:none;border:0;color:var(--k-fg);cursor:pointer;padding:6px}
.sp-desc{color:var(--k-mut);white-space:pre-line}.sp-big{width:100%;margin-top:22px}.sp-note{font-size:13px;color:var(--k-mut);margin-top:18px}
.sp-status{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:var(--k-card);border:1px solid var(--k-line);font-weight:600}
.spin{animation:sp-rot 1s linear infinite}@keyframes sp-rot{to{transform:rotate(360deg)}}</style></head>
<body><div class="k-mesh" style="position:fixed"><span></span><span></span><span></span></div><div class="k-noise"></div>
<header class="sp-top"><div class="k-container"><a href="/" aria-label="Accueil"><img src="/_brand/logo-light.webp" alt="AlphaPulse"></a></div></header>
<main><div class="sp-card k-glass k-border-anim" data-intro>${inner}</div></main>
<footer class="k-footer"><div class="k-container">Édité par ${esc(CFG.legal)} · ${esc(CFG.contact)} · ${LEGAL_LINKS}</div></footer>
<script>document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",()=>{navigator.clipboard?.writeText(b.dataset.copy);b.innerHTML='<svg class="k-ic"><use href="/_kit/icons.svg#check"/></svg>'}))</script></body></html>`;
}

function serveStatic(res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(root)) return send(res, 403, "forbidden");
  let f = file;
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) return send(res, 404, page("Introuvable", "<h1>404</h1><p>Page introuvable.</p>"), "text/html; charset=utf-8");
  const ext = path.extname(f).toLowerCase();
  const cache = ext === ".html" || ext === ".htm" ? "no-store"
    : /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|webp|svg)$/.test(f) ? "public, max-age=31536000, immutable"
    : f.includes(`${path.sep}vendor${path.sep}`) ? "public, max-age=86400" : f.startsWith(KIT_DIR) ? "public, max-age=3600" : "public, max-age=300";
  const head = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache, Vary: "Accept-Encoding" };
  const st = fs.statSync(f);
  if (/\.(html?|css|js|mjs|svg|json|txt|xml)$/.test(ext) && st.size > 1400 && /\bgzip\b/.test(res.req?.headers["accept-encoding"] || "")) {
    const key = f + ":" + st.mtimeMs;
    let gz = GZ.get(key);
    if (!gz) { gz = zlib.gzipSync(fs.readFileSync(f), { level: 8 }); if (GZ.size > 400) GZ.clear(); GZ.set(key, gz); }
    res.writeHead(200, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(200, head);
  fs.createReadStream(f).pipe(res);
}
const GZ = new Map();

async function publicApp(req, res, url) {
  const p = url.pathname;
  if (p === "/webhooks/c2p") {
    try {
      const r = await handleWebhook(req.url, req);
      console.log(`[webhook] ${r.ok ? "OK" : "REJET"} ${r.status || r.reason || ""} ${String(url.searchParams.get("chain2pay_order_id") || "").slice(0, 40)}`);
      return send(res, r.ok ? 200 : 400, r.ok ? `ok${r.status ? ": " + r.status : ""}` : `rejected: ${r.reason}`);
    }
    catch (e) { return send(res, 500, "error"); }
  }
  const buy = p.match(/^\/buy\/(p_[a-f0-9]+)$/);
  if (buy) {
    const prod = one("SELECT * FROM products WHERE id=? AND active=1", buy[1]);
    if (!prod) return send(res, 404, page("Produit", "<h1>Produit introuvable</h1>"), "text/html; charset=utf-8");
    if (payMode() === "off") return send(res, 200, shopPage(prod.name, `<span class="k-badge">${ico("clock")} Bientôt</span><h1 class="k-h2">${esc(prod.name)}</h1><p class="sp-desc">Le paiement en ligne ouvre très bientôt.</p>`), "text/html; charset=utf-8");
    try {
      const pay = await createCheckout(prod, url.searchParams.get("email"));
      const orderUrl = `${PUBLIC_BASE}/order/${encodeURIComponent(pay.id)}`;
      const price = Number(prod.price).toLocaleString("fr-FR", { minimumFractionDigits: Number(prod.price) % 1 ? 2 : 0, maximumFractionDigits: 2 });
      return send(res, 200, shopPage(prod.name, `<span class="k-badge">${ico("shield-check")} Paiement sécurisé</span>
<h1 class="k-h2" style="margin:14px 0 6px">${esc(prod.name)}</h1>
<div class="k-price">${price}<small>${esc(prod.currency)} · paiement unique</small></div>
<p class="sp-desc">${esc(String(prod.description || "").slice(0, 600))}</p>
<div class="sp-row">${ico("download")} Accès immédiat après paiement</div><div class="sp-row">${ico("credit-card")} Carte bancaire, traité par Chain2Pay</div><div class="sp-row">${ico("mail")} Une question : ${esc(CFG.contact)}</div>
<a class="k-btn k-btn-primary sp-big" data-magnetic href="${esc(pay.checkout_url)}">${ico("lock")} Payer ${price} ${esc(prod.currency)} par carte ${ico("arrow-right")}</a>
<p class="sp-note">Garde ce lien : ton produit y apparaît dès que le paiement est confirmé.</p>
<div class="sp-link">${ico("link")}<span>${esc(orderUrl)}</span><button type="button" data-copy="${esc(orderUrl)}" aria-label="Copier le lien">${ico("copy")}</button></div>`), "text/html; charset=utf-8");
    } catch (e) {
      console.error("[buy]", e.message);
      return send(res, 502, shopPage("Paiement", `<span class="k-badge">${ico("triangle-alert")} Indisponible</span><h1 class="k-h2">Paiement momentanément indisponible</h1><p class="sp-desc">Réessaie dans quelques minutes.</p>`), "text/html; charset=utf-8");
    }
  }
  const ord = p.match(/^\/order\/(C2P-[A-Za-z0-9-]+)(\/download)?$/);
  if (ord) {
    const sale = one("SELECT * FROM sales WHERE id=?", ord[1]);
    if (!sale) return send(res, 404, shopPage("Commande", `<h1 class="k-h2">Commande introuvable</h1>`), "text/html; charset=utf-8");
    const prod = one("SELECT * FROM products WHERE id=?", sale.product_id) || {};
    if (ord[2]) {
      if (sale.status !== "paid" || !prod.files) return send(res, 403, "Téléchargement disponible après paiement.");
      try {
        const dir = path.join(WORK, prod.files);
        const buf = zipDir(dir, String(prod.name || "produit").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "produit");
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${String(prod.name || "produit").normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "produit"}.zip"`, "Content-Length": buf.length, "Cache-Control": "no-store" });
        run("UPDATE sales SET downloads=COALESCE(downloads,0)+1 WHERE id=?", sale.id);
        return res.end(buf);
      } catch (e) { console.error("[download]", e.message); return send(res, 500, "Erreur de préparation du fichier. Écris à " + CFG.contact); }
    }
    if (sale.status !== "paid") return send(res, 200, shopPage("Commande", `<span class="sp-status">${ico("loader-circle", "k-ic spin")} Paiement ${sale.status === "pending" ? "en attente" : sale.status === "processing" ? "en cours de confirmation" : esc(sale.status)}</span>
<h1 class="k-h2" style="margin-top:16px">${esc(prod.name || "Commande")}</h1><p class="sp-desc">Dès que le paiement est confirmé, ton produit apparaît ici. La page se met à jour toute seule.</p><script>setTimeout(()=>location.reload(),15000)</script>`), "text/html; charset=utf-8");
    const d = esc(prod.delivery || "").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    return send(res, 200, shopPage("Merci", `<span class="k-badge">${ico("badge-check")} Paiement confirmé</span>
<h1 class="k-h2" style="margin:14px 0 6px">Merci pour ton achat</h1><p style="font-weight:600">${esc(prod.name || "")}</p>
${prod.files ? `<a class="k-btn k-btn-primary sp-big" href="/order/${encodeURIComponent(sale.id)}/download">${ico("download")} Télécharger (ZIP)</a>` : ""}
${d ? `<div class="sp-note" style="font-size:15px;color:var(--k-fg);margin-top:28px"><b>Mode d'emploi</b></div><p class="sp-desc">${d}</p>` : ""}
<p class="sp-note">Garde cette page dans tes favoris pour retélécharger. Besoin d'aide : ${esc(CFG.contact)}</p>`), "text/html; charset=utf-8");
  }
  if (p.startsWith("/_kit/")) return serveStatic(res, KIT_DIR, p.slice(6));
  if (p.startsWith("/_brand/")) return serveStatic(res, path.join(HERE, "public", "brand"), p.slice(8));
  if (p.startsWith("/_media/")) return serveStatic(res, path.join(SITES, "_media"), p.slice(8));
  if (/^\/[^/]+\.[a-z0-9]+$/i.test(p) && fs.existsSync(path.join(SITES, "accueil", p.slice(1)))) return serveStatic(res, path.join(SITES, "accueil"), p.slice(1));
  if ((p === "/" || p === "") && fs.existsSync(path.join(SITES, "accueil", "index.html"))) { run("UPDATE sites SET visits=visits+1 WHERE slug='accueil'"); return serveStatic(res, SITES, "accueil/index.html"); }
  const lg = p.match(/^\/legal\/([a-z-]+)\/?$/);
  if (lg) { const h = legalPage(lg[1]); return h ? send(res, 200, h, "text/html; charset=utf-8") : send(res, 404, page("Introuvable", "<h1>404</h1><p>Page introuvable.</p>"), "text/html; charset=utf-8"); }
  if (p === "/" || p === "") {
    // no "accueil" site: a designed store home listing only real, active products with a published sales page (never internal pages)
    const prods = q("SELECT p.* FROM products p JOIN sites s ON s.slug = p.site WHERE p.active = 1 ORDER BY p.created_at DESC");
    return send(res, 200, storeHome(prods), "text/html; charset=utf-8");
  }
  const m = p.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    if (!m[2]) { res.writeHead(301, { Location: `/${m[1]}/` }); return res.end(); }
    if (m[2] === "/" || m[2] === "/index.html") run("UPDATE sites SET visits=visits+1 WHERE slug=?", m[1]);
    return serveStatic(res, SITES, m[1] + decodeURIComponent(m[2]));
  }
  send(res, 404, "not found");
}

function snapshot() {
  const agents = q("SELECT * FROM agents ORDER BY CASE role WHEN 'ceo' THEN 0 WHEN 'builder' THEN 1 WHEN 'marketer' THEN 2 ELSE 3 END");
  const stats = {};
  for (const a of agents) {
    stats[a.id] = {
      revenue: one("SELECT COALESCE(SUM(s.paid_amount),0) v FROM sales s WHERE s.agent=? AND s.status='paid' AND s.sandbox=0", a.id).v,
      sales: one("SELECT COUNT(*) n FROM sales s WHERE s.agent=? AND s.status='paid' AND s.sandbox=0", a.id).n,
      products: one("SELECT COUNT(*) n FROM products WHERE created_by=?", a.id).n,
      sites: one("SELECT COUNT(*) n FROM sites WHERE agent=?", a.id).n,
      tasks: q("SELECT status, COUNT(*) n FROM tasks WHERE assignee=? GROUP BY status", a.id).reduce((o, r) => (o[r.status] = r.n, o), {}),
      tools: q("SELECT tool, COUNT(*) n FROM events WHERE agent=? AND tool IS NOT NULL AND kind='action' GROUP BY tool ORDER BY n DESC LIMIT 10", a.id),
    };
  }
  return {
    now: new Date().toISOString(),
    agents, stats,
    tasks: q("SELECT * FROM tasks ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, updated_at DESC LIMIT 120"),
    sites: q("SELECT * FROM sites ORDER BY updated_at DESC"),
    products: q("SELECT p.id,p.name,p.description,p.price,p.currency,p.site,p.created_by,p.active,p.files,p.created_at, (SELECT COUNT(*) FROM sales s WHERE s.product_id=p.id) checkouts, (SELECT COUNT(*) FROM sales s WHERE s.product_id=p.id AND s.status='paid') paid FROM products p ORDER BY created_at DESC"),
    sales: q("SELECT * FROM sales ORDER BY created_at DESC LIMIT 100"),
    revenue: one("SELECT COALESCE(SUM(paid_amount),0) total, COUNT(*) n FROM sales WHERE status='paid' AND sandbox=0"),
    notes: q("SELECT * FROM notes ORDER BY ts DESC LIMIT 50"),
    messages: q("SELECT * FROM messages ORDER BY id DESC LIMIT 60"),
    llm: { used: usedToday(), limit: dailyLimit(), models: MODELS, byModel: q("SELECT model, calls, ok FROM llm_usage WHERE day=?", new Date().toISOString().slice(0, 10)) },
    pay: payMode(), publicBase: PUBLIC_BASE,
    feed: q("SELECT * FROM events ORDER BY id DESC LIMIT 150"),
    caisse: summary(COMPANY),
    caisses: q("SELECT id, owner FROM treasury WHERE id != ?", COMPANY).map((t) => ({ ...summary(t.id), owner: t.owner })),
    costs: costsBySource(COMPANY),
    ledger: ledgerRows(80),
    models: currentModels(),
    channels: channelsStatus(),
    voiceLive: voiceStatus(),
    posts: q("SELECT * FROM posts ORDER BY id DESC LIMIT 40"),
    emails: q("SELECT id, agent, dir, peer, subject, substr(body,1,300) body, ts FROM emails ORDER BY id DESC LIMIT 40"),
    reviews: q("SELECT id, dir, score, verdict, issues, fixes, shot, ts FROM reviews ORDER BY id DESC LIMIT 20"),
    voice: q("SELECT id, agent, kind, output, ts FROM events WHERE tool='voice' ORDER BY id DESC LIMIT 40"),
    portraits: portraitsMap(),
    tgOwner: { linked: !!ownerChat(), code: ownerChat() ? null : ownerCode(), bot: CFG.telegramBot },
    ownerName: CFG.owner,
    gov: (() => {
      const c = currentCeo(); const since = c?.ceo_since ? new Date(c.ceo_since.replace(" ", "T") + "Z").getTime() : null;
      return {
        ceo: c?.id || null, ceoSince: c?.ceo_since || null, graceDays: GOV.ceoGraceDays,
        daysLeft: since ? Math.max(0, GOV.ceoGraceDays - (Date.now() - since) / 86400000) : null,
        payrollDay: getSetting("payroll.day"), payroll: agents.filter((a) => a.status !== "dead").reduce((t, a) => t + Number(a.salary || 0), 0),
        wallets: Object.fromEntries(agents.filter((a) => a.treasury && a.treasury !== COMPANY).map((a) => [a.id, Math.round(balance(a.treasury) * 100) / 100])),
        perms: Object.fromEntries(q("SELECT key, value FROM settings WHERE key LIKE 'perm.%'").map((r) => { try { return [r.key.slice(5), JSON.parse(r.value).deny || []]; } catch { return [r.key.slice(5), []]; } })),
        elections: q("SELECT * FROM elections ORDER BY id DESC LIMIT 10"),
      };
    })(),
    customTools: q("SELECT name, description, author, uses, fails, updated FROM custom_tools ORDER BY uses DESC LIMIT 60"),
    skills: q("SELECT name, kind, summary, author, uses, updated FROM skills ORDER BY updated DESC LIMIT 80"),
    lessons: q("SELECT * FROM lessons ORDER BY id DESC LIMIT 30"),
    rules: Object.fromEntries(q("SELECT key, value FROM settings WHERE key LIKE 'rule.%'").map((r) => [r.key.slice(5), r.value])),
    agentModels: q("SELECT key, value FROM settings WHERE key LIKE 'model.%.%'").map((r) => ({ agent: r.key.split(".")[1], slot: r.key.split(".")[2], model: r.value })),
  };
}

async function dashApp(req, res, url) {
  const p = url.pathname;
  const host = String(req.headers.host || "").toLowerCase();
  if (CANON_DASH && host !== CANON_DASH && !host.startsWith("localhost")) { res.writeHead(301, { Location: `https://${CANON_DASH}${req.url}` }); return res.end(); }
  if (p.startsWith("/auth/")) return handleAuth(req, res, url);
  if (p.startsWith("/vendor/") || p.startsWith("/brand/")) return serveStatic(res, path.join(HERE, "public"), p.slice(1));
  if (p.startsWith("/_kit/")) return serveStatic(res, KIT_DIR, p.slice(6));
  const s = session(req);
  if (!s || s.kind !== "full") {
    if (p === "/" || p === "/index.html") return serveStatic(res, path.join(HERE, "public"), "auth.html");
    res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"error":"auth"}');
  }
  if (p === "/api/ask" && req.method === "POST") {
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      try { const b = JSON.parse(body || "{}"); json(res, await askAgent(String(b.text || ""), b.agent ? String(b.agent) : null, b.lang === "ar" ? "ar" : "fr")); }
      catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (p === "/api/office") return json(res, snapshot());
  if (p.startsWith("/portraits/")) return serveStatic(res, PORTRAITS, p.slice(11));
  if (p === "/api/portrait/reset" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resetPortrait(String(JSON.parse(b || "{}").agent || "")); json(res, { ok: true }); } catch { send(res, 400, "bad"); } }); return; }
  const readBody = (max = 200000) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > max) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); });
  const fail = (e, code = 500) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); };
  if (p === "/api/generation" && req.method === "POST") {
    const b = await readBody(); try { const r = newGeneration(Math.max(5, Math.min(1000, Number(b.capital) || START_CAPITAL))); afterGeneration(); return json(res, r); } catch (e) { return fail(e, 400); }
  }
  if (p === "/api/voice/config") return json(res, voiceStatus());
  if (p === "/api/channels/check" && req.method === "POST") { try { return json(res, await checkChannels()); } catch (e) { return fail(e); } }
  if (p === "/api/voice/start" && req.method === "POST") {
    const b = await readBody(); try { return json(res, await startLive(String(b.agent || "atlas"), b.lang === "ar" ? "ar" : "fr")); } catch (e) { return fail(e, 400); }
  }
  if (p === "/api/voice/end" && req.method === "POST") {
    const b = await readBody(); try { return json(res, await endLive(String(b.sessionId || ""), b)); } catch (e) { return fail(e); }
  }
  if (p === "/api/voice/name" && req.method === "POST") {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 2e6) req.destroy(); else chunks.push(c); });
    req.on("end", async () => { try { const text = await transcribeClip(Buffer.concat(chunks), String(req.headers["content-type"] || "audio/webm")); json(res, { text, agent: detectAgent(text) }); } catch (e) { fail(e); } });
    return;
  }
  if (p === "/api/message" && req.method === "POST") {
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
      try {
        const { to, text } = JSON.parse(body || "{}");
        if (!one("SELECT id FROM agents WHERE id=?", String(to))) return send(res, 400, "agent inconnu");
        run("INSERT INTO messages(from_agent,to_agent,text) VALUES('owner',?,?)", String(to), String(text).slice(0, 2000));
        run("INSERT INTO events(agent,kind,tool,args,output) VALUES(?,?,?,?,?)", String(to), "inbox", "message", JSON.stringify({ from: "owner" }), String(text).slice(0, 2000));
        json(res, { ok: true });
      } catch { send(res, 400, "bad request"); }
    });
    return;
  }
  const ev = p.match(/^\/api\/agent\/([a-z]+)\/events$/);
  if (ev) return json(res, q("SELECT * FROM events WHERE agent=? ORDER BY id DESC LIMIT 120", ev[1]));
  if (p === "/api/files") {
    const out = []; const walk = (d, depth) => { if (depth > 4 || out.length > 400) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f, depth + 1); else { const st = fs.statSync(f); out.push({ path: path.relative(WORK, f), size: st.size, mtime: st.mtime }); } } };
    walk(WORK, 0); return json(res, out.sort((a, b) => b.mtime - a.mtime));
  }
  if (p === "/api/file") {
    const f = path.resolve(WORK, url.searchParams.get("path") || "");
    if (!f.startsWith(WORK) || !fs.existsSync(f)) return send(res, 404, "introuvable");
    if (fs.statSync(f).size > 4000000) return send(res, 413, "trop gros");
    const ext = path.extname(f).toLowerCase();
    return send(res, 200, fs.readFileSync(f), /\.(png|jpe?g|webp|svg|pdf)$/.test(ext) ? MIME[ext] : "text/plain; charset=utf-8");
  }
  if (p === "/" || p === "/index.html") return serveStatic(res, path.join(HERE, "public"), "index.html");
  return serveStatic(res, path.join(HERE, "public"), p.slice(1));
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const host = String(req.headers.host || "").toLowerCase();
  if (url.pathname.startsWith("/internal/")) return void handleInternal(req, res, url).catch((e) => { try { send(res, 500, "error"); } catch {} });
  const isDash = DASH_HOSTS.some((h) => host.startsWith(h));
  Promise.resolve(isDash ? dashApp(req, res, url) : publicApp(req, res, url)).catch((e) => { console.error(e); try { send(res, 500, "error"); } catch {} });
}).listen(PORT, "0.0.0.0", () => console.log(`[office] http on :${PORT}`));

startRuntime();
probeTelegram();
ensureVoices();
