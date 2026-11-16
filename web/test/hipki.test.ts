// Reading the replies of MOICA's component (src/card/hipki.ts). The shapes
// and codes come from reading the PSE web example and Chunghwa Telecom's
// client library, not from a real card's errors (web/README.md); the window
// round trip runs in the headless browser test against a fake component
// (test/e2e/ui.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CardError } from "../src/card/card.ts";
import { HipkiCard, certificatesOfReply, replyError, signatureOfReply } from "../src/card/hipki.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const certA = Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x01);
const certB = Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x02);

function cardError(f: () => unknown): { code: string; detail: string } {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof CardError, String(e));
    return { code: e.code, detail: e.detail };
  }
  assert.fail("no CardError");
}

describe("GetUserCert", () => {
  test("the certificates of the reader with a card", () => {
    const reply = {
      ret_code: 0,
      last_error: 0,
      version: "2.3.3",
      slots: [
        { slotDescription: "empty reader" },
        { slotDescription: "reader", token: { serialNumber: "X", certs: [{ certb64: b64(certA), label: "sign" }, { certb64: b64(certB) }] } },
      ],
    };
    assert.deepEqual(certificatesOfReply(JSON.stringify(reply)), [certA, certB]);
  });

  test("no reader with a card, or no reader at all: no card", () => {
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0, slots: [{ slotDescription: "r" }] }))), { code: "no_card", detail: "" });
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0, slots: [] }))), { code: "no_card", detail: "" });
    assert.equal(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0x76000006 }))).code, "no_card");
    assert.equal(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0x76100003 }))).code, "no_card");
  });

  test("a card without certificates: none (the flow says it)", () => {
    assert.deepEqual(certificatesOfReply(JSON.stringify({ ret_code: 0, slots: [{ token: { certs: [] } }] })), []);
  });

  test("anything not read strictly is a card error with a code", () => {
    assert.deepEqual(cardError(() => certificatesOfReply("not json")), { code: "card_error", detail: "reply_format" });
    assert.deepEqual(cardError(() => certificatesOfReply("[]")), { code: "card_error", detail: "reply_format" });
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0 }))), { code: "card_error", detail: "reply_format" });
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0, slots: [{ token: { certs: [{ certb64: "!!" }] } }] }))), {
      code: "card_error",
      detail: "certificate_format",
    });
    // 禁止存取的網域 (0x7600000F): the component refused this site.
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0x7600000f, message: "x" }))), { code: "card_error", detail: "7600000f" });
    // A success code with a minor error is not a success.
    assert.deepEqual(cardError(() => certificatesOfReply(JSON.stringify({ ret_code: 0, last_error: 6, slots: [] }))), { code: "card_error", detail: "0_6" });
  });
});

describe("MakeSignature", () => {
  const sig = new Uint8Array(256).fill(7);

  test("the signature and the certificate that made it", () => {
    const r = signatureOfReply(JSON.stringify({ func: "sign", ret_code: 0, last_error: 0, signature: b64(sig), certb64: b64(certA), cardSN: "X" }));
    assert.deepEqual(r, { signature: sig, certificate: certA });
  });

  test("a reply without the certificate, or a signature of the wrong length, is a card error", () => {
    assert.deepEqual(cardError(() => signatureOfReply(JSON.stringify({ ret_code: 0, signature: b64(sig) }))), { code: "card_error", detail: "no_certificate_in_reply" });
    assert.deepEqual(cardError(() => signatureOfReply(JSON.stringify({ ret_code: 0, signature: b64(sig.subarray(1)), certb64: b64(certA) }))), {
      code: "card_error",
      detail: "signature_format",
    });
  });

  test("the PIN was not accepted: wrong, or locked", () => {
    const login = (last_error: unknown) => cardError(() => signatureOfReply(JSON.stringify({ ret_code: 0x76100006, last_error })));
    assert.equal(login(0xa0).code, "pin_incorrect");
    assert.equal(login(0xa2).code, "pin_incorrect");
    // One or two tries left, written three ways.
    for (const x of [0x80000001, 0x80000002, -2147483647, -2147483646]) assert.equal(login(x).code, "pin_incorrect", String(x));
    assert.equal(cardError(() => signatureOfReply('{"ret_code":1980760070,"last_error":18446744071562067969}')).code, "pin_incorrect");
    assert.equal(login(0xa4).code, "card_locked");
    // Login failed without a reason: not guessed; a card error with the code.
    assert.deepEqual(login(0), { code: "card_error", detail: "76100006" });
    // The component's codes written as negative numbers.
    assert.deepEqual(replyError({ ret_code: 0x76100006 - 2 ** 32, last_error: 0xa4 }).code, "card_locked");
  });

  test("other codes: a card error with the code", () => {
    assert.deepEqual(cardError(() => signatureOfReply(JSON.stringify({ ret_code: 0x76000998 }))), { code: "card_error", detail: "76000998" });
    assert.deepEqual(cardError(() => signatureOfReply(JSON.stringify({ ret_code: "x" }))), { code: "card_error", detail: "no_code" });
  });
});

// Another site that opened this page could find the component's window by
// its fixed name. Each window now gets a name of its own. A stand-in
// `window` records what window.open was given.
describe("the component's window", () => {
  interface Opened {
    url: string;
    name: string;
    closed: boolean;
    closedBeforeNextOpen: boolean | null;
  }
  function fakeWindow(): { opened: Opened[]; restore: () => void } {
    const opened: Opened[] = [];
    const g = globalThis as { window?: unknown };
    const before = g.window;
    g.window = {
      open: (url: string, name: string) => {
        for (const o of opened) if (o.closedBeforeNextOpen === null) o.closedBeforeNextOpen = o.closed;
        const o: Opened = { url, name, closed: false, closedBeforeNextOpen: null };
        opened.push(o);
        return {
          get closed() {
            return o.closed;
          },
          close: () => (o.closed = true),
          postMessage: () => undefined,
        };
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return { opened, restore: () => (g.window = before) };
  }

  test("a name of its own each time, not one another page could guess; the last one closed before the next opens", () => {
    const w = fakeWindow();
    try {
      const card = new HipkiCard("http://localhost:61161");
      for (let i = 0; i < 3; i++) assert.equal(card.open(), true);
      card.release();
      assert.equal(w.opened.length, 3);
      const names = w.opened.map((o) => o.name);
      assert.equal(new Set(names).size, 3, `three names: ${names.join(", ")}`);
      for (const n of names) {
        assert.notEqual(n, "iamreal-hipki");
        assert.match(n, /^iamreal-[0-9a-f]{32}$/, n);
      }
      assert.ok(w.opened.every((o) => o.url === "http://localhost:61161/popupForm"));
      assert.deepEqual(
        w.opened.map((o) => o.closedBeforeNextOpen),
        [true, true, null],
        "each window was closed before the next was opened",
      );
      assert.ok(w.opened.every((o) => o.closed));
    } finally {
      w.restore();
    }
  });
});
