const crypto = require("node:crypto");
const { config } = require("../config");
const db = require("../db");
const { AppError } = require("../lib/errors");
const { sendJson, redirect, setCookie, clearCookie } = require("../lib/http");
const { ensureScuEmail, inferNameFromStudentId } = require("../lib/validation");
const { createSessionHelpers } = require("../lib/session");
const { auditInfo, auditWarn } = require("../lib/logger");

const sessionHelpers = createSessionHelpers(config, db);

function loginAudit(req, { studentId = "", userId = null, success, reason = "" }) {
  const actor = userId ? `user:${userId}|ip:${req.clientIp}` : `ip:${req.clientIp}`;
  const detail = {
    ip: req.clientIp,
    userAgent: String(req.headers["user-agent"] || ""),
    provider: "cas",
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

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function findXmlTagValues(xml, tagName) {
  const name = escapeRegex(tagName);
  const reg = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "gi");
  const values = [];
  let matched = reg.exec(xml);
  while (matched) {
    values.push(decodeXmlEntities(matched[1]).trim());
    matched = reg.exec(xml);
  }
  return values.filter(Boolean);
}

function firstAttribute(xml, keys) {
  for (const key of keys) {
    const values = findXmlTagValues(xml, key);
    if (values.length) return values[0];
  }
  return "";
}

async function validateCasTicket(ticket, serviceUrl) {
  const endpoint = `${config.cas.baseUrl.replace(/\/+$/, "")}${config.cas.validatePath}?service=${encodeURIComponent(
    serviceUrl
  )}&ticket=${encodeURIComponent(ticket)}`;
  const resp = await fetch(endpoint, { signal: AbortSignal.timeout(config.cas.fetchTimeoutMs) });
  const xml = await resp.text();
  if (!resp.ok) {
    throw new AppError(502, "cas_validate_failed", "CAS 验票失败");
  }
  const failMatch = xml.match(
    /<(?:\w+:)?authenticationFailure(?:\s+code="([^"]+)")?[^>]*>([\s\S]*?)<\/(?:\w+:)?authenticationFailure>/i
  );
  if (failMatch) {
    const code = failMatch[1] || "CAS_AUTH_FAILURE";
    const msg = (failMatch[2] || "").trim().slice(0, 180);
    throw new AppError(401, "cas_auth_failure", `${code}:${msg}`);
  }
  const studentId = firstAttribute(xml, config.cas.attrStudentIdKeys) || firstAttribute(xml, ["user"]);
  if (!studentId) {
    throw new AppError(401, "cas_user_not_found", "CAS 返回缺少用户标识");
  }
  const parsedMail = firstAttribute(xml, config.cas.attrEmailKeys);
  const parsedName = firstAttribute(xml, config.cas.attrNameKeys);
  return {
    studentId: String(studentId).trim(),
    email: String(parsedMail || `${studentId}@unknown.edu.cn`)
      .trim()
      .toLowerCase(),
    name: String(parsedName || inferNameFromStudentId(studentId)).trim()
  };
}

function registerCasRoutes(router) {
  router.get("/auth/cas/login", async (req, res) => {
    if (config.authMode !== "cas") {
      throw new AppError(400, "auth_mode_not_cas", "当前不是 CAS 模式");
    }
    const state = crypto.randomBytes(24).toString("base64url");
    setCookie(res, config.session.casStateCookieName, state, {
      path: "/",
      maxAge: 10 * 60,
      httpOnly: true,
      sameSite: "Lax",
      secure: config.session.secureCookie
    });
    const serviceUrl = `${req.publicBaseUrl}${config.cas.callbackPath}?state=${encodeURIComponent(state)}`;
    const loginUrl = `${config.cas.baseUrl.replace(/\/+$/, "")}${config.cas.loginPath}?service=${encodeURIComponent(
      serviceUrl
    )}`;
    redirect(res, loginUrl);
  });

  router.get(config.cas.callbackPath, async (req, res, { query }) => {
    if (config.authMode !== "cas") {
      redirect(res, "/");
      return;
    }
    const ticket = String(query.ticket || "");
    const state = String(query.state || "");
    const cookieState = String(req.cookies[config.session.casStateCookieName] || "");
    clearCookie(res, config.session.casStateCookieName, config.session.secureCookie);
    if (!ticket) {
      loginAudit(req, { success: false, reason: "ticket_missing" });
      redirect(res, "/?auth=error&reason=ticket_missing");
      return;
    }
    if (!state || !cookieState || state !== cookieState) {
      loginAudit(req, { success: false, reason: "cas_state_invalid" });
      redirect(res, "/?auth=error&reason=cas_state_invalid");
      return;
    }
    const serviceUrl = `${req.publicBaseUrl}${config.cas.callbackPath}?state=${encodeURIComponent(state)}`;
    let casUser;
    try {
      casUser = await validateCasTicket(ticket, serviceUrl);
    } catch (err) {
      const reason = encodeURIComponent(err && err.message ? err.message : "cas_validate_failed");
      loginAudit(req, {
        success: false,
        reason: String(err && err.message ? err.message : "cas_validate_failed")
      });
      redirect(res, `/?auth=error&reason=${reason}`);
      return;
    }
    if (!ensureScuEmail(casUser.email, config.email.allowedDomains)) {
      loginAudit(req, {
        studentId: casUser.studentId,
        success: false,
        reason: "email_not_scu_domain"
      });
      redirect(res, "/?auth=error&reason=email_not_scu_domain");
      return;
    }
    let user;
    try {
      user = db.upsertUserByStudentId({
        studentId: casUser.studentId,
        name: casUser.name,
        email: casUser.email,
        authProvider: "cas"
      });
    } catch (err) {
      if (String(err.message) === "email_already_bound_to_other_student_id") {
        loginAudit(req, {
          studentId: casUser.studentId,
          success: false,
          reason: "email_already_bound_to_other_student_id"
        });
        redirect(res, "/?auth=error&reason=email_already_bound_to_other_student_id");
        return;
      }
      throw err;
    }
    sessionHelpers.issueSession(req, res, user.id);
    loginAudit(req, {
      studentId: casUser.studentId,
      userId: user.id,
      success: true
    });
    redirect(res, "/?auth=ok");
  });

  router.get("/auth/cas/logout", async (req, res) => {
    sessionHelpers.clearCurrentSession(req, res);
    if (config.authMode === "cas" && config.cas.baseUrl) {
      const returnUrl = `${req.publicBaseUrl}/`;
      const logoutUrl = `${config.cas.baseUrl.replace(/\/+$/, "")}${config.cas.logoutPath}?service=${encodeURIComponent(
        returnUrl
      )}`;
      redirect(res, logoutUrl);
      return;
    }
    redirect(res, "/");
  });
}

module.exports = {
  registerCasRoutes
};
