// The copy buttons' script, served at /copy.js (layout.ts, `COPY_JS_PATH`):
// the one script of the visitors' pages, loaded by /verify and
// /hang/<short ID> only. It is the Go backend's (server/pages/copy.js),
// byte for byte; a test checks that for as long as that one is in the
// repository. The Worker sends it itself, as the Go backend did, with an
// ETag to ask again by (src/visitor.ts): the pages that load it are the
// Worker's own, so a file of Static Assets would make nothing about it
// harder to change.
export const COPY_JS = `// The one script of the visitors' pages, loaded only by /verify and
// /hang/<short ID> (server/pages). A button
//
//   <button data-copy="ID" data-copied="已複製" hidden>…</button>
//   <button data-copy-text="TEXT" data-copied="已複製" hidden>…</button>
//
// copies the text of the element ID, or TEXT, and then reads data-copied.
// The button is hidden in the page and shown here, so that a page whose
// script does not run has no button that does nothing; what to copy is on
// the page either way, and can be selected. No library, nothing sent
// anywhere.
"use strict";

for (const button of document.querySelectorAll("button[data-copy], button[data-copy-text]")) {
  const source = button.dataset.copy === undefined ? null : document.getElementById(button.dataset.copy);
  const text = button.dataset.copyText ?? (source === null ? null : source.textContent);
  if (text === null || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = button.dataset.copied;
      },
      () => {},
    );
  });
}
`;
