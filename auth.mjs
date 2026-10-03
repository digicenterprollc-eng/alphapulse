// AlphaPulse HQ — biometric access (WebAuthn passkeys: Face ID / Touch ID / Windows Hello)
// Password is ONLY used to enroll a new device passkey, never to open the HQ.
import crypto from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { db, q, one, run } from "./db.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, public_key BLOB, counter INTEGER DEFAULT 0, transports TEXT,
  device TEXT, rp_id TEXT, created_at TEXT DEFAULT (datetime('now')), last_used TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT, expires INTEGER, ua TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT, descriptor TEXT, created_at TEXT DEFAULT (datetime('now'))
);
`);
const faceTokens = new Map(); // token -> exp
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5);
export const faceEnrolled = () => one("SELECT COUNT(*) n FROM faces").n > 0;
function validDescriptor(d) { return Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 2); }
function faceDistance(d) {
  let best = Infinity;
  for (const r of q("SELECT descriptor FROM faces")) {
    const e = JSON.parse(r.descriptor); let s = 0;
    for (let i = 0; i < 128; i++) { const k = e[i] - d[i]; s += k * k; }
    best = Math.min(best, Math.sqrt(s));
  }
  return best;
}
function issueFaceToken(kind = "face") { const t = newToken(); faceTokens.set(t, { exp: now() + 3 * 60000, kind }); for (const [k, v] of faceTokens) if (v.exp < now()) faceTokens.delete(k); return t; }
function takeFaceToken(t, needKind = null) { const e = faceTokens.get(t); faceTokens.delete(t); return !!e && e.exp > now() && (!needKind || e.kind === needKind); }

const PASS = process.env.DASHBOARD_PASSWORD || "";
const RP_NAME = "AlphaPulse HQ";
const USER_ID = new TextEncoder().encode("alphapulse-owner");
const challenges = new Map(); // token -> {challenge, exp}
const attempts = new Map();   // ip -> [timestamps]

const now = () => Date.now();
const newToken = () => crypto.randomBytes(32).toString("base64url");
function rpFrom(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0].toLowerCase();
  const proto = String(req.headers["x-forwarded-proto"] || (host === "localhost" ? "http" : "https"));
  const port = String(req.headers.host || "").split(":")[1];
  return { rpID: host, origin: `${proto}://${host}${port && host === "localhost" ? ":" + port : ""}` };
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}
function setCookie(res, name, val, maxAgeSec, secure) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`);
}
export function session(req) {
  const t = cookies(req).ap_sess; if (!t) return null;
  const s = one("SELECT * FROM sessions WHERE token=?", t);
  if (!s || s.expires < now()) return null;
  return s;
}
export const hasPasskeys = (rpID) => one("SELECT COUNT(*) n FROM passkeys WHERE rp_id=?", rpID).n > 0;

async function body(req) {
  return await new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 100000) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); });
}
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }); res.end(JSON.stringify(obj)); };
function startSession(req, res, kind, days) {
  const t = newToken();
  run("INSERT INTO sessions(token,kind,expires,ua) VALUES(?,?,?,?)", t, kind, now() + days * 86400000, String(req.headers["user-agent"] || "").slice(0, 200));
  run("DELETE FROM sessions WHERE expires < ?", now());
  const { origin } = rpFrom(req);
  setCookie(res, "ap_sess", t, days * 86400, origin.startsWith("https"));
}
function rateLimited(ip) {
  const list = (attempts.get(ip) || []).filter((t) => now() - t < 15 * 60000);
  attempts.set(ip, list);
  return list.length >= 5;
}
function newChallengeToken(challenge) {
  const k = newToken(); challenges.set(k, { challenge, exp: now() + 5 * 60000 });
  for (const [kk, v] of challenges) if (v.exp < now()) challenges.delete(kk);
  return k;
}
function takeChallenge(k) { const c = challenges.get(k); challenges.delete(k); return c && c.exp > now() ? c.challenge : null; }

export async function handleAuth(req, res, url) {
  const p = url.pathname;
  const { rpID, origin } = rpFrom(req);
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  if (p === "/auth/status") return json(res, 200, { enrolled: hasPasskeys(rpID), faceEnrolled: faceEnrolled(), session: session(req)?.kind || null });

  // Face check (camera) — first factor. Returns a short-lived token required by the passkey login.
  if (p === "/auth/face/verify" && req.method === "POST") {
    if (rateLimited(ip)) return json(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    const b = await body(req);
    if (!faceEnrolled()) return json(res, 409, { error: "Aucun visage enregistré." });
    if (!validDescriptor(b.descriptor) || !b.liveness?.turn || !b.liveness?.blink) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 400, { error: "Analyse incomplète." }); }
    const dist = faceDistance(b.descriptor);
    if (dist > FACE_THRESHOLD) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 401, { error: "Visage non reconnu.", d: Math.round(dist * 100) / 100 }); }
    return json(res, 200, { ok: true, faceToken: issueFaceToken(), d: Math.round(dist * 100) / 100 });
  }
  // Backup path when the camera fails: enrollment code + passkey (still two factors).
  if (p === "/auth/face/backup" && req.method === "POST") {
    if (rateLimited(ip)) return json(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    const b = await body(req);
    const ok = PASS && typeof b.password === "string" && b.password.length === PASS.length && crypto.timingSafeEqual(Buffer.from(b.password), Buffer.from(PASS));
    if (!ok) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 401, { error: "Code incorrect." }); }
    return json(res, 200, { ok: true, faceToken: issueFaceToken("backup") });
  }
  // Enroll / replace the owner's face (requires a full session).
  if (p === "/auth/face/enroll" && req.method === "POST") {
    const s = session(req); if (!s || s.kind !== "full") return json(res, 401, { error: "Connexion requise." });
    const b = await body(req);
    const ds = (Array.isArray(b.descriptors) ? b.descriptors : []).filter(validDescriptor).slice(0, 6);
    if (ds.length < 3) return json(res, 400, { error: "Il faut au moins 3 captures du visage." });
    if (b.replace) run("DELETE FROM faces");
    for (const d of ds) run("INSERT INTO faces(descriptor) VALUES(?)", JSON.stringify(d.map((x) => Math.round(x * 1e5) / 1e5)));
    return json(res, 200, { ok: true, count: one("SELECT COUNT(*) n FROM faces").n });
  }

  // password → enrollment-only session (cannot open the HQ)
  if (p === "/auth/enroll-password" && req.method === "POST") {
    if (rateLimited(ip)) return json(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    const b = await body(req);
    const ok = PASS && typeof b.password === "string" && b.password.length === PASS.length && crypto.timingSafeEqual(Buffer.from(b.password), Buffer.from(PASS));
    if (!ok) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 401, { error: "Code d'enrôlement incorrect." }); }
    // a new device needs the owner's face too (once a face is registered)
    if (faceEnrolled() && !takeFaceToken(b.faceToken, "face")) return json(res, 403, { error: "Analyse du visage requise pour ajouter un appareil." });
    startSession(req, res, "enroll", 1 / 96); // 15 minutes
    return json(res, 200, { ok: true });
  }

  if (p === "/auth/register/options" && req.method === "POST") {
    const s = session(req); if (!s) return json(res, 401, { error: "Enrôlement non autorisé." });
    const existing = q("SELECT id, transports FROM passkeys WHERE rp_id=?", rpID);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID, userID: USER_ID, userName: process.env.OWNER_NAME || "owner", userDisplayName: process.env.OWNER_NAME || "Owner",
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
    });
    return json(res, 200, { options, ck: newChallengeToken(options.challenge) });
  }
  if (p === "/auth/register/verify" && req.method === "POST") {
    const s = session(req); if (!s) return json(res, 401, { error: "Enrôlement non autorisé." });
    const b = await body(req); const expectedChallenge = takeChallenge(b.ck);
    if (!expectedChallenge) return json(res, 400, { error: "Challenge expiré." });
    try {
      const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!v.verified) return json(res, 400, { error: "Vérification échouée." });
      const c = v.registrationInfo.credential;
      run("INSERT OR REPLACE INTO passkeys(id,public_key,counter,transports,device,rp_id) VALUES(?,?,?,?,?,?)",
        c.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports || b.response?.response?.transports || []), String(b.device || "").slice(0, 80), rpID);
      run("DELETE FROM sessions WHERE token=?", s.token);
      startSession(req, res, "full", 30);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  if (p === "/auth/login/options" && req.method === "POST") {
    const creds = q("SELECT id, transports FROM passkeys WHERE rp_id=?", rpID);
    if (!creds.length) return json(res, 409, { error: "Aucun appareil enregistré." });
    const options = await generateAuthenticationOptions({
      rpID, userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    });
    return json(res, 200, { options, ck: newChallengeToken(options.challenge) });
  }
  if (p === "/auth/login/verify" && req.method === "POST") {
    if (rateLimited(ip)) return json(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    const b = await body(req);
    if (faceEnrolled() && !takeFaceToken(b.faceToken)) return json(res, 403, { error: "Analyse du visage requise avant l'empreinte." });
    const expectedChallenge = takeChallenge(b.ck);
    if (!expectedChallenge) return json(res, 400, { error: "Challenge expiré." });
    const cred = one("SELECT * FROM passkeys WHERE id=? AND rp_id=?", b.response?.id, rpID);
    if (!cred) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 401, { error: "Appareil inconnu." }); }
    try {
      const v = await verifyAuthenticationResponse({
        response: b.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
      });
      if (!v.verified) return json(res, 401, { error: "Identité non vérifiée." });
      run("UPDATE passkeys SET counter=?, last_used=datetime('now') WHERE id=?", v.authenticationInfo.newCounter, cred.id);
      startSession(req, res, "full", 30);
      return json(res, 200, { ok: true });
    } catch (e) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(now()); return json(res, 401, { error: String(e.message || e) }); }
  }
  if (p === "/auth/logout") {
    const s = session(req); if (s) run("DELETE FROM sessions WHERE token=?", s.token);
    setCookie(res, "ap_sess", "", 0, origin.startsWith("https"));
    res.writeHead(302, { Location: "/" }); return res.end();
  }
  return json(res, 404, { error: "not found" });
}
