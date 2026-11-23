import { StrKey } from "@stellar/stellar-sdk";

export interface StellarAddressOptions {
  /** Accept muxed (`M...`) addresses in addition to base account (`G...`) addresses. */
  allowMuxed?: boolean;
  /** Accept contract (`C...`) addresses in addition to base account (`G...`) addresses. */
  allowContract?: boolean;
}

/**
 * Validate a Stellar address.
 *
 * By default only base account (`G...`) addresses are considered valid.
 * Pass `{ allowMuxed: true }` to also accept muxed (`M...`) addresses and
 * `{ allowContract: true }` to also accept contract (`C...`) addresses.
 */
export function isValidStellarAddress(
  addr: unknown,
  options: StellarAddressOptions = {},
): boolean {
  if (typeof addr !== "string" || addr.length === 0) {
    return false;
  }

  if (StrKey.isValidEd25519PublicKey(addr)) {
    return true;
  }

  if (options.allowMuxed && StrKey.isValidMed25519PublicKey(addr)) {
    return true;
  }

  if (options.allowContract && StrKey.isValidContract(addr)) {
    return true;
  }

  return false;
}

/**
 * Normalize a Stellar address.
 *
 * When `allowMuxed` is set and the input is a valid muxed (`M...`) address,
 * the underlying base account (`G...`) is returned. Otherwise the input is
 * returned unchanged.
 */
export function normalizeStellarAddress(
  addr: string,
  options: StellarAddressOptions = {},
): string {
  if (options.allowMuxed && StrKey.isValidMed25519PublicKey(addr)) {
    return StrKey.decodeMed25519PublicKey(addr).toString("hex");
  }

  return addr;
}
