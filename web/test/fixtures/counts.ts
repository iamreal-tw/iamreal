// What the tests of the counts search when a value must not be sent.

/**
 * A count without its three random IDs. Those are 32 hex digits each (`COUNT_ID`, which `readCount` checks), so they
 * can hold any run of hex digits by chance (#571): a search for a value that must not be sent looks at the other members.
 */
export const apartFromIds = (count: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(count).filter(([member]) => !["visit_id", "device_id", "attempt_id"].includes(member)));
