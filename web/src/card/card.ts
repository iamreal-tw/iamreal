// The card, as the flow sees it: two actions. hipki.ts implements it with
// MOICA's component (HiPKI); fake.ts implements it with test keys.

export type CardErrorCode =
  /** The component cannot be reached. */
  | "component_unreachable"
  /** The component found no card reader. */
  | "no_reader"
  /** No card in the reader. */
  | "no_card"
  /** The PIN was wrong. */
  | "pin_incorrect"
  /** The card is locked. */
  | "card_locked"
  /** Anything else the card or component reported. */
  | "card_error"
  /** The browser blocked the component's window: nothing was sent to the card. */
  | "popup_blocked";

export class CardError extends Error {
  readonly code: CardErrorCode;
  /** A short code for the screen ("讀卡時發生錯誤（代碼 X）"): letters, digits, `_`. Never a PIN or a certificate. */
  readonly detail: string;
  constructor(code: CardErrorCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export interface CardSignature {
  /** RSASSA-PKCS1-v1_5 / SHA-256, 256 bytes big-endian. */
  signature: Uint8Array;
  /**
   * The certificate (DER) of the key that made the signature, if the card's
   * reader says which; null if it does not. The flow stops unless it is the
   * certificate it chose when the card was read.
   */
  certificate: Uint8Array | null;
}

export interface Card {
  /**
   * The certificates on the card, DER. No PIN. `onConnected` is called once
   * the card's reader answers (MOICA's component: its window is ready),
   * before the certificates are read; for the screen's progress only.
   */
  readCertificates(onConnected?: () => void): Promise<Uint8Array[]>;
  /**
   * The card's signing key signs exactly 31 bytes. Needs the PIN; the
   * implementation passes it to the card and keeps no copy.
   */
  sign(message: Uint8Array, pin: string): Promise<CardSignature>;
  /**
   * The name of the card reader the last readCertificates() read from, as
   * the card's reader names it; null if it did not say, or there was more
   * than one card. Sent in the counts only in its form (counts.ts).
   */
  readerName?(): string | null;
}
