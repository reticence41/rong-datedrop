const path = require("node:path");
const db = require("../db");
const { config } = require("../config");
const { weekKey } = require("../time");
const { AppError } = require("../lib/errors");
const { sendJson, sendHtmlFile } = require("../lib/http");
const { runWeeklyMatchFlow } = require("../lib/match-runner");
const { analyzeUnmatched } = require("../match-engine");
const { auditInfo, auditWarn } = require("../lib/logger");
const { ACTION_ADMIN_RUN_MATCH, consumeConfirmToken } = require("../lib/confirm-token");

const ADMIN_HTML_PATH = path.join(__dirname, "..", "admin.html");

function assertAdmin(req) {
  const key = String(req.headers["x-admin-key"] || "");
  const keyPrefix = key ? key.slice(0, 8) : "missing";
  if (!key || key !== config.adminRunKey) {
    auditWarn("ADMIN_ACCESS_DENIED", `admin:${keyPrefix}|ip:${req.clientIp}`, {
      operation: `${String(req.method || "GET").toUpperCase()} ${req.pathname}`,
      adminKeyPrefix: keyPrefix,
      ip: req.clientIp
    });
    throw new AppError(403, "forbidden", "管理密钥不正确");
  }
  req.adminKeyPrefix = keyPrefix;
  auditInfo("ADMIN_OPERATION", `admin:${keyPrefix}|ip:${req.clientIp}`, {
    operation: `${String(req.method || "GET").toUpperCase()} ${req.pathname}`,
    adminKeyPrefix: keyPrefix,
    ip: req.clientIp
  });
}

function hasAdminAccessForPage(req) {
  const headerKey = String(req.headers["x-admin-key"] || "");
  if (headerKey && headerKey === config.adminRunKey) return true;
  const queryKey = String((req.query && req.query.adminKey) || "");
  return Boolean(queryKey && queryKey === config.adminRunKey);
}

function toNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function toCsvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');
  return `"${escaped}"`;
}

function toCsv(columns, rows) {
  const lines = [];
  lines.push(columns.map((col) => toCsvCell(col.title)).join(","));
  for (const row of rows) {
    lines.push(columns.map((col) => toCsvCell(row[col.key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function sendCsv(res, filename, csvContent) {
  const body = Buffer.from(csvContent, "utf8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function parseReasons(raw) {
  try {
    const arr = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(arr)) return "";
    return arr.map((item) => String(item || "").trim()).filter(Boolean).join("；");
  } catch {
    return "";
  }
}

function parseReasonArray(raw) {
  try {
    const arr = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isoWeekStartDate(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(week || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(wk) || wk < 1 || wk > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const target = new Date(mondayWeek1);
  target.setUTCDate(mondayWeek1.getUTCDate() + (wk - 1) * 7);
  return target;
}

function buildRecentWeekKeys(anchorWeekKey, count = 12) {
  const safeCount = Math.max(1, Math.min(52, Number(count || 12)));
  const anchorDate = isoWeekStartDate(anchorWeekKey) || new Date();
  const out = [];
  for (let i = safeCount - 1; i >= 0; i -= 1) {
    const d = new Date(anchorDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(weekKey(d));
  }
  return out;
}

function toYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekRangeInChina(week) {
  const startUtc = isoWeekStartDate(week);
  if (!startUtc) return null;
  const chinaOffsetMs = 8 * 60 * 60 * 1000;
  const startAtUtc = new Date(startUtc.getTime() - chinaOffsetMs);
  const endAtUtc = new Date(startAtUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
  const periodStart = new Date(startAtUtc.getTime() + chinaOffsetMs);
  const periodEnd = new Date(endAtUtc.getTime() - 24 * 60 * 60 * 1000 + chinaOffsetMs);
  return {
    startAtUtc,
    endAtUtc,
    period: `${toYmd(periodStart)} ~ ${toYmd(periodEnd)}`
  };
}

function previousWeekKey(currentWeekKey) {
  const start = isoWeekStartDate(currentWeekKey);
  if (!start) return "";
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() - 7);
  return weekKey(d);
}

function countByField(rows, field, fallbackLabel) {
  const out = {};
  for (const row of rows) {
    const key = String(row && row[field] ? row[field] : fallbackLabel);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function normalizeGenderLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) return "未填写";
  if (text.includes("男")) return "男生";
  if (text.includes("女")) return "女生";
  return text;
}

function normalizeMatches(rows = []) {
  return rows.map((row) => ({
    id: row.id,
    weekKey: row.week_key,
    score: row.score,
    reasons: parseReasons(row.reasons_json),
    contactUnlocked: Number(row.contact_unlocked || 0) === 1,
    createdAt: row.created_at,
    userA: {
      id: row.user_a_id,
      name: row.user_a_name,
      studentId: row.user_a_student_id,
      email: row.user_a_email,
      grade: row.user_a_grade,
      campus: row.user_a_campus,
      gender: row.user_a_gender
    },
    userB: {
      id: row.user_b_id,
      name: row.user_b_name,
      studentId: row.user_b_student_id,
      email: row.user_b_email,
      grade: row.user_b_grade,
      campus: row.user_b_campus,
      gender: row.user_b_gender
    }
  }));
}

function registerAdminRoutes(router, deps = {}) {
  router.get("/admin.html", async (req, res) => {
    sendHtmlFile(res, ADMIN_HTML_PATH);
  });

  router.get("/api/admin/stats", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || weekKey());
    const totalUsers = db.countTotalUsers();
    const thisWeekOptIns = db.countOptInForWeek(wk);
    const historicalTotalMatchPairs = db.countTotalMatches();
    const thisWeekMatchedPairs = db.countMatchedPairsForWeek(wk);
    const unlockedPairs = db.countUnlockedPairsForWeek(wk);
    const unlockRate = thisWeekMatchedPairs
      ? Number((unlockedPairs / thisWeekMatchedPairs).toFixed(4))
      : 0;
    sendJson(res, 200, {
      weekKey: wk,
      totalUsers,
      thisWeekOptIns,
      historicalTotalMatchPairs,
      thisWeekMatchedPairs,
      unlockedPairs,
      unlockRate
    });
  });

  router.get("/api/admin/match-runs", async (req, res) => {
    assertAdmin(req);
    const items = db.listMatchRuns().map((row) => ({
      weekKey: row.week_key,
      runAt: row.run_at,
      candidateCount: row.candidate_count,
      matchedCount: row.matched_count
    }));
    sendJson(res, 200, { items });
  });

  router.get("/api/admin/scheduler-status", async (req, res) => {
    assertAdmin(req);
    const status = deps.scheduler && typeof deps.scheduler.getStatus === "function"
      ? deps.scheduler.getStatus()
      : { running: false, startedAt: null, lastTickAt: null, tasks: [] };
    const weeklyTask = (status.tasks || []).find((task) => String(task.name || "").includes("weekly-match"));
    const latestRun = db.getLatestMatchRun();
    sendJson(res, 200, {
      running: Boolean(status.running),
      startedAt: status.startedAt || null,
      lastTickAt: status.lastTickAt || null,
      lastMatchTime: weeklyTask && weeklyTask.lastRunAt ? weeklyTask.lastRunAt : (latestRun ? latestRun.run_at : null),
      nextMatchTime: weeklyTask ? weeklyTask.nextRunAt : null,
      tasks: status.tasks || []
    });
  });

  router.get("/api/admin/mail-queue-stats", async (req, res) => {
    assertAdmin(req);
    const stats = db.getEmailQueueStats();
    sendJson(res, 200, stats);
  });

  router.get("/api/admin/users", async (req, res, { query }) => {
    assertAdmin(req);
    const page = toNumber(query.page, 1);
    const limit = toNumber(query.limit, 20);
    const search = String(query.search || "");
    const campus = String(query.campus || "");
    const grade = String(query.grade || "");
    const result = db.listUsersPaged({ page, limit, search, campus, grade });
    sendJson(res, 200, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      items: result.items.map((item) => ({
        id: item.id,
        studentId: item.student_id,
        name: item.name,
        email: item.email,
        campus: item.campus,
        grade: item.grade,
        createdAt: item.created_at
      }))
    });
  });

  router.get("/api/admin/matches", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || db.getLatestWeekKeyWithMatches() || weekKey());
    const items = normalizeMatches(db.listMatchesByWeek(wk));
    sendJson(res, 200, { weekKey: wk, total: items.length, items });
  });

  router.get("/api/admin/unmatched", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || db.getLatestWeekKeyWithMatches() || weekKey());
    const data = analyzeUnmatched(wk);
    sendJson(res, 200, data);
  });

  router.get("/api/admin/trend", async (req, res, { query }) => {
    assertAdmin(req);
    const anchor = String(query.weekKey || weekKey());
    const weekKeys = buildRecentWeekKeys(anchor, 12);
    const items = weekKeys.map((wk) => ({
      weekKey: wk,
      optIn: db.countOptInForWeek(wk),
      matchedPairs: db.countMatchedPairsForWeek(wk),
      unlockedPairs: db.countUnlockedPairsForWeek(wk)
    }));
    sendJson(res, 200, {
      anchorWeekKey: anchor,
      items
    });
  });

  router.get("/api/admin/weekly-report", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || db.getLatestWeekKeyWithMatches() || weekKey());
    const range = weekRangeInChina(wk);
    if (!range) {
      throw new AppError(400, "week_key_invalid", "周次格式错误");
    }
    const totalUsers = db.countTotalUsers();
    const newRegistrations = db.countUsersCreatedBetween(range.startAtUtc.toISOString(), range.endAtUtc.toISOString());
    const optInCount = db.countOptInForWeek(wk);
    const matchedPairs = db.countMatchedPairsForWeek(wk);
    const unmatchedCount = Math.max(0, optInCount - matchedPairs * 2);
    const avgScore = Number(db.getAverageMatchScoreForWeek(wk) || 0);
    const unlockedPairs = db.countUnlockedPairsForWeek(wk);
    const unlockRate = matchedPairs > 0 ? `${Math.round((unlockedPairs / matchedPairs) * 100)}%` : "0%";
    const participantRows = db.listOptInUsersBasic(wk);
    const campusDistribution = countByField(participantRows, "campus", "未填写");
    const gradeDistribution = countByField(participantRows, "grade", "未填写");
    const genderRows = participantRows.map((row) => ({ ...row, gender: normalizeGenderLabel(row.gender) }));
    const genderDistribution = countByField(genderRows, "gender", "未填写");
    const reasonCounter = new Map();
    for (const row of db.listMatchReasonsForWeek(wk)) {
      for (const reason of parseReasonArray(row.reasons_json)) {
        reasonCounter.set(reason, (reasonCounter.get(reason) || 0) + 1);
      }
    }
    const topReasons = Array.from(reasonCounter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((item) => item[0]);

    const prevWeek = previousWeekKey(wk);
    const prevOptIn = prevWeek ? db.countOptInForWeek(prevWeek) : 0;
    const prevMatched = prevWeek ? db.countMatchedPairsForWeek(prevWeek) : 0;
    const prevAvgScore = prevWeek ? Number(db.getAverageMatchScoreForWeek(prevWeek) || 0) : 0;
    const comparedToLastWeek = {
      optInChange: optInCount - prevOptIn,
      matchedChange: matchedPairs - prevMatched,
      scoreChange: Number((avgScore - prevAvgScore).toFixed(1))
    };

    sendJson(res, 200, {
      weekKey: wk,
      period: range.period,
      newRegistrations,
      totalUsers,
      optInCount,
      matchedPairs,
      unmatchedCount,
      avgScore: Number(avgScore.toFixed(1)),
      topReasons,
      unlockRate,
      campusDistribution,
      gradeDistribution,
      genderDistribution,
      comparedToLastWeek
    });
  });

  router.get("/api/admin/feedback-stats", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || "").trim();
    const stats = db.getFeedbackStats({ weekKey: wk || "" });
    sendJson(res, 200, {
      weekKey: wk || null,
      ...stats
    });
  });

  router.get("/api/admin/announcements", async (req, res) => {
    assertAdmin(req);
    const items = db.listAnnouncements(50).map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      isActive: Number(row.is_active || 0) === 1,
      createdAt: row.created_at
    }));
    sendJson(res, 200, { items });
  });

  router.post("/api/admin/announcements", async (req, res, { body }) => {
    assertAdmin(req);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    const isActive = body.isActive === undefined ? 1 : (body.isActive ? 1 : 0);
    if (!title) {
      throw new AppError(400, "announcement_title_required", "公告标题不能为空");
    }
    if (!content) {
      throw new AppError(400, "announcement_content_required", "公告正文不能为空");
    }
    const row = db.createAnnouncement({ title, content, isActive });
    auditInfo(
      "ADMIN_ANNOUNCEMENT_CREATE",
      req.clientIp,
      `announcement_id=${row.id} is_active=${Number(row.is_active || 0)}`
    );
    sendJson(res, 200, {
      ok: true,
      item: {
        id: row.id,
        title: row.title,
        content: row.content,
        isActive: Number(row.is_active || 0) === 1,
        createdAt: row.created_at
      }
    });
  });

  router.get("/api/admin/export/users", async (req, res, { query }) => {
    assertAdmin(req);
    const search = String(query.search || "");
    const campus = String(query.campus || "");
    const grade = String(query.grade || "");
    const rows = db.listUsersForExport({ search, campus, grade }).map((row) => ({
      id: row.id,
      studentId: row.student_id,
      name: row.name,
      email: row.email,
      campus: row.campus || "",
      grade: row.grade || "",
      gender: row.gender || "",
      seeking: row.seeking || "",
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || ""
    }));
    const csv = toCsv(
      [
        { key: "id", title: "ID" },
        { key: "studentId", title: "学号" },
        { key: "name", title: "姓名" },
        { key: "email", title: "邮箱" },
        { key: "campus", title: "校区" },
        { key: "grade", title: "年级" },
        { key: "gender", title: "性别" },
        { key: "seeking", title: "希望认识" },
        { key: "createdAt", title: "注册时间" },
        { key: "updatedAt", title: "更新时间" }
      ],
      rows
    );
    sendCsv(res, "scu_datedrop_users.csv", csv);
  });

  router.get("/api/admin/export/matches", async (req, res, { query }) => {
    assertAdmin(req);
    const wk = String(query.weekKey || db.getLatestWeekKeyWithMatches() || weekKey());
    const rows = normalizeMatches(db.listMatchesByWeek(wk)).map((item) => ({
      weekKey: item.weekKey,
      matchId: item.id,
      userAName: item.userA.name,
      userAStudentId: item.userA.studentId,
      userAEmail: item.userA.email,
      userBName: item.userB.name,
      userBStudentId: item.userB.studentId,
      userBEmail: item.userB.email,
      score: Number(item.score || 0).toFixed(2),
      unlocked: item.contactUnlocked ? "是" : "否",
      reasons: item.reasons || "",
      createdAt: item.createdAt || ""
    }));
    const csv = toCsv(
      [
        { key: "weekKey", title: "周次" },
        { key: "matchId", title: "匹配ID" },
        { key: "userAName", title: "用户A姓名" },
        { key: "userAStudentId", title: "用户A学号" },
        { key: "userAEmail", title: "用户A邮箱" },
        { key: "userBName", title: "用户B姓名" },
        { key: "userBStudentId", title: "用户B学号" },
        { key: "userBEmail", title: "用户B邮箱" },
        { key: "score", title: "匹配分数" },
        { key: "unlocked", title: "联系方式是否解锁" },
        { key: "reasons", title: "匹配理由" },
        { key: "createdAt", title: "匹配创建时间" }
      ],
      rows
    );
    sendCsv(res, `scu_datedrop_matches_${wk}.csv`, csv);
  });

  router.post("/api/admin/run-match", async (req, res, { body }) => {
    assertAdmin(req);
    const confirmToken = String(body.confirmToken || "").trim();
    if (!confirmToken) {
      throw new AppError(400, "confirm_token_required", "请先申请操作令牌");
    }
    const consumed = consumeConfirmToken(db, {
      token: confirmToken,
      action: ACTION_ADMIN_RUN_MATCH,
      adminKeyPrefix: req.adminKeyPrefix || String(config.adminRunKey || "").slice(0, 8)
    });
    if (!consumed) {
      throw new AppError(403, "confirm_token_invalid", "操作令牌无效或已过期");
    }
    const wk = String(body.weekKey || weekKey());
    const startedAt = Date.now();
    const runOut = runWeeklyMatchFlow({
      weekKey: wk,
      baseUrl: req.publicBaseUrl || "",
      trigger: "admin_manual"
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const result = {
      ...runOut.result,
      durationMs
    };
    auditInfo(
      "MATCH_RUN_EXECUTED",
      `admin:${req.adminKeyPrefix || "unknown"}|ip:${req.clientIp}`,
      {
        weekKey: wk,
        participants: result.participants,
        candidates: result.candidates,
        belowThresholdCount: result.belowThresholdCount,
        matchedPairs: result.matchedPairs,
        mailQueued: runOut.queueResult.queued,
        durationMs
      }
    );
    sendJson(res, 200, {
      ok: true,
      result,
      queueResult: runOut.queueResult,
      summary: runOut.summary,
      adminNotify: runOut.adminNotify
    });
  });
}

module.exports = {
  registerAdminRoutes
};
