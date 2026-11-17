// The scope string (spec/scope.md, ADR-0007, ADR-0017). The public roster is
// one scope, shared by every public platform: the device signs the scope
// string of the roster the page is built for, from the table below, and
// never takes one from a server response or the page's address (ADR-0016).
// The platform is not part of it: the list of accounts the card signs names
// the platforms (spec/declaration-code.md).

export type Roster = "production" | "test";

/** The open scope string of each roster (spec/scope.md, "Accepted scopes"). */
const SCOPE_STRINGS: Readonly<Record<Roster, string>> = Object.freeze({
  production: "iamreal:public:0_______________",
  test: "iamreal-test:public:0__________",
});

/** The scope string a card signs for `roster`. */
export function scopeOf(roster: Roster): string {
  return SCOPE_STRINGS[roster];
}

/** Whether `scopeString` is accepted by `roster`, in its exact spelling. */
export function lookupScope(roster: Roster, scopeString: string): boolean {
  return SCOPE_STRINGS[roster] === scopeString;
}
