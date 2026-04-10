const fs = require("node:fs");
const path = require("node:path");
const { chinaDate, toIso } = require("../time");

const DATA_DIR = path.join(__dirname, "..", "data");
const SCHEDULER_LOG_PATH = path.join(DATA_DIR, "scheduler.log");
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

const DAY_MAP = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function toChinaTimeParts(date = new Date()) {
  const d = chinaDate(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const weekday = d.getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

function chinaMinuteSlot(date = new Date()) {
  const p = toChinaTimeParts(date);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(
    p.hour
  ).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function chinaDateFromMs(chinaMs) {
  return new Date(chinaMs - CHINA_OFFSET_MS);
}

function parseMatchSchedule(input) {
  const raw = String(input || "").trim().toUpperCase();
  const match = /^([A-Z]{3}):([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) {
    throw new Error(`invalid_match_schedule:${raw || "(empty)"}`);
  }
  const dayName = match[1];
  const day = DAY_MAP[dayName];
  if (typeof day !== "number") {
    throw new Error(`invalid_match_schedule_day:${dayName}`);
  }
  return {
    type: "weekly",
    day,
    dayName,
    hour: Number(match[2]),
    minute: Number(match[3]),
    raw
  };
}

function intervalRule(seconds) {
  const n = Number(seconds);
  const safe = Number.isFinite(n) && n > 0 ? n : 300;
  return {
    type: "interval",
    everyMs: Math.max(60_000, Math.round(safe * 1000)),
    raw: `${safe}s`
  };
}

function stringifyDetail(detail) {
  try {
    return JSON.stringify(detail || {});
  } catch {
    return JSON.stringify({ error: "detail_not_serializable" });
  }
}

function appendSchedulerLog(taskName, status, detail) {
  const line = `[${toIso()}] [SCHEDULER] [${String(taskName || "-")}] [${String(status || "-")}] ${stringifyDetail(detail)}\n`;
  fs.appendFile(SCHEDULER_LOG_PATH, line, () => {});
}

function describeRule(rule) {
  if (!rule || typeof rule !== "object") return "unknown";
  if (rule.type === "weekly") {
    return `${rule.dayName}:${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
  }
  if (rule.type === "interval") {
    return `EVERY_${Math.round(rule.everyMs / 1000)}S`;
  }
  return "unknown";
}

function computeNextWeeklyRunAt(rule, now = new Date()) {
  const nowChinaMs = now.getTime() + CHINA_OFFSET_MS;
  const nowChina = new Date(nowChinaMs);
  const y = nowChina.getUTCFullYear();
  const m = nowChina.getUTCMonth();
  const d = nowChina.getUTCDate();
  const weekday = nowChina.getUTCDay();
  const todayTargetChinaMs = Date.UTC(y, m, d, rule.hour, rule.minute, 0, 0);
  let diffDays = (rule.day - weekday + 7) % 7;
  if (diffDays === 0 && todayTargetChinaMs <= nowChinaMs) {
    diffDays = 7;
  }
  const targetChinaMs = todayTargetChinaMs + diffDays * 24 * 60 * 60 * 1000;
  return chinaDateFromMs(targetChinaMs);
}

function normalizeRule(cronLike) {
  if (typeof cronLike === "string") {
    return parseMatchSchedule(cronLike);
  }
  if (cronLike && typeof cronLike === "object" && cronLike.type === "weekly") {
    return {
      ...cronLike,
      dayName: cronLike.dayName || Object.keys(DAY_MAP).find((k) => DAY_MAP[k] === cronLike.day) || "UNK"
    };
  }
  if (cronLike && typeof cronLike === "object" && cronLike.type === "interval") {
    return intervalRule(Math.round(Number(cronLike.everyMs || 0) / 1000));
  }
  throw new Error("invalid_scheduler_rule");
}

function createScheduler() {
  const tasks = [];
  let timer = null;
  let running = false;
  let startedAt = null;
  let lastTickAt = null;
  let tickInProgress = false;

  async function runTask(task) {
    if (task.runningNow) {
      appendSchedulerLog(task.name, "SKIP", { reason: "task_already_running" });
      return;
    }
    task.runningNow = true;
    const started = Date.now();
    try {
      const out = await task.fn();
      task.lastRunAt = new Date().toISOString();
      task.lastStatus = "success";
      task.lastDurationMs = Math.max(0, Date.now() - started);
      task.lastDetail = out || {};
      appendSchedulerLog(task.name, "SUCCESS", { durationMs: task.lastDurationMs, summary: task.lastDetail });
    } catch (err) {
      const message = String(err && err.message ? err.message : "unknown");
      task.lastRunAt = new Date().toISOString();
      task.lastStatus = "error";
      task.lastDurationMs = Math.max(0, Date.now() - started);
      task.lastDetail = { error: message };
      appendSchedulerLog(task.name, "ERROR", {
        durationMs: task.lastDurationMs,
        error: message
      });
    } finally {
      task.runningNow = false;
      if (task.rule.type === "interval") {
        task.nextRunAt = new Date(Date.now() + task.rule.everyMs).toISOString();
      } else if (task.rule.type === "weekly") {
        task.nextRunAt = computeNextWeeklyRunAt(task.rule).toISOString();
      }
    }
  }

  function shouldRunWeekly(task, now) {
    const p = toChinaTimeParts(now);
    if (p.weekday !== task.rule.day) return false;
    if (p.hour !== task.rule.hour || p.minute !== task.rule.minute) return false;
    const slot = chinaMinuteSlot(now);
    if (task.lastSlot === slot) return false;
    task.lastSlot = slot;
    return true;
  }

  function shouldRunInterval(task, now) {
    const nowMs = now.getTime();
    if (!task.nextRunAt) {
      task.nextRunAt = new Date(nowMs).toISOString();
    }
    const nextMs = new Date(task.nextRunAt).getTime();
    if (!Number.isFinite(nextMs)) {
      task.nextRunAt = new Date(nowMs).toISOString();
      return true;
    }
    return nowMs >= nextMs;
  }

  async function tick() {
    if (tickInProgress) return;
    tickInProgress = true;
    lastTickAt = new Date().toISOString();
    try {
      const now = new Date();
      for (const task of tasks) {
        if (task.rule.type === "weekly") {
          task.nextRunAt = computeNextWeeklyRunAt(task.rule, now).toISOString();
          if (shouldRunWeekly(task, now)) {
            await runTask(task);
          }
          continue;
        }
        if (task.rule.type === "interval") {
          if (shouldRunInterval(task, now)) {
            await runTask(task);
          }
        }
      }
    } finally {
      tickInProgress = false;
    }
  }

  return {
    register(name, cronLike, fn) {
      if (typeof fn !== "function") {
        throw new Error("scheduler_register_requires_function");
      }
      const rule = normalizeRule(cronLike);
      const task = {
        name: String(name || "").trim() || `task_${tasks.length + 1}`,
        rule,
        fn,
        runningNow: false,
        lastRunAt: null,
        lastStatus: "idle",
        lastDetail: null,
        lastDurationMs: 0,
        nextRunAt: rule.type === "weekly" ? computeNextWeeklyRunAt(rule).toISOString() : new Date().toISOString(),
        lastSlot: ""
      };
      tasks.push(task);
      return task.name;
    },
    start() {
      if (running) return;
      running = true;
      startedAt = new Date().toISOString();
      timer = setInterval(() => {
        void tick();
      }, 60_000);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
    },
    getStatus() {
      return {
        running,
        startedAt,
        lastTickAt,
        tasks: tasks.map((task) => ({
          name: task.name,
          rule: describeRule(task.rule),
          running: task.runningNow,
          lastRunAt: task.lastRunAt,
          lastStatus: task.lastStatus,
          lastDurationMs: task.lastDurationMs,
          lastDetail: task.lastDetail,
          nextRunAt: task.nextRunAt
        }))
      };
    }
  };
}

module.exports = {
  SCHEDULER_LOG_PATH,
  parseMatchSchedule,
  intervalRule,
  createScheduler
};

