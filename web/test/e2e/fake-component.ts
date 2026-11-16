// A fake of MOICA's component (HiPKI) for the headless browser test, with
// a card made of test keys. Only in tests: it serves `/popupForm`, a window
// that talks to its opener the way the real component's does (it posts
// `{"func":"getTbs"}` when ready, takes one request, posts the reply back,
// closes itself), and answers GetUserCert and MakeSignature from the card it
// is given. Its replies have the shape src/card/hipki.ts reads (from the PSE
// example and Chunghwa Telecom's client library); a wrong PIN and a locked
// card answer with the codes that library names. It records every request,
// so the test can check what the page asked of the card.
import { type Server, createServer } from "node:http";

export interface FakeCardSpec {
  /** What GetUserCert returns (DER), in order. */
  certificates: Uint8Array[];
  /** The certificate MakeSignature reports with each signature. */
  signingCertificate: Uint8Array;
  signingKey: CryptoKey;
  pin: string;
  /** Wrong PINs left before the card locks. */
  tries: number;
  /** An empty reader. */
  noCard?: boolean;
}

export interface ComponentRequest {
  func: string;
  tbs?: string;
  pin?: string;
}

const POPUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fake component</title></head>
<body><p>fake component</p><script src="/popup.js"></script></body></html>`;

// The window's script: ready, one request, the reply, close.
const POPUP_JS = `
(async () => {
  const mode = await (await fetch("/__mode")).json();
  if (mode.silent) return; // like a component that never answers
  window.addEventListener("message", async (ev) => {
    if (ev.source !== window.opener || typeof ev.data !== "string") return;
    const res = await fetch("/__request", { method: "POST", body: ev.data });
    window.opener.postMessage(await res.text(), "*");
    window.close();
  }, { once: true });
  window.opener.postMessage(JSON.stringify({ func: "getTbs" }), "*");
})();
`;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class FakeComponent {
  card: FakeCardSpec | null = null;
  /** The window never says it is ready (a component that is not running). */
  silent = false;
  readonly requests: ComponentRequest[] = [];
  private server: Server | null = null;

  async start(port: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (path === "/popupForm") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(POPUP_HTML);
      if (path === "/popup.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(POPUP_JS);
      if (path === "/__mode") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ silent: this.silent }));
      if (path === "/__request" && req.method === "POST") {
        const reply = await this.answer(body);
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
  }

  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async answer(text: string): Promise<Record<string, unknown>> {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(text);
    } catch {
      return { ret_code: 0x7600000b, message: "JSON格式錯誤" };
    }
    const func = String(r.func);
    this.requests.push({ func, ...(typeof r.tbs === "string" && { tbs: r.tbs }), ...(typeof r.pin === "string" && { pin: r.pin }) });
    const card = this.card;
    if (func === "GetUserCert") {
      if (!card || card.noCard) return { ret_code: 0, last_error: 0, version: "fake", slots: [{ slotDescription: "Fake Reader 0" }] };
      return {
        ret_code: 0,
        last_error: 0,
        version: "fake",
        slots: [{ slotDescription: "Fake Reader 0", token: { serialNumber: "FAKE0001", certs: card.certificates.map((c, i) => ({ certb64: b64(c), label: `cert${i}` })) } }],
      };
    }
    if (func === "MakeSignature") {
      if (!card || card.noCard) return { ret_code: 0x76000006, last_error: 0, message: "未插入IC卡" };
      if (typeof r.pin !== "string" || r.pin === "") return { ret_code: 0x76000998, last_error: 0, message: "未輸入PIN碼" };
      if (card.tries <= 0) return { ret_code: 0x76100006, last_error: 0xa4 };
      if (r.pin !== card.pin) {
        card.tries--;
        return { ret_code: 0x76100006, last_error: card.tries <= 0 ? 0xa4 : 0xa0 };
      }
      if (typeof r.tbs !== "string" || r.hashAlgorithm !== "SHA256" || r.signatureType !== "PKCS1") return { ret_code: 0x7600000c, last_error: 0, message: "參數錯誤" };
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", card.signingKey, new TextEncoder().encode(r.tbs)));
      return { func: "sign", ret_code: 0, last_error: 0, signature: b64(sig), certb64: b64(card.signingCertificate), cardSN: "FAKE0001" };
    }
    return { ret_code: 0x7600000e, last_error: 0, message: "不支援的方法" };
  }
}
