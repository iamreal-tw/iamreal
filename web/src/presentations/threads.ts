// Threads, as the screen writes it (src/platforms.ts). In every build.
import type { Presentation } from "../platforms.ts";

export const THREADS: Presentation = Object.freeze({
  platform: "threads",
  name: "Threads",
  prefix: "@",
  // Threads does not distinguish case.
  normalize: (typed: string): string => (typed.startsWith("@") ? typed.slice(1) : typed).replace(/[A-Z]/g, (c) => c.toLowerCase()),
  formatHint: "threads",
  profileUrl: (u: string): string => `https://www.threads.com/@${u}`,
  // Threads' web intent for a post, with a link attachment and no text:
  // https://developers.facebook.com/docs/threads/threads-web-intents
  shareUrl: (url: string): string => `https://www.threads.com/intent/post?url=${encodeURIComponent(url)}`,
});
