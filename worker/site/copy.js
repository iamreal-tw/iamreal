// The one script of the visitors' pages, loaded only by /faq, /verify and
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

// On the FAQ every question is a <details>, folded, with the question's id;
// its <summary> opens and closes it without this script. Opened here: the
// question the address names (/faq#<id>), when the page opens and when the
// part after # changes. A browser scrolls to that <details> but does not
// open it, as it is the target itself and not inside one. Anything else
// the address names (a category, #cat-...) is left as it is. The part
// after # is read from document.URL, which can only be read: :target does
// not match yet when this runs as the page opens, and the test of this
// file keeps out the word for the object that can also send the page to
// another address.
const openNamedQuestion = () => {
  const address = document.URL;
  const hash = address.indexOf("#");
  const named = hash === -1 ? null : document.getElementById(address.slice(hash + 1));
  if (named !== null && named.tagName === "DETAILS") named.open = true;
};
openNamedQuestion();
window.addEventListener("hashchange", openNamedQuestion);
