FROM node:24.19.0-bookworm-slim AS build

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

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY --chown=node:node apps/todo-mcp/package.json apps/todo-mcp/package.json
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/eslint-config/package.json packages/eslint-config/package.json
COPY --chown=node:node packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --frozen-lockfile

COPY --chown=node:node apps/todo-mcp apps/todo-mcp
COPY --chown=node:node packages/db packages/db
COPY --chown=node:node packages/eslint-config packages/eslint-config
COPY --chown=node:node packages/typescript-config packages/typescript-config
RUN pnpm --filter @forty-two/db build \
  && pnpm --filter @forty-two/todo-mcp build \
  && pnpm deploy --filter @forty-two/todo-mcp --prod /workspace/deploy

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/deploy ./
USER node
EXPOSE 8792
CMD ["node", "dist/index.js"]
