// The card through MOICA's component (HiPKI) on the cardholder's computer.
//
// The component serves no CORS headers, so a page cannot call it with
// fetch. It serves a page instead, `/popupForm`, that a page opens as a
// window: the window posts `{"func":"getTbs"}` to its opener when it is
// ready, the opener posts it one request, the window does it with the card
// and posts the reply back, then closes itself. One request per window.
// Written from reading the PSE web example (hipki-popup.ts, hipki-client.ts)
// and the benchmark page of web-isolation-bench; nothing is copied.
//
// What this file trusts, and what it does not:
//
//   - The component's address is a constant (target.ts), never taken from a
//     server's answer or the page's address. Requests are posted to that
//     origin only (postMessage's targetOrigin), so a window that navigated
//     elsewhere receives nothing, PIN included.
//   - Only messages whose origin is the component's are read; any other
//     message (an extension, another window) is ignored.
//   - The reply is read strictly. The certificates go to the flow, which
//     checks them itself; the signature too, with the certificate the
//     component says made it (the flow stops unless it is the one it chose).
//   - The PIN: a signing request is never sent without one; it is put into
//     the request and nowhere else (no field of this object holds it); a
//     reply that is not a success is reported to the flow, which stops and
//     lets the cardholder decide. Nothing here sends a request again.
//
// A browser lets one click open one window. The screen calls open()
// synchronously in its click handler, before anything is awaited; the next
// readCertificates() or sign() uses that window.
//
// How the component reports errors was learnt by reading code, not by
// trying (no wrong PIN was ever sent to a real card to find out): the PSE
// example checks `ret_code` and `last_error`; Chunghwa Telecom's client
// library (ChtICToken.js and index.js in moda-gov-tw/TWDIW-official-app)
// names the codes used below. README.md lists which behaviours were tested.
import { type Card, CardError, type CardSignature } from "./card.ts";

/** How long the window has to say it is ready. A component that is not running never does. */
export const READY_MS = 8_000;
/** How long a reply may take once the request is sent. Reading took about 3.4 s, signing 1.6 to 3 s (2026-11-11, 2026-11-16). */
export const REPLY_MS = 30_000;

const POPUP_PATH = "/popupForm";
const POPUP_NAME = "iamreal-hipki";
const POPUP_FEATURES = "popup,width=420,height=300";

// The component's codes (ChtICToken.js, index.js "MajorErrorReason" and
// "MinorErrorReason"). `ret_code` is the major one; with LOGIN_FAILED,
// `last_error` says why.
/** 未插入IC卡 */
const NO_CARD = 0x76000006;
/** 無可用讀卡機 */
const NO_READER = 0x76100003;
/** IC卡登入失敗: the PIN was not accepted; last_error says why. */
const LOGIN_FAILED = 0x76100006;
/** PKCS#11 CKR_PIN_INCORRECT: PIN碼錯誤 */
const CKR_PIN_INCORRECT = 0xa0;
/** PKCS#11 CKR_PIN_LEN_RANGE: PIN碼長度錯誤 */
const CKR_PIN_LEN_RANGE = 0xa2;
/** PKCS#11 CKR_PIN_LOCKED: 已鎖卡 */
const CKR_PIN_LOCKED = 0xa4;

/**
 * The messages the flow has the card sign: the scope string and the
 * declaration code, 31 ASCII characters each, sent as text (the component
 * signs the text's bytes: 2026-11-11). Only characters that need no
 * escaping are sent.
 */
const MESSAGE_CHARS = /^[A-Za-z0-9:_.-]{31}$/;
/**
 * Chunghwa's library writes `+` as `%2B` in the request, which suggests the
 * component decodes the request like a URL; a PIN with `+` or `%` might
 * reach the card changed and use up a try. Such a PIN is not sent.
 */
const PIN_CHARS = /^[\x21-\x7e]+$/;
const PIN_UNSAFE = /[+%]/;

export class HipkiCard implements Card {
  private readonly origin: string;
  private next: Popup | null = null;

  constructor(origin: string) {
    // Throws on anything but an origin.
    if (new URL(origin).origin !== origin) throw new Error("not an origin");
    this.origin = origin;
  }

  /**
   * Opens the component's window for the next readCertificates() or sign().
   * Call it synchronously in the click handler. Returns false if the browser
   * blocked the window: nothing was sent, and the next call reports
   * `popup_blocked` without sending anything either.
   */
  open(): boolean {
    this.release();
    this.next = new Popup(this.origin);
    return this.next.opened;
  }

  /** Closes a window from open() that no request used. */
  release(): void {
    this.next?.close();
    this.next = null;
  }

  private take(): Popup {
    const p = this.next ?? new Popup(this.origin);
    this.next = null;
    return p;
  }

  async readCertificates(): Promise<Uint8Array[]> {
    const reply = await this.take().request(JSON.stringify({ func: "GetUserCert" }));
    return certificatesOfReply(reply);
  }

  async sign(message: Uint8Array, pin: string): Promise<CardSignature> {
    const tbs = String.fromCharCode(...message);
    // Nothing is sent that the component could read differently from what
    // the flow meant: a message that is not 31 known characters, an empty
    // PIN, a PIN with characters it might decode.
    if (!MESSAGE_CHARS.test(tbs)) {
      this.release();
      throw new CardError("card_error", "message_format");
    }
    if (!PIN_CHARS.test(pin) || PIN_UNSAFE.test(pin)) {
      this.release();
      throw new CardError("card_error", pin === "" ? "no_pin" : "pin_characters");
    }
    const popup = this.take();
    // The request is built here and handed to the window; no field keeps it.
    const reply = await popup.request(JSON.stringify({ func: "MakeSignature", tbs, hashAlgorithm: "SHA256", signatureType: "PKCS1", pin }));
    return signatureOfReply(reply);
  }
}

/** One window of the component: one request, one reply. */
class Popup {
  private readonly origin: string;
  private readonly win: Window | null;
  private readonly openedAt = performance.now();
  private ready = false;
  private waitingReady: (() => void) | null = null;
  private waitingReply: ((text: string) => void) | null = null;
  private readonly onMessage = (ev: MessageEvent): void => {
    // Only the component's origin; only text, as the component sends.
    if (ev.origin !== this.origin || typeof ev.data !== "string") return;
    if (!this.ready) {
      let m: unknown;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof m !== "object" || m === null || (m as { func?: unknown }).func !== "getTbs") return;
      this.ready = true;
      this.waitingReady?.();
      return;
    }
    this.waitingReply?.(ev.data);
  };

  constructor(origin: string) {
    this.origin = origin;
    let win: Window | null = null;
    try {
      win = window.open(origin + POPUP_PATH, POPUP_NAME, POPUP_FEATURES);
    } catch {
      win = null;
    }
    this.win = win;
    if (win) window.addEventListener("message", this.onMessage);
  }

  /** False if the browser blocked the window. */
  get opened(): boolean {
    return this.win !== null;
  }

  close(): void {
    window.removeEventListener("message", this.onMessage);
    try {
      if (this.win && !this.win.closed) this.win.close();
    } catch {
      // A window that cannot be reached is already gone.
    }
  }

  private closed(): boolean {
    try {
      return this.win === null || this.win.closed;
    } catch {
      return true;
    }
  }

  /** Waits until the window is ready, posts `body` to it, and resolves with its reply. */
  request(body: string): Promise<string> {
    // Nothing is sent: the request never leaves this page.
    if (!this.win) return Promise.reject(new CardError("popup_blocked"));
    return new Promise<string>((resolve, reject) => {
      let payload: string | null = body;
      let done = false;
      const finish = (err: CardError | null, text?: string): void => {
        if (done) return;
        done = true;
        payload = null;
        clearTimeout(readyTimer);
        clearTimeout(replyTimer);
        clearInterval(closedPoll);
        this.waitingReady = null;
        this.waitingReply = null;
        this.close();
        if (err) reject(err);
        else resolve(text!);
      };
      let replyTimer: ReturnType<typeof setTimeout> | undefined;
      const send = (): void => {
        clearTimeout(readyTimer);
        try {
          this.win!.postMessage(payload, this.origin);
        } catch {
          return finish(new CardError("card_error", "post_failed"));
        }
        payload = null;
        replyTimer = setTimeout(() => finish(new CardError("card_error", "timeout")), REPLY_MS);
      };
      this.waitingReply = (text) => finish(null, text);
      const readyTimer = setTimeout(
        () => finish(new CardError("component_unreachable")),
        Math.max(0, READY_MS - (performance.now() - this.openedAt)),
      );
      // A window the cardholder closed will never answer. The component's
      // window closes itself right after posting its reply, so a closed
      // window gets a moment for that reply to arrive first.
      const closedPoll = setInterval(() => {
        if (!this.closed()) return;
        clearInterval(closedPoll);
        setTimeout(() => finish(new CardError(this.ready ? "card_error" : "component_unreachable", this.ready ? "popup_closed" : "")), 1_000);
      }, 250);
      if (this.ready) send();
      else this.waitingReady = send;
    });
  }
}

// Reading the replies ---------------------------------------------------------

type Reply = Record<string, unknown>;

function parseReply(text: string): Reply {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    throw new CardError("card_error", "reply_format");
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new CardError("card_error", "reply_format");
  return r as Reply;
}

/** A code as an unsigned 32-bit number; the component writes some as negative numbers. null if it is not a number. */
function code32(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x >= 2 ** 63) return null; // a 64-bit value JSON cannot carry exactly (0xFFFFFFFF8000000N)
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(x))));
}

/** The CardError for a reply whose `ret_code` is not 0, or whose `last_error` is not 0. */
export function replyError(r: Reply): CardError {
  const major = code32(r.ret_code);
  const minorRaw = r.last_error;
  const minor = code32(minorRaw);
  if (major === NO_CARD || major === NO_READER) return new CardError("no_card", hex(major));
  if (major === LOGIN_FAILED) {
    if (minor === CKR_PIN_LOCKED) return new CardError("card_locked");
    // 0x80000001 and 0x80000002: wrong PIN, one or two tries left
    // (written as -2147483647, -2147483646 or as 0xFFFFFFFF8000000N).
    const triesLeft = minor === 0x80000001 || minor === 0x80000002 || (typeof minorRaw === "number" && minorRaw >= 2 ** 63);
    if (minor === CKR_PIN_INCORRECT || minor === CKR_PIN_LEN_RANGE || triesLeft) return new CardError("pin_incorrect");
  }
  const parts = [major === null ? "no_code" : hex(major)];
  if (minor !== null && minor !== 0) parts.push(hex(minor));
  return new CardError("card_error", parts.join("_"));
}

const hex = (n: number): string => n.toString(16);

function isSuccess(r: Reply): boolean {
  return r.ret_code === 0 && (r.last_error === undefined || r.last_error === 0);
}

function base64Bytes(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || s.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new CardError("card_error", what);
  }
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * The certificates of a GetUserCert reply, from every reader that has a
 * card. With two cards in two readers, both cards' certificates are
 * returned and the flow stops (two certificates pass: ambiguous).
 */
export function certificatesOfReply(text: string): Uint8Array[] {
  const r = parseReply(text);
  if (!isSuccess(r)) throw replyError(r);
  if (!Array.isArray(r.slots)) throw new CardError("card_error", "reply_format");
  const tokens = r.slots.filter((s): s is Reply => typeof s === "object" && s !== null && typeof (s as Reply).token === "object" && (s as Reply).token !== null);
  if (tokens.length === 0) throw new CardError("no_card");
  const out: Uint8Array[] = [];
  for (const s of tokens) {
    const certs = (s.token as Reply).certs;
    if (certs === undefined) continue;
    if (!Array.isArray(certs)) throw new CardError("card_error", "reply_format");
    for (const c of certs) {
      if (typeof c !== "object" || c === null) throw new CardError("card_error", "reply_format");
      out.push(base64Bytes((c as Reply).certb64, "certificate_format"));
    }
  }
  return out;
}

/** The signature of a MakeSignature reply, and the certificate the component says made it. */
export function signatureOfReply(text: string): CardSignature {
  const r = parseReply(text);
  if (!isSuccess(r)) throw replyError(r);
  const signature = base64Bytes(r.signature, "signature_format");
  if (signature.length !== 256) throw new CardError("card_error", "signature_format");
  // The reply names the certificate that signed; without it the flow could
  // not check that the chosen one did.
  const certificate = base64Bytes(r.certb64, "no_certificate_in_reply");
  return { signature, certificate };
}
