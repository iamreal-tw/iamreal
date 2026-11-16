// Can a page on http://localhost, sent with the server's page headers, be
// cross-origin isolated and still talk to MOICA's real component? Opens a
// page on http://localhost:PORT with the Content-Security-Policy and
// Document-Isolation-Policy of server/headers.go, clicks its one button
// (a real mouse event), which opens the component's window and sends it
// CheckEnvir, the component's environment check, and nothing else: no
// certificate is read, nothing is signed, no PIN exists here. The reply is
// reduced in the page to the reader count and the codes; nothing else of it
// leaves the page.
//
//   node --experimental-strip-types test/e2e/check-component.ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS } from "./headers.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-output", "check-component");
mkdirSync(out, { recursive: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>component check</title><script src="/probe.js"></script></head>
<body><button id="go" type="button">CheckEnvir</button></body></html>`;

// The only request: {"func":"CheckEnvir"}.
const PROBE = `
const ORIGIN = "http://localhost:61161";
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("go").addEventListener("click", () => {
    const t0 = performance.now();
    const w = window.open(ORIGIN + "/popupForm", "iamreal-hipki", "popup,width=420,height=300");
    if (!w) { window.__result = { error: "popup_blocked" }; return; }
    let ready = false;
    const timer = setTimeout(() => { window.__result = { error: ready ? "no_reply" : "not_ready" }; }, 15000);
    window.addEventListener("message", (ev) => {
      if (ev.origin !== ORIGIN || typeof ev.data !== "string") return;
      if (!ready) {
        try { if (JSON.parse(ev.data).func !== "getTbs") return; } catch { return; }
        ready = true;
        w.postMessage(JSON.stringify({ func: "CheckEnvir" }), ORIGIN);
        return;
      }
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(ev.data); } catch {}
      const slots = r && Array.isArray(r.slots) ? r.slots : [];
      window.__result = r === null ? { error: "not_json" } : {
        ret_code: r.ret_code, last_error: r.last_error, readers: slots.length,
        readers_with_card: slots.filter((s) => s && s.token).length,
        version: typeof r.version === "string" ? r.version : null,
        ms: Math.round(performance.now() - t0),
      };
    });
  });
});
`;

const server = createServer((req, res) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
  if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(HTML);
  if (req.url === "/probe.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(PROBE);
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${(server.address() as AddressInfo).port}/`;

const browser = await Browser.launch({ dir: out });
const page = await browser.newPage();
await page.send("Page.enable");
await page.goto(url);
const isolated = await page.eval<boolean>("crossOriginIsolated");
await page.click("#go");
const result = await page.waitFor<Record<string, unknown>>("window.__result", "the component's reply", 20_000).catch((e) => ({ error: String(e) }));
const csp = browser.logs.filter((l) => /Content Security Policy/i.test(l.text)).map((l) => l.text);
await browser.close();
server.close();
console.log(JSON.stringify({ page: url, crossOriginIsolated: isolated, checkEnvir: result, cspViolations: csp }, null, 2));
