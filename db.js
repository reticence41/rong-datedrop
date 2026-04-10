const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { toIso, weekKey: toWeekKey } = require("./time");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "scu_match.db");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

function trimToMax(value, maxLen) {
  const text = String(value ?? "").trim();
  if (maxLen <= 0) return "";
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function parseIsoWeekStart(week) {
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

function previousWeek(week) {
  const start = parseIsoWeekStart(week);
  if (!start) return "";
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() - 7);
  return toWeekKey(d);
}

let writeLockDepth = 0;

function withReadLock(fn) {
  return fn();
}

function withWriteLock(fn) {
  writeLockDepth += 1;
  try {
    return fn();
  } finally {
    writeLockDepth -= 1;
  }
}

function ensureMigrationTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function migrationApplied(name) {
  return one("SELECT 1 AS ok FROM schema_migrations WHERE name=:name", { name });
}

function markMigrationApplied(name) {
  exec(
    `INSERT INTO schema_migrations (name, applied_at)
     VALUES (:name, :appliedAt)`,
    { name, appliedAt: toIso() }
  );
}

function applyMigration(name, sql) {
  withWriteLock(() => {
    db.exec("BEGIN;");
    try {
      db.exec(sql);
      markMigrationApplied(name);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      const msg = String(err && err.message ? err.message : "");
      // Allow idempotent column migration when column already exists.
      if (msg.toLowerCase().includes("duplicate column name")) {
        markMigrationApplied(name);
        return;
      }
      throw err;
    }
  });
}

function runMigrations() {
  ensureMigrationTable();
  const files = listMigrationFiles();
  for (const file of files) {
    if (migrationApplied(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    applyMigration(file, sql);
  }
}

function initSchema() {
  runMigrations();
}

function one(sql, params = {}) {
  return withReadLock(() => db.prepare(sql).get(params));
}

function many(sql, params = {}) {
  return withReadLock(() => db.prepare(sql).all(params));
}

function exec(sql, params = {}) {
  return withWriteLock(() => db.prepare(sql).run(params));
}

function transaction(fn) {
  return withWriteLock(() => {
    db.exec("BEGIN;");
    try {
      const out = fn();
      db.exec("COMMIT;");
      return out;
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function upsertUserByStudentId({ studentId, name, email, authProvider = "dev" }) {
  const safeStudentId = trimToMax(studentId, 64);
  const safeName = trimToMax(name, 50);
  const safeEmail = trimToMax(email, 100).toLowerCase();
  const safeAuthProvider = trimToMax(authProvider, 32) || "dev";
  const { inferUniversityFromEmail } = require("./lib/validation");
  const university = inferUniversityFromEmail(safeEmail);
  const now = toIso();
  const current = one("SELECT * FROM users WHERE student_id = :studentId", { studentId: safeStudentId });
  const byEmail = one("SELECT * FROM users WHERE email = :email", { email: safeEmail });
  if (byEmail && byEmail.student_id !== safeStudentId) {
    throw new Error("email_already_bound_to_other_student_id");
  }
  if (current) {
    exec(
      `UPDATE users
       SET name = :name, email = :email, auth_provider = :authProvider, university = :university, verified_at = :now, updated_at = :now
       WHERE id = :id`,
      { id: current.id, name: safeName, email: safeEmail, authProvider: safeAuthProvider, university, now }
    );
    return one("SELECT * FROM users WHERE id = :id", { id: current.id });
  }
  exec(
    `INSERT INTO users (student_id, name, email, auth_provider, university, verified_at, created_at, updated_at)
     VALUES (:studentId, :name, :email, :authProvider, :university, :now, :now, :now)`,
    { studentId: safeStudentId, name: safeName, email: safeEmail, authProvider: safeAuthProvider, university, now }
  );
  return one("SELECT * FROM users WHERE student_id = :studentId", { studentId: safeStudentId });
}

function createSession(userId, days = 14, maxActiveSessions = 5) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = toIso();
  transaction(() => {
    exec(
      `DELETE FROM sessions
       WHERE user_id = :userId AND expires_at < :nowIso`,
      { userId, nowIso }
    );
    exec(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
       VALUES (:tokenHash, :userId, :expiresAt, :createdAt)`,
      { tokenHash, userId, expiresAt, createdAt: nowIso }
    );
    const rows = many(
      `SELECT id
       FROM sessions
       WHERE user_id = :userId
       ORDER BY datetime(created_at) DESC, id DESC`,
      { userId }
    );
    if (rows.length > maxActiveSessions) {
      for (const row of rows.slice(maxActiveSessions)) {
        exec("DELETE FROM sessions WHERE id = :id", { id: row.id });
      }
    }
  });
  return { token, expiresAt };
}

function getSessionUser(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = one(
    `SELECT s.id AS session_id, s.expires_at, u.*
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = :tokenHash`,
    { tokenHash }
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    exec("DELETE FROM sessions WHERE id = :id", { id: row.session_id });
    return null;
  }
  return row;
}

function ping() {
  const row = one("SELECT 1 AS ok");
  return Boolean(row && row.ok === 1);
}

function deleteSessionByToken(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  exec("DELETE FROM sessions WHERE token_hash = :tokenHash", { tokenHash });
}

function createEmailOtp({ email, studentId, name, codeHash, expiresAt }) {
  const safeEmail = trimToMax(email, 100).toLowerCase();
  const safeStudentId = trimToMax(studentId, 64);
  const safeName = trimToMax(name, 50);
  const safeCodeHash = trimToMax(codeHash, 128);
  const safeExpiresAt = trimToMax(expiresAt, 64);
  const now = toIso();
  exec(
    `INSERT INTO email_otps (email, student_id, name, code_hash, expires_at, created_at)
     VALUES (:email, :studentId, :name, :codeHash, :expiresAt, :createdAt)`,
    {
      email: safeEmail,
      studentId: safeStudentId,
      name: safeName,
      codeHash: safeCodeHash,
      expiresAt: safeExpiresAt,
      createdAt: now
    }
  );
  return one("SELECT * FROM email_otps WHERE id = last_insert_rowid()");
}

function getLatestEmailOtp(email, studentId) {
  return one(
    `SELECT *
     FROM email_otps
     WHERE email=:email AND student_id=:studentId
     ORDER BY id DESC
     LIMIT 1`,
    { email, studentId }
  );
}

function bumpEmailOtpAttempt(id) {
  exec(
    `UPDATE email_otps
     SET attempt_count = attempt_count + 1
     WHERE id=:id`,
    { id }
  );
}

function consumeEmailOtp(id) {
  exec(
    `UPDATE email_otps
     SET consumed_at=:consumedAt
     WHERE id=:id`,
    { id, consumedAt: toIso() }
  );
}

function updateUserProfile(userId, profile) {
  const safeGender = trimToMax(profile.gender, 20);
  const safeSeeking = trimToMax(profile.seeking, 20);
  const safeGrade = trimToMax(profile.grade, 20);
  const safeCampus = trimToMax(profile.campus, 20);
  const safeWechat = trimToMax(profile.wechat, 20);
  const safeQq = trimToMax(profile.qq, 12);
  const safeBackupEmail = trimToMax(profile.backupEmail, 100).toLowerCase();
  const safeBio = trimToMax(profile.bio, 500);
  const safeSeekingGrades = JSON.stringify(
    Array.isArray(profile.seekingGrades) ? profile.seekingGrades.map((g) => trimToMax(g, 20)).filter(Boolean) : []
  );
  exec(
    `UPDATE users
     SET gender=:gender, seeking=:seeking, grade=:grade, campus=:campus, wechat=:wechat, qq=:qq, backup_email=:backupEmail, bio=:bio, seeking_grades=:seekingGrades, updated_at=:updatedAt
     WHERE id=:userId`,
    {
      userId,
      gender: safeGender,
      seeking: safeSeeking,
      grade: safeGrade,
      campus: safeCampus,
      wechat: safeWechat || null,
      qq: safeQq || null,
      backupEmail: safeBackupEmail || null,
      bio: safeBio || null,
      seekingGrades: safeSeekingGrades,
      updatedAt: toIso()
    }
  );
}

function upsertQuestionnaire(userId, values, sliders) {
  const safeValues = (Array.isArray(values) ? values : [])
    .map((x) => trimToMax(x, 30))
    .filter(Boolean);
  const now = toIso();
  const existing = one("SELECT id FROM questionnaires WHERE user_id = :userId", { userId });
  if (existing) {
    exec(
      `UPDATE questionnaires
       SET values_json=:valuesJson, sliders_json=:slidersJson, updated_at=:updatedAt
       WHERE user_id=:userId`,
      { userId, valuesJson: JSON.stringify(safeValues), slidersJson: JSON.stringify(sliders || {}), updatedAt: now }
    );
    return;
  }
  exec(
    `INSERT INTO questionnaires (user_id, values_json, sliders_json, updated_at)
     VALUES (:userId, :valuesJson, :slidersJson, :updatedAt)`,
    { userId, valuesJson: JSON.stringify(safeValues), slidersJson: JSON.stringify(sliders || {}), updatedAt: now }
  );
}

function setOptIn(userId, weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  const now = toIso();
  exec(
    `INSERT INTO opt_ins (user_id, week_key, status, created_at)
     VALUES (:userId, :weekKey, 'active', :createdAt)
     ON CONFLICT(user_id, week_key) DO UPDATE SET status='active', created_at=:createdAt`,
    { userId, weekKey: safeWeekKey, createdAt: now }
  );
}

function getUserQuestionnaire(userId) {
  const q = one("SELECT values_json, sliders_json FROM questionnaires WHERE user_id=:userId", { userId });
  if (!q) return null;
  return {
    values: JSON.parse(q.values_json),
    sliders: JSON.parse(q.sliders_json)
  };
}

function getUserById(userId) {
  return one("SELECT * FROM users WHERE id=:userId", { userId });
}

function countActiveUsers() {
  const nowIso = new Date().toISOString();
  const row = one(
    `SELECT COUNT(DISTINCT user_id) AS count
     FROM sessions
     WHERE expires_at >= :nowIso`,
    { nowIso }
  );
  return Number(row && row.count ? row.count : 0);
}

function countOptInForWeek(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  const row = one(
    `SELECT COUNT(1) AS count
     FROM opt_ins
     WHERE week_key = :weekKey
       AND status = 'active'`,
    { weekKey: safeWeekKey }
  );
  return Number(row && row.count ? row.count : 0);
}

function countTotalUsers() {
  const row = one("SELECT COUNT(1) AS count FROM users");
  return Number(row && row.count ? row.count : 0);
}

function countUsersCreatedBetween(startIso, endIso) {
  const row = one(
    `SELECT COUNT(1) AS count
     FROM users
     WHERE datetime(created_at) >= datetime(:startIso)
       AND datetime(created_at) < datetime(:endIso)`,
    { startIso, endIso }
  );
  return Number(row && row.count ? row.count : 0);
}

function countTotalMatches() {
  const row = one("SELECT COUNT(1) AS count FROM matches");
  return Number(row && row.count ? row.count : 0);
}

function countMatchedPairsForWeek(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  const row = one(
    `SELECT COUNT(1) AS count
     FROM matches
     WHERE week_key = :weekKey`,
    { weekKey: safeWeekKey }
  );
  return Number(row && row.count ? row.count : 0);
}

function getAverageMatchScoreForWeek(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  const row = one(
    `SELECT AVG(score) AS avg_score
     FROM matches
     WHERE week_key = :weekKey`,
    { weekKey: safeWeekKey }
  );
  const avg = Number(row && row.avg_score ? row.avg_score : 0);
  if (!Number.isFinite(avg)) return 0;
  return avg;
}

function listMatchReasonsForWeek(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  return many(
    `SELECT reasons_json
     FROM matches
     WHERE week_key = :weekKey`,
    { weekKey: safeWeekKey }
  );
}

function countUnlockedPairsForWeek(weekKey) {
  // 取消双方同意机制后，所有匹配对都视为已解锁
  const safeWeekKey = trimToMax(weekKey, 32);
  const row = one(
    `SELECT COUNT(1) AS count
     FROM matches m
     WHERE m.week_key = :weekKey`,
    { weekKey: safeWeekKey }
  );
  return Number(row && row.count ? row.count : 0);
}

function getLatestMatchRun() {
  return one(
    `SELECT week_key, run_at, candidate_count, matched_count
     FROM match_runs
     ORDER BY datetime(run_at) DESC
     LIMIT 1`
  );
}

function getLatestWeekKeyWithMatches() {
  const row = one(
    `SELECT week_key
     FROM matches
     ORDER BY week_key DESC
     LIMIT 1`
  );
  return row ? String(row.week_key || "") : "";
}

function getEmailQueueStats() {
  const row = one(
    `SELECT
       COUNT(1) AS total,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM email_queue`
  ) || { total: 0, pending: 0, sent: 0, failed: 0 };
  return {
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0)
  };
}

function listMatchRuns() {
  return many(
    `SELECT week_key, run_at, candidate_count, matched_count
     FROM match_runs
     ORDER BY week_key DESC`
  );
}

function escapeLike(raw) {
  return String(raw || "").replace(/[%_\\]/g, "\\$&");
}

function buildUserFilter({ search = "", campus = "", grade = "" } = {}) {
  const where = [];
  const params = {};
  const searchText = String(search || "").trim();
  if (searchText) {
    params.search = `%${escapeLike(searchText)}%`;
    where.push("(student_id LIKE :search ESCAPE '\\' OR name LIKE :search ESCAPE '\\')");
  }
  const campusText = String(campus || "").trim();
  if (campusText) {
    params.campus = campusText;
    where.push("campus = :campus");
  }
  const gradeText = String(grade || "").trim();
  if (gradeText) {
    params.grade = gradeText;
    where.push("grade = :grade");
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

function listUsersPaged({ page = 1, limit = 20, search = "", campus = "", grade = "" } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
  const safePage = Math.max(1, Number(page || 1));
  const offset = (safePage - 1) * safeLimit;
  const filter = buildUserFilter({ search, campus, grade });

  const totalRow = one(
    `SELECT COUNT(1) AS count
     FROM users
     ${filter.whereSql}`,
    filter.params
  );
  const items = many(
    `SELECT id, student_id, name, email, campus, grade, created_at, updated_at
     FROM users
     ${filter.whereSql}
     ORDER BY id DESC
     LIMIT :limit OFFSET :offset`,
    {
      ...filter.params,
      limit: safeLimit,
      offset
    }
  );
  return {
    page: safePage,
    limit: safeLimit,
    total: Number(totalRow && totalRow.count ? totalRow.count : 0),
    items
  };
}

function listUsersForExport({ search = "", campus = "", grade = "" } = {}) {
  const filter = buildUserFilter({ search, campus, grade });
  return many(
    `SELECT id, student_id, name, email, campus, grade, gender, seeking, created_at, updated_at
     FROM users
     ${filter.whereSql}
     ORDER BY id ASC`,
    filter.params
  );
}

function getParticipantPool(weekKey) {
  const rows = many(
    `SELECT u.*, q.values_json, q.sliders_json, o.created_at AS opt_in_created_at
     FROM opt_ins o
     JOIN users u ON u.id = o.user_id
     JOIN questionnaires q ON q.user_id = u.id
     WHERE o.week_key = :weekKey AND o.status='active'`,
    { weekKey }
  );
  return rows.map((r) => ({
    ...r,
    values: JSON.parse(r.values_json),
    sliders: JSON.parse(r.sliders_json),
    seekingGrades: (() => { try { return JSON.parse(r.seeking_grades || "[]"); } catch { return []; } })()
  }));
}

function listOptInUsersBasic(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  return many(
    `SELECT
       u.id,
       u.name,
       u.campus,
       u.grade,
       u.gender,
       o.created_at AS opt_in_created_at
     FROM opt_ins o
     JOIN users u ON u.id = o.user_id
     WHERE o.week_key = :weekKey
       AND o.status = 'active'
     ORDER BY datetime(o.created_at) ASC, u.id ASC`,
    { weekKey: safeWeekKey }
  );
}

function getAllHistoricalPairs(excludeWeekKey = "") {
  const hasExclude = Boolean(String(excludeWeekKey || "").trim());
  const rows = hasExclude
    ? many(
        `SELECT user_a, user_b
         FROM matches
         WHERE week_key <> :excludeWeekKey`,
        { excludeWeekKey: trimToMax(excludeWeekKey, 32) }
      )
    : many("SELECT user_a, user_b FROM matches");
  const out = new Map();
  for (const row of rows) {
    const a = Math.min(Number(row.user_a || 0), Number(row.user_b || 0));
    const b = Math.max(Number(row.user_a || 0), Number(row.user_b || 0));
    if (a <= 0 || b <= 0) continue;
    const key = `${a}:${b}`;
    out.set(key, Number(out.get(key) || 0) + 1);
  }
  return out;
}

function getConsecutiveUnmatchedWeeks(userId, currentWeekKey = "") {
  const uid = Number(userId || 0);
  if (!Number.isInteger(uid) || uid <= 0) return 0;

  const optInRows = many(
    `SELECT week_key
     FROM opt_ins
     WHERE user_id = :userId
       AND status = 'active'`,
    { userId: uid }
  );
  if (!optInRows.length) return 0;

  const matchedRows = many(
    `SELECT week_key
     FROM matches
     WHERE user_a = :userId OR user_b = :userId`,
    { userId: uid }
  );

  const optInSet = new Set(optInRows.map((row) => String(row.week_key || "").trim()).filter(Boolean));
  const matchedSet = new Set(matchedRows.map((row) => String(row.week_key || "").trim()).filter(Boolean));

  const anchorWeek = String(currentWeekKey || "").trim() || Array.from(optInSet).sort().at(-1) || "";
  if (!anchorWeek) return 0;

  let cursor = previousWeek(anchorWeek);
  let streak = 0;
  while (cursor && optInSet.has(cursor) && !matchedSet.has(cursor)) {
    streak += 1;
    cursor = previousWeek(cursor);
  }
  return streak;
}

function replaceWeekMatches(weekKey, pairs) {
  const safeWeekKey = trimToMax(weekKey, 32);
  transaction(() => {
    const oldIds = many("SELECT id FROM matches WHERE week_key=:weekKey", { weekKey: safeWeekKey }).map((x) => x.id);
    if (oldIds.length) {
      const ids = oldIds.join(",");
      db.exec(`DELETE FROM match_consents WHERE match_id IN (${ids})`);
    }
    exec("DELETE FROM matches WHERE week_key=:weekKey", { weekKey: safeWeekKey });
    for (const pair of pairs) {
      exec(
        `INSERT INTO matches (week_key, user_a, user_b, score, confidence, reasons_json, created_at)
         VALUES (:weekKey, :userA, :userB, :score, :confidence, :reasonsJson, :createdAt)`,
        {
          weekKey: safeWeekKey,
          userA: pair.userA,
          userB: pair.userB,
          score: pair.score,
          confidence: pair.confidence || null,
          reasonsJson: JSON.stringify(pair.reasons),
          createdAt: toIso()
        }
      );
      const inserted = one(
        `SELECT id FROM matches
         WHERE week_key=:weekKey AND ((user_a=:userA AND user_b=:userB) OR (user_a=:userB AND user_b=:userA))`,
        { weekKey: safeWeekKey, userA: pair.userA, userB: pair.userB }
      );
      exec(
        `INSERT INTO match_consents (match_id, user_id, share_contact, updated_at)
         VALUES (:matchId, :userId, 0, :updatedAt)`,
        { matchId: inserted.id, userId: pair.userA, updatedAt: toIso() }
      );
      exec(
        `INSERT INTO match_consents (match_id, user_id, share_contact, updated_at)
         VALUES (:matchId, :userId, 0, :updatedAt)`,
        { matchId: inserted.id, userId: pair.userB, updatedAt: toIso() }
      );
    }
    exec(
      `INSERT INTO match_runs (week_key, run_at, candidate_count, matched_count)
       VALUES (:weekKey, :runAt, :candidateCount, :matchedCount)
       ON CONFLICT(week_key) DO UPDATE SET run_at=:runAt, candidate_count=:candidateCount, matched_count=:matchedCount`,
      { weekKey: safeWeekKey, runAt: toIso(), candidateCount: pairs.length * 2, matchedCount: pairs.length }
    );
  });
}

function getCurrentMatch(userId, weekKey) {
  return one(
    `SELECT * FROM matches
     WHERE week_key=:weekKey AND (user_a=:userId OR user_b=:userId)`,
    { userId, weekKey }
  );
}

function getLatestMatch(userId) {
  return one(
    `SELECT * FROM matches
     WHERE user_a=:userId OR user_b=:userId
     ORDER BY week_key DESC
     LIMIT 1`,
    { userId }
  );
}

function getMatchDetail(matchId) {
  return one(
    `SELECT
       m.*,
       ua.id AS user_a_id,
       ua.name AS user_a_name,
       ua.email AS user_a_email,
       ua.grade AS user_a_grade,
       ua.campus AS user_a_campus,
       ua.gender AS user_a_gender,
       ua.wechat AS user_a_wechat,
       ua.qq AS user_a_qq,
       ua.backup_email AS user_a_backup_email,
       ub.id AS user_b_id,
       ub.name AS user_b_name,
       ub.email AS user_b_email,
       ub.grade AS user_b_grade,
       ub.campus AS user_b_campus,
       ub.gender AS user_b_gender,
       ub.wechat AS user_b_wechat,
       ub.qq AS user_b_qq,
       ub.backup_email AS user_b_backup_email
     FROM matches m
     JOIN users ua ON ua.id = m.user_a
     JOIN users ub ON ub.id = m.user_b
     WHERE m.id = :matchId`,
    { matchId }
  );
}

function getWeekMatchDetails(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  return many(
    `SELECT
       m.*,
       ua.id AS user_a_id,
       ua.name AS user_a_name,
       ua.email AS user_a_email,
       ua.grade AS user_a_grade,
       ua.campus AS user_a_campus,
       ua.gender AS user_a_gender,
       ua.wechat AS user_a_wechat,
       ua.qq AS user_a_qq,
       ua.backup_email AS user_a_backup_email,
       ub.id AS user_b_id,
       ub.name AS user_b_name,
       ub.email AS user_b_email,
       ub.grade AS user_b_grade,
       ub.campus AS user_b_campus,
       ub.gender AS user_b_gender,
       ub.wechat AS user_b_wechat,
       ub.qq AS user_b_qq,
       ub.backup_email AS user_b_backup_email
     FROM matches m
     JOIN users ua ON ua.id = m.user_a
     JOIN users ub ON ub.id = m.user_b
     WHERE m.week_key = :weekKey
     ORDER BY m.id ASC`,
    { weekKey: safeWeekKey }
  );
}

function listMatchesByWeek(weekKey) {
  const safeWeekKey = trimToMax(weekKey, 32);
  return many(
    `SELECT
       m.id,
       m.week_key,
       m.score,
       m.reasons_json,
       m.created_at,
       ua.id AS user_a_id,
       ua.name AS user_a_name,
       ua.student_id AS user_a_student_id,
       ua.email AS user_a_email,
       ua.grade AS user_a_grade,
       ua.campus AS user_a_campus,
       ua.gender AS user_a_gender,
       ub.id AS user_b_id,
       ub.name AS user_b_name,
       ub.student_id AS user_b_student_id,
       ub.email AS user_b_email,
       ub.grade AS user_b_grade,
       ub.campus AS user_b_campus,
       ub.gender AS user_b_gender,
       1 AS contact_unlocked
     FROM matches m
     JOIN users ua ON ua.id = m.user_a
     JOIN users ub ON ub.id = m.user_b
     WHERE m.week_key = :weekKey
     ORDER BY m.id DESC`,
    { weekKey: safeWeekKey }
  );
}

function getConsent(matchId) {
  return many(
    `SELECT user_id, share_contact
     FROM match_consents
     WHERE match_id=:matchId`,
    { matchId }
  );
}

function setConsent(matchId, userId, shareContact) {
  exec(
    `INSERT INTO match_consents (match_id, user_id, share_contact, updated_at)
     VALUES (:matchId, :userId, :shareContact, :updatedAt)
     ON CONFLICT(match_id, user_id) DO UPDATE SET share_contact=:shareContact, updated_at=:updatedAt`,
    { matchId, userId, shareContact: shareContact ? 1 : 0, updatedAt: toIso() }
  );
}

function cleanupConfirmTokens() {
  const now = toIso();
  exec(
    `DELETE FROM confirm_tokens
     WHERE datetime(expires_at) < datetime(:now)
        OR (used_at IS NOT NULL AND datetime(used_at) < datetime(:usedBefore))`,
    {
      now,
      usedBefore: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    }
  );
}

function createConfirmToken({ tokenHash, action, userId = null, adminKeyPrefix = null, expiresAt }) {
  cleanupConfirmTokens();
  const safeHash = trimToMax(tokenHash, 128);
  const safeAction = trimToMax(action, 64);
  const safePrefix = trimToMax(adminKeyPrefix || "", 32) || null;
  const safeExpiresAt = trimToMax(expiresAt, 64);
  const now = toIso();
  exec(
    `INSERT INTO confirm_tokens (
       token_hash, action, user_id, admin_key_prefix, expires_at, used_at, created_at
     ) VALUES (
       :tokenHash, :action, :userId, :adminKeyPrefix, :expiresAt, NULL, :createdAt
     )`,
    {
      tokenHash: safeHash,
      action: safeAction,
      userId: userId ? Number(userId) : null,
      adminKeyPrefix: safePrefix,
      expiresAt: safeExpiresAt,
      createdAt: now
    }
  );
  return one("SELECT * FROM confirm_tokens WHERE token_hash = :tokenHash", { tokenHash: safeHash });
}

function consumeConfirmToken({ tokenHash, action, userId = null, adminKeyPrefix = null }) {
  cleanupConfirmTokens();
  const safeHash = trimToMax(tokenHash, 128);
  const safeAction = trimToMax(action, 64);
  const safePrefix = trimToMax(adminKeyPrefix || "", 32) || null;
  const now = toIso();
  return transaction(() => {
    const row = one(
      `SELECT *
       FROM confirm_tokens
       WHERE token_hash = :tokenHash
         AND action = :action
         AND used_at IS NULL
         AND datetime(expires_at) >= datetime(:now)`,
      {
        tokenHash: safeHash,
        action: safeAction,
        now
      }
    );
    if (!row) return null;
    if (userId !== null && Number(row.user_id || 0) !== Number(userId)) return null;
    if (safePrefix !== null && String(row.admin_key_prefix || "") !== safePrefix) return null;
    exec(
      `UPDATE confirm_tokens
       SET used_at = :usedAt
       WHERE id = :id`,
      {
        id: row.id,
        usedAt: now
      }
    );
    return row;
  });
}

function createAnnouncement({ title, content, isActive = 1 }) {
  const safeTitle = trimToMax(title, 120);
  const safeContent = trimToMax(content, 2000);
  const safeActive = Number(isActive) === 0 ? 0 : 1;
  const now = toIso();
  exec(
    `INSERT INTO announcements (title, content, is_active, created_at)
     VALUES (:title, :content, :isActive, :createdAt)`,
    {
      title: safeTitle,
      content: safeContent,
      isActive: safeActive,
      createdAt: now
    }
  );
  return one("SELECT * FROM announcements WHERE id = last_insert_rowid()");
}

function listActiveAnnouncements(limit = 5) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit || 5)));
  return many(
    `SELECT id, title, content, is_active, created_at
     FROM announcements
     WHERE is_active = 1
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ${safeLimit}`
  );
}

function listAnnouncements(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 50)));
  return many(
    `SELECT id, title, content, is_active, created_at
     FROM announcements
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ${safeLimit}`
  );
}

function getMatchFeedback(matchId, userId) {
  return one(
    `SELECT *
     FROM match_feedback
     WHERE match_id = :matchId
       AND user_id = :userId`,
    { matchId, userId }
  );
}

function upsertMatchFeedback({ matchId, userId, rating, contacted = 0, comment = "" }) {
  const safeRating = Math.max(1, Math.min(5, Number(rating || 0)));
  const safeContacted = Number(contacted) ? 1 : 0;
  const safeComment = trimToMax(comment, 500);
  const now = toIso();
  exec(
    `INSERT INTO match_feedback (match_id, user_id, rating, contacted, comment, created_at)
     VALUES (:matchId, :userId, :rating, :contacted, :comment, :createdAt)
     ON CONFLICT(match_id, user_id) DO UPDATE SET
       rating = :rating,
       contacted = :contacted,
       comment = :comment,
       created_at = :createdAt`,
    {
      matchId,
      userId,
      rating: safeRating,
      contacted: safeContacted,
      comment: safeComment || null,
      createdAt: now
    }
  );
  return getMatchFeedback(matchId, userId);
}

function getFeedbackStats({ weekKey = "" } = {}) {
  const hasWeek = Boolean(String(weekKey || "").trim());
  const whereSql = hasWeek ? "WHERE m.week_key = :weekKey" : "";
  const params = hasWeek ? { weekKey: trimToMax(weekKey, 32) } : {};
  const summary = one(
    `SELECT
       COUNT(1) AS total_feedbacks,
       AVG(f.rating) AS avg_rating,
       SUM(CASE WHEN f.contacted = 1 THEN 1 ELSE 0 END) AS contacted_count
     FROM match_feedback f
     JOIN matches m ON m.id = f.match_id
     ${whereSql}`,
    params
  ) || { total_feedbacks: 0, avg_rating: 0, contacted_count: 0 };
  const byRatingRows = many(
    `SELECT f.rating AS rating, COUNT(1) AS count
     FROM match_feedback f
     JOIN matches m ON m.id = f.match_id
     ${whereSql}
     GROUP BY f.rating
     ORDER BY f.rating ASC`,
    params
  );
  const ratingBreakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of byRatingRows) {
    const key = Math.max(1, Math.min(5, Number(row.rating || 0)));
    ratingBreakdown[key] = Number(row.count || 0);
  }
  const recent = many(
    `SELECT
       f.id,
       f.match_id,
       f.user_id,
       f.rating,
       f.contacted,
       f.comment,
       f.created_at,
       u.name AS user_name,
       m.week_key
     FROM match_feedback f
     JOIN users u ON u.id = f.user_id
     JOIN matches m ON m.id = f.match_id
     ${whereSql}
     ORDER BY datetime(f.created_at) DESC, f.id DESC
     LIMIT 20`,
    params
  );
  const total = Number(summary.total_feedbacks || 0);
  const avgRating = Number(summary.avg_rating || 0);
  const contactedCount = Number(summary.contacted_count || 0);
  return {
    totalFeedbacks: total,
    avgRating: total > 0 ? Number(avgRating.toFixed(2)) : 0,
    contactedCount,
    contactedRate: total > 0 ? Number((contactedCount / total).toFixed(4)) : 0,
    ratingBreakdown,
    recent
  };
}

function recordPageView(path, ip, userAgent) {
  exec(
    `INSERT INTO page_views (path, ip, user_agent, created_at)
     VALUES (:path, :ip, :ua, datetime('now'))`,
    { path: trimToMax(path, 255), ip: trimToMax(ip, 64), ua: trimToMax(userAgent, 512) }
  );
}

function getPageViewStats() {
  const total = Number(
    (one("SELECT COUNT(*) AS c FROM page_views") || {}).c || 0
  );
  const today = Number(
    (one("SELECT COUNT(*) AS c FROM page_views WHERE created_at >= date('now')") || {}).c || 0
  );
  const uniqueIpsToday = Number(
    (one("SELECT COUNT(DISTINCT ip) AS c FROM page_views WHERE created_at >= date('now')") || {}).c || 0
  );
  const uniqueIpsTotal = Number(
    (one("SELECT COUNT(DISTINCT ip) AS c FROM page_views") || {}).c || 0
  );
  return { total, today, uniqueIpsToday, uniqueIpsTotal };
}

// ── Match Greetings (破冰留言) ──────────────────────────────────
function upsertMatchGreeting(matchId, userId, message) {
  const safeMsg = trimToMax(message, 300);
  const now = toIso();
  const existing = one(
    "SELECT id FROM match_greetings WHERE match_id = :matchId AND user_id = :userId",
    { matchId, userId }
  );
  if (existing) {
    exec(
      "UPDATE match_greetings SET message = :message, created_at = :now WHERE id = :id",
      { id: existing.id, message: safeMsg, now }
    );
  } else {
    exec(
      "INSERT INTO match_greetings (match_id, user_id, message, created_at) VALUES (:matchId, :userId, :message, :now)",
      { matchId, userId, message: safeMsg, now }
    );
  }
  return one("SELECT * FROM match_greetings WHERE match_id = :matchId AND user_id = :userId", { matchId, userId });
}

function getMatchGreetings(matchId) {
  return many("SELECT * FROM match_greetings WHERE match_id = :matchId", { matchId });
}

// ── Pause (暂停参与) ──────────────────────────────────────────
function setUserPaused(userId, paused) {
  const now = toIso();
  exec(
    "UPDATE users SET paused = :paused, updated_at = :now WHERE id = :id",
    { id: userId, paused: paused ? 1 : 0, now }
  );
  return one("SELECT * FROM users WHERE id = :id", { id: userId });
}

// ── Crush / "Shoot Your Shot" ──────────────────────────────────
function setMatchNarrative(matchId, narrative) {
  exec("UPDATE matches SET narrative = :narrative WHERE id = :id", { id: matchId, narrative: trimToMax(narrative, 2000) });
}

function getMatchNarrative(matchId) {
  const row = one("SELECT narrative FROM matches WHERE id = :id", { id: matchId });
  return row ? row.narrative : null;
}

function upsertCrush(userId, targetStudentId, weekKeyVal) {
  const safeTarget = trimToMax(targetStudentId, 64);
  const safeWeek = trimToMax(weekKeyVal, 16);
  const now = toIso();
  const existing = one(
    "SELECT id FROM crushes WHERE user_id = :userId AND week_key = :week",
    { userId, week: safeWeek }
  );
  if (existing) {
    exec(
      `UPDATE crushes SET target_student_id = :target, created_at = :now WHERE id = :id`,
      { id: existing.id, target: safeTarget, now }
    );
  } else {
    exec(
      `INSERT INTO crushes (user_id, target_student_id, week_key, created_at)
       VALUES (:userId, :target, :week, :now)`,
      { userId, target: safeTarget, week: safeWeek, now }
    );
  }
  return one("SELECT * FROM crushes WHERE user_id = :userId AND week_key = :week", { userId, week: safeWeek });
}

function getCrush(userId, weekKeyVal) {
  return one(
    "SELECT * FROM crushes WHERE user_id = :userId AND week_key = :week",
    { userId, week: weekKeyVal }
  );
}

function deleteCrush(userId, weekKeyVal) {
  exec("DELETE FROM crushes WHERE user_id = :userId AND week_key = :week", { userId, week: weekKeyVal });
}

function findMutualCrushes(weekKeyVal) {
  return many(
    `SELECT a.user_id AS user_a_id, b.user_id AS user_b_id,
            a.target_student_id AS a_target, b.target_student_id AS b_target
     FROM crushes a
     JOIN crushes b ON a.week_key = b.week_key
     JOIN users ua ON ua.id = a.user_id
     JOIN users ub ON ub.id = b.user_id
     WHERE a.week_key = :week
       AND a.target_student_id = ub.student_id
       AND b.target_student_id = ua.student_id
       AND a.user_id < b.user_id
       AND a.matched = 0 AND b.matched = 0`,
    { week: weekKeyVal }
  );
}

function markCrushMatched(userId, weekKeyVal) {
  exec(
    "UPDATE crushes SET matched = 1 WHERE user_id = :userId AND week_key = :week",
    { userId, week: weekKeyVal }
  );
}

module.exports = {
  DB_PATH,
  initSchema,
  ping,
  one,
  many,
  exec,
  transaction,
  upsertUserByStudentId,
  createSession,
  getSessionUser,
  deleteSessionByToken,
  createEmailOtp,
  getLatestEmailOtp,
  bumpEmailOtpAttempt,
  consumeEmailOtp,
  updateUserProfile,
  upsertQuestionnaire,
  setOptIn,
  getUserQuestionnaire,
  getUserById,
  countActiveUsers,
  countOptInForWeek,
  listOptInUsersBasic,
  getParticipantPool,
  getAllHistoricalPairs,
  getConsecutiveUnmatchedWeeks,
  replaceWeekMatches,
  getCurrentMatch,
  getLatestMatch,
  getMatchDetail,
  getWeekMatchDetails,
  listMatchesByWeek,
  getLatestWeekKeyWithMatches,
  getLatestMatchRun,
  listMatchRuns,
  getEmailQueueStats,
  countTotalUsers,
  countUsersCreatedBetween,
  countTotalMatches,
  countMatchedPairsForWeek,
  getAverageMatchScoreForWeek,
  listMatchReasonsForWeek,
  countUnlockedPairsForWeek,
  listUsersPaged,
  listUsersForExport,
  getConsent,
  setConsent,
  createAnnouncement,
  listActiveAnnouncements,
  listAnnouncements,
  getMatchFeedback,
  upsertMatchFeedback,
  getFeedbackStats,
  createConfirmToken,
  consumeConfirmToken,
  recordPageView,
  getPageViewStats,
  setMatchNarrative,
  getMatchNarrative,
  upsertMatchGreeting,
  getMatchGreetings,
  setUserPaused,
  upsertCrush,
  getCrush,
  deleteCrush,
  findMutualCrushes,
  markCrushMatched
};
