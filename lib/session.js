const crypto = require("node:crypto");
const { parseCookies, setSessionCookie, clearCookie, setCookie } = require("./http");

function createSessionHelpers(config, db) {
  const cookieName = config.session.cookieName;
  const csrfCookieName = config.session.csrfCookieName || "scu_csrf";
  const csrfCookieMaxAge = Math.max(1, Number(config.session.maxDays || 14)) * 24 * 60 * 60;

  function ensureCsrfCookie(req, res) {
    const cookies = parseCookies(req.headers.cookie || "");
    let token = String(req.csrfToken || cookies[csrfCookieName] || "").trim();
    if (!token) {
      token = crypto.randomBytes(24).toString("base64url");
    }
    setCookie(res, csrfCookieName, token, {
      path: "/",
      maxAge: csrfCookieMaxAge,
      sameSite: "Lax",
      secure: config.session.secureCookie
    });
    req.csrfToken = token;
    return token;
  }

  function issueSession(req, res, userId) {
    const session = db.createSession(userId, config.session.maxDays, config.session.maxActive);
    setSessionCookie(res, config, session.token, session.expiresAt);
    ensureCsrfCookie(req, res);
    req.sessionToken = session.token;
    return session;
  }

  function rotateSession(req, res, userId) {
    const cookies = parseCookies(req.headers.cookie || "");
    const oldToken = req.sessionToken || cookies[cookieName];
    if (oldToken) {
      db.deleteSessionByToken(oldToken);
    }
    return issueSession(req, res, userId);
  }

  function clearCurrentSession(req, res) {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = req.sessionToken || cookies[cookieName];
    if (token) {
      db.deleteSessionByToken(token);
    }
    clearCookie(res, cookieName, config.session.secureCookie);
  }

  return {
    issueSession,
    rotateSession,
    clearCurrentSession
  };
}

module.exports = {
  createSessionHelpers
};
