# sanctions-oracle

Off-chain adapter that checks a list of Stellar addresses against a
pluggable sanctions/watchlist data provider, then syncs any flagged
addresses into a Soroban `denylist-gate` contract instance (see
[compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives))
by invoking its `add_to_denylist(address)` contract function.

> ---
> **WARNING: PLACEHOLDER MOCK DATA — DEVELOPMENT/TESTING ONLY**
>
> The `MockSanctionsProvider` shipped in this package (`src/mockProvider.ts`)
> is a placeholder mock for development and testing ONLY. It contains NO
> real sanctions data and must NEVER be used as a real compliance data
> source in production. See the root [README](../README.md) disclaimer
> section for the repo-wide version of this warning.
> ---

## What it does

- Defines a generic `SanctionsProvider` interface so any external
  sanctions/watchlist data source can be plugged into the sync flow.
- Ships one reference implementation, `MockSanctionsProvider`, backed by a
  small static in-file list — for local development and tests only.
- Provides `syncSanctionsToDenylist`, a function that checks a list of
  candidate addresses against a `SanctionsProvider` and, for any flagged
  addresses, calls `add_to_denylist(address)` on a Soroban `denylist-gate`
  contract instance via `@stellar/stellar-sdk`.
- The actual "submit a transaction" step is isolated behind an injectable
  `DenylistWriter` interface, so the sync logic can be unit tested with a
  fake writer, with no live network required.

This package does **not** implement real sanctions data fetching — that is
tracked as a separate future issue.

Provider calls made during a sync (`provider.checkAddress`) are wrapped in
a retry-with-backoff helper (`withRetry`, see `src/retry.ts`): on failure
they retry with exponential backoff up to a configurable number of
attempts (`SyncOptions.retry`, default 3 attempts). If an address's
provider check still fails after exhausting all attempts, that address is
recorded in `SyncResult.failed` instead of aborting the whole sync run.

## The `SanctionsProvider` interface

```ts
export interface SanctionsProvider {
  checkAddress(address: string): Promise<{ flagged: boolean; source: string }>;
}
```

Implement this to plug in a real data source. For a detailed, copy-pasteable example of a REST-backed provider, see the `SanctionsProvider` JSDoc `@example` block in [`src/SanctionsProvider.ts`](./src/SanctionsProvider.ts) — it includes error handling and can serve as a template for integrating your own watchlist API.

A minimal implementation:

```ts
import { SanctionsProvider } from 'sanctions-oracle';

class MyProvider implements SanctionsProvider {
  async checkAddress(address: string) {
    const flagged = await myWatchlistApi.lookup(address);
    return { flagged: Boolean(flagged), source: 'my-watchlist-api' };
  }
}
```

Anything conforming to this interface — a REST client, a cache in front of
multiple upstream lists, a local CSV loader — can be passed to
`syncSanctionsToDenylist` in place of `MockSanctionsProvider`.

## Loading a CSV watchlist with `CsvSanctionsProvider`

`CsvSanctionsProvider` is a ready-made `SanctionsProvider` implementation for
CSV-backed watchlists, suitable for scenarios where you receive a periodic CSV
export from a compliance data vendor rather than querying a live API.

```ts
import { CsvSanctionsProvider } from 'sanctions-oracle';

const provider = new CsvSanctionsProvider('./watchlist.csv');
const result = await provider.checkAddress('GABC...');
// { flagged: true, source: 'csv-watchlist-v1' }   if address is in the file
// { flagged: false, source: 'csv-watchlist-v1' }  otherwise
```

### CSV format

The file must be UTF-8 encoded. The first row is treated as a header and always
skipped. Each subsequent row must have at least one comma-separated column:

| Column | Required | Description |
|---|---|---|
| 1 — `address` | yes | A valid Stellar Ed25519 public key (`G…`) |
| 2 — `source` | no | Free-text label identifying the list. Defaults to `csv-watchlist-v1` if omitted. |

Example:

```csv
address,source
GABC...,ofac-sdn
GDEF...,eu-consolidated
GHIJ...
```

Any row whose first column is not a valid `G…` public key is skipped with a
`console.warn` warning — the rest of the file continues loading normally.

### File-not-found behaviour

If the file at the provided path does not exist at construction time,
`CsvSanctionsProvider` logs a warning and starts with an empty flagged-address
set (i.e. every `checkAddress` call returns `{ flagged: false }`). This avoids
a hard crash in environments where the CSV file is populated asynchronously
after the provider is constructed.

### Wiring with `syncSanctionsToDenylist`

```ts
import { CsvSanctionsProvider, syncSanctionsToDenylist, createRpcDenylistWriter } from 'sanctions-oracle';
import { Keypair } from '@stellar/stellar-sdk';

const provider = new CsvSanctionsProvider('./watchlist.csv');
const writer = createRpcDenylistWriter({
  rpcUrl: process.env.STELLAR_RPC_URL!,
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
  contractId: process.env.DENYLIST_GATE_CONTRACT_ID!,
  sourceKeypair: Keypair.fromSecret(process.env.SANCTIONS_SOURCE_SECRET!),
});

const result = await syncSanctionsToDenylist({
  provider,
  addresses: ['GABC...', 'GDEF...'],
  writer,
});

console.log(`Flagged ${result.flagged.length} of ${result.checked} checked addresses`);
```

`CsvSanctionsProvider` also composes naturally with `ProviderRegistry` —
register it alongside other providers to combine CSV data with an API-backed
list.

## Running multiple providers with `ProviderRegistry`

Real deployments often want to check an address against more than one
source at once (e.g. an OFAC-style list, a regional list, and an internal
denylist) rather than a single `SanctionsProvider`. `ProviderRegistry` holds
several providers, queries all of them, and resolves disagreements according
to a configurable policy. It implements `SanctionsProvider` itself, so it's
a drop-in replacement anywhere a single provider is expected — including
`syncSanctionsToDenylist`:

```ts
import { ProviderRegistry, syncSanctionsToDenylist } from 'sanctions-oracle';

const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
registry.register('ofac-style', ofacProvider);
registry.register('regional-list', regionalProvider);
registry.register('internal-denylist', internalProvider);

await syncSanctionsToDenylist({ provider: registry, addresses, writer });
```

Supported conflict-resolution policies: `'any-flag-wins'` (flagged if any
provider flags it), `'majority-vote'` (flagged if a majority of responding
providers flag it, with a configurable tie-break), and
`'priority-override'` (the highest-priority registered provider's answer
wins outright). See
[`docs/provider-registry-design.md`](./docs/provider-registry-design.md)
for the full design, including how provider errors are handled.

## Configuration

Copy the root [`.env.example`](../.env.example) to `.env` at the repo root and
fill in the `sanctions-oracle` variables before running a live sync:

| Variable | CLI flag equivalent | Description |
|---|---|---|
| `STELLAR_RPC_URL` | `--rpc-url` | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `--network-passphrase` | Must match the network the RPC endpoint serves |
| `DENYLIST_GATE_CONTRACT_ID` | `--contract-id` | Deployed `denylist-gate` contract to write flagged addresses into |
| `SANCTIONS_SOURCE_SECRET` | `--secret-key` | Signing keypair that funds and signs denylist transactions |

See the comments in `.env.example` for allowed values and testnet guidance.

Dry-run mode (`--dry-run`) does not require `DENYLIST_GATE_CONTRACT_ID` or
`SANCTIONS_SOURCE_SECRET` — it only logs planned calls without touching the network.

## End-to-end example: custom provider with syncSanctionsToDenylist

This example shows how to wire a custom `SanctionsProvider` with
`syncSanctionsToDenylist` to check a list of addresses and submit them to
a denylist contract:

```ts
import { syncSanctionsToDenylist, createRpcDenylistWriter, SanctionsProvider } from 'sanctions-oracle';
import { Keypair } from '@stellar/stellar-sdk';

// 1. Implement your custom SanctionsProvider
// (For a realistic REST-backed example, see the @example block in src/SanctionsProvider.ts)
class MyCustomProvider implements SanctionsProvider {
  async checkAddress(address: string) {
    // Your watchlist logic here
    const flagged = await myWatchlistApi.lookup(address);
    return { flagged: Boolean(flagged), source: 'my-watchlist-api' };
  }
}

// 2. Create a writer that submits to your denylist contract
const writer = createRpcDenylistWriter({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'CABCDEF...',
  sourceKeypair: Keypair.fromSecret(process.env.SECRET_KEY!),
});

// 3. Sync: check addresses and write flagged ones to denylist
const result = await syncSanctionsToDenylist({
  provider: new MyCustomProvider(),
  addresses: ['GABC...', 'GDEF...'],
  writer,
  dryRun: false,
});

console.log(`Checked ${result.checked}, flagged ${result.flagged.length}, wrote ${result.written.length}`);
```

## Local / testnet walkthrough

This section walks through everything needed to run a live (non-dry-run) sync against a local or public Soroban testnet: funding an account, deploying the `denylist-gate` contract, and obtaining the `--rpc-url`, `--contract-id`, and `--secret-key` values the CLI requires.

### Prerequisites

- [Node.js ≥ 20](https://nodejs.org/)
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) — install with:
  ```sh
  cargo install --locked stellar-cli --features opt
  ```
  Or via the pre-built binaries on the [releases page](https://github.com/stellar/stellar-cli/releases).
- (Optional) [Docker](https://www.docker.com/) — only needed if you want a fully local network instead of the public testnet.

### Option A — Public Stellar testnet (quickest)

The Stellar Development Foundation runs a free, public Soroban-compatible testnet. No local Docker setup required.

```
RPC URL:            https://soroban-testnet.stellar.org
Network passphrase: Test SDF Network ; September 2015
```

#### 1. Generate a funded account

```sh
# Generate a new keypair
stellar keys generate --global alice --network testnet

# Print the secret key (keep this safe — treat it like a password)
stellar keys show alice

# The public key / address
stellar keys address alice
```

Friendbot automatically funds any newly generated testnet keypair when you use `--network testnet` with the Stellar CLI. If you created the keypair another way, fund it manually:

```sh
curl "https://friendbot.stellar.org/?addr=$(stellar keys address alice)"
```

Verify the account exists and has a balance:

```sh
stellar account balances --account-id $(stellar keys address alice) --network testnet
```

#### 2. Deploy the `denylist-gate` contract

> The `denylist-gate` Soroban contract lives in the [compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives) repo. Clone it and build the `.wasm` first:
>
> ```sh
> git clone https://github.com/stellar-compliance-kit/compliance-primitives
> cd compliance-primitives
> cargo build --release --target wasm32-unknown-unknown
> ```
>
> The compiled artifact will be at something like
> `target/wasm32-unknown-unknown/release/denylist_gate.wasm`.

Deploy the contract to testnet and capture the contract ID:

```sh
CONTRACT_ID=$(stellar contract deploy \
  --wasm path/to/denylist_gate.wasm \
  --source alice \
  --network testnet)

echo "Contract ID: $CONTRACT_ID"
```

The CLI prints the contract ID (a `C…` address). Keep it — this is your `--contract-id` value.

#### 3. Build the CLI

From inside the `sanctions-oracle` package:

```sh
npm install
npm run build
```

#### 4. Prepare an addresses file

Create a JSON file containing the Stellar addresses you want to check:

```json
["GABC...", "GDEF..."]
```

```sh
echo '["GABC...","GDEF..."]' > addresses.json
```

#### 5. Run a live sync

```sh
node dist/sync.js \
  --addresses ./addresses.json \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --contract-id "$CONTRACT_ID" \
  --secret-key "$(stellar keys show alice)"
```

The CLI submits one `add_to_denylist(address)` transaction per flagged address and prints a JSON summary, for example:

```json
{
  "checked": 2,
  "flagged": ["GABC..."],
  "written": ["GABC..."],
  "dryRun": false
}
```

---

### Option B — Fully local network (no public testnet)

Use `stellar network start` (backed by Docker) to run an isolated local environment:

```sh
# Start a local Stellar/Soroban node (runs in the background)
stellar network start local

# The local RPC endpoint and passphrase
#   RPC URL:            http://localhost:8000/soroban/rpc
#   Network passphrase: Standalone Network ; February 2017
```

Generate and fund a local account:

```sh
stellar keys generate --global alice --network local

# Friendbot for the local network
curl "http://localhost:8000/friendbot?addr=$(stellar keys address alice)"
```

Deploy and run exactly as in Option A, substituting:

```sh
--rpc-url http://localhost:8000/soroban/rpc \
--network-passphrase "Standalone Network ; February 2017"
```

Stop the local node when done:

```sh
stellar network stop local
```

---

### Quick-reference: values at a glance

| Flag | Public testnet | Local network |
|---|---|---|
| `--rpc-url` | `https://soroban-testnet.stellar.org` | `http://localhost:8000/soroban/rpc` |
| `--network-passphrase` | `Test SDF Network ; September 2015` | `Standalone Network ; February 2017` |
| `--contract-id` | output of `stellar contract deploy …` | output of `stellar contract deploy …` |
| `--secret-key` | output of `stellar keys show <name>` | output of `stellar keys show <name>` |

---

## Running the sync script

Once built (`npm run build`), the sync script is available as the
`sanctions-sync` CLI bin, or can be run directly with `node dist/sync.js`.

It reads a JSON file containing an array of candidate addresses to check
(in a real deployment this list might come from a chain scan or an
existing account list — the CLI takes it as a plain file for simplicity):

```json
[
  "GABC...",
  "GDEF..."
]
```

### Insomnia Collection

For a complete interactive reference of the sync script's CLI flags and
expected JSON input format, import [`insomnia_collection.json`](./insomnia_collection.json)
into [Insomnia](https://insomnia.rest/) or another API client. The collection includes:

- **Dry-run example** — Check addresses without submitting transactions
- **Live sync example** — Submit transactions to a Soroban contract
- **JSON schema documentation** — Expected addresses file format
- **CLI flags reference** — Complete parameter documentation

### View CLI flags

To see a summary of all available flags and examples:

```sh
node dist/sync.js --help
```

or the short form:

```sh
node dist/sync.js -h
```

### Dry-run against testnet (no transactions submitted)

```sh
node dist/sync.js --addresses ./addresses.json --dry-run
```

This checks every address against the (mock) provider and logs each
planned `add_to_denylist(address)` call, without calling the writer at
all.

### Live sync

```sh
node dist/sync.js \
  --addresses ./addresses.json \
  --contract-id CABCDEF... \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --secret-key SABCDEF...
```

This builds, signs, and submits one `add_to_denylist` invocation per
flagged address using `@stellar/stellar-sdk`'s `Contract`,
`TransactionBuilder`, and `rpc.Server`.

## Troubleshooting

- **`addToDenylist should not be called in dry-run mode` error** — This
  error occurs when the dry-run writer stub is used outside the intended
  CLI path (e.g., when calling `syncSanctionsToDenylist` programmatically
  with `dryRun: true` but accidentally providing a real writer). This is
  a deliberate guard to prevent accidental contract modifications. Ensure
  that when `dryRun: true`, you pass a stub writer (as the CLI does) that
  never actually submits transactions.
- **RPC url unreachable / request timeout** — verify `--rpc-url` is
  reachable from where you're running the script (e.g.
  `curl <rpc-url>`), and that you're not pointed at a local/private RPC
  endpoint from an environment that can't reach it.
- **Wrong network passphrase** — a `--network-passphrase` that doesn't
  match the network the RPC endpoint actually serves will cause
  transaction build or submission to fail (signature/hash mismatches,
  or the network rejecting the transaction). Double check you're using
  the testnet passphrase against a testnet RPC endpoint, and the
  pubnet/mainnet passphrase against a pubnet RPC endpoint.
- **Insufficient XLM balance for fees** — the account behind
  `--secret-key` needs enough XLM to cover the transaction fee (and to
  be funded/exist on the target network at all). Fund it via
  [friendbot](https://friendbot.stellar.org/) on testnet.
- **Contract not found** — a `--contract-id` that's misspelled, or that
  refers to a contract not deployed on the network your `--rpc-url`
  points at, will fail when the transaction is simulated/prepared.
  Double check the contract ID and that it's deployed on the same
  network you're targeting.
- **Sequence number errors (`tx_bad_seq` or similar)** — the error
  message typically includes `bad sequence` or an HTTP 400 with
  `transaction failed` during `sendTransaction`. This happens when the
  source account's sequence number in the transaction doesn't match what
  the network expects. Common causes:
  - The source account is being used by another process or script
    simultaneously (e.g. another sync run, a bot, or a manual wallet
    transaction), causing sequence numbers to drift.
  - A previous transaction from the same account hasn't been fully
    ingested by the network yet before the next one is submitted.

  **Fix:** ensure only one instance of the sync script runs against a
  given source account at a time. If you need to run concurrent syncs,
  use separate source accounts. If you're submitting many transactions
  in a loop (one per flagged address), add a small delay between
  submissions or poll `server.getTransaction(hash)` and wait for
  `status === 'SUCCESS'` before submitting the next one.
- **Rate limiting from the RPC endpoint (HTTP 429 or `ECONNRESET`)** —
  public RPC endpoints (including `https://soroban-testnet.stellar.org`)
  often enforce rate limits. Symptoms include:
  - `HTTP 429 Too Many Requests` responses.
  - Connection resets (`ECONNRESET`, `socket hang up`) mid-sync when
    submitting many transactions in quick succession.
  - Requests hanging or timing out after a batch of successful calls.

  **Fix:** first run a `--dry-run` to confirm that address checking
  works independently of submission throughput issues. Then add a
  delay between transaction submissions (e.g. 1–2 seconds) to stay
  within rate limits. For production workloads, consider using a
  dedicated RPC provider with higher rate limits, or self-hosting an
  RPC node.
- **Clock skew causing transaction submission failures** — if the local
  machine's clock is significantly out of sync with the Stellar network,
  transactions may be rejected because their time bounds don't align
  with the current ledger close time. The error may appear as a generic
  `sendTransaction` failure or a `transaction failed` status with no
  obvious explanation in the result codes.

  **Fix:** synchronize your system clock with NTP. On most Linux
  systems: `sudo ntpdate -u pool.ntp.org` or `sudo timedatectl
  set-ntp true`. On macOS, ensure "Set date and time automatically" is
  enabled in System Settings. A clock drift of more than 30 seconds is
  likely to cause issues.

## Related

- Root repo [README](../README.md)
- [compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives) —
  the Soroban contracts (including `denylist-gate`) this package talks to.
