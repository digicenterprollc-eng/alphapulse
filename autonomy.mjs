// Autonomy layer: the agents build their own tools (code) and call the company's capabilities (AI, vision, voice, images)
// through a private local API. Every call is charged to the caller's caisse, so the survival economy stays real.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { db, q, one, run, WORK, logEvent } from "./db.mjs";
import { chat, generateImage } from "./llm.mjs";
import { charge, treasuryOf, agentDead, getSetting, setSetting } from "./treasury.mjs";
import { voiceFor } from "./voicelive.mjs";
import { PUBLIC_BASE } from "./pay.mjs";

const PORT = Number(process.env.PORT || 8080);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EL_KEY = process.env.ELEVENLABS_API_KEY || "";
const TTS_USD_PER_CHAR = Number(process.env.TTS_USD_PER_CHAR || 0.0002);
export const TOOLS_DIR = path.join(WORK, "tools");
const LIB_DIR = path.join(WORK, "lib");

db.exec(`CREATE TABLE IF NOT EXISTS custom_tools (name TEXT PRIMARY KEY, description TEXT, args TEXT, timeout_s INTEGER DEFAULT 600,
  author TEXT, uses INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, created TEXT DEFAULT (datetime('now')), updated TEXT DEFAULT (datetime('now')))`);

// ---------- identity for the internal API ----------
function secret() { let s = getSetting("internal.secret"); if (!s) { s = crypto.randomBytes(24).toString("hex"); setSetting("internal.secret", s); } return s; }
export const agentToken = (id) => `${id}.${crypto.createHmac("sha256", secret()).update(String(id)).digest("hex").slice(0, 32)}`;
function verify(req) {
  const ip = String(req.socket?.remoteAddress || "");
  if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return null;
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [id, sig] = tok.split(".");
  if (!id || !sig || agentToken(id) !== tok) return null;
  return one("SELECT * FROM agents WHERE id=?", id) || null;
}

/** Environment given to agent code (exec + custom tools): capabilities, never raw secrets. */
export function agentEnv(agent) {
  let ffdir = "";
  try { const f = path.join(HERE, "node_modules", "ffmpeg-static", "ffmpeg"); if (fs.existsSync(f)) ffdir = path.dirname(f); } catch {}
  const home = path.join(WORK, ".home"); fs.mkdirSync(home, { recursive: true });
  return {
    PATH: [ffdir, path.join(HERE, "bin"), path.join(WORK, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(":"),
    HOME: home, LANG: "C.UTF-8", TZ: process.env.TZ || "UTC",
    NODE_PATH: [path.join(WORK, "node_modules"), path.join(HERE, "node_modules")].join(":"),
    npm_config_cache: path.join(WORK, ".npm-cache"),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright",
    FFMPEG_PATH: ffdir ? path.join(ffdir, "ffmpeg") : "ffmpeg",
    AP_API: `http://127.0.0.1:${PORT}/internal`, AP_TOKEN: agentToken(agent.id), AP_AGENT: agent.id,
    AP_WORK: WORK, AP_PUBLIC_BASE: PUBLIC_BASE, AP_APP: HERE,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(LIB_DIR, "hooks.mjs")).href}`,
  };
}

// ---------- helper library the agents import from their code ----------
const LIB_VERSION = "5";
export function ensureLib() {
  fs.mkdirSync(LIB_DIR, { recursive: true }); fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const stamp = path.join(LIB_DIR, ".version");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === LIB_VERSION) return;
  fs.writeFileSync(path.join(LIB_DIR, "ap.mjs"), `// AlphaPulse internal API (charged to YOUR caisse). import * as ap from "${LIB_DIR}/ap.mjs"
const API = process.env.AP_API, TOKEN = process.env.AP_TOKEN;
async function call(p, body, raw = false) {
  const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(p + " " + r.status + ": " + (await r.text()).slice(0, 400));
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
/** Text generation. messages = string or OpenAI-style array. opts: { model, slot: "main"|"builder"|"vision"|"voice", max_tokens, temperature, tools }. Returns { text, message, model, cost }. */
export const llm = (messages, opts = {}) => call("/llm", { messages: typeof messages === "string" ? [{ role: "user", content: messages }] : messages, ...opts });
/** Vision: images = Buffers or base64 strings (png/jpeg). Returns { text, model, cost }. */
export const vision = (images, question, opts = {}) => call("/vision", { images: images.map((b) => (Buffer.isBuffer(b) ? b.toString("base64") : b)), question, ...opts });
/** Professional voice (ElevenLabs). opts: { voice: agent id (atlas|nova|lyra|orion|...) or ElevenLabs voice_id, lang: "fr"|"ar"|"en", model_id }. Returns an MP3 Buffer. */
export const tts = (text, opts = {}) => call("/tts", { text, ...opts }, true);
/** List ElevenLabs voices: [{ voice_id, name, labels }]. */
export const voices = () => call("/voices", {});
/** Image generation. opts: { model (e.g. "google/gemini-3.1-flash-image", "google/gemini-3-pro-image"), aspect_ratio: "1:1"|"16:9"|"9:16"|"4:5" }. Returns { images: [base64 png], text, model, cost }. */
export const image = (prompt, opts = {}) => call("/image", { prompt, ...opts });
/** Write a line in the HQ activity feed. */
export const log = (text) => call("/log", { text });
export const WORK = process.env.AP_WORK, PUBLIC_BASE = process.env.AP_PUBLIC_BASE, APP = process.env.AP_APP, FFMPEG = process.env.FFMPEG_PATH;
`);
  fs.writeFileSync(path.join(LIB_DIR, "run-tool.mjs"), `import { pathToFileURL } from "node:url";
import * as ap from "./ap.mjs";
const file = process.argv[2];
let input = ""; for await (const c of process.stdin) input += c;
const args = input.trim() ? JSON.parse(input) : {};
const mod = await import(pathToFileURL(file).href);
const fn = mod.default || mod.run;
if (typeof fn !== "function") { console.error("Le module doit faire: export default async function (args, ap) { ... return résultat }"); process.exit(2); }
const out = await fn(args, ap);
process.stdout.write(typeof out === "string" ? out : JSON.stringify(out ?? "ok", null, 1));
`);
  // ESM ignores NODE_PATH: when a bare import is not found next to the agent's code, resolve it from the app's node_modules.
  fs.writeFileSync(path.join(LIB_DIR, "hooks.mjs"), `import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const APP = process.env.AP_APP;
if (typeof registerHooks === "function" && APP) {
  const parentURL = pathToFileURL(APP + "/server.mjs").href;
  registerHooks({ resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (e && e.code === "ERR_MODULE_NOT_FOUND" && !/^(\\.|\\/|node:|file:|data:)/.test(spec)) return next(spec, { ...ctx, parentURL });
      throw e;
    }
  } });
}
`);
  // reference examples the team can adopt (read_file lib/examples/...)
  const ex = path.join(HERE, "seed", "examples");
  if (fs.existsSync(ex)) { fs.mkdirSync(path.join(LIB_DIR, "examples"), { recursive: true }); for (const f of fs.readdirSync(ex)) fs.copyFileSync(path.join(ex, f), path.join(LIB_DIR, "examples", f)); }
  fs.writeFileSync(stamp, LIB_VERSION);
}

// ---------- internal HTTP API ----------
const body = (req) => new Promise((resolve, reject) => { const ch = []; let n = 0; req.on("data", (c) => { n += c.length; if (n > 40e6) { reject(new Error("too large")); req.destroy(); } else ch.push(c); }); req.on("end", () => { try { resolve(ch.length ? JSON.parse(Buffer.concat(ch).toString("utf8")) : {}); } catch (e) { reject(e); } }); });
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
let VOICES = null;

export async function handleInternal(req, res, url) {
  const agent = verify(req);
  if (!agent) return json(res, 401, { error: "unauthorized (local only, AP_TOKEN required)" });
  if (agentDead(agent.id)) return json(res, 403, { error: "MORT: caisse vide" });
  try {
    const b = req.method === "POST" ? await body(req) : {};
    const p = url.pathname.replace(/^\/internal/, "");
    if (p === "/llm") {
      const r = await chat(b.messages || [], b.tools, { agent: agent.id, slot: b.slot || "main", model: b.model || null, maxTokens: Math.min(Number(b.max_tokens) || 4000, 64000), temperature: b.temperature ?? 0.5, purpose: `outil · ${String(b.purpose || "llm").slice(0, 40)}` });
      return json(res, 200, { text: String(r.message.content || ""), message: r.message, model: r.model, cost: r.cost });
    }
    if (p === "/vision") {
      const imgs = (b.images || []).slice(0, 12).map((x) => Buffer.from(String(x).replace(/^data:[^,]+,/, ""), "base64"));
      const content = [{ type: "text", text: String(b.question || "Décris l'image.") }, ...imgs.map((x) => ({ type: "image_url", image_url: { url: `data:image/${x[0] === 0xff ? "jpeg" : "png"};base64,${x.toString("base64")}` } }))];
      const r = await chat([{ role: "user", content }], undefined, { agent: agent.id, slot: "vision", model: b.model || null, maxTokens: Math.min(Number(b.max_tokens) || 3000, 16000), purpose: "outil · vision" });
      return json(res, 200, { text: String(r.message.content || ""), model: r.model, cost: r.cost });
    }
    if (p === "/image") {
      const r = await generateImage(String(b.prompt || ""), { agent: agent.id, model: b.model, aspect_ratio: b.aspect_ratio });
      return json(res, 200, r);
    }
    if (p === "/tts") {
      if (!EL_KEY) return json(res, 503, { error: "ElevenLabs non configuré" });
      const text = String(b.text || "").slice(0, 5000); if (!text.trim()) return json(res, 400, { error: "text vide" });
      const lang = ["fr", "ar", "en"].includes(b.lang) ? b.lang : "fr";
      const voiceId = /^[A-Za-z0-9]{18,}$/.test(String(b.voice || "")) ? b.voice : await voiceFor(String(b.voice || agent.id), lang === "ar" ? "ar" : "fr");
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": EL_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: b.model_id || "eleven_multilingual_v2", language_code: lang, voice_settings: b.voice_settings || { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }), signal: AbortSignal.timeout(90000) });
      if (!r.ok) return json(res, 502, { error: `ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}` });
      charge(treasuryOf(agent.id), text.length * TTS_USD_PER_CHAR, "voix", `Voix off (${text.length} car.)`, agent.id);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length }); return res.end(buf);
    }
    if (p === "/voices") {
      if (!EL_KEY) return json(res, 200, []);
      VOICES ||= (await (await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": EL_KEY } })).json()).voices || [];
      return json(res, 200, VOICES.map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels })));
    }
    if (p === "/log") { logEvent(agent.id, "action", "outil", null, String(b.text || "").slice(0, 600)); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "endpoint inconnu: /llm /vision /image /tts /voices /log" });
  } catch (e) { return json(res, 500, { error: String(e.message || e).slice(0, 400) }); }
}

// ---------- agent-built tools ----------
const TOOL_NAME = /^[a-z][a-z0-9_]{1,39}$/;
export function customToolDefs() {
  return q("SELECT * FROM custom_tools ORDER BY name").map((t) => {
    let args = {}; try { args = JSON.parse(t.args || "{}"); } catch {}
    const props = Object.fromEntries(Object.entries(args).map(([k, d]) => [k, { type: "string", description: String(d).slice(0, 200) }]));
    return { name: `t_${t.name}`, def: { type: "function", function: { name: `t_${t.name}`, description: `[outil maison de ${t.author}] ${t.description}`.slice(0, 1000), parameters: { type: "object", properties: props } } } };
  });
}
export function createTool(agent, { name, description, args, code, timeout_s }) {
  name = String(name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!TOOL_NAME.test(name)) return "Nom invalide (a-z, 0-9, _ ; 2 à 40 caractères, commence par une lettre).";
  if (!String(description || "").trim()) return "Décris ce que fait l'outil (description).";
  code = String(code || "");
  if (!/export\s+default\s+async\s+function|export\s+default\s+async\s*\(|export\s+async\s+function\s+run/.test(code)) return "Le code doit exporter: export default async function (args, ap) { ... return résultat }";
  let argsObj = args;
  if (typeof args === "string") { try { argsObj = JSON.parse(args); } catch { argsObj = Object.fromEntries(args.split(",").map((x) => x.trim()).filter(Boolean).map((x) => [x, x])); } }
  if (!argsObj || typeof argsObj !== "object") argsObj = {};
  ensureLib();
  fs.writeFileSync(path.join(TOOLS_DIR, `${name}.mjs`), code);
  const t = Math.max(10, Math.min(Number(timeout_s) || 600, 3600));
  run(`INSERT INTO custom_tools(name,description,args,timeout_s,author) VALUES(?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET description=excluded.description, args=excluded.args, timeout_s=excluded.timeout_s, author=excluded.author, updated=datetime('now')`,
    name, String(description).slice(0, 800), JSON.stringify(argsObj), t, agent.id);
  logEvent(agent.id, "evolution", "create_tool", { name }, `Nouvel outil maison: t_${name} — ${String(description).slice(0, 160)}`);
  return `Outil t_${name} enregistré (tools/${name}.mjs). Il est disponible pour toute l'équipe dès le prochain shift. Teste-le avec run_tool(name="${name}", args={...}).`;
}
export function runCustomTool(agent, name, args = {}) {
  name = String(name || "").replace(/^t_/, "");
  const t = one("SELECT * FROM custom_tools WHERE name=?", name);
  const file = path.join(TOOLS_DIR, `${name}.mjs`);
  if (!t || !fs.existsSync(file)) return Promise.resolve(`Outil maison inconnu: ${name}`);
  ensureLib();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(LIB_DIR, "run-tool.mjs"), file], { cwd: WORK, env: agentEnv(agent), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); err += `\n[timeout ${t.timeout_s}s]`; }, t.timeout_s * 1000);
    p.stdout.on("data", (d) => { if (out.length < 200000) out += d; });
    p.stderr.on("data", (d) => { err = (err + d).slice(-6000); });
    p.on("close", (code) => {
      clearTimeout(timer);
      run(`UPDATE custom_tools SET uses=uses+1, fails=fails+? WHERE name=?`, code === 0 ? 0 : 1, name);
      const o = out.length > 12000 ? out.slice(0, 12000) + `\n…[+${out.length - 12000}]` : out;
      resolve(code === 0 ? (o || "(aucune sortie)") : `Erreur (code ${code}):\n${err.slice(-3000)}\n${o.slice(0, 2000)}`);
    });
    p.stdin.end(JSON.stringify(args || {}));
  });
}
export function deleteTool(agent, name) {
  name = String(name || "").replace(/^t_/, "");
  const r = run("DELETE FROM custom_tools WHERE name=?", name);
  if (r.changes) { try { fs.renameSync(path.join(TOOLS_DIR, `${name}.mjs`), path.join(TOOLS_DIR, `${name}.mjs.old`)); } catch {} logEvent(agent.id, "evolution", "delete_tool", { name }, `Outil maison retiré: t_${name}`); }
  return r.changes ? `Outil t_${name} retiré.` : "Outil introuvable.";
}
export const listCustomTools = () => q("SELECT name, description, args, author, uses, fails, updated FROM custom_tools ORDER BY uses DESC, name");
