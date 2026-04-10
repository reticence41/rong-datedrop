const { AppError } = require("./errors");
const { readJson } = require("./http");

function normalizePath(pathname) {
  if (!pathname) return "/";
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

function splitPath(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized === "/") return [];
  return normalized.slice(1).split("/");
}

function compile(pathname) {
  const tokens = splitPath(pathname);
  return tokens.map((token) => {
    if (token.startsWith(":")) {
      return { type: "param", name: token.slice(1) };
    }
    return { type: "literal", value: token };
  });
}

function matchTokens(compiled, pathname) {
  const parts = splitPath(pathname);
  if (compiled.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < compiled.length; i += 1) {
    const token = compiled[i];
    const part = parts[i];
    if (token.type === "literal") {
      if (token.value !== part) return null;
    } else {
      params[token.name] = decodeURIComponent(part);
    }
  }
  return params;
}

class Router {
  constructor() {
    this.routes = [];
  }

  get(pathname, handler) {
    this.routes.push({
      method: "GET",
      pathname: normalizePath(pathname),
      compiled: compile(pathname),
      handler
    });
  }

  post(pathname, handler) {
    this.routes.push({
      method: "POST",
      pathname: normalizePath(pathname),
      compiled: compile(pathname),
      handler
    });
  }

  async handle(req, res) {
    const method = String(req.method || "GET").toUpperCase();
    const pathname = normalizePath(req.pathname || "/");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchTokens(route.compiled, pathname);
      if (!params) continue;
      let body;
      if (method === "POST") {
        body = await readJson(req);
      }
      const query = req.query || {};
      const user = req.user || null;
      await route.handler(req, res, { params, query, body, user });
      return true;
    }
    return false;
  }
}

function createRouter() {
  return new Router();
}

function ensureHandled(handled) {
  if (!handled) {
    throw new AppError(404, "not_found", "请求资源不存在");
  }
}

module.exports = {
  createRouter,
  ensureHandled
};
