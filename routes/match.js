const db = require("../db");
const { weekKey } = require("../time");
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
const { enqueueContactUnlockedNotifications } = require("../lib/mail-queue");
const { ACTION_MATCH_CONSENT, consumeConfirmToken } = require("../lib/confirm-token");
const { generateMatchAnalysis } = require("../lib/ai-analysis");

const sessionHelpers = createSessionHelpers(config, db);

function isOlderThanDays(iso, days) {
  const ts = new Date(String(iso || "")).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts >= Math.max(1, Number(days || 1)) * 24 * 60 * 60 * 1000;
}

function registerMatchRoutes(router) {
  router.post("/api/opt-in", async (req, res, { body }) => {
    const user = requireAuth(req);
    const wk = String(body.weekKey || weekKey());
    db.setOptIn(user.id, wk);
    sendJson(res, 200, { ok: true, weekKey: wk });
  });

  router.post("/api/submit-all", async (req, res, { body }) => {
    const user = requireAuth(req);
    const profile = normalizeProfileInput(body.profile || {}, config.limits);
    const questionnaire = normalizeQuestionnaireInput(body.questionnaire || {}, config.limits);
    assertSliderWhitelist(questionnaire.sliders);
    const profileError = validateProfile(profile);
    if (profileError) {
      throw new AppError(400, profileError, "资料校验失败");
    }
    const questionnaireError = validateQuestionnaire(questionnaire);
    if (questionnaireError) {
      throw new AppError(400, questionnaireError, "问卷校验失败");
    }
    db.updateUserProfile(user.id, profile);
    db.upsertQuestionnaire(user.id, [...new Set(questionnaire.values)], questionnaire.sliders);
    const wk = String(body.weekKey || weekKey());
    db.setOptIn(user.id, wk);
    sessionHelpers.rotateSession(req, res, user.id);
    auditInfo("PROFILE_UPDATE", `user:${user.id}|ip:${req.clientIp}`, `submit_all=1 week=${wk}`);
    sendJson(res, 200, { ok: true, weekKey: wk });
  });

  router.get("/api/match/current", async (req, res, { query }) => {
    const user = requireAuth(req);
    const wk = String(query.weekKey || weekKey());
    const match = db.getCurrentMatch(user.id, wk) || db.getLatestMatch(user.id);
    if (!match) {
      sendJson(res, 200, { match: null });
      return;
    }
    const partnerId = match.user_a === user.id ? match.user_b : match.user_a;
    const partner = db.getUserById(partnerId);
    // 单向同意机制：你同意后对方能看到你的信息，对方同意后你能看到对方的信息
    const consents = db.getConsent(match.id);
    const selfConsentRow = consents.find((c) => c.user_id === user.id);
    const partnerConsentRow = consents.find((c) => c.user_id === partnerId);
    const selfConsent = Boolean(selfConsentRow && selfConsentRow.share_contact);
    const partnerConsent = Boolean(partnerConsentRow && partnerConsentRow.share_contact);
    const unlocked = partnerConsent; // 对方同意了，你才能看到对方的联系方式
    const feedback = db.getMatchFeedback(match.id, user.id);
    const feedbackEligible = isOlderThanDays(match.created_at, 7);
    sendJson(res, 200, {
      match: {
        id: match.id,
        weekKey: match.week_key,
        createdAt: match.created_at,
        score: match.score,
        confidence: match.confidence || null,
        reasons: (() => { try { return JSON.parse(match.reasons_json); } catch { return []; } })(),
        partner: {
          name: partner.name,
          campus: partner.campus,
          grade: partner.grade,
          gender: partner.gender
        },
        narrative: match.narrative || null,
        isCrushMatch: match.score >= 95 && (() => {
          try { const r = JSON.parse(match.reasons_json || "[]"); return r[0] && r[0].includes("双向心动"); } catch { return false; }
        })(),
        greetings: (() => {
          const rows = db.getMatchGreetings(match.id);
          const mine = rows.find((r) => r.user_id === user.id);
          const theirs = rows.find((r) => r.user_id === partnerId);
          return { myMessage: mine ? mine.message : null, theirMessage: theirs ? theirs.message : null };
        })(),
        contactUnlocked: unlocked,
        selfConsent,
        partnerConsent,
        feedbackEligible,
        feedbackSubmitted: Boolean(feedback),
        feedbackSubmittedAt: feedback ? feedback.created_at : null,
        contact: unlocked
          ? {
              wechat: partner.wechat,
              qq: partner.qq,
              backupEmail: partner.backup_email
            }
          : null
      }
    });
  });

  router.post("/api/match/feedback", async (req, res, { body }) => {
    const user = requireAuth(req);
    const matchId = Number(body.matchId || 0);
    const rating = Number(body.rating || 0);
    const contacted = Boolean(body.contacted);
    const comment = String(body.comment || "").trim();
    if (!Number.isInteger(matchId) || matchId <= 0) {
      throw new AppError(400, "feedback_match_id_invalid", "反馈匹配ID无效");
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError(400, "feedback_rating_invalid", "评分需在 1-5 之间");
    }
    if (comment.length > 500) {
      throw new AppError(400, "feedback_comment_too_long", "反馈文字最多 500 字");
    }
    const match = db.getMatchDetail(matchId);
    if (!match) {
      throw new AppError(404, "feedback_match_not_found", "未找到对应匹配记录");
    }
    if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
      throw new AppError(403, "feedback_forbidden", "无权提交该匹配反馈");
    }
    if (!isOlderThanDays(match.created_at, 7)) {
      throw new AppError(400, "feedback_not_eligible", "匹配超过 7 天后可提交反馈");
    }
    const row = db.upsertMatchFeedback({
      matchId,
      userId: user.id,
      rating,
      contacted,
      comment
    });
    auditInfo(
      "MATCH_FEEDBACK_SUBMIT",
      `user:${user.id}|ip:${req.clientIp}`,
      `match_id=${matchId} rating=${rating} contacted=${contacted ? 1 : 0}`
    );
    sendJson(res, 200, {
      ok: true,
      feedback: {
        id: row.id,
        matchId: row.match_id,
        rating: row.rating,
        contacted: row.contacted === 1,
        comment: row.comment || "",
        createdAt: row.created_at
      }
    });
  });

  router.post("/api/match/consent", async (req, res, { body }) => {
    const user = requireAuth(req);
    const confirmToken = String(body.confirmToken || "").trim();
    if (!confirmToken) {
      throw new AppError(400, "confirm_token_required", "请先申请操作令牌");
    }
    const consumed = consumeConfirmToken(db, {
      token: confirmToken,
      action: ACTION_MATCH_CONSENT,
      userId: user.id
    });
    if (!consumed) {
      throw new AppError(403, "confirm_token_invalid", "操作令牌无效或已过期");
    }
    const shareContact = Boolean(body.shareContact);
    const wk = String(body.weekKey || weekKey());
    const match = db.getCurrentMatch(user.id, wk) || db.getLatestMatch(user.id);
    if (!match) {
      throw new AppError(404, "match_not_found", "未找到匹配结果");
    }
    db.setConsent(match.id, user.id, shareContact);
    let unlockMailQueued = 0;
    if (shareContact) {
      const queueResult = enqueueContactUnlockedNotifications(match.id, req.publicBaseUrl || "", user.id);
      unlockMailQueued = Number(queueResult && queueResult.queued ? queueResult.queued : 0);
      if (unlockMailQueued > 0) {
        auditInfo(
          "MATCH_UNLOCK_MAIL_QUEUED",
          `user:${user.id}|ip:${req.clientIp}`,
          {
            matchId: match.id,
            queued: unlockMailQueued,
            userId: user.id
          }
        );
      }
    }
    sessionHelpers.rotateSession(req, res, user.id);
    auditInfo(
      "MATCH_CONSENT",
      `user:${user.id}|ip:${req.clientIp}`,
      {
        weekKey: wk,
        matchId: match.id,
        userId: user.id,
        shareContact,
        result: "ok"
      }
    );
    sendJson(res, 200, { ok: true, shareContact, unlockMailQueued });
  });

  // Generate or retrieve AI narrative for a match
  router.post("/api/match/narrative", async (req, res, { body }) => {
    const user = requireAuth(req);
    const wk = String(body.weekKey || weekKey());
    const match = db.getCurrentMatch(user.id, wk) || db.getLatestMatch(user.id);
    if (!match) {
      throw new AppError(404, "match_not_found", "未找到匹配结果");
    }
    // Return cached narrative if available
    if (match.narrative) {
      sendJson(res, 200, { narrative: match.narrative, cached: true });
      return;
    }
    // Generate new narrative
    if (!config.llm.enabled) {
      throw new AppError(503, "llm_not_configured", "AI 分析功能暂未开启");
    }
    const partnerId = match.user_a === user.id ? match.user_b : match.user_a;
    const partner = db.getUserById(partnerId);
    const userObj = db.getUserById(user.id);
    const questionnaireA = db.getUserQuestionnaire(match.user_a);
    const questionnaireB = db.getUserQuestionnaire(match.user_b);
    const reasons = (() => { try { return JSON.parse(match.reasons_json); } catch { return []; } })();
    const narrative = await generateMatchAnalysis({
      userA: { name: userObj.name, grade: userObj.grade, campus: userObj.campus, gender: userObj.gender },
      userB: { name: partner.name, grade: partner.grade, campus: partner.campus, gender: partner.gender },
      questionnaireA,
      questionnaireB,
      score: match.score,
      reasons
    });
    if (narrative) {
      db.setMatchNarrative(match.id, narrative);
    }
    sendJson(res, 200, { narrative: narrative || "AI 分析暂时无法生成，请稍后再试。", cached: false });
  });

  // ── 破冰留言 (Icebreaker Greeting) ────────────────────────────
  router.post("/api/match/greet", async (req, res, { body }) => {
    const user = requireAuth(req);
    const message = String(body.message || "").trim();
    if (!message) throw new AppError(400, "greet_empty", "留言不能为空");
    if (message.length > 300) throw new AppError(400, "greet_too_long", "留言最多 300 字");
    const wk = String(body.weekKey || weekKey());
    const match = db.getCurrentMatch(user.id, wk) || db.getLatestMatch(user.id);
    if (!match) throw new AppError(404, "match_not_found", "未找到匹配结果");
    const row = db.upsertMatchGreeting(match.id, user.id, message);
    auditInfo("MATCH_GREET", `user:${user.id}|ip:${req.clientIp}`, `match_id=${match.id}`);
    sendJson(res, 200, { ok: true, message: row.message, createdAt: row.created_at });
  });

  // ── 暂停参与 (Pause Matching) ─────────────────────────────────
  router.post("/api/user/pause", async (req, res, { body }) => {
    const user = requireAuth(req);
    const paused = Boolean(body.paused);
    const updated = db.setUserPaused(user.id, paused);
    auditInfo("USER_PAUSE", `user:${user.id}|ip:${req.clientIp}`, `paused=${paused}`);
    sendJson(res, 200, { ok: true, paused: updated.paused === 1 });
  });

  router.get("/api/user/me", async (req, res) => {
    const user = requireAuth(req);
    sendJson(res, 200, {
      id: user.id,
      name: user.name,
      campus: user.campus,
      grade: user.grade,
      gender: user.gender,
      paused: user.paused === 1
    });
  });
}

module.exports = {
  registerMatchRoutes
};
