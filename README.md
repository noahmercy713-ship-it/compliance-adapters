# compliance-adapters

[![CI](https://github.com/stellar-compliance-kit/compliance-adapters/actions/workflows/ci.yml/badge.svg)](https://github.com/stellar-compliance-kit/compliance-adapters/actions/workflows/ci.yml)

Integration adapters connecting Stellar compliance primitives to SEP-10 auth, sanctions oracles, and Horizon/RPC event streams.

Having on-chain compliance controls — allowlists, denylists, jurisdiction flags — is only half the problem. To actually run a compliant app on Stellar, teams still need to verify who's making a request, feed real-world watchlist data into those on-chain controls, and react when compliance state changes. That's a lot of repetitive off-chain glue: SEP-10 authentication, syncing external sanctions data, listening for contract events. This repo provides ready-made, well-tested adapters for that glue layer so app developers don't have to hand-roll it for every project.

## Relationship to `compliance-primitives`

This repo consumes the on-chain Soroban contracts defined in
[`compliance-primitives`](https://github.com/stellar-compliance-kit/compliance-primitives) —
`allowlist-token`, `denylist-gate`, and `jurisdiction-flag`. It does not vendor or reimplement
those contracts; adapters here call into deployed instances of them (or listen for events they
emit) via `@stellar/stellar-sdk`. If you're looking for the on-chain contract logic itself, that
lives in the other repo.

## What's in this repo

This is a monorepo with three independent packages and a runnable examples directory:

- **[`sep10-auth`](./sep10-auth)** — builds and verifies [SEP-10](https://stellar.org/protocol/sep-10)
  web authentication challenges, so you can confirm a request is really coming from the Stellar
  address it claims to be from before running any compliance check. Includes an example Express
  middleware.
- **[`sanctions-oracle`](./sanctions-oracle)** — a `SanctionsProvider` interface plus a mock
  implementation and a sync script that pushes flagged addresses into a deployed `denylist-gate`
  contract instance.
- **[`horizon-listener`](./horizon-listener)** — an example service that polls Soroban RPC for
  `denylist-gate` / `allowlist-token` contract events and re-emits them to a webhook, as a
  reference pattern for reacting to on-chain compliance state changes.

Each package has its own `README.md`, tests, and `package.json`.

## Examples

Runnable examples live under [`examples/`](./examples). Each is a self-contained npm workspace
that wires the adapters together in a realistic scenario.

### [`examples/sep10-sanctions-gate`](./examples/sep10-sanctions-gate)

An Express server exposing a single gated route (`GET /gated`) that composes `sep10-auth` and
`sanctions-oracle` end-to-end:

1. `createSep10Middleware` from `sep10-auth` validates the caller's SEP-10 Bearer token and
   attaches the verified Stellar address to `req.stellarAddress`. Unauthenticated requests get
   a 401 before the sanctions check ever runs.
2. The verified address is checked against a `SanctionsProvider`. A flagged address gets a 403;
   a clean address gets a 200 with the verified address echoed back.

To run it locally (requires a real `SERVER_ACCOUNT_ID` env var pointing to a Stellar G... key):

```bash
npm install --workspace=sep10-sanctions-gate
SERVER_ACCOUNT_ID=G... HOME_DOMAIN=localhost:3000 npm run dev --workspace=sep10-sanctions-gate
```

To run its tests:

```bash
npm test --workspace=sep10-sanctions-gate
```

## Architecture

The diagram below shows how the three packages fit together in a typical deployment alongside the on-chain contracts from [`compliance-primitives`](https://github.com/stellar-compliance-kit/compliance-primitives).

```mermaid
flowchart TD
    Client(["Client\n(Stellar wallet)"])
    App["Your API / App Server"]
    Sep10["sep10-auth\n(challenge · verify · middleware)"]
    Oracle["sanctions-oracle\n(SanctionsProvider · syncSanctionsToDenylist)"]
    Listener["horizon-listener\n(RpcEventSource · HorizonListener)"]
    Watchlist[["External watchlist\n/ sanctions data source"]]
    Webhook["Your webhook handler\n(re-acts to on-chain state changes)"]
    Soroban(["Soroban RPC\n(soroban-testnet / pubnet)"])
    Contracts["compliance-primitives contracts\n(denylist-gate · allowlist-token · jurisdiction-flag)"]
    Logger["logger\n(Logger · consoleLogger · noopLogger)"]

    Client -->|"1 · request challenge"| Sep10
    Sep10 -->|"2 · unsigned challenge XDR"| Client
    Client -->|"3 · signed challenge XDR"| Sep10
    Sep10 -->|"4 · verified Stellar address\n(req.stellarAddress)"| App

    App -->|"5 · compliance check\n(is address denied / allowed?)"| Contracts

    Watchlist -->|"flagged addresses"| Oracle
    Oracle -->|"add_to_denylist(address)\nvia Stellar SDK"| Soroban
    Soroban -->|"transaction applied"| Contracts

    Contracts -->|"emit AddedToDenylist /\nAddedToAllowlist events"| Soroban
    Listener -->|"poll getEvents (cursor-based)"| Soroban
    Listener -->|"HTTP POST event payload"| Webhook
    Webhook -->|"trigger re-sync /\nalert / audit log"| Oracle

    Logger -.->|"injectable Logger interface"| Sep10
    Logger -.->|"injectable Logger interface"| Oracle
    Logger -.->|"injectable Logger interface"| Listener
```

**Flow summary:**

1. `sep10-auth` authenticates the caller's Stellar address before any compliance check runs.
2. Your app server queries the on-chain `denylist-gate` / `allowlist-token` / `jurisdiction-flag` contracts to decide whether the authenticated address is permitted.
3. `sanctions-oracle` periodically pulls flagged addresses from an external watchlist and pushes them into `denylist-gate` via Soroban RPC.
4. `horizon-listener` polls Soroban RPC for contract events (e.g. `AddedToDenylist`) and forwards them to a webhook, allowing downstream services to react to on-chain state changes in near-real-time — for example by triggering a fresh `sanctions-oracle` sync.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/stellar-compliance-kit/compliance-adapters.git
cd compliance-adapters
npm install

# run every package's test suite
npm test

# run a single package's tests
npm test --workspace=sep10-auth

# build all packages
npm run build

# build a single package
npm run build --workspace=sep10-auth
```

### Building

The root-level `npm run build` script runs the TypeScript compiler across all three packages
(`sep10-auth`, `sanctions-oracle`, and `horizon-listener`) using npm workspaces. Each package
produces compiled output in its `dist/` directory. This is equivalent to running `tsc -p .` in
each package independently.

### Working with a single package

If you only need to work on one adapter:

```bash
# Install and test sep10-auth
npm install --workspace=sep10-auth
npm test --workspace=sep10-auth

# Install and test sanctions-oracle
npm install --workspace=sanctions-oracle
npm test --workspace=sanctions-oracle

# Install and test horizon-listener
npm install --workspace=horizon-listener
npm test --workspace=horizon-listener
```

## Full-stack demo example

A runnable example app lives at `examples/full-stack-demo`. It demonstrates the end-to-end flow:

- `sep10-auth` protects a `/private` route with SEP-10 bearer token verification
- `horizon-listener` polls Soroban RPC contract events and forwards them to an internal webhook
- `sanctions-oracle` sync logic is exposed via a `/sync` endpoint using the mock provider

To run it:

```bash
npm install
npm run build --workspaces --if-present
cd examples/full-stack-demo
npm install
npm start
```

The demo starts an Express server on `http://localhost:3000` and exposes:

- `GET /public`
- `GET /private`
- `GET /sync`
- `GET /challenge`

You can configure runtime values with environment variables such as `SERVER_ACCOUNT_ID`, `RPC_URL`, and `CONTRACT_ID`.

To try the sanctions sync script against testnet in dry-run mode (no transactions submitted, just
logs what it would do):

```bash
npm run build --workspace=sanctions-oracle
npx compliance-adapters sync-sanctions --dry-run --addresses ./sanctions-oracle/test/fixtures/addresses.json
```

Run `npx compliance-adapters --help` for available commands and
`npx compliance-adapters sync-sanctions --help` for command-specific options.

See each package's README for its full API and configuration options.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and version history.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and workflow details.

## Release tooling

This monorepo uses Changesets for coordinated package releases and changelog generation.

To create a release note for changed packages:

```bash
npm run changeset
```

Then to version packages and generate changelog entries:

```bash
npm run version
```

After review, publish releases with:

```bash
npm run release
```

Changesets will manage consistent version bumps across `sep10-auth`, `sanctions-oracle`, and `horizon-listener`.
This repo participates in the [Drips Wave](https://www.drips.network/) Stellar Program and is
deliberately kept full of small, well-scoped issues. Open issues are labeled by complexity
(`complexity: trivial`, `complexity: medium`, `complexity: high`) so you can pick work that
matches your available time — trivial issues are also tagged `good first issue` and don't require
Soroban expertise.

## Security

See [SECURITY.md](./SECURITY.md) for the trust model behind each package and how to report a
vulnerability.

## Disclaimer

The `sanctions-oracle` package's bundled mock provider is a **placeholder for development and
testing only**. It contains no real sanctions or watchlist data and **must not be used as an
actual compliance data source in production**. Integrate a real, licensed sanctions/watchlist
data provider before relying on this package for real compliance decisions.

## License

[MIT](./LICENSE)

## Package-scoped issue labels

This repo uses package-scoped labels to make triage easier. The intended labels are:

- `package: sep10-auth` — issues specific to the `sep10-auth` package
- `package: sanctions-oracle` — issues specific to the `sanctions-oracle` package
- `package: horizon-listener` — issues specific to the `horizon-listener` package

A helper script `scripts/apply-package-labels.js` can create these labels and apply them to open
issues using simple heuristics. It requires a `GITHUB_TOKEN` with repo access to run.
