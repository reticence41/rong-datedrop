const db = require("../db");
const { sendJson } = require("../lib/http");
const { AppError } = require("../lib/errors");
const {
  normalizeProfileInput,
  normalizeQuestionnaireInput,
  validateProfile,
  validateQuestionnaire,
  assertSliderWhitelist
} = require("../lib/validation");
const { requireAuth } = require("../middleware/auth");
const { createSessionHelpers } = require("../lib/session");
const { config } = require("../config");
const { auditInfo } = require("../lib/logger");

const sessionHelpers = createSessionHelpers(config, db);

function registerProfileRoutes(router) {
  router.post("/api/profile", async (req, res, { body }) => {
    const user = requireAuth(req);
    const profile = normalizeProfileInput(body || {}, config.limits);
    const error = validateProfile(profile);
    if (error) {
      throw new AppError(400, error, "资料校验失败");
    }
    db.updateUserProfile(user.id, profile);
    sessionHelpers.rotateSession(req, res, user.id);
    auditInfo("PROFILE_UPDATE", `user:${user.id}|ip:${req.clientIp}`, `campus=${profile.campus} grade=${profile.grade}`);
    sendJson(res, 200, { ok: true });
  });

  router.post("/api/questionnaire", async (req, res, { body }) => {
    const user = requireAuth(req);
    const questionnaire = normalizeQuestionnaireInput(body || {}, config.limits);
    assertSliderWhitelist(questionnaire.sliders);
    const error = validateQuestionnaire(questionnaire);
    if (error) {
      throw new AppError(400, error, "问卷校验失败");
    }
    db.upsertQuestionnaire(user.id, [...new Set(questionnaire.values)], questionnaire.sliders);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = {
  registerProfileRoutes
};
