FROM node:24.19.0-bookworm-slim

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
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node apps/docs/package.json apps/docs/package.json
COPY --chown=node:node packages/eslint-config/package.json packages/eslint-config/package.json
COPY --chown=node:node packages/typescript-config/package.json packages/typescript-config/package.json
COPY --chown=node:node packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages

RUN mkdir -p /workspace/apps/web/.next

EXPOSE 3000

CMD ["pnpm", "--filter", "web", "exec", "next", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
