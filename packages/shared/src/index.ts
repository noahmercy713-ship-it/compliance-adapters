// Shared utilities for Stellar address handling.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Validate a Stellar address.
 *
 * By default only base account (`G...`) addresses are accepted. Pass options to
 * also accept muxed (`M...`) and/or contract (`C...`) addresses.
 */
export function isValidStellarAddress(
  addr: unknown,
  options: { allowMuxed?: boolean; allowContract?: boolean } = {},
): boolean {
  if (typeof addr !== "string" || addr.length !== 56) {
    return false;
  }

  const prefix = addr[0];
  const allowed =
    prefix === "G" ||
    (prefix === "M" && options.allowMuxed === true) ||
    (prefix === "C" && options.allowContract === true);

  if (!allowed) {
    return false;
  }

  for (let i = 1; i < addr.length; i++) {
    if (BASE32_ALPHABET.indexOf(addr[i]) === -1) {
      return false;
    }
  }

  return true;
}

/**
 * Normalize a Stellar address.
 *
 * When `allowMuxed` is set, a muxed (`M...`) address is reduced to its
 * underlying base account (`G...`). Otherwise the address is returned as-is.
 */
export function normalizeStellarAddress(
  addr: string,
  options: { allowMuxed?: boolean } = {},
): string {
  if (options.allowMuxed && typeof addr === "string" && addr[0] === "M") {
    const base = muxedToBaseAccount(addr);
    if (base) {
      return base;
    }
  }
  return addr;
}

/**
 * Extract the base account (`G...`) from a muxed (`M...`) address.
 *
 * A muxed address encodes the 56-character base account in its first 56
 * characters, followed by the 8-byte multiplexed id. Returns `null` when the
 * input is not a well-formed muxed address.
 */
function muxedToBaseAccount(addr: string): string | null {
  if (typeof addr !== "string" || addr[0] !== "M" || addr.length < 56) {
    return null;
  }
  const base = "G" + addr.slice(1, 56);
  return isValidStellarAddress(base) ? base : null;
}

/**
 * Redact a Stellar address for logging. Supports base (`G...`), muxed (`M...`)
 * and contract (`C...`) addresses.
 */
export function redactAddress(addr: string): string {
  if (typeof addr !== "string" || addr.length <= 8) {
    return addr;
  }
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}
