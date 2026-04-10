const DEFAULT_OTP_SECRET = "change-this-otp-secret";
const ENV_DEFAULTS = {
  development: {
    port: 3000,
    authMode: "dev"
  },
  production: {
    port: 3000,
    authMode: "dev"
  },
  test: {
    port: 3100,
    authMode: "dev"
  }
};

function splitList(value, fallback) {
  return String(value || fallback || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildConfig() {
  const env = (process.env.NODE_ENV || "development").toLowerCase();
  const envDefault = ENV_DEFAULTS[env] || ENV_DEFAULTS.development;
  const authMode = (process.env.AUTH_MODE || envDefault.authMode || "dev").toLowerCase();
  return {
    env,
    isProduction: env === "production",
    isTest: env === "test",
    port: asNumber(process.env.PORT, envDefault.port || 3000),
    baseUrl: String(process.env.BASE_URL || "").trim(),
    authMode,
    adminRunKey: String(process.env.ADMIN_RUN_KEY || "change-this-admin-key").trim(),
    adminNotifyEmail: String(process.env.ADMIN_NOTIFY_EMAIL || "").trim().toLowerCase(),
    matchSchedule: String(process.env.MATCH_SCHEDULE || "THU:21:00").trim().toUpperCase(),
    matchMinScore: asNumber(process.env.MATCH_MIN_SCORE, 25),
    mailProcessIntervalSeconds: asNumber(process.env.MAIL_PROCESS_INTERVAL_SECONDS, 300),
    session: {
      cookieName: "rong_session",
      csrfCookieName: "rong_csrf",
      casStateCookieName: "rong_cas_state",
      secureCookie: process.env.COOKIE_SECURE === "1",
      maxDays: 14,
      maxActive: 5
    },
    confirmTokenTtlSeconds: asNumber(process.env.CONFIRM_TOKEN_TTL_SECONDS, 300),
    cas: {
      baseUrl: String(process.env.CAS_BASE_URL || "").trim(),
      loginPath: String(process.env.CAS_LOGIN_PATH || "/login").trim(),
      validatePath: String(process.env.CAS_VALIDATE_PATH || "/serviceValidate").trim(),
      logoutPath: String(process.env.CAS_LOGOUT_PATH || "/logout").trim(),
      callbackPath: String(process.env.CAS_CALLBACK_PATH || "/auth/cas/callback").trim(),
      attrStudentIdKeys: splitList(process.env.CAS_ATTR_STUDENT_ID_KEYS, "user,studentId,uid,username"),
      attrNameKeys: splitList(process.env.CAS_ATTR_NAME_KEYS, "displayName,name,cn"),
      attrEmailKeys: splitList(process.env.CAS_ATTR_EMAIL_KEYS, "mail,email"),
      fetchTimeoutMs: asNumber(process.env.CAS_FETCH_TIMEOUT_MS, 8000)
    },
    email: {
      allowedDomains: require("./lib/universities").getAllDomains(),
      otp: {
        ttlSeconds: asNumber(process.env.OTP_TTL_SECONDS, 300),
        resendCooldownSeconds: asNumber(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60),
        maxAttempts: asNumber(process.env.OTP_MAX_ATTEMPTS, 5),
        secret: String(process.env.OTP_SECRET || DEFAULT_OTP_SECRET),
        defaultSecret: DEFAULT_OTP_SECRET
      },
      resend: {
        apiKey: String(process.env.RESEND_API_KEY || "").trim(),
        from: String(process.env.RESEND_FROM || "noreply@rong.cn").trim()
      },
      smtp: {
        host: String(process.env.SMTP_HOST || "smtp.qq.com").trim(),
        port: asNumber(process.env.SMTP_PORT, 465),
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "1" : true,
        user: String(process.env.SMTP_USER || "").trim(),
        pass: String(process.env.SMTP_PASS || "").trim(),
        from: String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
        debugConsole: process.env.EMAIL_DEBUG_CONSOLE === "1"
      }
    },
    llm: {
      apiKey: String(process.env.SILICONFLOW_API_KEY || "").trim(),
      baseUrl: String(process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1").trim(),
      model: String(process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V3").trim(),
      maxTokens: asNumber(process.env.LLM_MAX_TOKENS, 600),
      enabled: Boolean(process.env.SILICONFLOW_API_KEY)
    },
    limits: {
      name: 50,
      wechat: 20,
      qq: 12,
      email: 100,
      bio: 500,
      valueItem: 30,
      studentId: 64
    },
    rateLimit: {
      authPerMinute: 10,
      submitPerMinute: 5,
      adminRunPerMinute: 3,
      windowMs: 60 * 1000
    },
    securityHeaders: {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"
    }
  };
}

function validateConfig(config) {
  const validAuthModes = new Set(["dev", "cas", "email"]);
  if (!validAuthModes.has(config.authMode)) {
    throw new Error(`Invalid AUTH_MODE: ${config.authMode}`);
  }
  if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }
  if (!/^(SUN|MON|TUE|WED|THU|FRI|SAT):([01]\d|2[0-3]):([0-5]\d)$/.test(config.matchSchedule)) {
    throw new Error(`Invalid MATCH_SCHEDULE: ${config.matchSchedule}`);
  }
  if (!Number.isFinite(config.confirmTokenTtlSeconds) || config.confirmTokenTtlSeconds < 60 || config.confirmTokenTtlSeconds > 3600) {
    throw new Error(`Invalid CONFIRM_TOKEN_TTL_SECONDS: ${config.confirmTokenTtlSeconds}`);
  }
  if (
    !Number.isFinite(config.mailProcessIntervalSeconds) ||
    config.mailProcessIntervalSeconds < 60 ||
    config.mailProcessIntervalSeconds > 86400
  ) {
    throw new Error(`Invalid MAIL_PROCESS_INTERVAL_SECONDS: ${config.mailProcessIntervalSeconds}`);
  }
  if (!Number.isFinite(config.matchMinScore) || config.matchMinScore < 0 || config.matchMinScore > 100) {
    throw new Error(`Invalid MATCH_MIN_SCORE: ${config.matchMinScore}`);
  }
  if (config.adminNotifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminNotifyEmail)) {
    throw new Error(`Invalid ADMIN_NOTIFY_EMAIL: ${config.adminNotifyEmail}`);
  }
  if (config.authMode === "cas" && !config.cas.baseUrl) {
    throw new Error("AUTH_MODE=cas 时必须配置 CAS_BASE_URL");
  }
  if (config.authMode === "email") {
    const smtp = config.email.smtp;
    if (!smtp.host || !smtp.port || !smtp.user || !smtp.pass || !smtp.from) {
      throw new Error("AUTH_MODE=email 时必须配置 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM");
    }
    if (config.email.otp.secret === config.email.otp.defaultSecret) {
      console.error("[scu-engine][fatal] OTP_SECRET 仍为默认值，请先配置随机密钥后再启动。");
      throw new Error("OTP_SECRET 仍为默认值，邮箱验证码模式已拒绝启动");
    }
  }
}

function getSafeStartupConfig(config) {
  return {
    env: config.env,
    port: config.port,
    baseUrl: config.baseUrl || "(auto)",
    authMode: config.authMode,
    matchSchedule: config.matchSchedule,
    matchMinScore: config.matchMinScore,
    confirmTokenTtlSeconds: config.confirmTokenTtlSeconds,
    mailProcessIntervalSeconds: config.mailProcessIntervalSeconds,
    adminNotifyEmailConfigured: Boolean(config.adminNotifyEmail),
    cas: {
      baseUrl: config.cas.baseUrl || "(not set)",
      callbackPath: config.cas.callbackPath
    },
    email: {
      smtpHost: config.email.smtp.host,
      smtpPort: config.email.smtp.port,
      smtpFrom: config.email.smtp.from || "(not set)",
      debugConsole: config.email.smtp.debugConsole
    }
  };
}

const config = buildConfig();
validateConfig(config);

module.exports = {
  config,
  getSafeStartupConfig
};
