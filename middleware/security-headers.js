function createSecurityHeadersMiddleware(headers) {
  const headerEntries = Object.entries(headers || {});
  return async function securityHeaders(req, res, next) {
    for (const [key, value] of headerEntries) {
      if (!res.hasHeader(key)) {
        res.setHeader(key, value);
      }
    }
    await next();
  };
}

module.exports = {
  createSecurityHeadersMiddleware
};
