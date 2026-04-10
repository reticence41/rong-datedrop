const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { config } = require("../config");
const db = require("../db");
const { AppError, badRequest } = require("../lib/errors");
const { sendJson } = require("../lib/http");
const {
  normalizeAuthInput,
  ensureScuEmail,
  sanitizeUser
} = require("../lib/validation");
const { createSessionHelpers } = require("../lib/session");
const { auditInfo, auditWarn } = require("../lib/logger");

const sessionHelpers = createSessionHelpers(config, db);
let smtpTransporter = null;

function inferProviderByMode() {
  if (config.authMode === "email") return "email_otp";
  if (config.authMode === "cas") return "cas";
  return "dev";
}

function hashOtpCode(email, studentId, code) {
  return crypto
    .createHash("sha256")
    .update(`${config.email.otp.secret}|${String(email).toLowerCase()}|${studentId}|${code}`)
    .digest("hex");
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;
  smtpTransporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass
    }
  });
  return smtpTransporter;
}

async function sendOtpEmail({ email, code }) {
  const subject = "蓉约 DateDrop 校园交友认证验证码";
  const text = [
    "你好，",
    "",
    `你的验证码是：${code}`,
    `有效期：${Math.floor(config.email.otp.ttlSeconds / 60)} 分钟`,
    "",
    "如果这不是你本人操作，请忽略本邮件。"
  ].join("\n");
  if (config.email.smtp.debugConsole) {
    console.log(`[email-otp][debug] to=${email} code=${code}`);
    return;
  }
  const transporter = getSmtpTransporter();
  await transporter.sendMail({
    from: config.email.smtp.from,
    to: email,
    subject,
    text
  });
}

function validateAuthIdentity({ studentId, name, email }) {
  if (!studentId || studentId.length < 6) {
    throw badRequest("student_id_invalid", "学号格式错误");
  }
  if (!name) {
    throw badRequest("name_required", "姓名不能为空");
  }
  if (!ensureScuEmail(email, config.email.allowedDomains)) {
    throw new AppError(400, "email_not_scu_domain", "邮箱域名不在白名单", {
      acceptedDomains: config.email.allowedDomains
    });
  }
}

function loginAudit(req, { provider, studentId = "", userId = null, success, reason = "" }) {
  const actor = userId ? `user:${userId}|ip:${req.clientIp}` : `ip:${req.clientIp}`;
  const detail = {
    ip: req.clientIp,
    userAgent: String(req.headers["user-agent"] || ""),
    provider,
    studentId: studentId || "",
    userId: userId || null,
    result: success ? "success" : "fail",
    reason: reason || ""
  };
  if (success) {
    auditInfo("AUTH_LOGIN_SUCCESS", actor, detail);
  } else {
    auditWarn("AUTH_LOGIN_FAIL", actor, detail);
  }
}

function registerAuthRoutes(router) {
  router.post("/api/auth/dev-login", async (req, res, { body }) => {
    const authInput = normalizeAuthInput(body, config.limits);
    try {
      if (config.authMode === "cas" && process.env.ALLOW_DEV_LOGIN !== "1") {
        throw new AppError(403, "dev_login_disabled", "CAS 模式下已禁用开发登录");
      }

      validateAuthIdentity(authInput, "dev", req.clientIp);
      let user;
      try {
        user = db.upsertUserByStudentId({
          studentId: authInput.studentId,
          name: authInput.name,
          email: authInput.email,
          authProvider: "dev"
        });
      } catch (err) {
        if (String(err.message) === "email_already_bound_to_other_student_id") {
          throw new AppError(409, "email_already_bound_to_other_student_id", "邮箱已绑定其他学号");
        }
        throw err;
      }
      sessionHelpers.issueSession(req, res, user.id);
      loginAudit(req, {
        provider: "dev",
        studentId: authInput.studentId,
        userId: user.id,
        success: true
      });
      sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
    } catch (err) {
      loginAudit(req, {
        provider: "dev",
        studentId: authInput.studentId,
        success: false,
        reason: err && err.errorCode ? err.errorCode : String(err && err.message ? err.message : "unknown")
      });
      throw err;
    }
  });

  router.post("/api/auth/email/request-code", async (req, res, { body }) => {
    if (config.authMode !== "email") {
      throw new AppError(403, "email_otp_disabled", "邮箱验证码模式未启用");
    }
    const authInput = normalizeAuthInput(body, config.limits);
    validateAuthIdentity(authInput, "email_otp", req.clientIp);

    const latestOtp = db.getLatestEmailOtp(authInput.email, authInput.studentId);
    const nowMs = Date.now();
    if (latestOtp) {
      const latestMs = new Date(latestOtp.created_at).getTime();
      const waitMs = config.email.otp.resendCooldownSeconds * 1000 - (nowMs - latestMs);
      if (waitMs > 0) {
        throw new AppError(429, "otp_too_frequent", "验证码发送过于频繁", {
          retryAfterSeconds: Math.ceil(waitMs / 1000)
        });
      }
    }

    const code = generateOtpCode();
    const codeHash = hashOtpCode(authInput.email, authInput.studentId, code);
    const expiresAt = new Date(nowMs + config.email.otp.ttlSeconds * 1000).toISOString();
    db.createEmailOtp({
      email: authInput.email,
      studentId: authInput.studentId,
      name: authInput.name,
      codeHash,
      expiresAt
    });
    try {
      await sendOtpEmail({ email: authInput.email, code });
    } catch (err) {
      throw new AppError(500, "otp_email_send_failed", "验证码发送失败", {
        reason: String(err.message || "unknown")
      });
    }
    sendJson(res, 200, { ok: true, expiresInSeconds: config.email.otp.ttlSeconds });
  });

  router.post("/api/auth/email/verify-code", async (req, res, { body }) => {
    if (config.authMode !== "email") {
      throw new AppError(403, "email_otp_disabled", "邮箱验证码模式未启用");
    }
    const authInput = normalizeAuthInput(body, config.limits);
    try {
      validateAuthIdentity(authInput, "email_otp", req.clientIp);
      if (!/^\d{6}$/.test(authInput.code)) {
        throw badRequest("otp_invalid_format", "验证码格式错误");
      }

      const latestOtp = db.getLatestEmailOtp(authInput.email, authInput.studentId);
      if (!latestOtp) {
        throw badRequest("otp_not_found", "验证码不存在");
      }
      if (latestOtp.consumed_at) {
        throw badRequest("otp_already_used", "验证码已使用");
      }
      if (new Date(latestOtp.expires_at).getTime() < Date.now()) {
        throw badRequest("otp_expired", "验证码已过期");
      }
      if (Number(latestOtp.attempt_count || 0) >= config.email.otp.maxAttempts) {
        throw new AppError(429, "otp_too_many_attempts", "验证码尝试次数过多");
      }

      const expectedHash = hashOtpCode(authInput.email, authInput.studentId, authInput.code);
      if (expectedHash !== latestOtp.code_hash) {
        db.bumpEmailOtpAttempt(latestOtp.id);
        throw badRequest("otp_invalid", "验证码错误");
      }

      db.consumeEmailOtp(latestOtp.id);
      let user;
      try {
        user = db.upsertUserByStudentId({
          studentId: authInput.studentId,
          name: authInput.name,
          email: authInput.email,
          authProvider: inferProviderByMode()
        });
      } catch (err) {
        if (String(err.message) === "email_already_bound_to_other_student_id") {
          throw new AppError(409, "email_already_bound_to_other_student_id", "邮箱已绑定其他学号");
        }
        throw err;
      }
      sessionHelpers.issueSession(req, res, user.id);
      loginAudit(req, {
        provider: "email_otp",
        studentId: authInput.studentId,
        userId: user.id,
        success: true
      });
      sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
    } catch (err) {
      loginAudit(req, {
        provider: "email_otp",
        studentId: authInput.studentId,
        success: false,
        reason: err && err.errorCode ? err.errorCode : String(err && err.message ? err.message : "unknown")
      });
      throw err;
    }
  });

  router.post("/api/auth/logout", async (req, res) => {
    sessionHelpers.clearCurrentSession(req, res);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = {
  registerAuthRoutes
};
