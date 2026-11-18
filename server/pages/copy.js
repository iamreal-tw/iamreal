// The one script of the visitors' pages, loaded only by /verify and
// /hang/<short ID> (server/pages). A button
//
//   <button data-copy="ID" data-copied="已複製" hidden>…</button>
//
// copies the text of the element ID and then reads data-copied. The button
// is hidden in the page and shown here, so that a page whose script does
// not run has no button that does nothing; the text to copy is on the page
// either way, and can be selected. No library, nothing sent anywhere.
"use strict";

for (const button of document.querySelectorAll("button[data-copy]")) {
  const source = document.getElementById(button.dataset.copy);
  if (source === null || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(source.textContent).then(
      () => {
        button.textContent = button.dataset.copied;
      },
      () => {},
    );
  });
}
