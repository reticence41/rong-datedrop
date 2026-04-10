class AppError extends Error {
  constructor(statusCode, errorCode, message, details = null) {
    super(message || errorCode || "app_error");
    this.name = "AppError";
    this.statusCode = Number(statusCode) || 500;
    this.errorCode = String(errorCode || "app_error");
    this.details = details;
  }
}

function isAppError(err) {
  return Boolean(err && err.name === "AppError" && Number.isInteger(err.statusCode) && err.errorCode);
}

function badRequest(errorCode, message, details = null) {
  return new AppError(400, errorCode, message, details);
}

function unauthorized(errorCode = "unauthorized", message = "未授权") {
  return new AppError(401, errorCode, message);
}

module.exports = {
  AppError,
  isAppError,
  badRequest,
  unauthorized
};
