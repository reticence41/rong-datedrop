const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaDate(date = new Date()) {
  return new Date(date.getTime() + CHINA_OFFSET_MS);
}

function toIso(date = new Date()) {
  return date.toISOString();
}

function weekKey(date = new Date()) {
  const c = chinaDate(date);
  const utcDate = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

module.exports = {
  chinaDate,
  toIso,
  weekKey
};
