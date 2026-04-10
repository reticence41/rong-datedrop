const fs = require("node:fs");
const path = require("node:path");
const { chinaDate } = require("../time");

const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeText(value) {
  if (value === null || value === undefined) return "-";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 512) || "-";
}

function toDatePart(date = new Date()) {
  const d = chinaDate(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getAuditLogPath(date = new Date()) {
  return path.join(DATA_DIR, `audit_${toDatePart(date)}.log`);
}

function normalizeDetail(detail) {
  if (detail === null || detail === undefined) return {};
  if (typeof detail === "object" && !Array.isArray(detail)) return detail;
  if (Array.isArray(detail)) return { items: detail };
  return { message: String(detail) };
}

function writeAudit(eventType, actor, detail = {}) {
  const iso = new Date().toISOString();
  const safeEvent = safeText(eventType);
  const safeActor = safeText(actor);
  const detailText = JSON.stringify(normalizeDetail(detail));
  const line = `[${iso}] [AUDIT] [${safeEvent}] [${safeActor}] ${detailText}\n`;
  fs.appendFile(getAuditLogPath(), line, (err) => {
    if (err) {
      console.error(`[audit] write failed: ${err.message}`);
    }
  });
}

function auditInfo(eventType, actor, detail = {}) {
  writeAudit(eventType, actor, detail);
}

function auditWarn(eventType, actor, detail = {}) {
  writeAudit(eventType, actor, detail);
}

function auditError(eventType, actor, detail = {}) {
  writeAudit(eventType, actor, detail);
}

module.exports = {
  getAuditLogPath,
  writeAudit,
  auditInfo,
  auditWarn,
  auditError
};
