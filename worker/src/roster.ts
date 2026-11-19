// One roster is one Durable Object, the roster's only writer (ADR-0023).
// For now it is an empty class: the setting, the binding and the migration
// are in place (wrangler.jsonc), and nothing calls it.
import { DurableObject } from "cloudflare:workers";

export class Roster extends DurableObject<Env> {}

/**
 * The roster's object. Its name is a setting of the environment
 * (`ROSTER_OBJECT_NAME`): clearing the test roster is giving it a new name
 * (ADR-0028).
 */
export function rosterOf(env: Env): DurableObjectStub<Roster> {
  return env.ROSTER.get(env.ROSTER.idFromName(env.ROSTER_OBJECT_NAME));
}
