// The scope string (spec/scope.md, ADR-0007, ADR-0017). The public proof log is
// one scope, shared by every public platform: the device signs the scope
// string of the proof log the page is built for, from the table below, and
// never takes one from a server response or the page's address (ADR-0016).
// The platform is not part of it: the list of accounts the card signs names
// the platforms (spec/declaration-code.md).

export type ProofLog = "production" | "test";

/** The open scope string of each proof log (spec/scope.md, "Accepted scopes"). */
const SCOPE_STRINGS: Readonly<Record<ProofLog, string>> = Object.freeze({
  production: "iamreal:public:0_______________",
  test: "iamreal-test:public:0__________",
});

/** The scope string a card signs for `proofLog`. */
export function scopeOf(proofLog: ProofLog): string {
  return SCOPE_STRINGS[proofLog];
}

/** Whether `scopeString` is accepted by `proofLog`, in its exact spelling. */
export function lookupScope(proofLog: ProofLog, scopeString: string): boolean {
  return SCOPE_STRINGS[proofLog] === scopeString;
}
