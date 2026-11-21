// The page (index.html): starts the one proof engine as the page opens
// (ADR-0013), then the screens, with MOICA's component as the card.
import "./style.css";
import { HipkiCard } from "../card/hipki.ts";
import { startEngine } from "../index.ts";
import { COMPONENT_ORIGIN } from "../target.ts";
import { startApp } from "./app.ts";

/** Step timings as performance measures: they stay in this page (for the headless test's measurements). */
const onTiming = (step: string, ms: number): void => {
  try {
    performance.measure(`iamreal:${step}`, { start: performance.now() - ms, duration: ms });
  } catch {
    // Timings are only for measurements.
  }
};

const prover = startEngine((step, ms) => onTiming(`engine_${step}`, ms));
startApp({ root: document.getElementById("app")!, prover, card: new HipkiCard(COMPONENT_ORIGIN), onTiming });
