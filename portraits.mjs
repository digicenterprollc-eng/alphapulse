// Photoreal identity for every agent: video-call portrait (+ talking and blink variants for the live call) and an office scene.
// Generated once per agent with an image model, paid by the agent's own caisse ("photo d'identité").
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { q, one, DATA, logEvent } from "./db.mjs";
import { generateImage } from "./llm.mjs";
import { getSetting, setSetting, agentDead } from "./treasury.mjs";

export const PORTRAITS = path.join(DATA, "portraits");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODEL = () => getSetting("model.portrait", "google/gemini-3-pro-image");
const VERSION = 1;

const PERSONA = {
  atlas: "man in his mid-forties, short salt-and-pepper hair, neatly trimmed beard, navy blazer over a white open-collar shirt, calm and confident",
  nova: "man around twenty-eight, short curly dark hair, thin black-framed glasses, black t-shirt under an open dark overshirt, focused and creative",
  lyra: "woman around thirty-two, shoulder-length dark brown hair, elegant beige blazer, subtle gold earrings, warm and sharp",
  orion: "man around thirty-five, short fade haircut, light stubble, charcoal knit polo, friendly and energetic",
};
const WORKSCREEN = { ceo: "dashboards with revenue charts", builder: "code editor and a website design", marketer: "social media analytics and content calendar", seller: "customer messages and a sales pipeline" };
function persona(a) {
  if (PERSONA[a.id]) return PERSONA[a.id];
  const h = [...a.id].reduce((x, c) => x + c.charCodeAt(0), 0);
  const who = ["woman around thirty, long straight black hair", "man around thirty, short brown hair and a short beard", "woman in her late twenties, curly auburn hair", "man in his early forties, shaved head", "woman around thirty-five, short platinum bob", "man in his late twenties, wavy black hair"][h % 6];
  const wear = ["dark turtleneck", "light blue oxford shirt", "olive bomber jacket", "cream knit sweater", "black blazer", "denim shirt"][(h >> 2) % 6];
  return `${who}, wearing a ${wear}`;
}

async function toJpg(pngB64, out, scale) {
  const tmp = out + ".png"; fs.writeFileSync(tmp, Buffer.from(pngB64, "base64"));
  let ff = "ffmpeg"; try { const f = path.join(HERE, "node_modules", "ffmpeg-static", "ffmpeg"); if (fs.existsSync(f)) ff = f; } catch {}
  await new Promise((res) => { const p = spawn(ff, ["-y", "-loglevel", "error", "-i", tmp, ...(scale ? ["-vf", `scale=${scale}:-2`] : []), "-q:v", "3", out]); p.on("close", res); p.on("error", res); });
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) fs.unlinkSync(tmp); else fs.renameSync(tmp, out);
}

export function portraitOf(id) { try { return JSON.parse(getSetting(`portrait.${id}`, "null")); } catch { return null; } }

let busy = false;
/** Generate the missing identity of ONE agent per call (cheap, incremental, retried later on failure). */
export async function ensurePortraits() {
  if (busy) return; busy = true;
  try {
    const agents = q("SELECT * FROM agents WHERE status != 'dead' ORDER BY CASE role WHEN 'ceo' THEN 0 ELSE 1 END, rowid");
    const a = agents.find((x) => { const p = portraitOf(x.id); const fail = Number(getSetting(`portrait.fail.${x.id}`, 0)); return (!p || p.v !== VERSION || !p.office) && Date.now() - fail > 10 * 60000; });
    if (!a || agentDead(a.id)) return;
    const dir = path.join(PORTRAITS, a.id); fs.mkdirSync(dir, { recursive: true });
    const cur = portraitOf(a.id) || { v: VERSION };
    const who = `${persona(a)}, the ${a.dept || a.role} of a modern tech company`;
    try {
      if (!cur.base) {
        const r = await generateImage(`Ultra-realistic photograph, a live video-call webcam frame of a ${who}. Head and shoulders, centered, face fully visible and sharp, looking straight into the camera with natural eye contact, relaxed neutral friendly expression, mouth closed. Soft natural window light, modern bright office softly blurred in the background, high-end webcam / 50mm lens look, realistic skin texture, natural colors, no retouching. No text, no logo, no watermark.`, { agent: a.id, model: MODEL(), aspect_ratio: "1:1", purpose: "portrait" });
        if (!r.images[0]) throw new Error("pas d'image");
        await toJpg(r.images[0], path.join(dir, "base.jpg"), 1024); cur.base = "base.jpg"; cur.persona = who;
        cur.t = Date.now(); setSetting(`portrait.${a.id}`, JSON.stringify(cur));
      }
      const base = fs.readFileSync(path.join(dir, cur.base));
      const edit = async (key, change) => {
        if (cur[key]) return;
        const r = await generateImage(`Edit this photo. Keep exactly the same person, face, pose, framing, lighting, clothes and background, perfectly aligned with the original. ${change} Change nothing else.`, { agent: a.id, model: MODEL(), images: [base], aspect_ratio: "1:1", purpose: `portrait ${key}` });
        if (!r.images[0]) throw new Error(`pas d'image (${key})`);
        await toJpg(r.images[0], path.join(dir, `${key}.jpg`), 1024); cur[key] = `${key}.jpg`;
        cur.t = Date.now(); setSetting(`portrait.${a.id}`, JSON.stringify(cur));
      };
      await edit("talk", "Only the mouth changes: open naturally mid-word as when saying 'ah', upper teeth slightly visible.");
      await edit("blink", "Only the eyes change: both eyes fully closed in a natural blink.");
      if (!cur.office) {
        const r = await generateImage(`Ultra-realistic photograph of this same person (same face, hair and clothes) at work in a premium modern office: sitting at a wooden desk, working on a laptop and a large monitor showing ${WORKSCREEN[a.role] || "their work"}, three-quarter view from a ceiling corner security camera slightly above, natural daylight through glass walls, plants, warm interior, realistic depth of field. No text, no logos, no watermark.`, { agent: a.id, model: MODEL(), images: [base], aspect_ratio: "16:9", purpose: "bureau" });
        if (!r.images[0]) throw new Error("pas d'image (bureau)");
        await toJpg(r.images[0], path.join(dir, "office.jpg"), 1600); cur.office = "office.jpg";
      }
      cur.v = VERSION; cur.t = Date.now(); setSetting(`portrait.${a.id}`, JSON.stringify(cur));
      logEvent(a.id, "action", "portrait", null, `Photo d'identité et bureau prêts pour ${a.name}`);
    } catch (e) {
      cur.t = Date.now(); setSetting(`portrait.${a.id}`, JSON.stringify(cur));
      setSetting(`portrait.fail.${a.id}`, Date.now());
      console.error("[portrait]", a.id, String(e.message).slice(0, 200));
    }
  } finally { busy = false; }
}
export function resetPortrait(id) { setSetting(`portrait.${id}`, "null"); setSetting(`portrait.fail.${id}`, 0); try { fs.rmSync(path.join(PORTRAITS, id), { recursive: true, force: true }); } catch {} }
export function portraitsMap() { const o = {}; for (const a of q("SELECT id FROM agents")) { const p = portraitOf(a.id); if (p) o[a.id] = p; } return o; }
