// EXEMPLE DE RÉFÉRENCE — studio vidéo motion design avec voix off (offert par le propriétaire comme point de départ).
// Utilisation: create_tool(name="video_studio", code=<ce fichier>, args={...}) puis améliore-le (styles, musique, formats, sous-titres incrustés…).
// Pipeline: script (IA) → voix off par scène (ElevenLabs via ap.tts) → composition HTML/GSAP (IA) → rendu image par image (Playwright)
//           → H.264 + audio (ffmpeg) → affiche + sous-titres .srt → revue visuelle (ap.vision).
// args: { slug, brief, format: "16:9"|"9:16"|"1:1", lang: "fr"|"ar"|"en", voice: "lyra"|..., name, music: "1"|"0", fps: "30", out_dir }
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const FORMATS = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] };
const KIT = path.join(process.env.AP_APP || "/app", "kit"), BRAND = path.join(process.env.AP_APP || "/app", "public", "brand");
const ICONS = (() => { try { return JSON.parse(fs.readFileSync(path.join(KIT, "icon-names.json"), "utf8")); } catch { return []; } })();
const FF = process.env.FFMPEG_PATH || "ffmpeg";
const slugify = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const noEmoji = (s) => String(s).replace(/(?:[\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic})(?:️|‍|\p{Extended_Pictographic})*/gu, "");

function ff(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FF, ["-hide_banner", "-y", ...args], { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("error", reject); p.on("close", (c) => (c === 0 ? resolve(err) : reject(new Error(`ffmpeg ${c}: ${err.slice(-500)}`))));
    if (input) input(p.stdin).catch((e) => { p.stdin.destroy(); reject(e); });
  });
}
async function seconds(file) {
  const e = await new Promise((r) => { const p = spawn(FF, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] }); let s = ""; p.stderr.on("data", (d) => (s += d)); p.on("close", () => r(s)); });
  const m = e.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}
async function route(page, dir) {
  await page.route("http://preview.local/**", (r) => {
    const p = decodeURIComponent(new URL(r.request().url()).pathname);
    const f = p.startsWith("/_kit/") ? path.join(KIT, p.slice(6)) : p.startsWith("/_brand/") ? path.join(BRAND, p.slice(8)) : path.join(dir, p);
    return fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({ path: f }) : r.fulfill({ status: 404, body: "" });
  });
}
// counts leaf elements really visible on the canvas (opacity of all ancestors > 0.15)
const VISIBLE = () => { let n = 0; for (const e of document.querySelectorAll("body *")) { if (e.childElementCount && e.tagName !== "svg") continue; const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue; let o = 1; for (let p = e; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.visibility === "hidden" || cs.display === "none") { o = 0; break; } o *= parseFloat(cs.opacity); } if (o > 0.15 && (e.textContent.trim() || /^(svg|img|canvas)$/i.test(e.tagName))) n++; } return n; };
const json = (t) => { try { return JSON.parse((String(t).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { return {}; } };

const SCRIPT_SYS = `Tu es un scénariste de vidéos produit (style Apple, Stripe, Linear) et un expert en conversion. Tu écris le script d'une vidéo de présentation en motion design avec voix off.
Règles: honnête (aucune fausse promesse, aucun faux chiffre, aucun faux avis), concret, rythmé, phrases courtes faites pour l'oral, ZÉRO emoji.
Structure: accroche (problème ou désir) → produit → 2 à 4 bénéfices concrets → comment ça marche / ce qu'on reçoit → offre et appel à l'action.
Réponds UNIQUEMENT en JSON: {"title":"...", "scenes":[{"voiceover":"phrase(s) dites", "onscreen":"texte court à l'écran (3 à 8 mots)", "visual":"idée visuelle précise", "icon":"nom d'icône Lucide"}]}`;
const VIDEO_SYS = (W, H) => `You are a senior motion designer (Apple keynote product films, Stripe / Linear launch videos, Buck, ManvsMachine). You create a motion-graphics video as ONE self-contained HTML page that is rendered frame by frame into an MP4.

TECH CONTRACT (follow exactly, or the render fails):
- Canvas exactly ${W}x${H}px: html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:<your bg>}. One root <div id="stage"> positioned relative, ${W}x${H}.
- At the END of <body>, in this order: <script src="/_kit/vendor/gsap.min.js"></script><script src="/_kit/vendor/SplitText.min.js"></script> then your inline <script>.
- Your script: gsap.registerPlugin(SplitText); build ONE paused master timeline: const tl = gsap.timeline({ paused: true, defaults: { ease: "expo.out" } }); put EVERY animation in tl at absolute times (tl.from(x, {...}, 1.25)); end with window.__VIDEO = { duration: TOTAL, tl };
- VISIBILITY (critical): never hide elements with CSS (no opacity:0, visibility:hidden or display:none in your stylesheet for animated elements) and never rely on tl.from() toward a hidden CSS state: from() animates TO the CSS value, so the element would stay invisible. Use tl.fromTo(el, {fromVars}, {toVars}, time) for every entrance and exit, and tl.set(el, {autoAlpha:0}, 0) for elements that appear later.
- FORBIDDEN: CSS @keyframes/animation/transition, setTimeout, setInterval, requestAnimationFrame, Date.now, Math.random, video/audio tags, external images. The page is seeked to each frame time, so only tl may move things. Looping motion = tweens with repeat inside tl (finite repeat count).
- ZERO emoji, no unicode pictograms. Icons only via <svg class="k-ic"><use href="/_kit/icons.svg#NAME"/></svg> (stroke = currentColor; size via width/height). Allowed icon names: ${ICONS.join(" ")}
- Allowed: Google Fonts <link>, inline SVG, CSS gradients, clip-path, filters (blur/glow), 3D transforms, the brand logo <img src="/_brand/logo-light.webp"> (white text, dark backgrounds) or /_brand/icon-256.png.

ART DIRECTION
- Premium, cinematic, modern. Kinetic typography (SplitText chars/words/lines with masks, staggered), layered depth and parallax between layers, bold scene transitions (mask wipes, zoom-throughs, shape morph covers, light sweeps), UI mockups of the product built in HTML/CSS (cards, dashboards, checklists, pages) that animate, icon reveals in glowing tiles, gradient glows, subtle grid/noise backgrounds, camera-like slow push-ins (scale 1 → 1.06 over a scene).
- Every scene must keep moving (no frozen frames): enter → small continuous drift → exit transition.
- Readability: headline 88–150px (${W < H ? "vertical video: keep text within the central 80% width" : "landscape"}), supporting text ≥ 40px, safe margins 7%. Max 8 words on screen at once. High contrast.
- Brand colours and fonts are given in the brief. Final scene: logo + call to action + URL, held 1.5 s.
- Code size ≤ 40 KB. Output ONLY:
=== FILE: video.html ===
...
=== END FILE ===`;
function parseHtml(text) {
  const m = text.match(/=== FILE: video\.html ===\n([\s\S]*?)(?:\n=== END FILE ===|$)/);
  let h = m ? m[1] : (text.match(/<!doctype html[\s\S]*<\/html>/i) || [""])[0];
  h = h.replace(/```\w*\n?/g, "").trim();
  return /<\/html>\s*$/i.test(h) ? noEmoji(h) : "";
}

export default async function (args, ap) {
  const s = slugify(args.slug); if (!s) return "slug requis";
  const fmt = FORMATS[args.format] ? args.format : "16:9", [W, H] = FORMATS[fmt];
  const FPS = Math.max(24, Math.min(60, Number(args.fps) || 30));
  const name = slugify(args.name || `presentation-${fmt.replace(":", "x")}`);
  const lang = ["fr", "ar", "en", "es"].includes(args.lang) ? args.lang : "fr";
  const work = path.join(ap.WORK, "videos", `${s}-${name}`); fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  // 1) script
  const sc = await ap.llm([{ role: "system", content: SCRIPT_SYS }, { role: "user", content: `Langue: ${lang}. Durée 30 à 50 s (90 à 130 mots), 5 à 7 scènes.\nIcônes: ${ICONS.join(" ")}\n\nBRIEF:\n${args.brief}` }], { slot: "builder", max_tokens: 2500, temperature: 0.6 });
  const scenes = (json(sc.text).scenes || []).filter((x) => x && x.voiceover).slice(0, 9).map((x) => ({ ...x, voiceover: noEmoji(x.voiceover).trim(), onscreen: noEmoji(x.onscreen || "").trim(), icon: ICONS.includes(x.icon) ? x.icon : "sparkles" }));
  if (scenes.length < 3) return "Script invalide: " + sc.text.slice(0, 300);
  // 2) voice-over per scene (exact timing)
  let t = 0.5;
  for (let i = 0; i < scenes.length; i++) {
    const f = path.join(work, `vo-${i}.mp3`);
    fs.writeFileSync(f, await ap.tts(scenes[i].voiceover, { voice: args.voice || "lyra", lang }));
    const d = await seconds(f); Object.assign(scenes[i], { file: f, start: +t.toFixed(2), dur: +d.toFixed(2) }); t += d + 0.45;
  }
  const total = +(t + 1.6).toFixed(2);
  const timing = scenes.map((x, i) => ({ n: i + 1, start: i ? +(x.start - 0.2).toFixed(2) : 0, end: i < scenes.length - 1 ? +(scenes[i + 1].start - 0.2).toFixed(2) : total, ...x }));
  // 3) composition (retry with the error if it is broken or blank)
  const user = `VIDEO ${fmt} ${W}x${H}, TOTAL = ${total} s.\nBRAND/STYLE: ${args.style || "premium palette that fits the product"}\nSCENES:\n${timing.map((x) => `${x.n}. ${x.start}s → ${x.end}s | on screen: "${x.onscreen}" | icon: ${x.icon} | visual: ${x.visual} | voice: "${x.voiceover}"`).join("\n")}\nCTA URL: ${(ap.PUBLIC_BASE || "").replace(/^https?:\/\//, "")}/${s}\n\nBRIEF:\n${args.brief}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    let html = "", err = "";
    for (let k = 0; k < 3 && !html; k++) {
      const r = await ap.llm([{ role: "system", content: VIDEO_SYS(W, H) }, { role: "user", content: user + (err ? `\n\nPREVIOUS ATTEMPT FAILED: ${err}` : "") }], { slot: "builder", max_tokens: 24000, temperature: 0.7 });
      html = parseHtml(r.text); if (!html) { err = "missing or truncated HTML"; continue; }
      fs.writeFileSync(path.join(work, "video.html"), html);
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      try {
        const errs = []; page.on("pageerror", (e) => errs.push(e.message)); await route(page, work);
        await page.goto("http://preview.local/video.html", { waitUntil: "load" }); await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; return true; });
        if (!(await page.evaluate(() => !!(window.__VIDEO && window.__VIDEO.tl))) || errs.length) throw new Error(errs[0] || "window.__VIDEO.tl missing");
        let blank = 0; for (const x of [timing[0], timing[1], timing[timing.length - 1]]) { await page.evaluate((v) => { window.__VIDEO.tl.seek(v, false); return 0; }, (x.start + x.end) / 2); const shown = await page.evaluate(VISIBLE); const kb = (await page.screenshot({ type: "jpeg", quality: 80 })).length; if (!shown || kb < (W * H) / 400) blank++; }
        if (blank >= 2) throw new Error("frames are EMPTY: content hidden by CSS + from(); use fromTo with visible end states");
      } catch (e) { err = String(e.message).slice(0, 300); html = ""; } finally { await page.close(); }
    }
    if (!html) return "Composition ratée: " + err;
    // 4) deterministic render: seek each frame, screenshot, pipe to ffmpeg (resumes if Chromium crashes)
    const silent = path.join(work, "silent.mp4"), frames = Math.ceil(total * FPS);
    await ff(["-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", silent], async (stdin) => {
      let i = 0, tries = 0;
      while (i < frames && tries < 4) {
        const page = await browser.newPage({ viewport: { width: W, height: H } });
        try {
          await route(page, work); await page.goto("http://preview.local/video.html", { waitUntil: "load" });
          await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
          await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; return true; });
          for (; i < frames; i++) {
            await page.evaluate((v) => { window.__VIDEO.tl.seek(v, false); return 0; }, i / FPS);
            const b = await page.screenshot({ type: "jpeg", quality: 92 });
            if (!stdin.write(b)) await new Promise((r) => stdin.once("drain", r));
          }
        } catch (e) { tries++; } finally { await page.close().catch(() => {}); }
      }
      stdin.end();
    });
    // 5) audio: voice lines at exact times + optional ambient bed, loudness normalised
    const a = []; scenes.forEach((x) => a.push("-i", x.file));
    const fil = scenes.map((x, i) => `[${i}:a]adelay=${Math.round(x.start * 1000)}|${Math.round(x.start * 1000)},aformat=channel_layouts=stereo[v${i}]`);
    let mix = `${scenes.map((_, i) => `[v${i}]`).join("")}amix=inputs=${scenes.length}:normalize=0[voice]`;
    if (args.music !== "0") {
      a.push("-f", "lavfi", "-t", String(total), "-i", "aevalsrc='0.05*(sin(2*PI*110*t)+0.8*sin(2*PI*164.81*t)+0.6*sin(2*PI*220*t)+0.5*sin(2*PI*277.18*t))*(0.6+0.4*sin(2*PI*t/8))':s=44100:c=stereo");
      fil.push(`[${scenes.length}:a]lowpass=f=900,aecho=0.8:0.7:120|240:0.25|0.18,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2)}:d=2,volume=0.55[bed]`);
      mix += ";[voice][bed]amix=inputs=2:normalize=0[mix]";
    } else mix += ";[voice]anull[mix]";
    const audio = path.join(work, "audio.m4a");
    await ff([...a, "-filter_complex", `${fil.join(";")};${mix};[mix]apad,atrim=0:${total},loudnorm=I=-16:TP=-1.5:LRA=11[out]`, "-map", "[out]", "-c:a", "aac", "-b:a", "160k", audio]);
    const outDir = path.join(ap.WORK, args.out_dir || path.join("sites", s, "media")); fs.mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, `${name}.mp4`), jpg = path.join(outDir, `${name}.jpg`);
    await ff(["-i", silent, "-i", audio, "-c", "copy", "-shortest", "-movflags", "+faststart", mp4]);
    await ff(["-ss", String(Math.max(0.5, timing[1].start - 0.3)), "-i", silent, "-frames:v", "1", "-q:v", "3", jpg]);
    const tc = (v) => new Date(v * 1000).toISOString().slice(11, 23).replace(".", ",");
    fs.writeFileSync(mp4.replace(/\.mp4$/, ".srt"), scenes.map((x, i) => `${i + 1}\n${tc(x.start)} --> ${tc(x.start + x.dur)}\n${x.voiceover}\n`).join("\n"));
    // 6) review
    const shots = []; for (let k = 1; k <= 6; k++) { const f = path.join(work, `r${k}.jpg`); await ff(["-ss", String((total * k) / 7), "-i", silent, "-frames:v", "1", "-vf", `scale=${W / 2}:-2`, f]); shots.push(fs.readFileSync(f)); }
    const v = await ap.vision(shots, `6 images d'une vidéo motion design (${fmt}), dans l'ordre. Note /10 (8 = premium) et liste les défauts. JSON: {"score":n,"verdict":"","issues":[]}`).catch(() => ({ text: "{}" }));
    const o = json(v.text);
    await ap.log(`Vidéo ${fmt} créée: ${path.relative(ap.WORK, mp4)} (${Math.round(total)} s, ${o.score ?? "?"}/10)`);
    return { video: path.relative(ap.WORK, mp4), poster: path.relative(ap.WORK, jpg), seconds: total, score: o.score, verdict: o.verdict, issues: o.issues };
  } finally { await browser.close(); }
}
