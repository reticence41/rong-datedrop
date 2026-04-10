const { config } = require("../config");
const db = require("../db");
const { runWeeklyMatch } = require("../match-engine");
const { enqueueEmail, enqueueMatchResultNotifications } = require("./mail-queue");

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  return Number(asNumber(value, 0).toFixed(2));
}

function computeScoreSummary(rows) {
  const scores = rows.map((row) => asNumber(row.score, 0));
  if (!scores.length) {
    return { highest: 0, lowest: 0, average: 0 };
  }
  const highest = Math.max(...scores);
  const lowest = Math.min(...scores);
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return {
    highest: round2(highest),
    lowest: round2(lowest),
    average: round2(average)
  };
}

function buildAdminSummaryMail({ weekKey, summary }) {
  const subject = `[SCU DateDrop] 第 ${weekKey} 周匹配完成`;
  const text = [
    `SCU DateDrop 第 ${weekKey} 周匹配任务已完成。`,
    "",
    `参与人数：${summary.participants}`,
    `匹配对数：${summary.matchedPairs}`,
    `未匹配人数：${summary.unmatchedUsers}`,
    `最高分：${summary.score.highest}`,
    `最低分：${summary.score.lowest}`,
    `平均分：${summary.score.average}`,
    "",
    `候选配对数：${summary.candidates}`,
    `低于阈值导致未入候选人数：${summary.belowThresholdCount}`,
    `结果通知入队：${summary.queueQueued}`,
    `执行耗时：${summary.durationMs} ms`
  ].join("\n");
  const html = `
    <div style="margin:0;padding:20px;background:#faf8f5;color:#2d2a26;font-family:Inter,PingFang SC,Microsoft YaHei,sans-serif;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e8e4df;border-radius:14px;overflow:hidden;">
        <div style="padding:16px 18px;background:linear-gradient(120deg,#242969,#1a116f 45%,#1f177b 100%);color:#fff;">
          <div style="font-size:12px;opacity:.9;letter-spacing:.06em;">SCU DateDrop</div>
          <h2 style="margin:8px 0 0;font-size:20px;line-height:1.4;">第 ${weekKey} 周匹配完成</h2>
        </div>
        <div style="padding:16px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;">
            <tr><td style="padding:4px 0;color:#5a5550;">参与人数</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.participants}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">匹配对数</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.matchedPairs}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">未匹配人数</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.unmatchedUsers}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">最高/最低/平均分</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.score.highest} / ${summary.score.lowest} / ${summary.score.average}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">候选配对数</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.candidates}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">低于阈值未入候选人数</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.belowThresholdCount}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">通知入队</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.queueQueued}</td></tr>
            <tr><td style="padding:4px 0;color:#5a5550;">执行耗时</td><td style="padding:4px 0;text-align:right;font-weight:700;">${summary.durationMs} ms</td></tr>
          </table>
        </div>
      </div>
    </div>
  `;
  return { subject, text, html };
}

function enqueueAdminSummaryEmail({ weekKey, summary }) {
  const to = String(config.adminNotifyEmail || "").trim().toLowerCase();
  if (!to) {
    return { enabled: false, queued: 0, reason: "admin_notify_email_not_configured" };
  }
  const mail = buildAdminSummaryMail({ weekKey, summary });
  const dedupeKey = `admin-summary:${weekKey}`;
  const queued = enqueueEmail({
    toEmail: to,
    subject: mail.subject,
    textBody: mail.text,
    htmlBody: mail.html,
    dedupeKey
  });
  return { enabled: true, queued, toEmail: to };
}

async function runWeeklyMatchFlow({ weekKey, baseUrl = "", trigger = "manual" }) {
  const startedAt = Date.now();
  const result = runWeeklyMatch(weekKey);
  const queueResult = await enqueueMatchResultNotifications(weekKey, baseUrl);
  const matchRows = db.getWeekMatchDetails(weekKey);
  const score = computeScoreSummary(matchRows);
  const participants = asNumber(result.participants, 0);
  const matchedPairs = asNumber(result.matchedPairs, 0);
  const summary = {
    trigger,
    weekKey,
    participants,
    candidates: asNumber(result.candidates, 0),
    belowThresholdCount: asNumber(result.belowThresholdCount, 0),
    matchedPairs,
    unmatchedUsers: Math.max(0, participants - matchedPairs * 2),
    score,
    queueQueued: asNumber(queueResult.queued, 0),
    durationMs: Math.max(0, Date.now() - startedAt)
  };
  const adminNotify = enqueueAdminSummaryEmail({ weekKey, summary });
  return {
    ok: true,
    weekKey,
    result,
    queueResult,
    summary,
    adminNotify
  };
}

module.exports = {
  runWeeklyMatchFlow
};
