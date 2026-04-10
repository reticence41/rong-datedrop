const db = require("../db");
const { config } = require("../config");
const { weekKey } = require("../time");
const { sendJson } = require("../lib/http");
const { AppError } = require("../lib/errors");
const { auditInfo } = require("../lib/logger");
const { getClientList } = require("../lib/universities");
const {
  ACTION_MATCH_CONSENT,
  ACTION_ADMIN_RUN_MATCH,
  isAllowedAction,
  issueConfirmToken
} = require("../lib/confirm-token");
const { sanitizeUser } = require("../lib/validation");
const { requireAuth } = require("../middleware/auth");

async function buildHealthPayload() {
  const currentWeek = weekKey();
  const dbOk = db.ping();
  const activeUsers = db.countActiveUsers();
  const thisWeekOptIn = db.countOptInForWeek(currentWeek);
  return {
    ok: Boolean(dbOk),
    now: new Date().toISOString(),
    weekKey: currentWeek,
    authMode: config.authMode,
    activeUsers,
    thisWeekOptIn
  };
}

function registerSystemRoutes(router) {
  router.get("/api/health", async (req, res) => {
    const payload = await buildHealthPayload();
    sendJson(res, payload.ok ? 200 : 503, payload);
  });

  router.get("/api/health/ready", async (req, res) => {
    const ok = db.ping();
    sendJson(res, ok ? 200 : 503, {
      ready: Boolean(ok),
      now: new Date().toISOString()
    });
  });

  router.get("/api/config", async (req, res) => {
    sendJson(res, 200, {
      authMode: config.authMode,
      weekKey: weekKey(),
      allowedEmailDomains: config.email.allowedDomains,
      universities: getClientList(),
      cas:
        config.authMode === "cas"
          ? {
              loginPath: "/auth/cas/login",
              callbackPath: config.cas.callbackPath,
              logoutPath: "/auth/cas/logout",
              serviceValidatePath: config.cas.validatePath,
              baseUrl: req.publicBaseUrl
            }
          : null,
      emailOtp:
        config.authMode === "email"
          ? {
              ttlSeconds: config.email.otp.ttlSeconds,
              resendCooldownSeconds: config.email.otp.resendCooldownSeconds
            }
          : null
    });
  });

  router.get("/api/announcements/active", async (req, res) => {
    const items = db.listActiveAnnouncements(5).map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      createdAt: row.created_at
    }));
    sendJson(res, 200, { items });
  });

  router.post("/api/confirm-token", async (req, res, { body }) => {
    const action = String(body.action || "").trim().toLowerCase();
    if (!isAllowedAction(action)) {
      throw new AppError(400, "confirm_action_invalid", "无效的敏感操作类型");
    }
    if (action === ACTION_MATCH_CONSENT) {
      const user = requireAuth(req);
      const out = issueConfirmToken(db, {
        action,
        userId: user.id,
        ttlSeconds: config.confirmTokenTtlSeconds
      });
      auditInfo("CONFIRM_TOKEN_ISSUED", `user:${user.id}|ip:${req.clientIp}`, {
        action,
        userId: user.id,
        ip: req.clientIp
      });
      sendJson(res, 200, {
        ok: true,
        action,
        token: out.token,
        expiresInSeconds: config.confirmTokenTtlSeconds
      });
      return;
    }

    const adminKey = String(req.headers["x-admin-key"] || "");
    if (!adminKey || adminKey !== config.adminRunKey) {
      throw new AppError(403, "forbidden", "管理密钥不正确");
    }
    const keyPrefix = adminKey.slice(0, 8);
    const out = issueConfirmToken(db, {
      action: ACTION_ADMIN_RUN_MATCH,
      adminKeyPrefix: keyPrefix,
      ttlSeconds: config.confirmTokenTtlSeconds
    });
    auditInfo("CONFIRM_TOKEN_ISSUED", `admin:${keyPrefix}|ip:${req.clientIp}`, {
      action: ACTION_ADMIN_RUN_MATCH,
      adminKeyPrefix: keyPrefix,
      ip: req.clientIp
    });
    sendJson(res, 200, {
      ok: true,
      action: ACTION_ADMIN_RUN_MATCH,
      token: out.token,
      expiresInSeconds: config.confirmTokenTtlSeconds
    });
  });

  router.get("/api/me", async (req, res) => {
    const user = requireAuth(req);
    const questionnaire = db.getUserQuestionnaire(user.id);
    sendJson(res, 200, {
      authenticated: true,
      user: sanitizeUser(user),
      onboardingComplete: Boolean(questionnaire && user.gender && user.campus && user.grade && user.seeking)
    });
  });
}

module.exports = {
  registerSystemRoutes
};
