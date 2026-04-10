const db = require("../db");
const { weekKey } = require("../time");
const { sendJson, sendHtmlFile } = require("../lib/http");
const path = require("node:path");

const DASHBOARD_HTML_PATH = path.join(__dirname, "..", "dashboard.html");

function registerDashboardRoutes(router, deps = {}) {
  router.get("/dashboard.html", async (_req, res) => {
    sendHtmlFile(res, DASHBOARD_HTML_PATH);
  });

  // Public lightweight stats for index.html
  router.get("/api/stats/overview", async (_req, res) => {
    const totalUsers = db.countTotalUsers();
    const onlineCount = typeof deps.getOnlineCount === "function" ? deps.getOnlineCount() : 0;
    const pvStats = db.getPageViewStats();
    sendJson(res, 200, {
      totalUsers,
      onlineCount,
      pageViews: pvStats.total,
      pageViewsToday: pvStats.today,
      uniqueVisitors: pvStats.uniqueIpsTotal,
      uniqueVisitorsToday: pvStats.uniqueIpsToday
    });
  });

  router.get("/api/dashboard/stats", async (_req, res) => {
    const wk = weekKey();

    const totalUsers = db.countTotalUsers();
    const quizDone = Number(
      (db.one("SELECT COUNT(DISTINCT user_id) AS c FROM questionnaires") || {}).c || 0
    );
    const totalMatches = db.countTotalMatches();
    const thisWeekOptIns = db.countOptInForWeek(wk);
    const thisWeekMatched = db.countMatchedPairsForWeek(wk);
    const unlockedPairs = db.countUnlockedPairsForWeek(wk);
    const onlineCount = typeof deps.getOnlineCount === "function" ? deps.getOnlineCount() : 0;
    const pvStats = db.getPageViewStats();

    const genderRows = db.many(
      `SELECT
         CASE
           WHEN gender LIKE '%男%' THEN '男生'
           WHEN gender LIKE '%女%' THEN '女生'
           ELSE '未填写'
         END AS label,
         COUNT(*) AS count
       FROM users
       GROUP BY label
       ORDER BY count DESC`
    );

    const seekingRows = db.many(
      `SELECT
         CASE
           WHEN seeking LIKE '%男%' THEN '想认识男生'
           WHEN seeking LIKE '%女%' THEN '想认识女生'
           WHEN seeking LIKE '%都%' OR seeking LIKE '%不限%' OR seeking LIKE '%朋友%' THEN '其他(历史数据)'
           ELSE '未填写'
         END AS label,
         COUNT(*) AS count
       FROM users
       GROUP BY label
       ORDER BY count DESC`
    );

    const gradeRows = db.many(
      `SELECT COALESCE(NULLIF(TRIM(grade),''),'未填写') AS label, COUNT(*) AS count
       FROM users
       GROUP BY label
       ORDER BY count DESC`
    );

    const campusRows = db.many(
      `SELECT COALESCE(NULLIF(TRIM(campus),''),'未填写') AS label, COUNT(*) AS count
       FROM users
       GROUP BY label
       ORDER BY count DESC`
    );

    const growthRows = db.many(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM users
       WHERE created_at >= datetime('now','-30 days')
       GROUP BY day
       ORDER BY day ASC`
    );

    const hourlyRows = db.many(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count
       FROM users
       WHERE created_at >= datetime('now','-7 days')
       GROUP BY hour
       ORDER BY hour ASC`
    );

    const funnelRegistered = totalUsers;
    const funnelQuiz = quizDone;
    const funnelMatched = Number(
      (db.one("SELECT COUNT(DISTINCT user_a) + COUNT(DISTINCT user_b) AS c FROM matches") || {}).c || 0
    );

    sendJson(res, 200, {
      weekKey: wk,
      updatedAt: new Date().toISOString(),
      counters: {
        totalUsers,
        quizDone,
        totalMatches,
        thisWeekOptIns,
        thisWeekMatched,
        unlockedPairs,
        onlineCount,
        pageViews: pvStats.total,
        pageViewsToday: pvStats.today,
        uniqueVisitors: pvStats.uniqueIpsTotal
      },
      gender: genderRows.map((r) => ({ label: r.label, count: Number(r.count) })),
      seeking: seekingRows.map((r) => ({ label: r.label, count: Number(r.count) })),
      grade: gradeRows.map((r) => ({ label: r.label, count: Number(r.count) })),
      campus: campusRows.map((r) => ({ label: r.label, count: Number(r.count) })),
      growth: growthRows.map((r) => ({ day: r.day, count: Number(r.count) })),
      hourly: hourlyRows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) })),
      funnel: {
        registered: funnelRegistered,
        quizDone: funnelQuiz,
        matched: funnelMatched
      }
    });
  });
}

module.exports = { registerDashboardRoutes };
