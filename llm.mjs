// LLM client — OpenRouter. Model routing by "slot", real cost charged to the caisse (treasury).
import { CFG } from "./config.mjs";
import { run, one, db } from "./db.mjs";
import { charge, treasuryOf, tier, getSetting, COMPANY, isDead } from "./treasury.mjs";

const KEY = process.env.OPENROUTER_API_KEY;
export const FREE = (process.env.OFFICE_MODELS ||
  "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free")
  .split(",").map((s) => s.trim()).filter(Boolean);
export const DEFAULT_MODELS = {
  main: "deepseek/deepseek-v4.1-flash",     // agents' daily loop: cheap, fast, good at tools
  builder: "anthropic/claude-sonnet-5.5",   // design + code of the sites
  vision: "google/gemini-3.8-flash",        // looks at screenshots
  voice: "deepseek/deepseek-v4.1-flash",    // spoken answers / transcript analysis
};
export const modelFor = (slot, agent) => (agent && getSetting(`model.${agent}.${slot}`)) || getSetting(`model.${slot}`, DEFAULT_MODELS[slot] || DEFAULT_MODELS.main);
export const currentModels = () => Object.fromEntries(Object.keys(DEFAULT_MODELS).map((k) => [k, modelFor(k)]));
export const MODELS = FREE;
// Daily safety valve against runaway loops; the team can change it (rule.daily_calls).
const DAILY_LIMIT = () => Number(getSetting("rule.daily_calls", process.env.OFFICE_DAILY_CALLS || 20000));
const MIN_GAP_MS = Number(process.env.OFFICE_MIN_GAP_MS || 4500); // only for :free models (rate limits)

try { db.exec("ALTER TABLE llm_usage ADD COLUMN cost REAL DEFAULT 0"); } catch {}

let lastFree = 0, chain = Promise.resolve();
const cooldown = new Map();
const today = () => new Date().toISOString().slice(0, 10);
export function usedToday() { return one("SELECT COALESCE(SUM(calls),0) n FROM llm_usage WHERE day=?", today()).n; }
export const dailyLimit = () => DAILY_LIMIT();
function track(model, ok, cost = 0) {
  run(`INSERT INTO llm_usage(day,model,calls,ok,cost) VALUES(?,?,1,?,?)
       ON CONFLICT(day,model) DO UPDATE SET calls=calls+1, ok=ok+excluded.ok, cost=cost+excluded.cost`, today(), model, ok ? 1 : 0, cost);
}
async function throttleFree() {
  const p = chain.then(async () => { const w = lastFree + MIN_GAP_MS - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); lastFree = Date.now(); });
  chain = p.catch(() => {}); return p;
}

// price cache for cost estimation when the API does not return usage.cost
let PRICES = {}, pricesAt = 0;
async function prices() {
  if (Date.now() - pricesAt < 6 * 3600e3 && Object.keys(PRICES).length) return PRICES;
  try {
    const d = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    PRICES = Object.fromEntries(d.data.map((m) => [m.id, { p: Number(m.pricing?.prompt || 0), c: Number(m.pricing?.completion || 0), img: (m.architecture?.input_modalities || []).includes("image"), tools: (m.supported_parameters || []).includes("tools"), ctx: m.context_length }]));
    pricesAt = Date.now();
  } catch {}
  return PRICES;
}
export async function modelInfo(id) { return (await prices())[id] || null; }

function chainFor(slot, lvl, agent, explicit) {
  const primary = explicit || modelFor(slot, agent);
  if (lvl === "critique" && !explicit) return slot === "builder" || slot === "vision" ? [modelFor("main", agent), ...FREE] : [...FREE, modelFor("main", agent)];
  const list = [primary];
  if (slot === "builder" || slot === "vision") list.push(modelFor("main", agent));
  return [...new Set([...list, ...FREE])];
}

/**
 * chat(messages, tools, { agent, slot, maxTokens, purpose, temperature })
 * Returns { message, model, cost }. Throws "MORT" if the caisse is empty.
 */
export async function chat(messages, tools, opts = {}) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY manquante");
  const { agent = null, slot = "main", maxTokens = 4000, purpose = "", temperature = 0.4, model: explicit = null } = opts;
  const tid = agent ? treasuryOf(agent) : COMPANY;
  if (isDead(tid)) throw new Error("MORT: caisse vide");
  if (usedToday() >= DAILY_LIMIT()) throw new Error("BUDGET_JOUR_ATTEINT");
  const needsImg = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
  let lastErr;
  for (const model of chainFor(slot, tier(tid), agent, explicit)) {
    if ((cooldown.get(model) || 0) > Date.now()) continue;
    if (needsImg) { const inf = await modelInfo(model); if (inf && !inf.img) continue; }
    if (model.endsWith(":free") || model === "openrouter/free") await throttleFree();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "HTTP-Referer": CFG.site, "X-Title": "AlphaPulse HQ" },
        body: JSON.stringify({ model, messages, tools, tool_choice: tools ? "auto" : undefined, max_tokens: maxTokens, temperature, usage: { include: true } }),
        signal: AbortSignal.timeout(slot === "builder" ? 420000 : 150000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        track(model, false);
        const code = data.error?.code || res.status;
        lastErr = new Error(`${model}: ${code} ${data.error?.message || ""}`.slice(0, 300));
        cooldown.set(model, Date.now() + (code === 429 || code >= 500 ? 60_000 : 10 * 60_000));
        continue;
      }
      let cost = Number(data.usage?.cost);
      if (!Number.isFinite(cost)) {
        const pr = (await prices())[data.model || model];
        cost = pr ? (data.usage?.prompt_tokens || 0) * pr.p + (data.usage?.completion_tokens || 0) * pr.c : 0;
      }
      track(model, true, cost || 0);
      if (cost > 0) charge(tid, cost, "IA", `${(data.model || model).split("/").pop()} · ${purpose || slot}`, agent);
      const msg = data.choices?.[0]?.message || { role: "assistant", content: "" };
      return { message: msg, model: data.model || model, cost: cost || 0 };
    } catch (e) {
      track(model, false); lastErr = e; cooldown.set(model, Date.now() + 60_000);
    }
  }
  throw lastErr || new Error("Aucun modèle disponible");
}

/** One-shot text completion (no tools). */
export async function complete(system, user, opts = {}) {
  const r = await chat([{ role: "system", content: system }, { role: "user", content: user }], undefined, opts);
  return { text: String(r.message.content || ""), model: r.model, cost: r.cost };
}

/** Vision: ask a question about one or more PNG/JPEG buffers. */
export async function look(images, question, opts = {}) {
  const content = [{ type: "text", text: question }, ...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/${b[0] === 0xff && b[1] === 0xd8 ? "jpeg" : "png"};base64,${b.toString("base64")}` } }))];
  const r = await chat([{ role: "user", content }], undefined, { slot: "vision", maxTokens: 2500, ...opts });
  return { text: String(r.message.content || ""), model: r.model, cost: r.cost };
}

/** Image generation through OpenRouter image models. Returns { images: [base64 png], text, model, cost }. */
export async function generateImage(prompt, { agent = null, model, aspect_ratio, images = [], purpose = "image" } = {}) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY manquante");
  const tid = agent ? treasuryOf(agent) : COMPANY;
  if (isDead(tid)) throw new Error("MORT: caisse vide");
  const m = model || getSetting("model.image", "google/gemini-3.1-flash-image");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "HTTP-Referer": CFG.site, "X-Title": "AlphaPulse HQ" },
    body: JSON.stringify({ model: m, messages: [{ role: "user", content: images.length ? [...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/${b[0] === 0xff ? "jpeg" : "png"};base64,${b.toString("base64")}` } })), { type: "text", text: String(prompt).slice(0, 8000) }] : String(prompt).slice(0, 8000) }], modalities: ["image", "text"], image_config: aspect_ratio ? { aspect_ratio } : undefined, max_tokens: 4096, usage: { include: true } }),
    signal: AbortSignal.timeout(240000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) { track(m, false); throw new Error(`${m}: ${data.error?.message || res.status}`); }
  let cost = Number(data.usage?.cost);
  if (!Number.isFinite(cost)) { const pr = (await prices())[m]; cost = pr ? (data.usage?.prompt_tokens || 0) * pr.p + (data.usage?.completion_tokens || 0) * pr.c : 0.04; }
  track(m, true, cost);
  if (cost > 0) charge(tid, cost, "IA", `${m.split("/").pop()} · ${purpose}`, agent);
  const msg = data.choices?.[0]?.message || {};
  const outImages = (msg.images || []).map((x) => String(x.image_url?.url || x.url || "").replace(/^data:[^,]+,/, "")).filter(Boolean);
  return { images: outImages, text: String(msg.content || ""), model: data.model || m, cost };
}
