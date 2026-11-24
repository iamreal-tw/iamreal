// test-example, the second platform of test logs (spec/scope.md): it
// stands for no real service. Only in the headless tests' build
// (test/e2e/target.ts), where the screens of more than one platform are
// tested; the builds of a real card (production, the test site, this
// computer) know Threads only (#309, test/build.test.ts). The copy has no
// format hint for it, and it has no public page and no page to share from.
import type { Presentation } from "../platforms.ts";

export const TEST_EXAMPLE: Presentation = Object.freeze({
  platform: "test-example",
  name: "Example (no real service)",
  prefix: "",
  normalize: (typed: string): string => typed,
  formatHint: null,
  profileUrl: null,
  shareUrl: null,
});
