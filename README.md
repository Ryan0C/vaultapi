# VaultAPI

VaultAPI is the backend service for the Vault stack. It handles auth/session flows, serves world and actor APIs, and writes import envelopes consumed by VaultSync.

## Working Directory

`/Users/ryanoconnor/Documents/development/foundryvtt/vaultapi`

## Setup

```bash
npm install
cp .env.example .env
```

## Run

```bash
npm run dev
```

Production-style local run:

```bash
npm run build
npm start
```

## Test

```bash
npm test
```

Explicit test profiles:

```bash
npm run test:unit
npm run test:integration
npm run check:ts-nocheck
```

Notes:
- Default/unit tests run from `src/**` only.
- `dist/**` is excluded from discovery.
- Integration profile is reserved for `src/**/__tests__/integration/**`.
- `check:ts-nocheck` fails if `@ts-nocheck` usage exceeds the committed baseline.
- Incremental removal plan: `docs/ts-nocheck-burndown.md`.

## Environment

Primary env file: `vaultapi/.env`  
Template: `vaultapi/.env.example`

Key variables:

- `PORT`: API listen port (local default `4000`)
- `NODE_ENV`: runtime mode (typically `development`)
- `LOG_LEVEL`: log verbosity
- `VAULT_ROOT`: vault storage root in Foundry data
- `VAULT_DB_PATH`: SQLite database path
- `FOUNDRY_DATA_ROOT`: Foundry data root
- `FOUNDRY_PUBLIC_ROOT`: Foundry public root for media resolution
- `CORS_ORIGINS`: allowed frontend origins (include VaultHero dev origin)
- `SESSION_SECRET`: session signing secret
- `SESSION_DB_DIR`: session DB directory
- `SESSION_DB_NAME`: session DB filename
- `BOOTSTRAP_ADMIN_USERNAME`: initial admin username for first boot
- `BOOTSTRAP_ADMIN_PASSWORD`: initial admin password for first boot

## Related Repos

- VaultHero frontend: `/Users/ryanoconnor/Documents/development/foundryvtt/vaulthero`
- VaultSync Foundry module: `/Users/ryanoconnor/Documents/development/foundryvtt/vaultsync`
- Cross-service runbook: `/Users/ryanoconnor/Documents/development/foundryvtt/vault-ops/docs/cross-service-runbook.md`
