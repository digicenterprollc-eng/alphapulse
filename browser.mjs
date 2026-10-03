// Real Chromium for the agents (Playwright): read any page, click links, screenshots, previews, image rendering.
// Read-only by design: no typing into forms, no account creation, no form submissions.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const KIT_DIR = path.join(HERE, "kit");
export const BRAND_DIR = path.join(HERE, "public", "brand");
let pw = null, browser = null, launching = null;

export async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    if (!pw) pw = await import("playwright").catch(() => null);
    if (!pw) throw new Error("Navigateur indisponible (playwright non installé)");
    browser = await pw.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"], executablePath: process.env.CHROMIUM_PATH || undefined });
    browser.on("disconnected", () => { browser = null; });
    return browser;
  })().finally(() => { launching = null; });
  return launching;
}
export async function browserOk() { try { await getBrowser(); return true; } catch { return false; } }

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export async function withPage(fn, { mobile = false, width, height } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: width || (mobile ? 390 : 1440), height: height || (mobile ? 844 : 900) },
    deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: "fr-FR", ignoreHTTPSErrors: process.env.BROWSER_IGNORE_HTTPS === "1",
    userAgent: mobile ? IPHONE_UA : undefined,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  try { return await fn(page); } finally { await ctx.close().catch(() => {}); }
}

// Serve a local site folder at http://preview.local/ inside the browser only (nothing exposed publicly).
export async function routePreview(page, dir) {
  await page.route("http://preview.local/**", async (route) => {
    const u = new URL(route.request().url());
    let p = decodeURIComponent(u.pathname);
    let file;
    if (p.startsWith("/_kit/")) file = path.join(KIT_DIR, p.slice(6));
    else if (p.startsWith("/_brand/")) file = path.join(BRAND_DIR, p.slice(8));
    else if (p.startsWith("/buy/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Paiement (aperçu)</h1>" });
    else { file = path.join(dir, p); if (p.endsWith("/")) file = path.join(file, "index.html"); }
    if (!file.startsWith(dir) && !file.startsWith(KIT_DIR) && !file.startsWith(BRAND_DIR)) return route.fulfill({ status: 403, body: "" });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
    return route.fulfill({ status: 404, body: "not found" });
  });
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.evaluate(async () => {
    const H = document.documentElement.scrollHeight;
    for (let y = 0; y < H; y += 450) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); }
    window.scrollTo(0, 0);
    document.querySelectorAll("[data-reveal]").forEach((e) => e.classList.add("k-in"));
  }).catch(() => {});
  await page.waitForTimeout(1100);
}

/** Read a page: title, visible text, links. Optional click on a link/button by visible text. */
export async function readPage(url, clickText) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
    if (clickText) {
      const loc = page.getByRole("link", { name: clickText }).or(page.getByRole("button", { name: clickText })).or(page.getByText(clickText)).first();
      await loc.click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1500);
    }
    const title = await page.title();
    const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n"));
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => [(a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 70), a.href]).filter(([t, h]) => t && /^https?:/.test(h)).slice(0, 50));
    return { url: page.url(), title, text, links };
  });
}

/** Screenshot (desktop + mobile) of a local folder or a URL + automatic QA checks. */
export async function shoot({ dir, url }, { maxHeight = 4200 } = {}) {
  const out = {};
  for (const mobile of [false, true]) {
    out[mobile ? "mobile" : "desktop"] = await withPage(async (page) => {
      const errors = [];
      await page.addInitScript(() => { window.__KIT_SHOT = 1; });
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
      page.on("requestfailed", (r) => { if (!r.url().includes("fonts.g")) errors.push(`échec chargement: ${r.url().slice(0, 120)}`); });
      if (dir) { await routePreview(page, dir); await page.goto("http://preview.local/index.html", { waitUntil: "load", timeout: 30000 }); }
      else await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await settle(page);
      const m = await page.evaluate(() => ({
        h: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        title: document.title, desc: document.querySelector('meta[name=description]')?.content || "",
        buy: [...document.querySelectorAll('a[href*="/buy/"]')].length, pending: document.querySelectorAll("[data-buy=pending]").length,
        brokenImgs: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
        kit: !!document.querySelector('link[href*="/_kit/kit.css"]'),
        motion: !!document.querySelector('script[src*="/_kit/motion.js"]') || !!window.gsap,
        motionAttrs: document.querySelectorAll("[data-split],[data-intro],[data-text-scrub],[data-parallax],[data-scale],[data-clip],[data-draw],[data-float],[data-spin],[data-batch],[data-pin],[data-horizontal],[data-reveal],[data-bg]").length,
        icons: document.querySelectorAll('svg use[href*="icons.svg"],svg.k-ic,svg[class*="lucide"]').length,
        iconRefs: [...document.querySelectorAll('svg use[href*="icons.svg#"]')].map((u) => u.getAttribute("href").split("#")[1]),
        emoji: (() => { const t = document.title + " " + (document.body?.innerText || "") + " " + [...document.querySelectorAll("[alt],[aria-label]")].map((e) => e.getAttribute("alt") || e.getAttribute("aria-label")).join(" "); let n = 0; for (const m of t.matchAll(/(?:[\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic})/gu)) if (!/[\u00a9\u00ae\u2122\u2194-\u2199\u21a9\u21aa]/u.test(m[0])) n++; return n; })(),
        soon: /bient[oô]t disponible|ouverture des ventes|liste d'attente/i.test(document.body?.innerText || "") && !document.querySelector('a[href*="/buy/"]'),
      }));
      const vp = page.viewportSize();
      const png = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.min(m.h, mobile ? 3200 : maxHeight) }, type: "png" });
      return { png, errors: [...new Set(errors)].slice(0, 8), metrics: m };
    }, { mobile });
  }
  return out;
}

/** Render an HTML snippet to a PNG (social images: Instagram 1080x1350, OG 1200x630). */
export async function renderHtml(html, { width = 1080, height = 1350 } = {}) {
  return withPage(async (page) => {
    await routePreview(page, path.join(KIT_DIR));
    await page.route("http://render.local/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://render.local/", { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(600);
    return page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  }, { width, height });
}

// ---------- Interactive browser sessions (one per agent, cookies persisted) ----------
const SESS = new Map();
const stateFile = (agentId, WORK) => path.join(WORK, ".browser", `${agentId}.json`);
async function session(agentId, WORK) {
  let s = SESS.get(agentId);
  if (s && !s.page.isClosed()) { s.last = Date.now(); return s; }
  const b = await getBrowser();
  const sf = stateFile(agentId, WORK);
  const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, locale: "fr-FR", storageState: fs.existsSync(sf) ? sf : undefined, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  s = { ctx, page, last: Date.now(), sf }; SESS.set(agentId, s);
  return s;
}
setInterval(async () => { for (const [id, s] of SESS) if (Date.now() - s.last > 12 * 60000) { try { fs.mkdirSync(path.dirname(s.sf), { recursive: true }); await s.ctx.storageState({ path: s.sf }); await s.ctx.close(); } catch {} SESS.delete(id); } }, 60000).unref();

async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), st = getComputedStyle(e); return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none" && r.bottom > 0 && r.top < innerHeight * 3; };
    document.querySelectorAll("[data-ap-idx]").forEach((e) => e.removeAttribute("data-ap-idx"));
    const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],summary,label[for]')].filter(vis).slice(0, 120);
    const items = els.map((e, i) => {
      e.setAttribute("data-ap-idx", String(i));
      const t = (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("title") || e.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 70);
      const tag = e.tagName.toLowerCase(), type = e.getAttribute("type");
      return `[${i}] ${tag}${type ? ":" + type : ""}${e.getAttribute("href") ? " → " + e.getAttribute("href").slice(0, 80) : ""} ${t}`;
    });
    const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 5000);
    return { title: document.title, url: location.href, items, text };
  });
}

/**
 * Drive a real browser like a person: open, read, click, type, press, scroll, back, screenshot, close.
 * Elements are addressed by the [index] shown in the last read. Returns text for the agent (+ PNG when asked).
 */
export async function browserAct(agentId, WORK, a = {}) {
  const s = await session(agentId, WORK), page = s.page;
  const el = () => page.locator(`[data-ap-idx="${Number(a.index)}"]`).first();
  const act = String(a.action || "read");
  let note = "";
  switch (act) {
    case "open": await page.goto(String(a.url), { waitUntil: "domcontentloaded", timeout: 35000 }); await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); break;
    case "click": if (a.index != null) await el().click({ timeout: 10000 }); else if (a.text) await page.getByText(String(a.text), { exact: false }).first().click({ timeout: 10000 }); else if (a.x != null) await page.mouse.click(Number(a.x), Number(a.y)); await page.waitForLoadState("domcontentloaded").catch(() => {}); await page.waitForTimeout(900); break;
    case "type": if (a.index != null) { await el().click({ timeout: 8000 }).catch(() => {}); await el().fill(String(a.text ?? "")); } else await page.keyboard.type(String(a.text ?? ""), { delay: 15 }); break;
    case "select": await el().selectOption(String(a.text ?? "")); break;
    case "press": await page.keyboard.press(String(a.key || "Enter")); await page.waitForTimeout(800); break;
    case "scroll": await page.mouse.wheel(0, (a.direction === "up" ? -1 : 1) * (Number(a.amount) || 700)); await page.waitForTimeout(500); break;
    case "back": await page.goBack().catch(() => {}); await page.waitForTimeout(700); break;
    case "wait": await page.waitForTimeout(Math.min(Number(a.ms) || 1500, 15000)); break;
    case "close": try { fs.mkdirSync(path.dirname(s.sf), { recursive: true }); await s.ctx.storageState({ path: s.sf }); await s.ctx.close(); } catch {} SESS.delete(agentId); return { text: "Navigateur fermé (cookies conservés)." };
    case "read": case "screenshot": break;
    default: return { text: `action inconnue: ${act}. Actions: open, read, click, type, select, press, scroll, back, wait, screenshot, close.` };
  }
  try { fs.mkdirSync(path.dirname(s.sf), { recursive: true }); await s.ctx.storageState({ path: s.sf }); } catch {}
  const snap = await snapshot(page);
  const png = act === "screenshot" || a.look ? await page.screenshot({ type: "png", fullPage: !!a.full }) : null;
  const text = `${note}URL: ${snap.url}\nTitre: ${snap.title}\n\nÉléments interactifs (utilise index):\n${snap.items.join("\n")}\n\nTexte visible:\n${snap.text}`;
  return { text, png };
}
