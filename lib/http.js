const fs = require("node:fs");
const { AppError } = require("./errors");

function sendJson(res, statusCode, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  if (!res.hasHeader("Cache-Control")) {
    res.setHeader("Cache-Control", "no-store");
  }
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(body);
}

function sendHtmlFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new AppError(404, "file_not_found", "页面不存在");
  }
  const content = fs.readFileSync(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", content.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(content);
}

function redirect(res, location, statusCode = 302) {
  res.statusCode = statusCode;
  res.setHeader("Location", location);
  res.end();
}

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (xff) return xff;
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp) return realIp;
  return req.socket?.remoteAddress || "unknown";
}

function getPublicBaseUrl(req, config) {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = xfProto || (req.socket.encrypted ? "https" : "http");
  const host = xfHost || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function setCookie(res, key, value, opts = {}) {
  const parts = [`${key}=${encodeURIComponent(value)}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  const cookie = parts.join("; ");
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookie]);
  } else {
    res.setHeader("Set-Cookie", [prev, cookie]);
  }
}

function clearCookie(res, key, secureCookie) {
  setCookie(res, key, "", {
    path: "/",
    maxAge: 0,
    sameSite: "Lax",
    secure: secureCookie
  });
}

function setSessionCookie(res, config, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  setCookie(res, config.session.cookieName, token, {
    path: "/",
    maxAge,
    httpOnly: true,
    sameSite: "Lax",
    secure: config.session.secureCookie
  });
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new AppError(415, "unsupported_media_type", "Content-Type 必须为 application/json");
  }
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new AppError(413, "payload_too_large", "请求体超过 1MB 限制"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError(400, "invalid_json", "JSON 格式错误"));
      }
    });
    req.on("error", (err) => reject(new AppError(400, "request_stream_error", err.message)));
  });
}

module.exports = {
  sendJson,
  sendHtmlFile,
  redirect,
  parseCookies,
  getClientIp,
  getPublicBaseUrl,
  setCookie,
  clearCookie,
  setSessionCookie,
  readJson
};
