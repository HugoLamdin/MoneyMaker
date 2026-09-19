# UK Quant Dashboard

A self-contained dark-mode paper-trading workspace for UK residents to review GBP trend signals, manage mock cash, and stay in simulation mode until they are ready to connect a broker.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/uk-quant-dashboard run dev` — run the web dashboard
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/uk-quant-dashboard/src/App.tsx` — auth gate, dashboard views, cash dialogs, and broker compliance dialog
- `artifacts/uk-quant-dashboard/src/index.css` — dark instrument-panel theme and responsive layout rules
- `artifacts/api-server/src/routes/quant.ts` — auth, portfolio, market, signal, and cash API routes
- `artifacts/api-server/src/lib/market.ts` — deterministic simulated UK market history and SMA50 signal engine
- `artifacts/api-server/src/lib/auth.ts` — scrypt password hashing and signed httpOnly session cookie helpers
- `lib/db/src/schema/` — PostgreSQL tables for users, portfolios, and signal history
- `lib/api-spec/openapi.yaml` — source of truth for the generated API hooks and Zod contracts

## Architecture decisions

- Local account auth is intentional: users are stored in the built-in PostgreSQL database, passwords use Node's `scryptSync`, and sessions use a signed httpOnly cookie.
- Market data uses a validated Yahoo adjusted-close snapshot for UK shares, the FTSE benchmark, Bitcoin/GBP, and Ethereum/GBP, so paper trading works without broker keys.
- Signals are generated from the price vs 50-day moving average and persisted per user with a short duplicate window.
- New BUY signals automatically allocate paper cash across eligible UK equities and crypto under the configured reserve and position caps; new SELL or stop-loss signals close matching holdings.
- Broker credentials are intentionally not persisted or sent anywhere; the UI keeps the workspace in safe simulation mode.
- The Paper/Live mode control is persisted per portfolio, but live mode remains locked until verified broker order routing is implemented and connected.

## Product

- Centered email/password login and registration
- GBP portfolio overview with simulated UK assets, sparklines, trend state, and BUY/SELL/HOLD decisions
- Persistent mock cash deposit and withdraw controls
- Persistent auto-managed paper holdings with equal-weight BUY entries and signal-driven SELL exits
- Explainable signal log with price, SMA50, timestamp, and reason
- Watchlist view and broker compliance modal for Interactive Brokers UK / Alpaca UK
- Persisted Paper/Live mode control with a hard safety gate before live order routing

## User preferences

- Keep the experience self-contained with no manual database, auth, or broker setup required for simulation mode.

## Gotchas

- Run `pnpm run typecheck:libs` after schema changes so workspace declarations expose new tables to the API server.
- API routes live under `/api`; web and API workflows provide `PORT` and `BASE_PATH`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
