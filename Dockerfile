FROM node:22-alpine

WORKDIR /app

# Runtime tools used by healthcheck scripts.
RUN apk add --no-cache curl

# Install dependencies first for better layer cache hit rate.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source.
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
