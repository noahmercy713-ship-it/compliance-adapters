/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { Keypair, Networks, Transaction, WebAuth, StellarToml } from '@stellar/stellar-sdk';
import { type Logger, noopLogger } from '@compliance-adapters/logger';
import { isValidStellarAddress } from '@compliance-adapters/shared';
import { assertBareDomain } from './challenge';

/**
 * Thrown by {@link authenticateWithSep10} when any step of the client flow
 * fails. The {@link Sep10ClientError.code | code} field is a stable string
 * identifying the failure category.
 */
export class Sep10ClientError extends Error {
  /** Stable error code identifying the failure category. */
  readonly code: Sep10ClientErrorCode;

  constructor(message: string, code: Sep10ClientErrorCode) {
    super(message);
    this.name = 'Sep10ClientError';
    this.code = code;
  }
}

/**
 * Stable error codes used by {@link Sep10ClientError}.
 *
 * | Code | Meaning |
 * |------|---------|
 * | `INVALID_KEYPAIR` | The provided keypair cannot sign. |
 * | `INVALID_SERVER_ACCOUNT_ID` | The resolved or provided `serverAccountId` is not a valid Ed25519 public key. |
 * | `SERVER_KEY_NOT_FOUND` | No `SIGNING_KEY` found in the server's `stellar.toml`. |
 * | `TOML_RESOLUTION_FAILED` | The server's `stellar.toml` could not be fetched or parsed. |
 * | `CHALLENGE_REQUEST_FAILED` | The `GET /auth` request returned a non-200 status. |
 * | `NETWORK_MISMATCH` | The `network_passphrase` in the challenge response does not match the expected value. |
 * | `INVALID_SERVER_SIGNATURE` | The challenge transaction is not signed by the server, or the home/web-auth domain does not match. |
 * | `ACCOUNT_MISMATCH` | The challenge was built for a different account than the one requested. |
 * | `TOKEN_EXCHANGE_FAILED` | The `POST /auth` request returned a non-200 status. |
 */
export type Sep10ClientErrorCode =
  | 'INVALID_KEYPAIR'
  | 'INVALID_SERVER_ACCOUNT_ID'
  | 'SERVER_KEY_NOT_FOUND'
  | 'TOML_RESOLUTION_FAILED'
  | 'CHALLENGE_REQUEST_FAILED'
  | 'NETWORK_MISMATCH'
  | 'INVALID_SERVER_SIGNATURE'
  | 'ACCOUNT_MISMATCH'
  | 'TOKEN_EXCHANGE_FAILED';

export interface AuthenticateWithSep10Options {
  /**
   * Full URL of the SEP-10 auth endpoint, e.g. `https://example.com/auth`.
   * The helper sends `GET {authEndpoint}?account=...` to fetch the challenge
   * and `POST {authEndpoint}` to exchange the signed challenge for a JWT.
   */
  authEndpoint: string;
  /**
   * Client keypair that will sign the challenge. Must be able to sign
   * (i.e. must contain a secret key).
   */
  keypair: Keypair;
  /**
   * Home domain to authenticate for. Sent as the `home_domain` query
   * parameter and used to validate the challenge's `home_domain` manage_data
   * operation.
   */
  homeDomain: string;
  /**
   * The wallet's client domain, for the SEP-10 client domain flow where a
   * wallet's client-domain server co-signs the challenge. When set, the
   * challenge is requested with `client_domain=<clientDomain>` and the
   * keypair co-signs as the client domain signer.
   */
  clientDomain?: string;
  /**
   * The server's public key (G...). Used to validate the server's signature
   * on the challenge transaction before the client signs it. If omitted,
   * the helper resolves it from the `SIGNING_KEY` field of the server's
   * `stellar.toml` at `https://<homeDomain>/.well-known/stellar.toml`.
   */
  serverAccountId?: string;
  /**
   * Network passphrase the challenge must be built for. The helper rejects
   * a challenge whose `network_passphrase` does not match this value.
   * @default `Networks.TESTNET`
   */
  networkPassphrase?: string;
  /**
   * Web-auth domain expected in the challenge's `web_auth_domain`
   * manage_data operation. Used together with {@link homeDomain} to validate
   * the server signature via `WebAuth.readChallengeTx`.
   * @default `homeDomain`
   */
  webAuthDomain?: string;
  /** Optional memo to include in the challenge request. */
  memo?: string;
  /**
   * Injectable `fetch` implementation. Defaults to the global `fetch`
   * (available in Node 20+). Pass a custom implementation for testing or
   * when you need to customise headers, timeouts, etc.
   */
  fetch?: typeof globalThis.fetch;
  /** Injectable logger (`debug` / `info` / `warn` / `error`). */
  logger?: Logger;
}

/**
 * Performs the SEP-10 client authentication flow end-to-end:
 *
 * 1. **Fetch** — sends `GET {authEndpoint}?account=<keypair.publicKey()>&home_domain=<homeDomain>`
 *    (plus `client_domain` and `memo` when provided) and receives
 *    `{ transaction, network_passphrase }`.
 * 2. **Validate** — verifies that the `network_passphrase` matches the expected
 *    value, then calls `WebAuth.readChallengeTx` to confirm the challenge
 *    transaction is signed by the server and carries the correct
 *    `home_domain` / `web_auth_domain`. The challenge account is also checked
 *    to match the requested account.
 * 3. **Sign** — signs the challenge transaction with the client keypair.
 * 4. **Exchange** — sends `POST {authEndpoint}` with the signed XDR and returns
 *    the JWT (`{ token }`) from the response.
 *
 * This helper is designed for server-to-server (anchor-to-anchor) integrations
 * where a Node.js service needs to authenticate against another server's
 * SEP-10 endpoint without a browser wallet.
 *
 * @example
 * ```ts
 * import { Keypair, Networks } from '@stellar/stellar-sdk';
 * import { authenticateWithSep10 } from 'sep10-auth';
 *
 * const keypair = Keypair.fromSecret(process.env.CLIENT_SECRET!);
 *
 * const token = await authenticateWithSep10({
 *   authEndpoint: 'https://anchor.example.com/auth',
 *   keypair,
 *   homeDomain: 'anchor.example.com',
 *   networkPassphrase: Networks.PUBLIC,
 * });
 *
 * // Use the JWT as a Bearer token for subsequent API calls:
 * // fetch('https://anchor.example.com/transactions', {
 * //   headers: { Authorization: `Bearer ${token}` },
 * // });
 * ```
 *
 * @throws {@link Sep10ClientError} on any failure, with a stable `code` field
 *   identifying the failure category.
 */
export async function authenticateWithSep10(
  options: AuthenticateWithSep10Options,
): Promise<string> {
  if (!options.keypair.canSign()) {
    throw new Sep10ClientError(
      'keypair must be able to sign — provide a keypair with a secret key',
      'INVALID_KEYPAIR',
    );
  }

  const logger = options.logger ?? noopLogger;
  const homeDomain = options.homeDomain;
  assertBareDomain('homeDomain', homeDomain);

  const webAuthDomain = options.webAuthDomain ?? homeDomain;
  assertBareDomain('webAuthDomain', webAuthDomain);

  if (options.clientDomain) {
    assertBareDomain('clientDomain', options.clientDomain);
  }

  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const account = options.keypair.publicKey();

  // Resolve the server's signing key, either from the option or stellar.toml.
  let serverAccountId = options.serverAccountId;
  if (!serverAccountId) {
    logger.debug('sep10-auth: resolving server signing key from stellar.toml', { homeDomain });
    try {
      const toml = await StellarToml.Resolver.resolve(homeDomain);
      serverAccountId = toml.SIGNING_KEY;
    } catch (error) {
      throw new Sep10ClientError(
        `Failed to resolve stellar.toml for ${homeDomain}: ${error instanceof Error ? error.message : String(error)}`,
        'TOML_RESOLUTION_FAILED',
      );
    }
    if (!serverAccountId) {
      throw new Sep10ClientError(
        `No SIGNING_KEY found in stellar.toml for ${homeDomain}`,
        'SERVER_KEY_NOT_FOUND',
      );
    }
  }

  if (!isValidStellarAddress(serverAccountId)) {
    throw new Sep10ClientError(
      `Invalid serverAccountId: ${serverAccountId}`,
      'INVALID_SERVER_ACCOUNT_ID',
    );
  }

  // 1. Fetch the challenge.
  const params = new URLSearchParams({ account, home_domain: homeDomain });
  if (options.clientDomain) {
    params.set('client_domain', options.clientDomain);
  }
  if (options.memo) {
    params.set('memo', options.memo);
  }

  const challengeUrl = `${options.authEndpoint}?${params.toString()}`;
  logger.debug('sep10-auth: fetching challenge', { challengeUrl, account });

  let getRes: Response;
  try {
    getRes = await fetchFn(challengeUrl);
  } catch (error) {
    throw new Sep10ClientError(
      `Challenge request failed: ${error instanceof Error ? error.message : String(error)}`,
      'CHALLENGE_REQUEST_FAILED',
    );
  }
  if (!getRes.ok) {
    const body = await getRes.json().catch(() => ({}));
    throw new Sep10ClientError(
      `Challenge request failed (${getRes.status}): ${(body as { error?: string }).error ?? getRes.statusText}`,
      'CHALLENGE_REQUEST_FAILED',
    );
  }

  const challenge = (await getRes.json()) as { transaction: string; network_passphrase: string };

  // 2. Validate the network passphrase.
  if (challenge.network_passphrase !== networkPassphrase) {
    throw new Sep10ClientError(
      `Network passphrase mismatch: expected "${networkPassphrase}", got "${challenge.network_passphrase}"`,
      'NETWORK_MISMATCH',
    );
  }

  // 3. Validate the server signature before signing.
  logger.debug('sep10-auth: validating server signature', { serverAccountId });
  let clientAccountID: string;
  try {
    const result = WebAuth.readChallengeTx(
      challenge.transaction,
      serverAccountId,
      networkPassphrase,
      homeDomain,
      webAuthDomain,
    );
    clientAccountID = result.clientAccountID;
  } catch (error) {
    throw new Sep10ClientError(
      `Server signature validation failed: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_SERVER_SIGNATURE',
    );
  }

  if (clientAccountID !== account) {
    throw new Sep10ClientError(
      `Challenge account mismatch: expected "${account}", got "${clientAccountID}"`,
      'ACCOUNT_MISMATCH',
    );
  }

  // 4. Sign the challenge.
  const tx = new Transaction(challenge.transaction, networkPassphrase);
  tx.sign(options.keypair);
  const signedXDR = tx.toXDR();

  // 5. Exchange the signed challenge for a JWT.
  logger.debug('sep10-auth: submitting signed challenge');
  let postRes: Response;
  try {
    postRes = await fetchFn(options.authEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXDR }),
    });
  } catch (error) {
    throw new Sep10ClientError(
      `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
      'TOKEN_EXCHANGE_FAILED',
    );
  }

  if (!postRes.ok) {
    const body = await postRes.json().catch(() => ({}));
    throw new Sep10ClientError(
      `Token exchange failed (${postRes.status}): ${(body as { error?: string }).error ?? postRes.statusText}`,
      'TOKEN_EXCHANGE_FAILED',
    );
  }

  const result = (await postRes.json()) as { token: string };
  logger.info('sep10-auth: authentication successful', { account });
  return result.token;
}
