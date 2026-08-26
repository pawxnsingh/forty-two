FROM node:24.19.0-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
  && mkdir -p /corepack /pnpm/store /workspace \
  && chown -R node:node /corepack /pnpm /workspace

WORKDIR /workspace
USER node

RUN corepack prepare pnpm@9.15.9 --activate

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY --chown=node:node apps/data-source-mcp/package.json apps/data-source-mcp/package.json
COPY --chown=node:node packages/data-source/package.json packages/data-source/package.json
COPY --chown=node:node packages/typescript-config/package.json packages/typescript-config/package.json

RUN pnpm install --filter @forty-two/data-source-mcp... --frozen-lockfile

COPY --chown=node:node apps/data-source-mcp apps/data-source-mcp
COPY --chown=node:node packages/data-source packages/data-source
COPY --chown=node:node packages/typescript-config packages/typescript-config

RUN pnpm --filter @forty-two/data-source-mcp... build

ENV NODE_ENV=production
EXPOSE 8791

CMD ["pnpm", "--filter", "@forty-two/data-source-mcp", "start"]
