const db = require("../db");
const { weekKey } = require("../time");
const { sendJson } = require("../lib/http");
const { AppError } = require("../lib/errors");
const { requireAuth } = require("../middleware/auth");
const { auditInfo } = require("../lib/logger");

function registerCrushRoutes(router) {
  // Submit or update a crush for the current week
  router.post("/api/crush", async (req, res, { body }) => {
    const user = requireAuth(req);
    const targetStudentId = String(body.targetStudentId || "").trim();
    if (!targetStudentId) {
      throw new AppError(400, "crush_target_required", "请输入心仪对象的学号");
    }
    if (targetStudentId.length > 64) {
      throw new AppError(400, "crush_target_too_long", "学号格式不正确");
    }
    // Prevent self-crush
    if (targetStudentId === user.student_id) {
      throw new AppError(400, "crush_self", "不能选择自己哦");
    }
    // Check target exists
    const target = db.one("SELECT id, name FROM users WHERE student_id = :sid", { sid: targetStudentId });
    if (!target) {
      throw new AppError(404, "crush_target_not_found", "未找到该学号对应的用户，请确认对方已注册");
    }

    const wk = String(body.weekKey || weekKey());
    const crush = db.upsertCrush(user.id, targetStudentId, wk);
    auditInfo("CRUSH_SUBMIT", `user:${user.id}|ip:${req.clientIp}`, `target=${targetStudentId} week=${wk}`);
    sendJson(res, 200, {
      ok: true,
      crush: {
        weekKey: wk,
        targetStudentId,
        targetName: maskName(target.name),
        matched: crush.matched === 1,
        createdAt: crush.created_at
      }
    });
  });

  // Get current crush status
  router.get("/api/crush", async (req, res, { query }) => {
    const user = requireAuth(req);
    const wk = String(query.weekKey || weekKey());
    const crush = db.getCrush(user.id, wk);
    if (!crush) {
      sendJson(res, 200, { crush: null });
      return;
    }
    const target = db.one("SELECT name FROM users WHERE student_id = :sid", { sid: crush.target_student_id });
    sendJson(res, 200, {
      crush: {
        weekKey: crush.week_key,
        targetStudentId: crush.target_student_id,
        targetName: target ? maskName(target.name) : "未知",
        matched: crush.matched === 1,
        createdAt: crush.created_at
      }
    });
  });

  // Delete crush for current week
  router.post("/api/crush/delete", async (req, res, { body }) => {
    const user = requireAuth(req);
    const wk = String(body.weekKey || weekKey());
    db.deleteCrush(user.id, wk);
    auditInfo("CRUSH_DELETE", `user:${user.id}|ip:${req.clientIp}`, `week=${wk}`);
    sendJson(res, 200, { ok: true });
  });
}

function maskName(name) {
  if (!name) return "**";
  if (name.length <= 1) return "*";
  return name[0] + "*".repeat(name.length - 1);
}

module.exports = { registerCrushRoutes };
