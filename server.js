require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const db = require("./db");
const { config, getSafeStartupConfig } = require("./config");
const { AppError, isAppError } = require("./lib/errors");
const { sendJson, sendHtmlFile, getPublicBaseUrl, getClientIp, parseCookies } = require("./lib/http");
const { createRouter, ensureHandled } = require("./lib/router");
const { createAuthMiddleware } = require("./middleware/auth");
const { createCsrfMiddleware } = require("./middleware/csrf");
const { createRateLimitMiddleware } = require("./middleware/rate-limit");
const { createSecurityHeadersMiddleware } = require("./middleware/security-headers");
const { registerSystemRoutes } = require("./routes/system");
const { registerAuthRoutes } = require("./routes/auth");
const { registerProfileRoutes } = require("./routes/profile");
const { registerMatchRoutes } = require("./routes/match");
const { registerAdminRoutes } = require("./routes/admin");
const { registerDashboardRoutes } = require("./routes/dashboard");
const { registerCasRoutes } = require("./routes/cas");
const { registerCrushRoutes } = require("./routes/crush");
const { auditError } = require("./lib/logger");
const { weekKey } = require("./time");
const { runWeeklyMatchFlow } = require("./lib/match-runner");
const { processEmailQueue } = require("./lib/mail-queue");
const { createScheduler, parseMatchSchedule, intervalRule } = require("./lib/scheduler");

const ERROR_LOG_PATH = path.join(__dirname, "data", "error.log");
const INDEX_HTML_PATH = path.join(__dirname, "index.html");

// Online user tracking (in-memory, 5-minute window)
const onlineIps = new Map();
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function trackOnline(ip) {
  onlineIps.set(ip, Date.now());
}

function getOnlineCount() {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  let count = 0;
  for (const [ip, ts] of onlineIps) {
    if (ts >= cutoff) { count++; } else { onlineIps.delete(ip); }
  }
  return count;
}

setInterval(() => {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [ip, ts] of onlineIps) {
    if (ts < cutoff) onlineIps.delete(ip);
  }
}, 60 * 1000).unref();
const CAMPUS_IMAGES_DIR = path.join(__dirname, "public", "images", "campus");
const PUBLIC_JS_DIR = path.join(__dirname, "public", "js");

const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

function serveCampusImage(req, res) {
  if (req.method !== "GET") return false;
  const m = req.pathname.match(/^\/images\/campus\/([a-zA-Z0-9_\-]+\.(jpg|jpeg|png|webp|gif))$/i);
  if (!m) return false;
  const file = path.join(CAMPUS_IMAGES_DIR, m[1]);
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext] || "application/octet-stream";
  if (!fs.existsSync(file)) { res.writeHead(404); res.end("Not Found"); return true; }
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function servePublicJs(req, res) {
  if (req.method !== "GET") return false;
  const m = req.pathname.match(/^\/js\/([a-zA-Z0-9_.\-]+\.js)$/);
  if (!m) return false;
  const file = path.join(PUBLIC_JS_DIR, m[1]);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end("Not Found"); return true; }
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=604800" });
  fs.createReadStream(file).pipe(res);
  return true;
}

if (!fs.existsSync(path.dirname(ERROR_LOG_PATH))) {
  fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
}

function appendErrorLog(req, err) {
  const now = new Date().toISOString();
  const method = String(req.method || "-");
  const pathname = String(req.pathname || req.url || "-");
  const ip = String(req.clientIp || getClientIp(req));
  const message = String(err && err.message ? err.message : "unknown");
  const stack = String(err && err.stack ? err.stack : "").slice(0, 6000);
  const line = `[${now}] [ERROR] [UNCAUGHT] [${ip}] ${method} ${pathname} ${message}\n${stack}\n`;
  fs.appendFile(ERROR_LOG_PATH, line, () => {});
}

async function runMiddlewares(req, res, middlewares, finalHandler) {
  let index = -1;
  async function dispatch(i) {
    if (i <= index) throw new Error("next() called multiple times");
    index = i;
    if (i === middlewares.length) {
      await finalHandler();
      return;
    }
    const middleware = middlewares[i];
    await middleware(req, res, () => dispatch(i + 1));
  }
  await dispatch(0);
}

function createContextMiddleware() {
  return async function contextMiddleware(req, res, next) {
    const baseUrl = getPublicBaseUrl(req, config);
    let urlObj;
    try {
      urlObj = new URL(req.url, `${baseUrl}/`);
    } catch {
      throw new AppError(400, "invalid_url", "URL 不合法");
    }
    req.publicBaseUrl = baseUrl;
    req.urlObj = urlObj;
    req.pathname = urlObj.pathname.replace(/\/+$/, "") || "/";
    req.query = Object.fromEntries(urlObj.searchParams.entries());
    req.clientIp = getClientIp(req);
    req.cookies = parseCookies(req.headers.cookie || "");
    await next();
  };
}

function createAppRouter(deps = {}) {
  const router = createRouter();
  registerSystemRoutes(router);
  registerAuthRoutes(router);
  registerProfileRoutes(router);
  registerMatchRoutes(router);
  registerAdminRoutes(router, deps);
  registerDashboardRoutes(router, { getOnlineCount });
  registerCasRoutes(router);
  registerCrushRoutes(router);
  return router;
}

db.initSchema();

const scheduler = createScheduler();
scheduler.register("weekly-match", parseMatchSchedule(config.matchSchedule), async () => {
  const wk = weekKey();
  const output = await runWeeklyMatchFlow({
    weekKey: wk,
    baseUrl: config.baseUrl || `http://localhost:${config.port}`,
    trigger: "scheduler"
  });
  return {
    weekKey: wk,
    participants: output.summary.participants,
    matchedPairs: output.summary.matchedPairs,
    unmatchedUsers: output.summary.unmatchedUsers,
    queueQueued: output.summary.queueQueued,
    adminNotifyQueued: output.adminNotify.queued
  };
});
scheduler.register("mail-queue-process", intervalRule(config.mailProcessIntervalSeconds), async () => {
  const stats = await processEmailQueue({ limit: 50 });
  return stats;
});

const router = createAppRouter({ scheduler });
const middlewares = [
  createSecurityHeadersMiddleware(config.securityHeaders),
  createContextMiddleware(),
  createAuthMiddleware(config, db),
  createCsrfMiddleware(config),
  createRateLimitMiddleware(config)
];

const server = http.createServer(async (req, res) => {
  try {
    await runMiddlewares(req, res, middlewares, async () => {
      // Track online users and page views
      if (req.clientIp) trackOnline(req.clientIp);
      if (req.method === "GET" && (req.pathname === "/" || req.pathname === "/index.html" || req.pathname === "/dashboard.html")) {
        try { db.recordPageView(req.pathname, req.clientIp || "", String(req.headers["user-agent"] || "")); } catch {}
      }

      const handled = await router.handle(req, res);
      if (handled) return;
      if (serveCampusImage(req, res)) return;
      if (servePublicJs(req, res)) return;
      if (req.method === "GET" && (req.pathname === "/" || req.pathname === "/index.html")) {
        sendHtmlFile(res, INDEX_HTML_PATH);
        return;
      }
      ensureHandled(false);
    });
  } catch (err) {
    if (isAppError(err)) {
      const payload = { error: err.errorCode };
      if (err.details && typeof err.details === "object") {
        if (typeof err.details.retryAfterSeconds === "number") {
          res.setHeader("Retry-After", String(err.details.retryAfterSeconds));
        }
        Object.assign(payload, err.details);
      }
      sendJson(res, err.statusCode, payload);
      return;
    }
    appendErrorLog(req, err);
    auditError("SERVER_ERROR", req.clientIp || getClientIp(req), String(err && err.message ? err.message : "unknown"));
    sendJson(res, 500, { error: "server_error" });
  }
});

server.listen(config.port, () => {
  const safe = getSafeStartupConfig(config);
  const bind = config.baseUrl || `http://localhost:${config.port}`;
  console.log(`[rong-engine] running at ${bind}`);
  console.log(`[rong-engine] startup: ${JSON.stringify(safe)}`);
  scheduler.start();
  console.log(
    `[rong-engine] scheduler started, match schedule=${config.matchSchedule}, mail interval=${config.mailProcessIntervalSeconds}s`
  );
});
