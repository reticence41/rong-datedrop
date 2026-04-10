const crypto = require("node:crypto");
const { AppError } = require("../lib/errors");
const { setCookie } = require("../lib/http");

function createCsrfMiddleware(config) {
  const csrfCookieName = config.session.csrfCookieName || "scu_csrf";
  const cookieMaxAge = Math.max(1, Number(config.session.maxDays || 14)) * 24 * 60 * 60;

  return async function csrfMiddleware(req, res, next) {
    let csrfToken = String((req.cookies && req.cookies[csrfCookieName]) || "").trim();
    if (!csrfToken) {
      csrfToken = crypto.randomBytes(24).toString("base64url");
      setCookie(res, csrfCookieName, csrfToken, {
        path: "/",
        maxAge: cookieMaxAge,
        sameSite: "Lax",
        secure: config.session.secureCookie
      });
    }
    req.csrfToken = csrfToken;

    const method = String(req.method || "GET").toUpperCase();
    const pathname = String(req.pathname || "");
    if (method === "POST" && pathname.startsWith("/api/")) {
      const headerToken = String(req.headers["x-csrf-token"] || "").trim();
      if (!headerToken || headerToken !== csrfToken) {
        throw new AppError(403, "csrf_invalid", "CSRF token 校验失败");
      }
    }
    await next();
  };
}

module.exports = {
  createCsrfMiddleware
};
