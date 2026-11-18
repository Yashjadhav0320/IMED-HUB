"use strict";
/**
 * IMEDHUB payment server (Razorpay) - zero dependencies, needs Node 18+.
 *
 *   POST /api/create-order    { amount: <rupees>, description?, type?, email? }
 *   POST /api/verify-payment  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *   GET  /api/health
 *
 * It also serves the website (../IMED HUB) so you can open http://localhost:3000/fees.html
 * The Razorpay SECRET never leaves this file / the .env file.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- tiny .env loader (no dotenv needed) ----------
(function loadEnv() {
  let text = "";
  try { text = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); } catch (e) { return; }
  text.split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line[0] === "#") return;
    const i = line.indexOf("=");
    if (i < 1) return;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  });
})();

const PORT = Number(process.env.PORT) || 3000;
const KEY_ID = (process.env.RAZORPAY_KEY_ID || "").trim();
const KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || "").trim();
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(__dirname, "..", "IMED HUB"));
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT) || 500000;           // rupees per payment
const RZP_API = process.env.RAZORPAY_API_URL || "https://api.razorpay.com"; // override only for tests
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);

if (!KEY_ID || !KEY_SECRET) {
  console.error("\n[!] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing. Create backend/.env (see .env.example).\n");
}

// ---------- helpers ----------
function isAllowedOrigin(o) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || o === "null" || EXTRA_ORIGINS.indexOf(o) !== -1;
}
function setCors(req, res) {
  const o = req.headers.origin;
  if (o && isAllowedOrigin(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}
function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
function readJson(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > 10 * 1024) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(Object.assign(new Error("Invalid JSON body."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- API handlers ----------
async function createOrder(req, res) {
  if (!KEY_ID || !KEY_SECRET) return sendJson(req, res, 500, { error: "Payment server is not configured (missing Razorpay keys in backend/.env)." });
  const b = await readJson(req);
  const amount = Number(b.amount);
  const paise = Math.round(amount * 100);
  if (!isFinite(amount) || amount < 1 || amount > MAX_AMOUNT || Math.abs(amount * 100 - paise) > 1e-6)
    return sendJson(req, res, 400, { error: "Amount must be between 1 and " + MAX_AMOUNT + " rupees (max 2 decimals)." });

  const payload = {
    amount: paise,
    currency: "INR",
    receipt: ("rcpt_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex")).slice(0, 40),
    notes: { type: String(b.type || "").slice(0, 30), email: String(b.email || "").slice(0, 60), description: String(b.description || "").slice(0, 100) }
  };
  let r, data;
  try {
    r = await fetch(RZP_API + "/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64") },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    data = await r.json();
  } catch (e) {
    console.error("Razorpay unreachable:", e.message);
    return sendJson(req, res, 502, { error: "Could not reach Razorpay. Check the internet connection and try again." });
  }
  if (!r.ok || !data.id) {
    const msg = (data && data.error && data.error.description) || "Razorpay rejected the order.";
    console.error("Razorpay order error:", r.status, msg);
    return sendJson(req, res, 502, { error: msg });
  }
  sendJson(req, res, 200, { orderId: data.id, amount: data.amount, currency: data.currency, keyId: KEY_ID });
}

async function verifyPayment(req, res) {
  if (!KEY_SECRET) return sendJson(req, res, 500, { error: "Payment server is not configured." });
  const b = await readJson(req);
  const oid = b.razorpay_order_id, pid = b.razorpay_payment_id, sig = b.razorpay_signature;
  if (![oid, pid, sig].every(function (v) { return typeof v === "string" && v.length > 0 && v.length < 200; }))
    return sendJson(req, res, 400, { error: "Missing payment details." });
  const expected = crypto.createHmac("sha256", KEY_SECRET).update(oid + "|" + pid).digest("hex");
  if (!safeEqual(expected, sig)) return sendJson(req, res, 400, { error: "Payment signature check failed." });
  sendJson(req, res, 200, { ok: true, paymentId: pid, orderId: oid });
}

const ROUTES = {
  "/create-order": { POST: createOrder },
  "/verify-payment": { POST: verifyPayment },
  "/health": { GET: function (req, res) { sendJson(req, res, 200, { ok: true, configured: !!(KEY_ID && KEY_SECRET), mode: KEY_ID.indexOf("rzp_live_") === 0 ? "live" : "test" }); } }
};

// ---------- static website ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".pdf": "application/pdf", ".woff2": "font/woff2" };
function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end("Method Not Allowed"); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  if (rel.indexOf("\0") !== -1 || rel.split(/[\\/]/).some(function (s) { return s.charAt(0) === "."; })) { res.writeHead(404); return res.end("Not found"); }
  let file = path.join(SITE_DIR, rel);
  if (file !== SITE_DIR && file.indexOf(SITE_DIR + path.sep) !== 0) { res.writeHead(404); return res.end("Not found"); }
  fs.stat(file, function (err, st) {
    if (!err && st.isDirectory()) { file = path.join(file, "index.html"); }
    fs.readFile(file, function (e2, buf) {
      if (e2) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  });
}

// ---------- server ----------
const server = http.createServer(async function (req, res) {
  const pathname = (req.url || "/").split("?")[0];
  const apiPath = pathname.indexOf("/api/") === 0 ? pathname.slice(4) : null;
  // also accept /create-order and /verify-payment without the /api prefix
  const key = apiPath || (ROUTES[pathname] ? pathname : null);

  if (key) {
    if (req.method === "OPTIONS") { setCors(req, res); res.writeHead(204, { "Access-Control-Max-Age": "600" }); return res.end(); }
    const route = ROUTES[key];
    if (!route) return sendJson(req, res, 404, { error: "Unknown API route." });
    const handler = route[req.method];
    if (!handler) { res.setHeader("Allow", Object.keys(route).join(", ")); return sendJson(req, res, 405, { error: "Method not allowed." }); }
    try { await handler(req, res); }
    catch (e) {
      if (e && e.status) return sendJson(req, res, e.status, { error: e.message });
      console.error(e); sendJson(req, res, 500, { error: "Internal server error." });
    }
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, function () {
  console.log("IMEDHUB server running:  http://localhost:" + PORT + "/fees.html");
  console.log("Razorpay: " + (KEY_ID && KEY_SECRET ? "configured (" + KEY_ID.slice(0, 12) + "..., " + (KEY_ID.indexOf("rzp_live_") === 0 ? "LIVE" : "test") + " mode)" : "NOT configured"));
  console.log("Website folder: " + SITE_DIR);
});
server.on("error", function (e) {
  console.error(e.code === "EADDRINUSE" ? "Port " + PORT + " is already in use. Close the other server or set PORT in .env." : e);
  process.exit(1);
});
