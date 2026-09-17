# Multi-stage build for warehouse-system-api. Runs as the `app` service in
# docker-compose.yml alongside a `db` (MariaDB) container — mirrors the
# sibling skinet-auth-api's Dockerfile for consistency on the same VPS. See
# docs/deployment-vps.md.

# ---- deps: install once, cached across builds unless package*.json changes ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# No native addons in this app's dependency tree (mysql2/jose/exceljs are pure
# JS) — no build toolchain needed, unlike auth-backend's argon2.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: small image, no build toolchain, no dev deps ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN groupadd -r -g 10002 warehouse && useradd -r -u 10002 -g warehouse -d /app warehouse

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY knexfile.js ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

RUN chown -R warehouse:warehouse /app
USER warehouse

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
