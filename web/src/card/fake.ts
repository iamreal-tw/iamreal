// A card made of test keys: certificates issued by a throwaway issuer key in
// the layout of a citizen's primary card (test/fixtures/certs.ts), and the
// matching private key in WebCrypto. Never used with a real card, PIN or
// certificate; the page never builds one (index.ts does not export it).
import { type Card, CardError, type CardSignature } from "./card.ts";

export interface FakeCardOptions {
  /** What readCertificates returns, in order (for example a signing and an encryption certificate). */
  certificates: Uint8Array[];
  /** The signing key (RSASSA-PKCS1-v1_5, SHA-256). */
  signingKey: CryptoKey;
  /** The certificate sign() reports with each signature, like MOICA's component; none by default. */
  signingCertificate?: Uint8Array;
  pin: string;
  /** Wrong PINs before the card locks (3, like the copy says). */
  triesLeft?: number;
  /** Simulates an empty reader. */
  noCard?: boolean;
  /** Simulates a computer with no reader. */
  noReader?: boolean;
  /** The reader's name the card reports (readerName); none by default. */
  readerName?: string;
}

export class FakeCard implements Card {
  private readonly opts: FakeCardOptions;
  private tries: number;
  /** Every message signed, for tests that check what the flow had the card sign. */
  readonly signed: Uint8Array[] = [];

  constructor(opts: FakeCardOptions) {
    this.opts = opts;
    this.tries = opts.triesLeft ?? 3;
  }

  async readCertificates(onConnected?: () => void): Promise<Uint8Array[]> {
    onConnected?.();
    if (this.opts.noReader) throw new CardError("no_reader");
    if (this.opts.noCard) throw new CardError("no_card");
    return this.opts.certificates.map((c) => c.slice());
  }

  readerName(): string | null {
    return this.opts.readerName ?? null;
  }

  async sign(message: Uint8Array, pin: string): Promise<CardSignature> {
    if (this.opts.noCard) throw new CardError("no_card");
    if (this.tries <= 0) throw new CardError("card_locked");
    if (pin !== this.opts.pin) {
      this.tries--;
      throw new CardError(this.tries <= 0 ? "card_locked" : "pin_incorrect");
    }
    this.tries = this.opts.triesLeft ?? 3;
    if (message.length !== 31) throw new CardError("card_error", "the card signs 31 bytes");
    this.signed.push(message.slice());
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.opts.signingKey, message as BufferSource));
    return { signature, certificate: this.opts.signingCertificate?.slice() ?? null };
  }
}
