// A slot of a card's state as JSON: the one spelling the back end has for
// it. `card-state` answers with it (docs/api/card-proof.md, `platforms`) and
// the card state table stores it (card-table.ts). The names are those of
// spec/record-rules.md, "State"; a date is `YYYY-MM-DD`.
import { formatDay, parseDay } from "iamreal-protocol/date.ts";
import type { SlotState } from "iamreal-protocol/record-rules.ts";

export interface SlotJson {
  current: string | null;
  last_declared: string | null;
  switch_count: number;
  correction_date: string | null;
}

export function slotToJson(slot: SlotState): SlotJson {
  return {
    current: slot.current,
    last_declared: slot.lastDeclared,
    switch_count: slot.switchCount,
    correction_date: slot.correctionDate === null ? null : formatDay(slot.correctionDate),
  };
}

/**
 * The slot a SlotJson spells, or null if its `correction_date` is not a
 * date. Nothing else is judged here: whether the slot is one the rules can
 * leave is for the reader of the table (card-table.ts).
 */
export function slotOfJson(json: SlotJson): SlotState | null {
  const correctionDate = json.correction_date === null ? null : parseDay(json.correction_date);
  if (json.correction_date !== null && correctionDate === null) return null;
  return { current: json.current, lastDeclared: json.last_declared, switchCount: json.switch_count, correctionDate };
}
