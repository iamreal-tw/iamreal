// test-example, the second platform of test rosters (spec/scope.md): it
// stands for no real service. Only in the builds that run against a test
// roster (test/e2e/target.ts, src/target-local.ts), never in the production
// build (test/build.test.ts). The copy has no format hint for it, and it has
// no public page.
import type { Presentation } from "../platforms.ts";

export const TEST_EXAMPLE: Presentation = Object.freeze({
  platform: "test-example",
  name: "Example (no real service)",
  prefix: "",
  normalize: (typed: string): string => typed,
  formatHint: null,
  profileUrl: null,
});
