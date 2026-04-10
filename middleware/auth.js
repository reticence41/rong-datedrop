const { parseCookies } = require("../lib/http");
const { unauthorized } = require("../lib/errors");

function createAuthMiddleware(config, db) {
  const sessionCookieName = config.session.cookieName;
  return async function authMiddleware(req, res, next) {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies[sessionCookieName];
    req.sessionToken = token || "";
    req.user = token ? db.getSessionUser(token) : null;
    await next();
  };
}

function requireAuth(req) {
  if (!req.user) {
    throw unauthorized("unauthorized", "请先登录");
  }
  return req.user;
}

module.exports = {
  createAuthMiddleware,
  requireAuth
};
