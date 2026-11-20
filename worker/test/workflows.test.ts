// The GitHub Actions workflows (.github/workflows/) keep to ADR-0029 and to
// CONTRIBUTING.md, "部署會執行到的東西": what a pull request runs gets no
// secret, and only the job that uploads the Worker holds the deploy token.
//
// The workflows are read line by line, not with a YAML parser (there is none
// among the packages, and none is added for this): each file keeps to the
// plain block style the helpers below read. A file written another way
// fails these tests rather than passing them unread.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR } from "./build.ts";

const WORKFLOWS_DIR = join(WORKER_DIR, "..", ".github", "workflows");

interface Workflow {
  readonly file: string;
  readonly lines: readonly string[];
}

/** A line without its comment, if it has one. */
const code = (line: string): string => line.replace(/(^|\s)#.*$/, "");

function workflows(): Workflow[] {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "there are workflows");
  return files.map((file) => ({ file, lines: readFileSync(join(WORKFLOWS_DIR, file), "utf8").split("\n") }));
}

test("every action is pinned to a full commit SHA, with the version it is in a comment", () => {
  let seen = 0;
  for (const w of workflows()) {
    for (const line of w.lines) {
      if (!/^\s*(-\s+)?uses:/.test(line)) continue;
      seen++;
      assert.match(line, /^\s*(-\s+)?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${w.file}: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0, "the check read the actions");
});

test("no workflow is triggered by pull_request_target or workflow_run, which run with the secrets", () => {
  for (const w of workflows()) {
    for (const line of w.lines) assert.doesNotMatch(code(line), /pull_request_target|workflow_run/, `${w.file}: ${line.trim()}`);
  }
});
