// Live phone-like calls with the agents (ElevenLabs Agents). One professional voice per agent.
// The call stays open until the owner hangs up or says goodbye. Cost per minute is charged to the caisse.
import crypto from "node:crypto";
import { db, q, one, run, logEvent } from "./db.mjs";
import { charge, treasuryOf, agentDead, getSetting, setSetting, COMPANY } from "./treasury.mjs";
import { complete } from "./llm.mjs";
import { buildVoiceContext } from "./voice.mjs";

const KEY = process.env.ELEVENLABS_API_KEY || "";
const API = "https://api.elevenlabs.io";
const PER_MIN = Number(process.env.VOICE_USD_PER_MIN || 0.08);
db.exec("CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT PRIMARY KEY, agent TEXT, lang TEXT, started INTEGER, ended INTEGER, seconds REAL)");

export const liveReady = () => KEY.length > 10;
async function el(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "xi-api-key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${t.slice(0, 300)}`);
  return d;
}

// Native voices per language: French (Paris) and Moroccan Arabic for Darija.
const PREF = {
  atlas: { g: "male", fr: ["Alexandre", "Félix", "Sebastian"], ar: ["Yassine", "Mehdi", "Houssam"] },
  nova: { g: "female", fr: ["Clara", "Charlotte", "Jeanne", "Léa"], ar: ["Layla", "Fatima", "Salma"] },
  lyra: { g: "female", fr: ["Claire", "Clara"], ar: ["Ghozlan", "Layla", "Fatima"] },
  orion: { g: "male", fr: ["Sebastian", "Félix", "Alexandre"], ar: ["Houssam", "Yassine", "Mehdi"] },
};
let VOICES = null;
export async function voiceFor(agentId, lang = "fr") {
  const key = `el.voice.${agentId}.${lang}`;
  const saved = getSetting(key); if (saved) return saved;
  VOICES ||= (await el("GET", "/v1/voices")).voices || [];
  const used = new Set(q("SELECT value FROM settings WHERE key LIKE ?", `el.voice.%.${lang}`).map((r) => r.value));
  const row = one("SELECT gender, name FROM agents WHERE id=?", agentId);
  const pref = PREF[agentId] || { g: row?.gender === "f" ? "female" : row?.gender === "m" ? "male" : (crypto.randomInt(2) ? "male" : "female"), fr: [], ar: [] };
  const first = (v) => String(v.name).split(/[\s-]/)[0];
  const speaks = (v) => (v.labels?.language === lang) || (v.verified_languages || []).some((x) => x.language === lang);
  const local = (v) => lang === "ar" ? /moroccan/i.test(v.labels?.accent || "") : /parisian|standard|french/i.test(v.labels?.accent || "") || v.labels?.language === "fr";
  const gender = (v) => String(v.labels?.gender || "").toLowerCase() === pref.g;
  const free = VOICES.filter((v) => !used.has(v.voice_id));
  // never give a woman a man's voice (or the reverse): gender first, then language, then reuse if the pool is exhausted
  // a voice that carries the agent's own first name (Leila → "Layla", Sami → "Sami"…) when the library has one
  const nm = String(row?.name || agentId).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const same = (x) => { const f = first(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return f === nm || f.replace(/y/g, "i") === nm.replace(/y/g, "i") || f.replace(/ei/g, "ay") === nm.replace(/ei/g, "ay"); };
  const v = free.find((x) => same(x) && gender(x)) || (pref[lang] || []).map((n) => free.find((x) => first(x) === n)).find(Boolean)
    || free.find((x) => speaks(x) && local(x) && gender(x)) || free.find((x) => speaks(x) && gender(x)) || free.find(gender)
    || VOICES.find((x) => speaks(x) && gender(x)) || VOICES.find(gender) || free.find(speaks) || free[0] || VOICES[0];
  if (!v) throw new Error("Aucune voix ElevenLabs disponible");
  setSetting(key, v.voice_id); setSetting(`el.voicename.${agentId}.${lang}`, v.name.split(" - ")[0]);
  return v.voice_id;
}
async function elAgentFor(a) {
  const id = getSetting(`el.agent.${a.id}`); if (id) return id;
  const voice = await voiceFor(a.id, "fr");
  const d = await el("POST", "/v1/convai/agents/create", {
    name: `AlphaPulse · ${a.name}`,
    conversation_config: {
      agent: { first_message: `Oui, c'est ${a.name}. Je t'écoute.`, language: "fr", prompt: { prompt: `Tu es ${a.name}, agent d'AlphaPulse.` } },
      tts: { voice_id: voice, model_id: "eleven_flash_v2_5" },
    },
  });
  setSetting(`el.agent.${a.id}`, d.agent_id);
  return d.agent_id;
}

export async function startLive(agentId, lang = "fr") {
  if (!liveReady()) throw new Error("ElevenLabs pas encore configuré");
  const a = one("SELECT * FROM agents WHERE id=?", agentId);
  if (!a) throw new Error("Agent inconnu");
  if (agentDead(agentId)) throw new Error("Cet agent est mort (caisse vide)");
  const elId = await elAgentFor(a);
  const ar = lang === "ar";
  const voiceId = await voiceFor(agentId, ar ? "ar" : "fr");
  const prompt = `${buildVoiceContext(agentId)}

Tu es au TÉLÉPHONE avec le propriétaire de l'entreprise. Conversation orale en direct.
- ${ar ? "Parle en darija marocaine naturelle (tu peux mélanger avec du français comme les Marocains)." : "Parle en français oral, naturel et chaleureux."}
- Phrases courtes. Jamais de listes, de markdown ou d'emoji. Une idée à la fois, puis laisse-le parler.
- Base-toi UNIQUEMENT sur ton journal et tes chiffres ci-dessus. Si tu n'as rien fait, dis-le honnêtement. N'invente jamais de ventes, de chiffres ou de résultats.
- S'il te donne une consigne, reformule-la en une phrase pour confirmer. Elle sera transmise à ton prochain shift.
- Tu peux parler de la caisse, des risques, de tes idées pour gagner de l'argent honnêtement.
- Quand il dit au revoir (bye, beslama, à plus, ciao), réponds par un au revoir très court.`;
  await el("PATCH", `/v1/convai/agents/${elId}`, {
    conversation_config: {
      agent: { prompt: { prompt }, first_message: ar ? `Ahlan, m3ak ${a.name}. Ana kansme3k.` : `Oui, c'est ${a.name}. Je t'écoute.`, language: ar ? "ar" : "fr" },
      tts: { model_id: "eleven_flash_v2_5", voice_id: voiceId },
    },
  });
  const s = await el("GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(elId)}`);
  const sid = crypto.randomUUID();
  run("INSERT INTO voice_sessions(id,agent,lang,started) VALUES(?,?,?,?)", sid, agentId, ar ? "ar" : "fr", Date.now());
  logEvent(agentId, "call", "voice", { lang }, `Appel du propriétaire`);
  return { sessionId: sid, signedUrl: s.signed_url, name: a.name };
}

export async function endLive(sessionId, { seconds, transcript } = {}) {
  const s = one("SELECT * FROM voice_sessions WHERE id=?", sessionId);
  if (!s || s.ended) return { ok: false };
  const maxSecs = (Date.now() - s.started) / 1000 + 5;
  const secs = Math.max(1, Math.min(Number(seconds) || maxSecs, maxSecs));
  run("UPDATE voice_sessions SET ended=?, seconds=? WHERE id=?", Date.now(), secs, sessionId);
  charge(COMPANY, (secs / 60) * PER_MIN, "voix", `Appel avec le propriétaire · ${Math.round(secs)} s`, s.agent, `voice:${sessionId}`);
  const lines = (Array.isArray(transcript) ? transcript : []).filter((m) => m && m.text).slice(-80);
  for (const m of lines) logEvent(s.agent, m.role === "user" ? "inbox" : "voice_reply", "voice", { from: m.role === "user" ? "owner" : s.agent, call: sessionId }, String(m.text).slice(0, 1200));
  logEvent(s.agent, "call", "voice", { seconds: Math.round(secs) }, `Fin d'appel (${Math.round(secs)} s)`);
  const said = lines.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  if (said.trim().length > 12) {
    try {
      const r = await complete(
        `Tu extrais les consignes données par le propriétaire à l'agent pendant un appel. Une consigne = une demande d'action concrète. Ignore les questions et la politesse. Réponds UNIQUEMENT en JSON: {"consignes":["..."]} (liste vide si aucune).`,
        lines.map((m) => `${m.role === "user" ? "Propriétaire" : "Agent"}: ${m.text}`).join("\n"),
        { agent: s.agent, slot: "voice", purpose: "consignes d'appel", maxTokens: 600 });
      const o = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
      for (const c of (o.consignes || []).slice(0, 6)) {
        run("INSERT INTO messages(from_agent,to_agent,text) VALUES('owner',?,?)", s.agent, `Consigne donnée au téléphone: ${String(c).slice(0, 600)}`);
        run("UPDATE agents SET next_shift=datetime('now') WHERE id=?", s.agent);
      }
    } catch (e) { console.error("[voice consignes]", e.message); }
  }
  return { ok: true, seconds: secs };
}

/** Calls whose browser never reported the end: charge them (capped) after 20 minutes. */
export function sweepLive() {
  for (const s of q("SELECT id, started FROM voice_sessions WHERE ended IS NULL AND started < ?", Date.now() - 20 * 60000)) {
    endLive(s.id, { seconds: Math.min(900, (Date.now() - s.started) / 1000) }).catch(() => {});
  }
}

/** Assign each living agent its French + Darija voice at boot (no ElevenLabs agent is created here). */
export async function ensureVoices() {
  if (!liveReady()) return;
  try { for (const a of q("SELECT id FROM agents WHERE status != 'dead'")) for (const l of ["fr", "ar"]) await voiceFor(a.id, l); }
  catch (e) { console.error("[voices]", e.message); }
}
export function voiceStatus() {
  const voices = {};
  for (const r of q("SELECT key, value FROM settings WHERE key LIKE 'el.voicename.%.%'")) { const [, , id, lang] = r.key.split("."); (voices[id] ||= {})[lang] = r.value; }
  return { live: liveReady(), perMin: PER_MIN, voices };
}

/** Speech-to-text for "call by name": short audio clip → text (ElevenLabs Scribe). */
export async function transcribeClip(buf, mime = "audio/webm") {
  if (!liveReady()) throw new Error("ElevenLabs pas encore configuré");
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  const ext = /mp4|m4a|aac/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
  fd.append("file", new Blob([buf], { type: mime.split(";")[0] }), `clip.${ext}`);
  const r = await fetch(API + "/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": KEY }, body: fd, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`STT ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  charge("company", 0.004, "voix", "Reconnaissance du nom (STT)", null);
  return String(d.text || "");
}
