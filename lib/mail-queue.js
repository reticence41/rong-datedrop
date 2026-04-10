const nodemailer = require("nodemailer");
const db = require("../db");
const { toIso } = require("../time");
const { config } = require("../config");
const { generateMatchAnalysis } = require("./ai-analysis");

const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_SECONDS = 60;

let transporter = null;

// ── Resend ──────────────────────────────────────────────────────────────────
function hasResendConfig() {
  return Boolean(config.email && config.email.resend && config.email.resend.apiKey);
}

async function sendViaResend({ from, to, subject, text, html }) {
  const apiKey = config.email.resend.apiKey;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to, subject, text, html })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}

// ── SMTP (nodemailer fallback) ────────────────────────────────────────────
function hasSmtpConfig() {
  return Boolean(
    config.email &&
      config.email.smtp &&
      config.email.smtp.host &&
      config.email.smtp.port &&
      config.email.smtp.user &&
      config.email.smtp.pass &&
      config.email.smtp.from
  );
}

function getTransporter() {
  if (transporter) return transporter;
  if (!hasSmtpConfig()) {
    throw new Error("smtp_not_configured");
  }
  transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass
    }
  });
  return transporter;
}

function hasMailConfig() {
  return hasResendConfig() || hasSmtpConfig();
}

function getBaseUrl(explicitBaseUrl = "") {
  const raw = String(explicitBaseUrl || config.baseUrl || `http://localhost:${config.port}`).trim();
  return raw.replace(/\/+$/, "");
}

function toReasonList(reasonsRaw) {
  let reasons = [];
  if (Array.isArray(reasonsRaw)) {
    reasons = reasonsRaw;
  } else {
    try {
      reasons = JSON.parse(String(reasonsRaw || "[]"));
    } catch {
      reasons = [];
    }
  }
  return reasons
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMatchResultMail({ user, partner, weekKey, score, reasons, entryUrl, aiAnalysis }) {
  const topReasons = toReasonList(reasons);
  const reasonsText = topReasons.length
    ? topReasons.map((item, idx) => `${idx + 1}. ${item}`).join("\n")
    : "1. 你们在问卷多个核心维度契合度较高\n2. 你们的生活节律与沟通风格较匹配";
  const reasonsHtml = topReasons.length
    ? topReasons
        .map((item) => `<li style="margin:0 0 6px; color:#5a5550;">${escapeHtml(item)}</li>`)
        .join("")
    : `<li style="margin:0 0 6px; color:#5a5550;">你们在问卷多个核心维度契合度较高</li><li style="margin:0 0 6px; color:#5a5550;">你们的生活节律与沟通风格较匹配</li>`;
  const subject = `「蓉约」你的第 ${weekKey} 周匹配结果来啦`;
  const aiSection = aiAnalysis ? `\nAI 智能分析：\n${aiAnalysis}\n` : "";
  const text = [
    `Hi ${user.name}，`,
    "",
    `你的第 ${weekKey} 周匹配结果已生成。`,
    `匹配分数：${Number(score).toFixed(2)} 分`,
    "",
    "匹配理由：",
    reasonsText,
    aiSection,
    "对方基本信息：",
    `- 姓名：${partner.name}`,
    `- 年级：${partner.grade || "未知年级"}`,
    `- 校区：${partner.campus || "未知校区"}`,
    "",
    `点击查看匹配详情并选择是否公开你的联系方式：${entryUrl}`,
    "隐私提示：你同意后对方可以看到你的联系方式，对方同意后你才能看到对方的联系方式。",
    "",
    "蓉约 DateDrop"
  ].join("\n");

  const html = `
    <div style="margin:0;padding:24px;background:#faf8f5;font-family:Inter,PingFang SC,Microsoft YaHei,sans-serif;color:#2d2a26;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e8e4df;border-radius:16px;overflow:hidden;">
        <div style="padding:18px 20px;background:linear-gradient(120deg,#242969,#1a116f 45%,#1f177b 100%);color:#fff;">
          <div style="font-size:12px;opacity:.9;letter-spacing:.08em;">蓉约 DateDrop</div>
          <h2 style="margin:8px 0 0;font-size:22px;line-height:1.35;">你的第 ${escapeHtml(weekKey)} 周匹配结果来啦</h2>
        </div>
        <div style="padding:20px;">
          <p style="margin:0 0 12px;color:#5a5550;line-height:1.75;">Hi ${escapeHtml(user.name)}，</p>
          <p style="margin:0 0 12px;color:#5a5550;line-height:1.75;">你本周的匹配分数为 <b style="color:#8b3a3a;">${Number(score).toFixed(
            2
          )} 分</b>。</p>
          <div style="padding:12px;border:1px solid #ece2d6;border-radius:12px;background:#fffdf8;">
            <div style="font-weight:700;color:#8b3a3a;margin:0 0 8px;">匹配理由</div>
            <ul style="padding-left:18px;margin:0;">${reasonsHtml}</ul>
          </div>
          ${aiAnalysis ? `
          <div style="margin-top:12px;padding:14px;border:1px solid #d4c4f0;border-radius:12px;background:linear-gradient(135deg,#f9f5ff,#fff);">
            <div style="font-weight:700;color:#6b3fa0;margin:0 0 8px;font-size:13px;letter-spacing:.04em;">✦ AI 智能分析</div>
            <p style="margin:0;font-size:14px;color:#4a4060;line-height:1.85;">${escapeHtml(aiAnalysis)}</p>
          </div>` : ""}
          <div style="margin-top:12px;padding:12px;border:1px solid #ece2d6;border-radius:12px;background:#fff;">
            <div style="font-weight:700;color:#8b3a3a;margin:0 0 8px;">对方基本信息</div>
            <div style="font-size:14px;color:#5a5550;line-height:1.8;">姓名：${escapeHtml(partner.name)}</div>
            <div style="font-size:14px;color:#5a5550;line-height:1.8;">年级：${escapeHtml(partner.grade || "未知年级")}</div>
            <div style="font-size:14px;color:#5a5550;line-height:1.8;">校区：${escapeHtml(partner.campus || "未知校区")}</div>
          </div>
          <p style="margin:14px 0 0;color:#5a5550;line-height:1.8;">请前往网站查看匹配详情并选择是否公开你的联系方式：</p>
          <p style="margin:8px 0 0;"><a href="${escapeHtml(
            entryUrl
          )}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#c14e2f;color:#fff;text-decoration:none;font-weight:700;">查看匹配结果</a></p>
          <p style="margin:14px 0 0;color:#7a6c60;font-size:13px;line-height:1.75;">隐私提示：你同意后对方可以看到你的联系方式，对方同意后你才能看到对方的联系方式。</p>
        </div>
      </div>
    </div>
  `;
  return { subject, text, html };
}

function buildUnlockedMail({ user, partner, contact, weekKey, entryUrl }) {
  const subject = `「蓉约」${partner.name} 已公开联系方式给你`;
  const text = [
    `Hi ${user.name}，`,
    "",
    `你的匹配对象「${partner.name}」（${weekKey}）已同意公开联系方式给你：`,
    `- 微信：${contact.wechat || "-"}`,
    `- QQ：${contact.qq || "-"}`,
    `- 备用邮箱：${contact.backupEmail || "-"}`,
    "",
    `查看详情：${entryUrl}`,
    "请尊重对方的隐私和边界，祝你们聊得愉快。",
    "",
    "蓉约 DateDrop"
  ].join("\n");
  const html = `
    <div style="margin:0;padding:24px;background:#faf8f5;font-family:Inter,PingFang SC,Microsoft YaHei,sans-serif;color:#2d2a26;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e8e4df;border-radius:16px;overflow:hidden;">
        <div style="padding:18px 20px;background:linear-gradient(120deg,#242969,#1a116f 45%,#1f177b 100%);color:#fff;">
          <div style="font-size:12px;opacity:.9;letter-spacing:.08em;">蓉约 DateDrop</div>
          <h2 style="margin:8px 0 0;font-size:22px;line-height:1.35;">对方已公开联系方式</h2>
        </div>
        <div style="padding:20px;">
          <p style="margin:0 0 12px;color:#5a5550;line-height:1.75;">Hi ${escapeHtml(user.name)}，</p>
          <p style="margin:0 0 12px;color:#5a5550;line-height:1.75;">你的匹配对象 <b style="color:#8b3a3a;">${escapeHtml(
            partner.name
          )}</b> 已同意公开联系方式给你：</p>
          <div style="padding:12px;border:1px solid #ece2d6;border-radius:12px;background:#fffdf8;line-height:1.8;color:#5a5550;">
            <div>微信：${escapeHtml(contact.wechat || "-")}</div>
            <div>QQ：${escapeHtml(contact.qq || "-")}</div>
            <div>备用邮箱：${escapeHtml(contact.backupEmail || "-")}</div>
          </div>
          <p style="margin:14px 0 0;"><a href="${escapeHtml(
            entryUrl
          )}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#c14e2f;color:#fff;text-decoration:none;font-weight:700;">前往网站查看</a></p>
          <p style="margin:14px 0 0;color:#7a6c60;font-size:13px;line-height:1.75;">请尊重对方的隐私和边界，祝你们聊得愉快。</p>
        </div>
      </div>
    </div>
  `;
  return { subject, text, html };
}

function enqueueEmail({ toEmail, subject, textBody, htmlBody, dedupeKey = null, maxAttempts = MAX_RETRY_ATTEMPTS }) {
  const now = toIso();
  const safeTo = String(toEmail || "").trim().toLowerCase();
  if (!safeTo) return 0;
  const run = db.exec(
    `INSERT INTO email_queue (
       dedupe_key, to_email, subject, text_body, html_body,
       status, attempts, max_attempts, next_attempt_at,
       last_error, created_at, updated_at, sent_at
     ) VALUES (
       :dedupeKey, :toEmail, :subject, :textBody, :htmlBody,
       'pending', 0, :maxAttempts, :nextAttemptAt,
       NULL, :createdAt, :updatedAt, NULL
     )
     ON CONFLICT(dedupe_key) DO NOTHING`,
    {
      dedupeKey: dedupeKey || null,
      toEmail: safeTo,
      subject: String(subject || "").trim(),
      textBody: String(textBody || "").trim(),
      htmlBody: String(htmlBody || "").trim(),
      maxAttempts: Math.max(1, Number(maxAttempts || MAX_RETRY_ATTEMPTS)),
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    }
  );
  return Number(run && run.changes ? run.changes : 0);
}

async function enqueueMatchResultNotifications(weekKey, explicitBaseUrl = "") {
  const rows = db.getWeekMatchDetails(weekKey);
  const baseUrl = getBaseUrl(explicitBaseUrl);
  const entryUrl = `${baseUrl}/?view=done&week=${encodeURIComponent(weekKey)}`;
  let queued = 0;
  for (const row of rows) {
    const reasons = toReasonList(row.reasons_json);

    // 尝试生成 AI 分析报告（若未配置 ANTHROPIC_API_KEY 则返回 null，静默跳过）
    const questionnaireA = db.getUserQuestionnaire(row.user_a_id);
    const questionnaireB = db.getUserQuestionnaire(row.user_b_id);
    let aiAnalysis = null;
    try {
      aiAnalysis = await generateMatchAnalysis({
        userA: { name: row.user_a_name, grade: row.user_a_grade, campus: row.user_a_campus, gender: row.user_a_gender },
        userB: { name: row.user_b_name, grade: row.user_b_grade, campus: row.user_b_campus, gender: row.user_b_gender },
        questionnaireA,
        questionnaireB,
        score: row.score,
        reasons
      });
      // Cache narrative in matches table for frontend display
      if (aiAnalysis) {
        try { db.setMatchNarrative(row.match_id || row.id, aiAnalysis); } catch {}
      }
    } catch (err) {
      // AI 分析失败不影响邮件正常发送
      console.error(`[ai-analysis] pair=${row.user_a_id}:${row.user_b_id} error:`, err && err.message);
    }

    const aMail = buildMatchResultMail({
      user: { id: row.user_a_id, name: row.user_a_name || "同学" },
      partner: { name: row.user_b_name || "同学", grade: row.user_b_grade || "", campus: row.user_b_campus || "" },
      weekKey,
      score: row.score,
      reasons,
      entryUrl,
      aiAnalysis
    });
    queued += enqueueEmail({
      toEmail: row.user_a_email,
      subject: aMail.subject,
      textBody: aMail.text,
      htmlBody: aMail.html,
      dedupeKey: `match-result:${weekKey}:${row.user_a_id}`
    });

    const bMail = buildMatchResultMail({
      user: { id: row.user_b_id, name: row.user_b_name || "同学" },
      partner: { name: row.user_a_name || "同学", grade: row.user_a_grade || "", campus: row.user_a_campus || "" },
      weekKey,
      score: row.score,
      reasons,
      entryUrl,
      aiAnalysis
    });
    queued += enqueueEmail({
      toEmail: row.user_b_email,
      subject: bMail.subject,
      textBody: bMail.text,
      htmlBody: bMail.html,
      dedupeKey: `match-result:${weekKey}:${row.user_b_id}`
    });
  }
  return { weekKey, matchPairs: rows.length, queued };
}

function enqueueContactUnlockedNotifications(matchId, explicitBaseUrl = "", consentUserId = null) {
  const row = db.getMatchDetail(matchId);
  if (!row) {
    return { matchId, queued: 0, reason: "match_not_found" };
  }
  // 单向同意：只通知对方（即能看到同意者联系方式的那个人）
  const baseUrl = getBaseUrl(explicitBaseUrl);
  const entryUrl = `${baseUrl}/?view=done&match=${matchId}`;
  let queued = 0;

  // 确定同意者和接收通知者
  const isA = consentUserId === row.user_a_id;
  const isB = consentUserId === row.user_b_id;

  // 如果 A 同意了，通知 B（B 现在可以看到 A 的联系方式）
  if (!consentUserId || isA) {
    const mail = buildUnlockedMail({
      user: { name: row.user_b_name || "同学" },
      partner: { name: row.user_a_name || "同学" },
      contact: {
        wechat: row.user_a_wechat,
        qq: row.user_a_qq,
        backupEmail: row.user_a_backup_email
      },
      weekKey: row.week_key,
      entryUrl
    });
    queued += enqueueEmail({
      toEmail: row.user_b_email,
      subject: mail.subject,
      textBody: mail.text,
      htmlBody: mail.html,
      dedupeKey: `unlock:${matchId}:${row.user_a_id}:to:${row.user_b_id}`
    });
  }

  // 如果 B 同意了，通知 A（A 现在可以看到 B 的联系方式）
  if (!consentUserId || isB) {
    const mail = buildUnlockedMail({
      user: { name: row.user_a_name || "同学" },
      partner: { name: row.user_b_name || "同学" },
      contact: {
        wechat: row.user_b_wechat,
        qq: row.user_b_qq,
        backupEmail: row.user_b_backup_email
      },
      weekKey: row.week_key,
      entryUrl
    });
    queued += enqueueEmail({
      toEmail: row.user_a_email,
      subject: mail.subject,
      textBody: mail.text,
      htmlBody: mail.html,
      dedupeKey: `unlock:${matchId}:${row.user_b_id}:to:${row.user_a_id}`
    });
  }

  return { matchId, queued, reason: "ok" };
}

function getDueEmails(limit = 20) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 20)));
  const now = toIso();
  return db.many(
    `SELECT *
     FROM email_queue
     WHERE status = 'pending'
       AND attempts < max_attempts
       AND datetime(next_attempt_at) <= datetime(:now)
     ORDER BY id ASC
     LIMIT ${safeLimit}`,
    { now }
  );
}

function computeBackoffSeconds(attempts) {
  const normalized = Math.max(1, Number(attempts || 1));
  return BASE_BACKOFF_SECONDS * (2 ** (normalized - 1));
}

async function processEmailQueue({ limit = 20 } = {}) {
  if (!hasMailConfig()) {
    return {
      processed: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
      reason: "mail_not_configured"
    };
  }
  const dueRows = getDueEmails(limit);
  if (!dueRows.length) {
    return { processed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, reason: "empty" };
  }

  // 优先 Resend，没有 Resend 配置则退回 nodemailer SMTP
  const useResend = hasResendConfig();
  const mailer = useResend ? null : getTransporter();
  const fromAddr = useResend ? config.email.resend.from : config.email.smtp.from;

  const stats = { processed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, reason: useResend ? "resend" : "smtp" };
  for (const row of dueRows) {
    stats.processed += 1;
    try {
      if (useResend) {
        await sendViaResend({
          from: fromAddr,
          to: row.to_email,
          subject: row.subject,
          text: row.text_body,
          html: row.html_body
        });
      } else {
        await mailer.sendMail({
          from: fromAddr,
          to: row.to_email,
          subject: row.subject,
          text: row.text_body,
          html: row.html_body
        });
      }
      db.exec(
        `UPDATE email_queue
         SET status='sent',
             sent_at=:sentAt,
             updated_at=:updatedAt,
             last_error=NULL
         WHERE id=:id`,
        {
          id: row.id,
          sentAt: toIso(),
          updatedAt: toIso()
        }
      );
      stats.sent += 1;
    } catch (err) {
      const nextAttempts = Number(row.attempts || 0) + 1;
      const safeErr = String(err && err.message ? err.message : "unknown").slice(0, 500);
      if (nextAttempts >= Number(row.max_attempts || MAX_RETRY_ATTEMPTS)) {
        db.exec(
          `UPDATE email_queue
           SET status='failed',
               attempts=:attempts,
               last_error=:lastError,
               updated_at=:updatedAt
           WHERE id=:id`,
          {
            id: row.id,
            attempts: nextAttempts,
            lastError: safeErr,
            updatedAt: toIso()
          }
        );
        stats.failed += 1;
      } else {
        const nextAttemptAt = new Date(Date.now() + computeBackoffSeconds(nextAttempts) * 1000).toISOString();
        db.exec(
          `UPDATE email_queue
           SET status='pending',
               attempts=:attempts,
               next_attempt_at=:nextAttemptAt,
               last_error=:lastError,
               updated_at=:updatedAt
           WHERE id=:id`,
          {
            id: row.id,
            attempts: nextAttempts,
            nextAttemptAt,
            lastError: safeErr,
            updatedAt: toIso()
          }
        );
        stats.retried += 1;
      }
    }
  }
  return stats;
}

module.exports = {
  hasResendConfig,
  hasSmtpConfig,
  hasMailConfig,
  enqueueEmail,
  enqueueMatchResultNotifications,
  enqueueContactUnlockedNotifications,
  processEmailQueue
};
