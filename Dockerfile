# Stage 1: Build frontend (Vite) and backend (esbuild -> dist/server.js)
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Install production-only dependencies (no tsx, typescript, esbuild, etc.)
FROM node:22-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: Minimal non-root runtime image
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DEMO_MODE=false \
    ALLOW_ACTIONS=false \
    DATA_DIR=/data

RUN addgroup -S -g 1001 change \
    && adduser -S -u 1001 -G change change \
    && mkdir -p /data \
    && chown -R change:change /data /app

COPY --from=prod-deps --chown=change:change /app/node_modules ./node_modules
COPY --from=builder --chown=change:change /app/package.json ./package.json
COPY --from=builder --chown=change:change /app/dist ./dist

USER change
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
