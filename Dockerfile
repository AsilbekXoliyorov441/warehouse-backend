# syntax=docker/dockerfile:1

# ---- base: runtime OS deps shared by every stage ---------------------------------
FROM node:22-bookworm-slim AS base
WORKDIR /app
# OpenSSL is required by the Prisma query engine. Disable third-party install telemetry.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV SCARF_ANALYTICS=false
# The lockfile is produced by npm 11 (which also enforces package.json#allowScripts).
RUN npm install -g npm@11.17.0 && npm --version

# ---- deps: full dependency install (cached unless the lockfile changes) ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

# ---- build: compile, then drop dev dependencies ----------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate \
 && npm run build \
 && npm run build:seed \
 && npm prune --omit=dev \
 && npx prisma generate

# ---- runtime: minimal, non-root ---------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Exec form so SIGTERM reaches Node directly and triggers graceful shutdown.
CMD ["node", "dist/main.js"]
