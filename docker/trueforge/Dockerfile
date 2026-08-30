# syntax=docker/dockerfile:1

# Platform-owned derivative of vendor/trueforge/Dockerfile.dev. The only
# behavioral difference is patching TrueForge's release sandbox image constant
# before compilation; vendor source remains unchanged.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && pnpm config set store-dir /pnpm/store
WORKDIR /app

FROM base AS store
COPY vendor/trueforge/pnpm-lock.yaml vendor/trueforge/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

FROM store AS workspace
COPY vendor/trueforge/package.json vendor/trueforge/.npmrc vendor/trueforge/tsconfig.base.json ./
COPY vendor/trueforge/packages/trueforge-core/package.json packages/trueforge-core/package.json
COPY vendor/trueforge/packages/trueforge/package.json packages/trueforge/package.json
COPY vendor/trueforge/packages/trueforge-sdk/package.json packages/trueforge-sdk/package.json
COPY vendor/trueforge/packages/frontend/package.json packages/frontend/package.json
COPY vendor/trueforge/packages/trueforge-ui/package.json packages/trueforge-ui/package.json
COPY vendor/trueforge/packages/trueforge-core/scripts packages/trueforge-core/scripts
COPY vendor/trueforge/packages/trueforge-core/src/core/sandbox/scripts packages/trueforge-core/src/core/sandbox/scripts

FROM workspace AS builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline --filter @truefoundry/trueforge...
COPY vendor/trueforge/packages/trueforge-core packages/trueforge-core
COPY vendor/trueforge/packages/trueforge packages/trueforge
COPY scripts/platform-sandbox-image-contract.mjs scripts/platform-sandbox-image-contract.mjs
ARG PLATFORM_SANDBOX_IMAGE_URI
RUN node scripts/platform-sandbox-image-contract.mjs \
  "$PLATFORM_SANDBOX_IMAGE_URI" \
  packages/trueforge-core/src/core/sandbox/sandboxImage.json
RUN pnpm --filter @truefoundry/trueforge-core build && pnpm --filter @truefoundry/trueforge build

FROM workspace AS frontend-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline --filter frontend...
COPY vendor/trueforge/packages/trueforge-sdk packages/trueforge-sdk
RUN pnpm --filter @truefoundry/trueforge-sdk build
COPY vendor/trueforge/packages/trueforge-ui packages/trueforge-ui
RUN pnpm --filter @truefoundry/trueforge-ui build
COPY vendor/trueforge/packages/frontend packages/frontend
RUN pnpm --filter frontend build

FROM workspace AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline --prod --filter @truefoundry/trueforge...

FROM base AS runner
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/trueforge-core/node_modules ./packages/trueforge-core/node_modules
COPY --from=prod-deps /app/packages/trueforge/node_modules ./packages/trueforge/node_modules
COPY --from=builder /app/packages/trueforge-core/package.json ./packages/trueforge-core/package.json
COPY --from=builder /app/packages/trueforge-core/dist ./packages/trueforge-core/dist
COPY --from=builder /app/packages/trueforge/package.json ./packages/trueforge/package.json
COPY --from=builder /app/packages/trueforge/dist ./packages/trueforge/dist
COPY --from=frontend-builder /app/packages/frontend/dist ./packages/trueforge/dist/_frontend
WORKDIR /app/packages/trueforge
EXPOSE 8790
CMD ["node", "dist/main.js"]
