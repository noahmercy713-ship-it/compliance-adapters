# sep10-auth

Verifies a user's authenticated Stellar address via [SEP-10 Web
Authentication](https://stellar.org/protocol/sep-10) before compliance checks
(allowlist, denylist, jurisdiction flags) run elsewhere in the stack. It wraps
`@stellar/stellar-sdk`'s `WebAuth` helpers to build a challenge transaction,
verify a signed challenge, and expose an Express middleware that resolves the
signed-in Stellar address for downstream handlers.

## Install

```sh
npm install
```

(This package is part of the `compliance-adapters` npm workspace; run install
from the repo root.)

## Configuration

Copy the root [`.env.example`](../.env.example) to `.env` at the repo root and
fill in the `SEP10_*` variables before running the package locally:

| Variable | Description |
|---|---|
| `SEP10_SERVER_SECRET` | Secret key of the server-side SEP-10 signing keypair |
| `SEP10_SERVER_PUBLIC_KEY` | Corresponding public key (used as `serverAccountId`) |
| `SEP10_HOME_DOMAIN` | Home domain embedded in challenge transactions |
| `SEP10_WEB_AUTH_DOMAIN` | Web-auth domain (often the same as `SEP10_HOME_DOMAIN`) |
| `SEP10_TIMEOUT_SECONDS` | Challenge lifetime in seconds, passed as `timeoutSec` (default `900`, maximum `3600`) |

See the comments in `.env.example` for allowed values and testnet guidance.

## Which SEP covers which account type

| Account type | Standard | API |
|---|---|---|
| Classic `G...` account | [SEP-10](https://stellar.org/protocol/sep-10) | `generateChallenge` / `verifyChallenge` |
| Muxed `M...` account (SEP-10 v3) | [SEP-10](https://stellar.org/protocol/sep-10) | `generateChallenge` / `verifyChallenge` |
| Soroban contract account `C...` | [SEP-45](https://stellar.org/protocol/sep-45) (prototype) | `generateContractChallenge` / `verifyContractChallenge`, see [SEP-45 prototype](#sep-45-prototype-contract-accounts) |

## API

### `generateChallenge(clientAddress, serverKeypair, options?)`

Builds a SEP-10 challenge transaction for a client to sign.

```ts
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { generateChallenge } from 'sep10-auth';

const serverKeypair = Keypair.fromSecret(process.env.SEP10_SERVER_SECRET!);

const challenge = generateChallenge(clientAddress, serverKeypair, {
  homeDomain: 'example.com',
  webAuthDomain: 'auth.example.com',
  networkPassphrase: Networks.PUBLIC,
  timeoutSec: 300,
});

// send challenge.transactionXDR to the client to sign
```

`timeoutSec` is the challenge validity window in seconds. It defaults to `900`
and must be finite, greater than `0` and at most `3600`; any other value throws
`InvalidTimeoutError`. The older `timeoutSeconds` option is a deprecated alias
and is validated the same way.

`clientAddress` may be a muxed `M...` address (SEP-10 v3), which lets custodial
wallets identify sub-users. A muxed account cannot be combined with `memo`;
doing so throws `MemoWithMuxedAccountError`.

To support the SEP-10 client domain flow (where a wallet's client-domain
server co-signs the challenge), pass `clientDomain` along with the
`clientSigningKey` published on `<clientDomain>/.well-known/stellar.toml`
(this package does not fetch stellar.toml itself, so resolve the key
yourself):

```ts
const challenge = generateChallenge(clientAddress, serverKeypair, {
  homeDomain: 'example.com',
  webAuthDomain: 'auth.example.com',
  clientDomain: 'wallet.example',
  clientSigningKey: 'GABC...', // from wallet.example/.well-known/stellar.toml
});
```

### `resolveHomeDomain(requested, configured)`

Resolves the SEP-10 `home_domain` request parameter against your configured
home domains. A missing or empty value falls back to the first configured
domain; a value that is not configured throws `UnknownHomeDomainError`, which
a router should turn into a `400` response.

```ts
import { resolveHomeDomain, UnknownHomeDomainError } from 'sep10-auth';

try {
  const homeDomain = resolveHomeDomain(req.query.home_domain as string | undefined, [
    'example.com',
    'other.example.org',
  ]);
  // pass `homeDomain` to generateChallenge
} catch (error) {
  if (error instanceof UnknownHomeDomainError) {
    res.status(400).json({ error: error.message });
    return;
  }
  throw error;
}
```

### `verifyChallenge(signedTransactionXDR, options)`

Verifies a client-signed challenge transaction and returns the authenticated
address.

```ts
import { verifyChallenge } from 'sep10-auth';

const result = verifyChallenge(signedXDR, {
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'auth.example.com',
});

if (result.valid) {
  // result.address is the authenticated Stellar account ID
  // result.clientDomain is set if the challenge used the client domain flow
} else {
  // result.error describes why verification failed
}
```

For a muxed client account, `result.account` is the `M...` address,
`result.baseAccount` is the underlying `G...` account and `result.muxedId` is
the mux id (decimal string). For a plain `G...` account `account` and
`baseAccount` are equal and `muxedId` is absent.

#### `clockSkewToleranceSec`

`WebAuth.readChallengeTx` already tolerates 300 seconds of clock drift on each
timebound. Set `clockSkewToleranceSec` to widen that window symmetrically
(`minTime - tolerance` and `maxTime + tolerance`) for clients and servers whose
clocks drift further apart:

```ts
verifyChallenge(signedXDR, {
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'auth.example.com',
  clockSkewToleranceSec: 120, // default 0: no tolerance beyond the SDK's own
});
```

It must be finite and non-negative; otherwise verification fails with
`INVALID_OPTIONS`.

### SEP-45 prototype (contract accounts)
### `authenticateWithSep10(options)`

A client-side helper for server-to-server (Node/CLI) SEP-10 flows. It fetches a
challenge, validates the server signature and network passphrase, signs the
challenge with the provided keypair, and exchanges it for a JWT — all in one
call. Designed for anchors or services that need to authenticate against
another server's SEP-10 endpoint without a browser wallet.

```ts
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { authenticateWithSep10 } from 'sep10-auth';

const keypair = Keypair.fromSecret(process.env.CLIENT_SECRET!);

const token = await authenticateWithSep10({
  authEndpoint: 'https://anchor.example.com/auth',
  keypair,
  homeDomain: 'anchor.example.com',
  networkPassphrase: Networks.PUBLIC,
});

// Use the JWT as a Bearer token for subsequent API calls:
await fetch('https://anchor.example.com/transactions', {
  headers: { Authorization: `Bearer ${token}` },
});
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `authEndpoint` | `string` | *(required)* | Full URL of the SEP-10 auth endpoint (e.g. `https://example.com/auth`). |
| `keypair` | `Keypair` | *(required)* | Client keypair that signs the challenge. Must contain a secret key. |
| `homeDomain` | `string` | *(required)* | Home domain to authenticate for. Sent as `home_domain` and used to validate the challenge. |
| `clientDomain` | `string` | — | Wallet client domain for the SEP-10 client domain flow. |
| `serverAccountId` | `string` | resolved from `stellar.toml` | Server's public key (G...) used to validate the server's signature. When omitted, resolved from `SIGNING_KEY` in the server's `stellar.toml`. |
| `networkPassphrase` | `string` | `Networks.TESTNET` | Expected network passphrase. The challenge is rejected if its `network_passphrase` does not match. |
| `webAuthDomain` | `string` | `homeDomain` | Web-auth domain expected in the challenge's `web_auth_domain` operation. |
| `memo` | `string` | — | Optional memo to include in the challenge request. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injectable `fetch` implementation (for testing or custom headers/timeouts). |
| `logger` | `Logger` | `noopLogger` | Injectable logger. |

**Errors:**

All failures throw a `Sep10ClientError` with a stable `code` field:

| Code | Meaning |
|------|---------|
| `INVALID_KEYPAIR` | The provided keypair cannot sign. |
| `INVALID_SERVER_ACCOUNT_ID` | The resolved or provided `serverAccountId` is not a valid Ed25519 public key. |
| `SERVER_KEY_NOT_FOUND` | No `SIGNING_KEY` found in the server's `stellar.toml`. |
| `TOML_RESOLUTION_FAILED` | The server's `stellar.toml` could not be fetched or parsed. |
| `CHALLENGE_REQUEST_FAILED` | The `GET /auth` request returned a non-200 status or the connection failed. |
| `NETWORK_MISMATCH` | The `network_passphrase` in the challenge response does not match the expected value. |
| `INVALID_SERVER_SIGNATURE` | The challenge transaction is not signed by the server, or the home/web-auth domain does not match. |
| `ACCOUNT_MISMATCH` | The challenge was built for a different account than the one requested. |
| `TOKEN_EXCHANGE_FAILED` | The `POST /auth` request returned a non-200 status or the connection failed. |

```ts
import { authenticateWithSep10, Sep10ClientError } from 'sep10-auth';

try {
  const token = await authenticateWithSep10({ /* ... */ });
} catch (error) {
  if (error instanceof Sep10ClientError) {
    console.error(`SEP-10 failed: ${error.code} — ${error.message}`);
  }
}
```


`generateContractChallenge` and `verifyContractChallenge` authenticate Soroban
contract accounts (`C...`) with authorization entries for the anchor's
`web_auth_verify` contract function instead of a `manage_data` transaction.
They live in a separate module that is not re-exported from the package index,
so the SEP-10 surface is unchanged:

```ts
import { generateContractChallenge, verifyContractChallenge } from 'sep10-auth/dist/sep45';

const challenge = await generateContractChallenge(clientContractId, serverKeypair, {
  webAuthContractId,
  validUntilLedger: currentLedger + 100,
  homeDomain: 'example.com',
});
// send challenge.authorizationEntries; the client signs its entry and returns both

const result = await verifyContractChallenge(signedEntries, {
  webAuthContractId,
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'example.com',
  currentLedger,
  verifyClientAuthorization: (clientEntry) => simulateWebAuthVerify(clientEntry),
});
```

See [`docs/sep45-design.md`](../docs/sep45-design.md) for the flow and the
prototype's limits.

### `createSep10Middleware(options)`

An Express middleware factory. Expects the signed challenge transaction XDR on
each request as `Authorization: Bearer <base64-xdr>`, and sets
`req.stellarAddress` on success.

```ts
import express from 'express';
import { createSep10Middleware } from 'sep10-auth';

const app = express();

app.use(
  '/compliance',
  createSep10Middleware({
    serverAccountId: serverKeypair.publicKey(),
    homeDomains: 'example.com',
    webAuthDomain: 'auth.example.com',
  })
);

app.get('/compliance/status', (req, res) => {
  res.json({ address: req.stellarAddress });
});
```

Every `401` response carries an RFC 6750 `WWW-Authenticate` header, e.g.
`Bearer realm="example.com", error="invalid_token"`. The `realm` is the first
configured home domain; `error` is `invalid_request` when the `Authorization`
header is missing or malformed, and `invalid_token` when the token is too
large, fails verification or belongs to a revoked address.

This is a reference pattern: it re-verifies the raw challenge transaction on
every request. A production deployment would typically verify once and issue
a short-lived session token instead — that's out of scope for this package.

### `sep10Plugin` (Fastify)

A Fastify plugin, imported from `sep10-auth/fastify`, that shares its
authentication logic with `createSep10Middleware` through
`authenticateRequest(headers, options)` and decorates `request.stellarAddress`.
It takes the same options as `createSep10Middleware` plus `global`. `fastify`
and `fastify-plugin` are optional peer dependencies.

```ts
import Fastify from 'fastify';
import { sep10Plugin } from 'sep10-auth/fastify';

const app = Fastify();
await app.register(sep10Plugin, {
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'auth.example.com',
});

app.get('/compliance/status', async (request) => ({ address: request.stellarAddress }));
```

By default every route in the scope is authenticated. Pass `global: false` to
only decorate `fastify.sep10Authenticate` and attach it to individual routes
with `{ preHandler: app.sep10Authenticate }`. `401` responses match the Express
adapter, including the `WWW-Authenticate` header.

### `createSep10Router(options)`

An Express `Router` implementing the SEP-10 endpoints, guarded by the built-in
`rateLimiter`:

- `GET /auth?account=...&home_domain=...&client_domain=...&memo=...` responds
  `{ "transaction": "...", "network_passphrase": "..." }`.
- `POST /auth` with `{ "transaction": "<signed XDR>" }` (JSON or form-encoded)
  responds `{ "token": "<jwt>" }`.

Failures respond `{ "error": "<message>" }` with `400` (invalid request or
challenge) or `429` (rate limited).

```ts
import express from 'express';
import { createSep10Router } from 'sep10-auth';

const app = express();
app.use(
  createSep10Router({
    serverKeypair,
    homeDomain: 'example.com',
    jwtSecret: process.env.SEP10_JWT_SECRET!,
  })
);
```

| Option | Default | Description |
|--------|---------|-------------|
| `serverKeypair` | *(required)* | Keypair that signs challenge transactions. |
| `homeDomain` | *(required)* | Home domain(s). The first is the default when `home_domain` is omitted. |
| `webAuthDomain` | first home domain | Web-auth domain(s) embedded in challenges. |
| `networkPassphrase` | `Networks.TESTNET` | Stellar network passphrase. |
| `challengeTimeoutSeconds` | `300` | Challenge lifetime. |
| `rateLimit` | `{}` | Options for the built-in `rateLimiter`, or `false` to disable it. |
| `jwtSecret` | — | HMAC secret for the built-in HS256 JWT issuer (`issueJwt`). Required unless `issueToken` is set. |
| `jwtExpiresInSeconds` | `86400` | Lifetime of issued tokens. |
| `jwtIssuer` | `https://<first home domain>` | The JWT `iss` claim. |
| `issueToken` | — | Replaces the built-in JWT issuer: `(account, { clientDomain, transaction }) => string \| Promise<string>`. |
| `resolveClientSigningKey` | — | Resolves a `client_domain`'s `SIGNING_KEY`. Without it, requests with `client_domain` get `400`. |
| `maxTransactionLength` | `8192` | Maximum accepted length of the posted transaction. |
| `logger` | `noopLogger` | Injectable logger. |

### `rateLimiter(options?)`

An Express middleware factory that rate-limits incoming requests with a
sliding-window counter. Mount it on the challenge-generation route so one
client cannot hammer challenge issuance. It composes with
`createSep10Middleware` like any other Express middleware: place it earlier
in the chain so the request is counted before SEP-10 verification runs.

> **`trust proxy` required behind a reverse proxy or load balancer**: the
> default key generator keys on `req.ip`, which only reflects the real
> client IP when Express's `app.set('trust proxy', ...)` is configured
> correctly for your deployment. Without it, every request appears to
> come from the proxy's IP, collapsing the rate limit to a single shared
> bucket for all clients. See the
> [Express `trust proxy` docs](https://expressjs.com/en/guide/behind-proxies.html)
> and set it to match your infrastructure (e.g. the number of trusted
> hops, or `true` only if you fully control the proxy).

```ts
import express from 'express';
import { createSep10Middleware, rateLimiter } from 'sep10-auth';

const app = express();

// Mount ahead of challenge generation.
app.post(
  '/api/challenge',
  rateLimiter({ windowMs: 30_000, maxRequests: 10 }),
  (req, res) => {
    // ... generate and return the challenge ...
  }
);

// The same helper can sit in front of createSep10Middleware.
app.use(
  '/compliance',
  rateLimiter({ windowMs: 60_000, maxRequests: 100 }),
  createSep10Middleware({
    serverAccountId: serverKeypair.publicKey(),
    homeDomains: 'example.com',
    webAuthDomain: 'auth.example.com',
  })
);
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `windowMs` | `60000` (1 minute) | Sliding window length in milliseconds. Must be a positive integer. |
| `maxRequests` | `100` | Maximum requests allowed inside the window for one key. Must be a positive integer. |
| `keyGenerator` | `req.ip`, then `req.socket.remoteAddress`, then `"unknown"` | Returns the counter key for a request. |
| `skip` | `undefined` | `(req) => boolean \| Promise<boolean>`. Return `true` to exempt a request (e.g. internal health checkers or trusted partner IPs). Skipped requests never consume tokens. Async predicates are supported. |
| `store` | `InMemoryRateLimitStore` | A pluggable backend implementing `RateLimitStore` (`consume(key, now, windowMs, maxRequests)`) for local or distributed counters (e.g. Redis). |
| `standardHeaders` | `true` | Send the IETF draft `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers on every response that passes through the limiter, allowed or throttled. Set to `false` to turn them off. |

`RateLimit-Limit` is `maxRequests`, `RateLimit-Remaining` is the number of
requests left in the current window (`0` once throttled) and `RateLimit-Reset`
is the number of seconds until the window resets.

When the limit is exceeded the middleware responds with **429** and a JSON body:

```json
{ "error": "rate_limit_exceeded", "retryAfter": 15 }
```

`retryAfter` is the number of whole seconds until the oldest request in the
window falls out (at least `1`). The `Retry-After` header is set to the same
value.

> **Note**: The default in-memory store is process-local and not shared across
> instances, and its counters are lost on process restart. For multi-process
> or multi-region deployments, supply a custom `store` implementation backed
> by Redis or another shared datastore.

### `createSep10Middleware` Options

`createSep10Middleware(options)` accepts the following options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverAccountId` | `string` | *(required)* | Stellar public key (G...) of the SEP-10 auth server. |
| `homeDomains` | `string \| string[]` | *(required)* | Expected home domain(s) embedded in the challenge. |
| `webAuthDomain` | `string \| string[]` | *(required)* | Expected web-auth domain(s) embedded in the challenge. |
| `networkPassphrase` | `string` | `Networks.TESTNET` | Stellar network passphrase. |
| `expectedMemo` | `string` | `undefined` | Optional memo that must match the challenge memo. |
| `maxTokenLength` | `number` | `8192` | Maximum accepted length (in characters) of the bearer token, rejected with `401` (`"bearer token too large"`) before XDR parsing is attempted. Guards against unauthenticated callers forcing expensive XDR-parsing work with oversized input. |
| `getToken` | `(req) => string \| undefined` | Bearer header parsing | Custom token extractor (e.g. cookie or query parameter). Return `undefined` when no token is present and the request is rejected with `401`. See the CSRF note below. |
| `revocationStore` | `RevocationStore` | `undefined` | Optional store consulted after challenge verification to reject revoked addresses before `timeoutSeconds` expires. |
| `logger` | `Logger` | `noopLogger` | Injectable logger (`debug`, `info`, `warn`, `error`) for auth and revocation observability. |

#### Custom token extraction and CSRF

Browser apps often keep the session token in an HttpOnly cookie instead of an
`Authorization` header. Pass `getToken` to read it from there:

```ts
createSep10Middleware({
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'auth.example.com',
  getToken: (req) => req.cookies?.sep10_token,
});
```

Browsers attach cookies to cross-site requests automatically, so cookie-based
extraction exposes state-changing endpoints to CSRF. Mitigate it with
`SameSite=Strict` (or `Lax`) cookies and a CSRF token or `Origin` header check.
Avoid query-parameter tokens where possible: they leak into logs and referrers.
The default behaviour (Bearer header) is unchanged.

### Session revocation (`revocationStore`)

A signed challenge stays usable until its `timeoutSeconds` elapse, because
this package does not issue a session token. Pass `revocationStore` when an
operator needs to cut an address off sooner.

The store is checked only after challenge verification succeeds.
`isRevoked` is called with the authenticated Stellar address. A revoked
address is rejected with **401** before `req.stellarAddress` is set:

```json
{ "error": "unauthorized", "reason": "address revoked" }
```

If `isRevoked` throws or rejects, the error is passed to Express with
`next(error)` and the request is not treated as authenticated.

`RevocationStore` is the contract a backend implements. Every method may
return its value directly or as a `Promise`.

| Method | Behavior |
|--------|----------|
| `isRevoked(address)` | Whether `address` is currently revoked. |
| `revoke(address, until?)` | Revokes `address`. Omit `until` to keep it revoked until `unrevoke`. Pass a `Date` to expire the revocation at that time. |
| `unrevoke(address)` | Lifts a revocation previously set with `revoke`. |
| `list?()` | Optional. Returns the addresses that are currently revoked. |
| `revokeToken?(jti, expiresAt)` | Optional. Revokes one token (identified by its `jti`) without affecting the address's other tokens. The entry expires and is pruned at `expiresAt`. |
| `isTokenRevoked?(jti)` | Optional. Whether the token identified by `jti` is currently revoked. |

The `jti` of a verified token is the hex-encoded hash of its challenge
transaction. It is available as `result.jti` from `verifyChallenge` and as
`req.stellarTokenId` inside the middleware. When the store implements
`isTokenRevoked`, the middleware checks it after the per-address check and
rejects a revoked token with **401** and `{ "error": "unauthorized", "reason": "token revoked" }`.

`InMemoryRevocationStore` is the included reference implementation. It holds
revocations in a process-local `Map`, so they do not survive a process
restart and are not shared across instances.

```ts
import { createSep10Middleware, InMemoryRevocationStore } from 'sep10-auth';

const revocationStore = new InMemoryRevocationStore();

app.use(
  '/compliance',
  createSep10Middleware({
    serverAccountId: serverKeypair.publicKey(),
    homeDomains: 'example.com',
    webAuthDomain: 'auth.example.com',
    revocationStore,
  })
);

// Cut off access immediately, without waiting for timeoutSeconds:
revocationStore.revoke(someAddress);

// Or revoke until a specific time, then lift it early if needed:
revocationStore.revoke(someAddress, new Date(Date.now() + 15 * 60_000));
revocationStore.unrevoke(someAddress);

// Sign out a single device: revoke only this token, until it would expire anyway.
revocationStore.revokeToken(req.stellarTokenId!, tokenExpiresAt);
```

For a store that survives restarts, implement `RevocationStore` against
Redis or a database.
[`examples/redisRevocationStore.ts`](./examples/redisRevocationStore.ts) is
a copy-in Redis example and is not a dependency of this package.

sep10-auth has no built-in logging (and its lint config forbids `console.*`
calls), so pass a `logger` implementing the `Logger` interface (`debug` /
`info` / `warn` / `error`) if you want visibility into verification and
revocation failures:

```ts
createSep10Middleware({
  serverAccountId: serverKeypair.publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'auth.example.com',
  logger: console,
});
```

## Example Walkthrough

Below is a step-by-step walkthrough showing how a client requests a SEP-10 challenge, signs it, and passes it to an Express endpoint protected with `createSep10Middleware`.

### 1. Request a Challenge
The client requests a SEP-10 challenge transaction from the auth server:

```sh
curl -X GET "https://auth.example.com/auth?account=G...&home_domain=example.com"
```

Example JSON response from server:
```json
{
  "transaction": "AAAAAgAAAAA...",
  "network_passphrase": "Test SDF Network ; July 2015"
}
```

### 2. Sign Challenge Client-Side (Conceptual)
The client signs the returned `transaction` XDR using their Stellar wallet keypair (e.g., Freighter or `@stellar/stellar-sdk`):

```ts
import { Keypair, Transaction } from '@stellar/stellar-sdk';

const tx = new Transaction(challengeXDR, networkPassphrase);
tx.sign(clientKeypair);
const signedXDR = tx.toXDR();
```

### 3. Send Request to Protected Endpoint
The client passes the signed XDR as a Bearer token in the `Authorization` header:

```sh
curl -X GET https://example.com/compliance/status \
  -H "Authorization: Bearer AAAAAgAAAAA..."
```

#### Expected Success Response (`200 OK`)
```json
{
  "address": "G..."
}
```

#### Expected Error Response (`401 Unauthorized`)
If the challenge is unsigned, expired, or invalid:
```json
{
  "error": "unauthorized",
  "reason": "Transaction has expired"
}
```

## Replay Risk & Performance Tradeoffs

`createSep10Middleware` provides a simplified reference implementation that re-verifies the raw signed challenge transaction XDR on every incoming request via `Authorization: Bearer <base64-xdr>`. Consumers should note the following tradeoffs when using this pattern:

- **Replay Risk**: Because the middleware re-verifies the raw signed transaction XDR directly, any bearer token (signed XDR) intercepted in transit remains valid for authentication until its timebounds expire (by default 300 seconds). Without a server-side session store, token revocation, or single-use nonce tracking, an attacker possessing the signed XDR can replay it across multiple requests during the validity window.
- **Performance Overhead**: Verifying cryptographic signatures (via `WebAuth.verifyChallengeTxSigners`) and parsing XDR on every HTTP request incurs non-trivial CPU overhead compared to verifying a lightweight, symmetric-key session token or JWT.
- **Production Recommendation**: For production services, applications should use SEP-10 challenge verification once to authenticate the client, and upon successful verification, issue a short-lived session JWT or auth token for subsequent API requests.

See [`examples/express-app`](./examples/express-app) for a small runnable
Express app wiring together the full challenge/verify roundtrip.

## Scope

This package only implements the SEP-10 building blocks (challenge
generation, verification, thin middleware, rate limiting, and session
revocation). It does not
collect the user's signature itself — clients are responsible for signing
the challenge with their own wallet (e.g. [Freighter](https://www.freighter.app/)
or another Stellar wallet) and sending the signed XDR back.

See the [repo root README](../README.md) for how this package fits into the
rest of `compliance-adapters`, and
[`compliance-primitives`](https://github.com/stellar-compliance-kit/compliance-primitives)
for the on-chain contracts (`allowlist-token`, `denylist-gate`,
`jurisdiction-flag`) this auth step feeds into.
