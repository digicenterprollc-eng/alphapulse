// Sales & marketing channels: agent mailboxes (Hostinger IMAP/SMTP), Telegram, Instagram, Reddit.
// Each channel activates only when its keys exist. Hard limits keep agents away from spam.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, q, one, run, SITES, logEvent } from "./db.mjs";
import { PUBLIC_BASE } from "./pay.mjs";
import { getSetting, setSetting } from "./treasury.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, dir TEXT, peer TEXT, subject TEXT, body TEXT, uid TEXT, ts TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS suppress (email TEXT PRIMARY KEY, ts TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, channel TEXT, ref TEXT, text TEXT, url TEXT, ts TEXT DEFAULT (datetime('now')));
`);
const E = process.env;
const DOMAIN = E.MAIL_DOMAIN || "example.com";
// anti-spam ceilings only (the team decides everything else)
const LIMITS = { email_agent: 60, email_total: 250, telegram: 30, instagram: 10, reddit: 3 };
const countToday = (sql, ...p) => one(sql + " AND ts >= datetime('now','start of day')", ...p).n;

/* ---------------- email ---------------- */
export const mailboxOf = (agent) => {
  const id = String(agent).toLowerCase();
  const pass = E[`EMAIL_${id.toUpperCase()}_PASSWORD`];
  return pass ? { user: `${id}@${DOMAIN}`, pass } : null;
};
export const contactBox = () => (E.EMAIL_CONTACT_PASSWORD ? { user: `contact@${DOMAIN}`, pass: E.EMAIL_CONTACT_PASSWORD } : null);
export const emailReady = (agent) => !!mailboxOf(agent);

async function smtp(box) {
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({ host: E.SMTP_HOST || "smtp.hostinger.com", port: Number(E.SMTP_PORT || 465), secure: true, auth: { user: box.user, pass: box.pass } });
}
export async function sendMail(box, { to, subject, text, html, from_name }, { agent = null, footer = true } = {}) {
  const t = await smtp(box);
  const body = String(text || "") + (footer ? `\n\n—\n${from_name || "AlphaPulse"} · ${box.user}\nPour ne plus recevoir nos emails, répondez simplement « STOP ».` : "");
  const info = await t.sendMail({ from: `"${from_name || "AlphaPulse"}" <${box.user}>`, to, subject, text: body, html });
  run("INSERT INTO emails(agent,dir,peer,subject,body,uid) VALUES(?,?,?,?,?,?)", agent || box.user, "out", to, subject, body.slice(0, 4000), info.messageId || "");
  return info.messageId;
}
export async function agentSendEmail(agent, { to, subject, text }) {
  const box = mailboxOf(agent.id); if (!box) return "Ta boîte email n'est pas encore activée (mot de passe manquant).";
  const addr = String(to || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(addr)) return "Adresse invalide.";
  if (one("SELECT email FROM suppress WHERE email=?", addr)) return "Cette personne a demandé à ne plus recevoir d'emails (STOP). Interdit.";
  if (countToday("SELECT COUNT(*) n FROM emails WHERE dir='out' AND agent=?", agent.id) >= LIMITS.email_agent) return `Limite atteinte: ${LIMITS.email_agent} emails/jour pour toi.`;
  if (countToday("SELECT COUNT(*) n FROM emails WHERE dir='out'") >= LIMITS.email_total) return "Limite d'équipe atteinte pour aujourd'hui.";
  if (one("SELECT COUNT(*) n FROM emails WHERE dir='out' AND peer=? AND ts >= datetime('now','-7 days')", addr).n >= 2 && !one("SELECT id FROM emails WHERE dir='in' AND peer=? LIMIT 1", addr)) return "Déjà 2 emails sans réponse à cette adresse cette semaine: pas de relance supplémentaire.";
  const id = await sendMail(box, { to: addr, subject, text, from_name: `${agent.name} · AlphaPulse` }, { agent: agent.id });
  return `Email envoyé à ${addr} (${id}).`;
}
export async function agentInbox(agent, { limit = 10 } = {}) {
  const box = mailboxOf(agent.id); if (!box) return "Ta boîte email n'est pas encore activée.";
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({ host: E.IMAP_HOST || "imap.hostinger.com", port: Number(E.IMAP_PORT || 993), secure: true, auth: { user: box.user, pass: box.pass }, logger: false });
  await c.connect(); const out = [];
  try {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const uids = (await c.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(-Math.min(20, limit))) {
        const msg = await c.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase() || "";
        const raw = msg.source?.toString("utf8") || "";
        const bodyTxt = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/=\r?\n/g, "").replace(/<[^>]+>/g, " ").slice(0, 2500);
        if (/^\s*stop\b/i.test(bodyTxt) || /\bstop\b/i.test(msg.envelope?.subject || "")) run("INSERT OR IGNORE INTO suppress(email) VALUES(?)", from);
        run("INSERT INTO emails(agent,dir,peer,subject,body,uid) VALUES(?,?,?,?,?,?)", agent.id, "in", from, msg.envelope?.subject || "", bodyTxt, String(uid));
        out.push({ uid, de: from, sujet: msg.envelope?.subject, date: msg.envelope?.date, extrait: bodyTxt.slice(0, 600) });
        await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      }
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
  return out.length ? JSON.stringify(out, null, 1) : "Aucun nouvel email.";
}
/** Automatic delivery email after payment (from contact@). */
export async function sendDeliveryEmail(sale, product) {
  const box = contactBox(); if (!box || !sale.customer_email) return false;
  if (one("SELECT id FROM emails WHERE dir='out' AND uid=?", `delivery:${sale.id}`)) return false;
  await sendMail(box, {
    to: sale.customer_email, subject: `Votre commande : ${product.name}`,
    text: `Bonjour,\n\nMerci pour votre achat de « ${product.name} ».\n\nVotre produit est disponible ici :\n${PUBLIC_BASE}/order/${sale.id}\n\n${product.delivery || ""}\n\nUne question ? Répondez à cet email.\n\nL'équipe AlphaPulse`,
    from_name: "AlphaPulse",
  }, { agent: "orion", footer: false });
  run("UPDATE emails SET uid=? WHERE id=(SELECT MAX(id) FROM emails)", `delivery:${sale.id}`);
  return true;
}

/* ---------------- telegram ---------------- */
const TG = E.TELEGRAM_BOT_TOKEN, TG_CH = E.TELEGRAM_CHANNEL;
let tgChannelOk = null;
export const telegramReady = () => !!(TG && TG_CH) && tgChannelOk !== false;
export async function probeTelegram() { if (!TG || !TG_CH) return; try { const c = await tg("getChat", { chat_id: TG_CH }); tgChannelOk = c.type === "channel"; } catch { tgChannelOk = false; } }
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json(); if (!d.ok) throw new Error(`Telegram: ${d.description}`); return d.result;
}
export async function telegramPost(agent, { text, image_url, button_text, button_url }) {
  if (!telegramReady()) return "Telegram pas encore configuré.";
  if (countToday("SELECT COUNT(*) n FROM posts WHERE channel='telegram'") >= LIMITS.telegram) return `Limite: ${LIMITS.telegram} posts Telegram/jour.`;
  const markup = button_url ? { inline_keyboard: [[{ text: button_text || "Voir l'offre", url: button_url }]] } : undefined;
  const r = image_url ? await tg("sendPhoto", { chat_id: TG_CH, photo: image_url, caption: String(text).slice(0, 1000), reply_markup: markup })
    : await tg("sendMessage", { chat_id: TG_CH, text: String(text).slice(0, 4000), reply_markup: markup, disable_web_page_preview: false });
  const url = String(TG_CH).startsWith("@") ? `https://t.me/${TG_CH.slice(1)}/${r.message_id}` : "";
  run("INSERT INTO posts(agent,channel,ref,text,url) VALUES(?,?,?,?,?)", agent.id, "telegram", String(r.message_id), String(text).slice(0, 1000), url);
  return `Publié sur Telegram ${url}`;
}
/* Telegram bridge: one central poller. The owner talks to any agent through the bot; customers land in a queue for Sofia. */
db.exec("CREATE TABLE IF NOT EXISTS tg_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, from_name TEXT, username TEXT, text TEXT, owner INTEGER DEFAULT 0, handled INTEGER DEFAULT 0, ts TEXT DEFAULT (datetime('now')))");
export const ownerCode = () => crypto.createHash("sha256").update("alphapulse-owner:" + (E.DASHBOARD_PASSWORD || "")).digest("hex").slice(0, 8).toUpperCase();
export const ownerChat = () => getSetting("telegram.owner", "");
export const telegramDM = (chat_id, text) => tg("sendMessage", { chat_id, text: String(text).slice(0, 4000), disable_web_page_preview: true });
let polling = false;
export async function pollTelegram(onOwner) {
  if (!TG || polling) return; polling = true;
  try {
    let offset = Number(getSetting("telegram.offset", 0));
    const ups = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
    for (const u of ups) {
      offset = u.update_id + 1; setSetting("telegram.offset", offset);
      const m = u.message; if (!m?.text || m.chat?.type !== "private") continue;
      const txt = m.text.trim(), chat = String(m.chat.id), who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || "client";
      const link = txt.match(/^\/(?:lier|link)\s+([A-Za-z0-9]+)/i);
      if (link) {
        if (link[1].toUpperCase() === ownerCode() && (!ownerChat() || ownerChat() === chat)) { setSetting("telegram.owner", chat); await telegramDM(chat, "Compte lié. Tu es reconnu comme le propriétaire. Écris le nom d'un agent au début du message pour lui parler (ex: Nova, où en est le site ?). Sans nom, le message va à Atlas. /equipe pour la liste, /statut pour la caisse."); }
        else await telegramDM(chat, "Code invalide.");
        continue;
      }
      if (ownerChat() && chat === ownerChat()) {
        run("INSERT INTO tg_inbox(chat_id,from_name,username,text,owner,handled) VALUES(?,?,?,?,1,1)", chat, who, m.from?.username || "", txt.slice(0, 4000));
        try { await onOwner(chat, txt); } catch (e) { await telegramDM(chat, "Erreur: " + String(e.message).slice(0, 200)).catch(() => {}); }
      } else run("INSERT INTO tg_inbox(chat_id,from_name,username,text) VALUES(?,?,?,?)", chat, who, m.from?.username || "", txt.slice(0, 4000));
    }
  } catch (e) { if (!/409|Conflict/.test(String(e.message))) console.error("[telegram]", String(e.message).slice(0, 160)); }
  finally { polling = false; }
}
export async function telegramInbox() {
  if (!TG) return "Telegram pas encore configuré.";
  const rows = q("SELECT id, chat_id, from_name, username, text, ts FROM tg_inbox WHERE owner=0 AND handled=0 ORDER BY id LIMIT 30");
  for (const r of rows) run("UPDATE tg_inbox SET handled=1 WHERE id=?", r.id);
  return rows.length ? JSON.stringify(rows.map((r) => ({ chat_id: r.chat_id, de: r.username ? "@" + r.username : r.from_name, texte: r.text, recu: r.ts })), null, 1) : "Aucun nouveau message client sur Telegram.";
}
export async function telegramReply(agent, { chat_id, text }) {
  if (!TG) return "Telegram pas encore configuré.";
  if (ownerChat() && String(chat_id) === ownerChat()) return messageOwner(agent, { text });
  await tg("sendMessage", { chat_id, text: String(text).slice(0, 3500) });
  run("INSERT INTO posts(agent,channel,ref,text) VALUES(?,?,?,?)", agent.id, "telegram-dm", String(chat_id), String(text).slice(0, 1000));
  return "Réponse envoyée.";
}
/** An agent writes to le propriétaire (Telegram when linked, always visible in the HQ). */
export async function messageOwner(agent, { text }) {
  const t = String(text || "").trim(); if (!t) return "Message vide.";
  if (countToday("SELECT COUNT(*) n FROM messages WHERE to_agent='owner'") >= 60) return "Déjà beaucoup de messages au propriétaire aujourd'hui: regroupe l'essentiel dans un seul message plus tard.";
  run("INSERT INTO messages(from_agent,to_agent,text,read) VALUES(?,?,?,1)", agent.id, "owner", t.slice(0, 3000));
  logEvent(agent.id, "voice_reply", "message_owner", { to: "owner" }, t.slice(0, 1200));
  if (TG && ownerChat()) { await telegramDM(ownerChat(), `${agent.name} · ${agent.dept || agent.role}\n\n${t}`); return "Message envoyé au propriétaire sur Telegram."; }
  return "Message déposé dans le HQ (le propriétaire n'a pas encore lié son Telegram).";
}

/* ---------------- instagram (official Graph API) ---------------- */
const IG_ID = E.INSTAGRAM_USER_ID, IG_TOKEN = E.INSTAGRAM_ACCESS_TOKEN;
export const instagramReady = () => !!(IG_ID && IG_TOKEN);
const igHost = () => (String(IG_TOKEN).startsWith("EA") ? "https://graph.facebook.com/v23.0" : "https://graph.instagram.com/v23.0");
export async function instagramPost(agent, { caption, image_url, image_html }, renderHtml) {
  if (!instagramReady()) return "Instagram pas encore configuré.";
  if (countToday("SELECT COUNT(*) n FROM posts WHERE channel='instagram'") >= LIMITS.instagram) return `Limite: ${LIMITS.instagram} posts Instagram/jour.`;
  let url = image_url;
  if (!url && image_html) {
    const png = await renderHtml(image_html, { width: 1080, height: 1350 });
    const name = `ig-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.png`;
    fs.mkdirSync(path.join(SITES, "_media"), { recursive: true });
    fs.writeFileSync(path.join(SITES, "_media", name), png);
    url = `${PUBLIC_BASE}/_media/${name}`;
  }
  if (!url) return "Il faut image_url ou image_html (visuel 1080x1350).";
  const c = await fetch(`${igHost()}/${IG_ID}/media`, { method: "POST", body: new URLSearchParams({ image_url: url, caption: String(caption).slice(0, 2100), access_token: IG_TOKEN }) }).then((r) => r.json());
  if (!c.id) return `Instagram a refusé le média: ${JSON.stringify(c.error || c).slice(0, 300)}`;
  await new Promise((r) => setTimeout(r, 4000));
  const p = await fetch(`${igHost()}/${IG_ID}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: IG_TOKEN }) }).then((r) => r.json());
  if (!p.id) return `Publication refusée: ${JSON.stringify(p.error || p).slice(0, 300)}`;
  run("INSERT INTO posts(agent,channel,ref,text,url) VALUES(?,?,?,?,?)", agent.id, "instagram", p.id, String(caption).slice(0, 1000), url);
  return `Publié sur Instagram (id ${p.id}).`;
}

/* ---------------- reddit (official API, very limited) ---------------- */
const RD = { u: E.REDDIT_USERNAME, p: E.REDDIT_PASSWORD, id: E.REDDIT_CLIENT_ID, s: E.REDDIT_CLIENT_SECRET };
export const redditReady = () => !!(RD.u && RD.p && RD.id && RD.s);
export async function redditPost(agent, { subreddit, title, text, url }) {
  if (!redditReady()) return "Reddit pas encore configuré.";
  if (countToday("SELECT COUNT(*) n FROM posts WHERE channel='reddit'") >= LIMITS.reddit) return "Limite: 1 post Reddit/jour.";
  const tok = await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${RD.id}:${RD.s}`).toString("base64"), "User-Agent": "AlphaPulse/1.0" }, body: new URLSearchParams({ grant_type: "password", username: RD.u, password: RD.p }) }).then((r) => r.json());
  if (!tok.access_token) return "Connexion Reddit refusée.";
  const body = new URLSearchParams({ sr: String(subreddit).replace(/^r\//, ""), title: String(title).slice(0, 290), kind: url ? "link" : "self", api_type: "json" });
  if (url) body.set("url", url); else body.set("text", String(text || ""));
  const r = await fetch("https://oauth.reddit.com/api/submit", { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "AlphaPulse/1.0" }, body }).then((x) => x.json());
  const link = r?.json?.data?.url; if (!link) return `Reddit a refusé: ${JSON.stringify(r?.json?.errors || r).slice(0, 300)}`;
  run("INSERT INTO posts(agent,channel,ref,text,url) VALUES(?,?,?,?,?)", agent.id, "reddit", subreddit, title, link);
  return `Publié: ${link}`;
}

export function channelsStatus() {
  return {
    email: ["contact", ...q("SELECT id FROM agents").map((a) => a.id)].filter((id) => !!(id === "contact" ? contactBox() : mailboxOf(id))),
    telegram: telegramReady(), instagram: instagramReady(), reddit: redditReady(),
  };
}

/** Owner diagnostic: real login test of every configured channel (no message is sent). */
export async function checkChannels() {
  const out = {};
  const boxes = [["contact", contactBox()], ...q("SELECT id FROM agents").map((a) => [a.id, mailboxOf(a.id)])].filter(([, b]) => b);
  const { ImapFlow } = await import("imapflow");
  for (const [id, box] of boxes) {
    const r = { imap: false, smtp: false };
    try { const c = new ImapFlow({ host: E.IMAP_HOST || "imap.hostinger.com", port: 993, secure: true, auth: { user: box.user, pass: box.pass }, logger: false }); await c.connect(); await c.logout(); r.imap = true; } catch (e) { r.imapErr = String(e.responseText || e.message).slice(0, 120); }
    try { await (await smtp(box)).verify(); r.smtp = true; } catch (e) { r.smtpErr = String(e.message).slice(0, 120); }
    out[`email:${id}`] = r;
  }
  if (TG) {
    try { const me = await tg("getMe", {}); out.telegram_bot = { ok: true, username: me.username }; } catch (e) { out.telegram_bot = { ok: false, err: e.message }; }
    if (TG_CH) { try { const c = await tg("getChat", { chat_id: TG_CH }); out.telegram_channel = { ok: c.type === "channel", type: c.type, title: c.title }; } catch (e) { out.telegram_channel = { ok: false, err: e.message }; } }
  }
  if (instagramReady()) { try { const d = await fetch(`${igHost()}/${IG_ID}?fields=username&access_token=${IG_TOKEN}`).then((r) => r.json()); out.instagram = { ok: !!d.username, username: d.username, err: d.error?.message }; } catch (e) { out.instagram = { ok: false, err: e.message }; } }
  return out;
}
