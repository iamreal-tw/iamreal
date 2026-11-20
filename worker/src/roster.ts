// One roster is one Durable Object, the roster's only writer (ADR-0023).
// So far it keeps one thing: the newest CRLs, as the CRL mirror tells it
// after each round (src/mirror.ts). Records, challenges and card state come
// with the API.
import { DurableObject } from "cloudflare:workers";
import { type NewestCrls, newestOfEach } from "./crl-index.ts";
import { ISSUER_NAMES } from "./issuers.ts";

export class Roster extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // For each issuer key, its newest usable CRLs: `place` 0 is the newest.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS newest_crls (issuer TEXT NOT NULL, place INTEGER NOT NULL, root TEXT NOT NULL, crl_number TEXT NOT NULL, crl_date TEXT NOT NULL, PRIMARY KEY (issuer, place)) WITHOUT ROWID",
    );
  }

  /**
   * Replaces what the object knows of the CRL archive: for each issuer key,
   * its newest usable CRLs, the newest first. Called by the CRL mirror, each
   * time with all of what the index in the data bucket lists at that moment
   * (src/crl-index.ts, `newestCrls`, which is where "newest" and how many
   * are decided).
   */
  setNewestCrls(newest: NewestCrls): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM newest_crls");
      for (const issuer of ISSUER_NAMES) {
        for (const [place, crl] of newest[issuer].entries()) {
          this.ctx.storage.sql.exec("INSERT INTO newest_crls (issuer, place, root, crl_number, crl_date) VALUES (?, ?, ?, ?, ?)", issuer, place, crl.root, crl.crlNumber, crl.crlDate);
        }
      }
    });
  }

  /**
   * For each issuer key, its two newest usable CRLs as the mirror last told
   * them, the newest first: fewer than two, or none, if the archive has no
   * more. A record's `smt_root` is accepted only if it is the root of one
   * of them, and none is if the first one's date is too old
   * (spec/revocation-tree.md, "Who checks what").
   */
  newestCrls(): NewestCrls {
    return newestOfEach((issuer) =>
      this.ctx.storage.sql
        .exec<{ root: string; crl_number: string; crl_date: string }>("SELECT root, crl_number, crl_date FROM newest_crls WHERE issuer = ? ORDER BY place", issuer)
        .toArray()
        .map((row) => ({ root: row.root, crlNumber: row.crl_number, crlDate: row.crl_date })),
    );
  }
}

/**
 * The roster's object. Its name is a setting of the environment
 * (`ROSTER_OBJECT_NAME`): clearing the test roster is giving it a new name
 * (ADR-0028).
 */
export function rosterOf(env: Env): DurableObjectStub<Roster> {
  return env.ROSTER.get(env.ROSTER.idFromName(env.ROSTER_OBJECT_NAME));
}
