// A slot of a card's state as JSON: the one spelling the back end has for
// it. `card-state` answers with it (docs/api/card-proof.md, `platforms`) and
// the card state table stores it (card-table.ts). The names are those of
// spec/record-rules.md, "State".
import type { SlotState } from "iamreal-protocol/record-rules.ts";

export interface SlotJson {
  current: string | null;
  last_declared: string | null;
  switch_count: number;
}

export function slotToJson(slot: SlotState): SlotJson {
  return { current: slot.current, last_declared: slot.lastDeclared, switch_count: slot.switchCount };
}

/**
 * The slot a SlotJson spells. Nothing is judged here: whether the slot is
 * one the rules can leave is for the reader of the table (card-table.ts).
 */
export function slotOfJson(json: SlotJson): SlotState {
  return { current: json.current, lastDeclared: json.last_declared, switchCount: json.switch_count };
}
