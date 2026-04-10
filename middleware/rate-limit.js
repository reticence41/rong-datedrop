const { AppError } = require("../lib/errors");

const RATE_LIMIT_ENTRY_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_CLEAN_MS = 5 * 60 * 1000;

function createSlidingWindowLimiter() {
  const state = new Map();

  function check(bucket, limit, windowMs = 60 * 1000) {
    const now = Date.now();
    const start = now - windowMs;
    const entry = state.get(bucket) || { hits: [], touchedAt: now };
    entry.hits = entry.hits.filter((ts) => ts >= start);
    entry.touchedAt = now;
    if (entry.hits.length >= limit) {
      state.set(bucket, entry);
      const retryAt = entry.hits[0] + windowMs;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000))
      };
    }
    entry.hits.push(now);
    state.set(bucket, entry);
    return { ok: true, retryAfterSeconds: 0 };
  }

  function cleanup() {
    const deadline = Date.now() - RATE_LIMIT_ENTRY_TTL_MS;
    for (const [key, entry] of state.entries()) {
      if (!entry || entry.touchedAt < deadline) {
        state.delete(key);
      }
    }
  }

  setInterval(cleanup, RATE_LIMIT_CLEAN_MS).unref();
  return { check };
}

function createRateLimitMiddleware(config) {
  const limiter = createSlidingWindowLimiter();
  const windowMs = config.rateLimit.windowMs;
  return async function rateLimitMiddleware(req, res, next) {
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "POST") {
      await next();
      return;
    }

    let result = null;
    if (req.pathname.startsWith("/api/auth/")) {
      result = limiter.check(`auth:${req.clientIp}`, config.rateLimit.authPerMinute, windowMs);
    } else if (req.pathname === "/api/submit-all") {
      const key = req.user ? `submit:${req.user.id}` : `submit:${req.clientIp}`;
      result = limiter.check(key, config.rateLimit.submitPerMinute, windowMs);
    } else if (req.pathname === "/api/admin/run-match") {
      result = limiter.check(`admin_match:${req.clientIp}`, config.rateLimit.adminRunPerMinute, windowMs);
    }

    if (result && !result.ok) {
      throw new AppError(429, "rate_limited", "请求过于频繁", {
        retryAfterSeconds: result.retryAfterSeconds
      });
    }
    await next();
  };
}

module.exports = {
  createSlidingWindowLimiter,
  createRateLimitMiddleware
};
