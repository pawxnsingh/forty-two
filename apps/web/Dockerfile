FROM node:24.19.0-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV npm_config_store_dir=/pnpm/store
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
  && mkdir -p /corepack /pnpm/store /workspace \
  && chown -R node:node /corepack /pnpm /workspace

WORKDIR /workspace
USER node
RUN corepack prepare pnpm@9.15.9 --activate

FROM base AS dependencies

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY --chown=node:node apps/data-source-mcp/package.json apps/data-source-mcp/package.json
COPY --chown=node:node apps/todo-mcp/package.json apps/todo-mcp/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node apps/docs/package.json apps/docs/package.json
COPY --chown=node:node packages/app-shell/package.json packages/app-shell/package.json
COPY --chown=node:node packages/artifacts/package.json packages/artifacts/package.json
COPY --chown=node:node packages/charting/package.json packages/charting/package.json
COPY --chown=node:node packages/data-source/package.json packages/data-source/package.json
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/design-tokens/package.json packages/design-tokens/package.json
COPY --chown=node:node packages/eslint-config/package.json packages/eslint-config/package.json
COPY --chown=node:node packages/typescript-config/package.json packages/typescript-config/package.json
COPY --chown=node:node packages/ui/package.json packages/ui/package.json
COPY --chown=node:node packages/ui-web/package.json packages/ui-web/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS builder

COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node config ./config

RUN pnpm --filter web... build

FROM node:24.19.0-bookworm-slim AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /workspace

COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /workspace/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
