# Turborepo starter

This Turborepo starter is maintained by the Turborepo core team.

## Local Docker stack

The root Compose project runs the Next.js application, hosted-mode TrueForge,
the Forty Two datasource and Todo MCP services, PostgreSQL, MySQL, SQL Server,
and Redis. Next.js and TrueForge share the `forty_two` PostgreSQL database.
TrueForge is built from the pinned `vendor/trueforge` submodule.

Initialize the submodule after cloning:

```sh
git submodule update --init --recursive
```

Copy `.env.example` to `.env`, then set every required value listed below.
Compose fails fast when any is missing. Use a different long, unique value for
each password, token, and key; `openssl rand -hex 32` produces URL-safe
local-development secrets. SQL Server's `SQLSERVER_SA_PASSWORD` must also meet
SQL Server's password-complexity policy.

```sh
cp .env.example .env
```

Required database credentials:

```text
POSTGRES_PASSWORD
POSTGRES_READER_PASSWORD
POSTGRES_WRITER_PASSWORD
POSTGRES_MUTATION_PASSWORD
POSTGRES_MCP_PASSWORD
MYSQL_ROOT_PASSWORD
MYSQL_READER_PASSWORD
MYSQL_WRITER_PASSWORD
SQLSERVER_SA_PASSWORD
SQLSERVER_READER_PASSWORD
SQLSERVER_WRITER_PASSWORD
```

Required platform, MCP, storage, and model values:

```text
DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY
MCP_AUTH_TOKEN
MCP_CAPABILITY_SIGNING_KEY
TODO_MCP_AUTH_TOKEN
AZURE_STORAGE_ACCOUNT_NAME
AZURE_STORAGE_ACCOUNT_KEY
AZURE_STORAGE_CONTAINER
DAYTONA_API_KEY
OPENAI_API_KEY
PLATFORM_SANDBOX_IMAGE_URI
```

The owner database credentials remain separate from the read-only, writer,
controlled-mutation, and MCP control-plane roles. `MCP_AUTH_TOKEN` authenticates
only internal service-to-service calls to the shared datasource MCP;
`MCP_CAPABILITY_SIGNING_KEY` signs browser artifact-read capabilities and must
be generated independently.

Before building TrueForge, publish the custom Daytona sandbox image from
`docker/sandbox/Dockerfile` to a registry Daytona can pull. Resolve the pushed
image to its immutable registry digest and set `PLATFORM_SANDBOX_IMAGE_URI` to
the full `registry/repository@sha256:...` reference. Mutable tags are rejected
because every product sandbox must use the exact helper image registered at
bootstrap.

```sh
docker build -f docker/sandbox/Dockerfile -t registry.example.com/forty-two-sandbox:local .
docker push registry.example.com/forty-two-sandbox:local
docker buildx imagetools inspect registry.example.com/forty-two-sandbox:local
```

After copying the reported digest into `.env`, build the stack (including the
TrueForge image that embeds that immutable sandbox reference) and recreate the
services:

```sh
docker compose build
docker compose up -d --force-recreate
```

A plain `docker compose up` cannot bootstrap a fresh deployment until the
custom sandbox has been published and `PLATFORM_SANDBOX_IMAGE_URI` contains its
immutable digest.

The one-shot `trueforge-bootstrap` service configures OpenAI, Daytona, the Todo
connector, and exactly one shared internal `forty-two-data-source` connector,
then creates or updates the named `forty-two-data-agent`. The connector uses
the server-only `MCP_AUTH_TOKEN`; every datasource, file, database, artifact,
chart, and SQL tool also validates its explicit active application session and
immutable datasource bindings before accessing secrets, SAS URLs, or state.
TrueForge is an internal control plane with no host-published port; Next.js is
the only public/control-plane HTTP gateway used by judges and browsers. The
demo databases remain loopback-published for local connector E2E tests.

Datasource connections are registered through the server-side datasource API
and persisted under public `ds_` identifiers before they can be bound to a chat
session. The authenticated MCP bridge resolves only those exact, ready session
bindings; Compose does not inject an unscoped static datasource alias.

After the stack is healthy, run the live integration check:

```sh
pnpm test:control-plane-isolation
pnpm test:platform-integration
```

The first command proves the host cannot reach TrueForge and the public
Next.js session API rejects raw AgentSpecs and connector names. The second runs
inside the Compose network and proves that the shared service-token transport
cannot access a missing, inactive, deleted, or unbound application session.

The Next.js backend is the only public/control-plane HTTP gateway. It creates
datasource-bound sessions, accepts JSON turns, waits for completion, and
returns events through `/api/chat/sessions`. Public requests cannot supply raw
AgentSpecs or connector names; the backend constructs those control-plane
objects internally.

Run the complete frontend-facing backend test with the stack healthy:

```sh
pnpm test:chat-backend-e2e
```

This live test runs from the internal web container while calling the Next.js
product API. It proves a randomized Azure file download into Daytona, exact
ETag and byte-size checks, a session-scoped PostgreSQL query, cross-session
denial, and cleanup/revocation without exposing TrueForge on the host.

- Next.js: http://localhost:3000
- Postgres: `localhost:5432`, database `forty_two`
- MySQL: `localhost:3306`, database `forty_two_demo`
- SQL Server: `localhost:1433`, database `forty_two_demo`

Stop the stack without deleting persisted data:

```sh
docker compose down
```

### Manual file datasource blob cleanup

To retry pending cleanup for already-deleted file datasources on demand, run:

```sh
pnpm --filter web sweep:file-datasource-blobs
```

Each invocation claims at most 25 pending, already-soft-deleted file rows and
makes one exact-name, ETag-conditional Azure delete attempt per claimed row.
Set `FILE_DATASOURCE_CLEANUP_BATCH_SIZE` to an integer from 1 through 100 to
tune the per-run bound. Concurrent invocations are safe: PostgreSQL row locks
skip work already claimed by another process. A crash rolls the claim back, so
the next manual run resumes it; terminal deleted, missing, and superseded
rows are idempotently excluded. The JSON result contains aggregate progress
only and never emits blob names, ETags, SAS URLs, or account credentials.
For targeted remediation, set the optional comma-separated
`FILE_DATASOURCE_CLEANUP_DATA_SOURCE_IDS` (at most 100 valid `ds_` IDs); the
same exact-row state machine runs without scanning or deleting a blob prefix.

If an older local `postgres_data` volume was initialized with a different
password, either update that Postgres role or remove only that development
volume after `docker compose down`. Removing `forty-two_postgres_data`
permanently deletes the local database; never do this when its data is needed.

The Next.js and database ports listed above bind to `127.0.0.1`. The database
ports exist only for local connector E2E tests; they are not public HTTP or
control-plane APIs. TrueForge and both MCP services are intentionally
internal-only. Datasource MCP transport is authenticated by the server-only
service token and every tool validates the active session and its bindings.
Public session IDs are routing and correctness context, not tenant secrets or
authentication. The separate `ftart1` browser capability is scoped only to
read-only artifact list/detail/download APIs; it cannot call MCP tools or other
control-plane endpoints.

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
