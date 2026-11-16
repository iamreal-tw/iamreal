// The card, as the flow sees it: two actions. The bridge to MOICA's
// component (HiPKI) implements this in the next piece of work; fake.ts
// implements it with test keys.

export type CardErrorCode =
  /** The component cannot be reached. */
  | "component_unreachable"
  /** No card in the reader. */
  | "no_card"
  /** The PIN was wrong. */
  | "pin_incorrect"
  /** The card is locked. */
  | "card_locked"
  /** Anything else the card or component reported. */
  | "card_error";

export class CardError extends Error {
  readonly code: CardErrorCode;
  constructor(code: CardErrorCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export interface Card {
  /** The certificates on the card, DER. No PIN. */
  readCertificates(): Promise<Uint8Array[]>;
  /**
   * RSASSA-PKCS1-v1_5 / SHA-256 signature of the card's signing key over
   * exactly 31 bytes, 256 bytes big-endian. Needs the PIN; the
   * implementation passes it to the card and keeps no copy.
   */
  sign(message: Uint8Array, pin: string): Promise<Uint8Array>;
}
