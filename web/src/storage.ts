// The only thing web/ writes into the browser's storage: per issuer key, the
// highest CRL number the device has used (spec/revocation-tree.md, "Who
// checks what"; ADR-0015). Nothing else is stored: no certificate, signature,
// PIN, scoped ID or username.
import type { IssuerName } from "./issuers.ts";

export interface CrlNumberStore {
  get(issuer: IssuerName): bigint | null;
  set(issuer: IssuerName, crlNumber: bigint): void;
}

export const STORAGE_KEY_PREFIX = "iamreal.highest_crl_number.";

/** The page's store, in `localStorage`. A value it cannot read counts as none. */
export function localStorageStore(storage: Storage = localStorage): CrlNumberStore {
  return {
    get(issuer) {
      const v = storage.getItem(STORAGE_KEY_PREFIX + issuer);
      return v !== null && /^(0|[1-9][0-9]*)$/.test(v) ? BigInt(v) : null;
    },
    set(issuer, crlNumber) {
      storage.setItem(STORAGE_KEY_PREFIX + issuer, crlNumber.toString());
    },
  };
}

/** For tests. */
export function memoryStore(initial: Partial<Record<IssuerName, bigint>> = {}): CrlNumberStore & { values: Partial<Record<IssuerName, bigint>> } {
  const values = { ...initial };
  return {
    values,
    get: (issuer) => values[issuer] ?? null,
    set: (issuer, n) => {
      values[issuer] = n;
    },
  };
}
