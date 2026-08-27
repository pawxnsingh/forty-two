# Turborepo starter

This Turborepo starter is maintained by the Turborepo core team.

## Local Docker stack

The root Compose project runs the Next.js application, hosted-mode TrueForge,
the Forty Two datasource MCP, Postgres, and Redis. Next.js and TrueForge share
the `forty_two` Postgres database. TrueForge is built from the pinned
`vendor/trueforge` submodule.

Initialize the submodule after cloning:

```sh
git submodule update --init --recursive
```

Copy `.env.example` to `.env`, then set `POSTGRES_PASSWORD`, `MCP_AUTH_TOKEN`,
`DAYTONA_API_KEY`, and `OPENAI_API_KEY`. Use separate long, unique values for
the database and MCP secrets; `openssl rand -hex 32` produces URL-safe
local-development secrets. Compose fails fast when a required value is
missing.

```sh
cp .env.example .env
```

Then start the complete stack:

```sh
docker compose up --build
```

The one-shot `trueforge-bootstrap` service automatically configures OpenAI and
Daytona, then registers the authenticated datasource MCP server in TrueForge.
It also verifies that TrueForge can discover the MCP tools and creates or
updates the named `forty-two-data-agent` from
`config/agents/forty-two-data-agent.json`. Real credentials remain in the
ignored `.env` file and TrueForge's settings database; the agent spec contains
only resource references and no secrets.

After the stack is healthy, run the live integration check:

```sh
pnpm test:platform-integration
```

This creates a TrueForge test session that runs Code Mode in Daytona and
queries local PostgreSQL through the authenticated datasource MCP bridge.

- Next.js: http://localhost:3000
- TrueForge UI and API: http://localhost:8790
- TrueForge health: http://localhost:8790/healthz
- TrueForge API documentation: http://localhost:8790/api/v1/docs
- Datasource MCP: http://localhost:8791/mcp
- Datasource MCP health: http://localhost:8791/healthz
- Postgres: `localhost:5432`, database `forty_two`

Stop the stack without deleting persisted data:

```sh
docker compose down
```

If an older local `postgres_data` volume was initialized with a different
password, either update that Postgres role or remove only that development
volume after `docker compose down`. Removing `forty-two_postgres_data`
permanently deletes the local database; never do this when its data is needed.

Local ports bind to `127.0.0.1`. Authentication is intentionally disabled in
this local TrueForge setup, so do not expose it publicly.

## Using this example

Run the following command:

```sh
npx create-turbo@latest
```

## What's inside?

This Turborepo includes the following packages/apps:

### Apps and Packages

- `docs`: a [Next.js](https://nextjs.org/) app
- `web`: another [Next.js](https://nextjs.org/) app
- `@repo/ui`: a stub React component library shared by both `web` and `docs` applications
- `@repo/eslint-config`: `eslint` configurations (includes `eslint-config-next` and `eslint-config-prettier`)
- `@repo/typescript-config`: `tsconfig.json`s used throughout the monorepo

Each package/app is 100% [TypeScript](https://www.typescriptlang.org/).

### Utilities

This Turborepo has some additional tools already setup for you:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [ESLint](https://eslint.org/) for code linting
- [Prettier](https://prettier.io) for code formatting

### Build

To build all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo build
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo build
pnpm dlx turbo build
pnpm exec turbo build
```

You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo build --filter=docs
```

Without global `turbo`:

```sh
npx turbo build --filter=docs
pnpm exec turbo build --filter=docs
pnpm exec turbo build --filter=docs
```

### Develop

To develop all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo dev
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo dev
pnpm exec turbo dev
pnpm exec turbo dev
```

You can develop a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo dev --filter=web
```

Without global `turbo`:

```sh
npx turbo dev --filter=web
pnpm exec turbo dev --filter=web
pnpm exec turbo dev --filter=web
```

### Remote Caching

> [!TIP]
> Vercel Remote Cache is free for all plans. Get started today at [vercel.com](https://vercel.com/signup?utm_source=remote-cache-sdk&utm_campaign=free_remote_cache).

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

By default, Turborepo will cache locally. To enable Remote Caching you will need an account with Vercel. If you don't have an account you can [create one](https://vercel.com/signup?utm_source=turborepo-examples), then enter the following commands:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo login
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo login
pnpm exec turbo login
pnpm exec turbo login
```

This will authenticate the Turborepo CLI with your [Vercel account](https://vercel.com/docs/concepts/personal-accounts/overview).

Next, you can link your Turborepo to your Remote Cache by running the following command from the root of your Turborepo:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo link
```

Without global `turbo`:

```sh
npx turbo link
pnpm exec turbo link
pnpm exec turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
