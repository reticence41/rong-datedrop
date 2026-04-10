const { ALL_SLIDER_KEYS } = require("../match-engine");
const { AppError } = require("./errors");

const ALLOWED_SLIDER_KEYS = new Set(ALL_SLIDER_KEYS);

function normalizeString(value, maxLen, { lowerCase = false } = {}) {
  let text = String(value ?? "").trim();
  if (lowerCase) text = text.toLowerCase();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function normalizeAuthInput(body = {}, limits) {
  return {
    studentId: normalizeString(body.studentId, limits.studentId),
    name: normalizeString(body.name, limits.name),
    email: normalizeString(body.email, limits.email, { lowerCase: true }),
    code: normalizeString(body.code, 12)
  };
}

function normalizeProfileInput(profile = {}, limits) {
  return {
    gender: normalizeString(profile.gender, 20),
    seeking: normalizeString(profile.seeking, 20),
    grade: normalizeString(profile.grade, 20),
    campus: normalizeString(profile.campus, 20),
    wechat: normalizeString(profile.wechat, limits.wechat),
    qq: normalizeString(profile.qq, limits.qq),
    backupEmail: normalizeString(profile.backupEmail, limits.email, { lowerCase: true }),
    bio: normalizeString(profile.bio, limits.bio),
    seekingGrades: Array.isArray(profile.seekingGrades)
      ? profile.seekingGrades.map((g) => normalizeString(g, 20)).filter(Boolean)
      : []
  };
}

function normalizeQuestionnaireInput(body = {}, limits) {
  const values = Array.isArray(body.values)
    ? body.values.map((item) => normalizeString(item, limits.valueItem)).filter(Boolean)
    : [];
  const sliders =
    body.sliders && typeof body.sliders === "object" && !Array.isArray(body.sliders)
      ? body.sliders
      : {};
  return { values, sliders };
}

function ensureScuEmail(email, allowedDomains) {
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = normalized.slice(at + 1);
  return allowedDomains.includes(domain);
}

function inferUniversityFromEmail(email) {
  const { findByDomain } = require("./universities");
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "";
  const domain = normalized.slice(at + 1);
  const uni = findByDomain(domain);
  return uni ? uni.id : "";
}

function inferNameFromStudentId(studentId) {
  return `同学${String(studentId || "").slice(-4)}`;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    studentId: user.student_id,
    name: user.name,
    email: user.email,
    campus: user.campus,
    grade: user.grade,
    gender: user.gender,
    seeking: user.seeking,
    verifiedAt: user.verified_at
  };
}

function validateProfile(profile) {
  const required = ["gender", "seeking", "grade", "campus"];
  for (const key of required) {
    if (!profile[key] || typeof profile[key] !== "string") {
      return `${key}_required`;
    }
  }
  const wechat = String(profile.wechat || "").trim();
  const qq = String(profile.qq || "").trim();
  const backupEmail = String(profile.backupEmail || "").trim();
  const hasContact = Boolean(wechat || qq || backupEmail);
  if (!hasContact) return "contact_required";
  if (wechat && !/^[a-zA-Z][-_a-zA-Z0-9]{5,19}$/.test(wechat)) return "wechat_invalid";
  if (qq && !/^[1-9][0-9]{4,11}$/.test(qq)) return "qq_invalid";
  if (backupEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(backupEmail)) return "backup_email_invalid";
  return null;
}

function assertSliderWhitelist(sliders) {
  const keys = Object.keys(sliders || {});
  for (const key of keys) {
    if (!ALLOWED_SLIDER_KEYS.has(key)) {
      throw new AppError(400, "slider_key_invalid", `非法量表字段: ${key}`);
    }
  }
}

function validateQuestionnaire(questionnaire) {
  const values = Array.isArray(questionnaire.values) ? questionnaire.values : [];
  const sliders =
    questionnaire.sliders &&
    typeof questionnaire.sliders === "object" &&
    !Array.isArray(questionnaire.sliders)
      ? questionnaire.sliders
      : null;
  if (values.length < 6 || values.length > 30) return "values_count_invalid";
  if (!sliders) return "sliders_required";
  const sliderKeys = Object.keys(sliders);
  if (sliderKeys.length < 10) return "sliders_too_few";
  for (const valueItem of values) {
    if (!String(valueItem || "").trim()) return "value_item_invalid";
    if (String(valueItem).length > 30) return "value_item_too_long";
  }
  for (const key of sliderKeys) {
    if (!ALLOWED_SLIDER_KEYS.has(key)) return `slider_${key}_invalid`;
    const num = Number(sliders[key]);
    if (!Number.isFinite(num) || num < 1 || num > 7) return `slider_${key}_invalid`;
  }
  return null;
}

module.exports = {
  ALLOWED_SLIDER_KEYS,
  assertSliderWhitelist,
  normalizeAuthInput,
  normalizeProfileInput,
  normalizeQuestionnaireInput,
  ensureScuEmail,
  inferUniversityFromEmail,
  inferNameFromStudentId,
  sanitizeUser,
  validateProfile,
  validateQuestionnaire
};
