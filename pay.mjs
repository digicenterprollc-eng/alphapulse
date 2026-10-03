// Chain2Pay integration (API v2) — https://docs.chain2pay.is
import { CFG } from "./config.mjs";
import crypto from "node:crypto";
import { run, one } from "./db.mjs";

const API = "https://chain2pay.is/api/v2";
export const C2P_KEY = process.env.CHAIN2PAY_API_KEY || "";
export const PUBLIC_BASE = process.env.PUBLIC_BASE || "http://127.0.0.1:8080";
const HOOK_TOKEN = process.env.WEBHOOK_TOKEN || crypto.createHash("sha256").update("hook:" + (process.env.CHAIN2PAY_API_KEY || "none")).digest("hex").slice(0, 24);
export const payConfigured = () => C2P_KEY.startsWith("c2p_");
export const payMode = () => (C2P_KEY.startsWith("c2p_live_") ? "live" : C2P_KEY.startsWith("c2p_sandbox_") ? "sandbox" : "off");

async function c2p(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${C2P_KEY}`, "Content-Type": "application/json", "User-Agent": `AlphaPulse/1.0 (+${CFG.site})`, Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Chain2Pay ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function createCheckout(product, email) {
  if (!payConfigured()) throw new Error("Chain2Pay pas encore configuré (clé API manquante).");
  const pay = await c2p("POST", "/payments", {
    amount: Number(product.price),
    currency: product.currency || "EUR",
    callback_url: `${PUBLIC_BASE}/webhooks/c2p?t=${HOOK_TOKEN}`,
    customer_email: email || undefined,
    metadata: { product_id: product.id, site: product.site },
  });
  run(`INSERT OR REPLACE INTO sales(id,product_id,amount,currency,status,agent,customer_email,sandbox)
       VALUES(?,?,?,?,?,?,?,?)`,
    pay.id, product.id, pay.amount, pay.currency, pay.status, product.created_by, email || null, pay.sandbox ? 1 : 0);
  return pay;
}

// Webhook = hint only; we confirm with GET /payments/:id before marking paid.
// Optional HMAC-SHA256 (hex) of the full request URL in x-chain2pay-signature, keyed with the dashboard secret.
const HOOK_SECRET = process.env.CHAIN2PAY_WEBHOOK_SECRET || "";
export async function handleWebhook(url, req) {
  const u = new URL(url, PUBLIC_BASE);
  const sig = String(req?.headers?.["x-chain2pay-signature"] || "").trim().toLowerCase();
  let signed = false;
  if (HOOK_SECRET && sig) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || new URL(PUBLIC_BASE).host).split(",")[0].trim();
    const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const candidates = new Set([`${proto}://${host}${url}`, `${PUBLIC_BASE}${url}`, `https://${host}${url}`, `http://${host}${url}`]);
    signed = [...candidates].some((full) => { const h = crypto.createHmac("sha256", HOOK_SECRET).update(full).digest("hex"); return h.length === sig.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig)); });
    if (!signed) return { ok: false, reason: "signature" };
  }
  const oid = u.searchParams.get("chain2pay_order_id") || "";
  // dashboard "Send a signed test webhook": valid signature + synthetic order id
  if (signed && /^test[_-]/i.test(oid)) return { ok: true, status: "test", test: true };
  // a valid signature proves the call comes from Chain2Pay; otherwise our secret token in the callback URL is required
  if (!signed && u.searchParams.get("t") !== HOOK_TOKEN) return { ok: false, reason: "token" };
  // signed call for an order that is not ours (same Chain2Pay account used by other sites): acknowledge, do nothing
  if (signed && oid && !one("SELECT id FROM sales WHERE id=?", oid)) return { ok: true, status: "ignored" };
  const mail = u.searchParams.get("customer_email");
  if (mail && /^[^@\s]+@[^@\s]+$/.test(mail)) run("UPDATE sales SET customer_email=COALESCE(customer_email, ?) WHERE id=?", mail.slice(0, 200), u.searchParams.get("chain2pay_order_id"));
  const id = u.searchParams.get("chain2pay_order_id");
  if (!id || !one("SELECT id FROM sales WHERE id=?", id)) return { ok: false, reason: "unknown order" };
  const p = await c2p("GET", `/payments/${encodeURIComponent(id)}`);
  if (p.status === "paid") {
    run("UPDATE sales SET status='paid', paid_amount=?, tx=?, paid_at=datetime('now') WHERE id=?",
      p.paid_amount ?? p.amount, p.tx_hash || u.searchParams.get("txid_out"), id);
  } else {
    run("UPDATE sales SET status=? WHERE id=?", p.status, id);
  }
  return { ok: true, status: p.status };
}

export async function refreshPending() {
  if (!payConfigured()) return;
  const pending = one("SELECT id FROM sales WHERE status IN ('pending','processing') ORDER BY created_at LIMIT 1");
  if (!pending) return;
  try {
    const p = await c2p("GET", `/payments/${encodeURIComponent(pending.id)}`);
    run("UPDATE sales SET status=?, paid_amount=COALESCE(?,paid_amount), tx=COALESCE(?,tx), paid_at=CASE WHEN ?='paid' THEN datetime('now') ELSE paid_at END WHERE id=?",
      p.status, p.paid_amount ?? null, p.tx_hash ?? null, p.status, pending.id);
  } catch {}
}
