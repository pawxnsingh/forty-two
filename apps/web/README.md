# Forty Two web

The web application is Forty Two's public product surface and server-side
gateway. It contains the connector marketplace, datasource setup flows,
conversation UI, execution and plan presentation, approval controls, and table
and chart artifact rendering.

The browser never talks directly to TrueForge, either MCP service, Daytona,
PostgreSQL, or Azure Blob Storage. Server routes in this app enforce the public
API contract and keep control-plane credentials private.

## Run from the workspace

Install dependencies from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Start only the web development server on port 3000:

```sh
pnpm --filter web dev
```

The full product requires the Compose services and root `.env` configuration.
Follow the root [`README.md`](../../README.md) for a working end-to-end stack.

## Routes

- `/connectors` — list, inspect, start a session from, or remove datasources
- `/connectors/new` — connector marketplace
- `/connectors/new/[type]` — file or database connector setup
- `/chat` — create a new datasource-bound session
- `/chat/[sessionId]` — durable conversation, execution, plan, and artifacts
- `/api/data-sources/*` — server-side datasource lifecycle APIs
- `/api/chat/sessions/*` — session, turn, approval, event, and artifact APIs

## Commands

Run these from the repository root:

```sh
pnpm --filter web check-types
pnpm --filter web lint
pnpm --filter web build
pnpm --filter web test
pnpm --filter web test:chat-client
pnpm --filter web test:turn-events
pnpm --filter web test:artifacts
```

The production image is built by the root Compose stack. It runs the optimized
Next.js standalone server rather than a development server. The app uses Google
Sans Flex through `next/font` together with the shared Forty Two design-token
font stacks.
