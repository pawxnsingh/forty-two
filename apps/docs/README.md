# Forty Two docs scaffold

This workspace is a separate Next.js documentation scaffold. It is not included
in the production Compose deployment and is not the Forty Two product UI. The
public product lives in [`apps/web`](../web).

Run the docs scaffold from the repository root:

```sh
pnpm --filter docs dev
```

Open [http://localhost:3001](http://localhost:3001).

Available checks:

```sh
pnpm --filter docs check-types
pnpm --filter docs lint
pnpm --filter docs build
```

The current pages and assets are still the starter documentation surface. Do
not treat this workspace as product or deployment documentation; the root
[`README.md`](../../README.md) is authoritative.
