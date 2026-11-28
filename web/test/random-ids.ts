// What the tests of the counts search when a value must not be sent.
import { COUNT_ID } from "iamreal-protocol/counts.ts";

/**
 * A count without its random IDs: the members named `…_id` that hold 32 hex digits (`COUNT_ID`). Those can hold any
 * run of hex digits by chance (#571), so a search for a value that must not be sent looks at the other members.
 */
export const withoutRandomIds = (count: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(count).filter(([member, value]) => !(member.endsWith("_id") && typeof value === "string" && COUNT_ID.test(value))));
