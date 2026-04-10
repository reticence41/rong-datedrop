const crypto = require("node:crypto");

const ACTION_MATCH_CONSENT = "match_consent";
const ACTION_ADMIN_RUN_MATCH = "admin_run_match";
const ALLOWED_ACTIONS = new Set([ACTION_MATCH_CONSENT, ACTION_ADMIN_RUN_MATCH]);

function normalizeAction(action) {
  return String(action || "").trim().toLowerCase();
}

function isAllowedAction(action) {
  return ALLOWED_ACTIONS.has(normalizeAction(action));
}

function hashConfirmToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function issueConfirmToken(db, { action, userId = null, adminKeyPrefix = null, ttlSeconds = 300 }) {
  const normalizedAction = normalizeAction(action);
  const rawToken = crypto.randomBytes(24).toString("base64url");
  const tokenHash = hashConfirmToken(rawToken);
  const expiresAt = new Date(Date.now() + Math.max(60, Number(ttlSeconds || 300)) * 1000).toISOString();
  db.createConfirmToken({
    tokenHash,
    action: normalizedAction,
    userId,
    adminKeyPrefix,
    expiresAt
  });
  return {
    token: rawToken,
    action: normalizedAction,
    expiresAt
  };
}

function consumeConfirmToken(db, { token, action, userId = null, adminKeyPrefix = null }) {
  const normalizedAction = normalizeAction(action);
  const tokenHash = hashConfirmToken(token);
  return db.consumeConfirmToken({
    tokenHash,
    action: normalizedAction,
    userId,
    adminKeyPrefix
  });
}

module.exports = {
  ACTION_MATCH_CONSENT,
  ACTION_ADMIN_RUN_MATCH,
  isAllowedAction,
  normalizeAction,
  issueConfirmToken,
  consumeConfirmToken
};
