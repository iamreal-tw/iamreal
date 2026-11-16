// The mark: a card set at a slant, the island standing up from behind it.
// Built with DOM calls (no innerHTML); its colours are in style.css. The
// outline of the main island is from Natural Earth's public-domain map data
// (1:50m). It holds no text.

const SVG = "http://www.w3.org/2000/svg";

const TAIWAN =
  "M14.84 45.97 L13.85 48.00 L13.07 50.14 L12.75 52.17 L12.77 54.25 L12.55 56.14 L12.16 58.00 L10.62 57.46 L9.79 56.13 L9.59 53.94 " +
  "L8.48 51.29 L8.06 50.54 L6.45 49.06 L4.99 48.32 L3.86 47.23 L4.01 47.32 L3.18 45.85 L2.54 44.28 L1.23 39.83 L0.78 38.76 L0.17 37.78 " +
  "L0.00 36.81 L0.21 35.73 L0.77 34.12 L1.12 32.49 L0.84 30.29 L0.95 28.10 L1.37 27.13 L8.83 13.81 L10.85 10.98 L12.10 9.59 L13.14 8.02 " +
  "L14.13 6.04 L15.34 4.22 L16.21 3.67 L20.49 2.04 L21.82 0.48 L22.89 0.00 L24.10 0.03 L24.89 0.77 L25.58 1.65 L26.31 2.12 L28.21 2.98 " +
  "L29.04 3.81 L29.42 5.25 L28.26 6.60 L27.69 7.83 L27.58 9.18 L27.79 11.01 L27.82 12.85 L26.37 17.16 L24.83 19.84 L24.41 21.18 " +
  "L23.94 24.50 L23.03 27.84 L22.26 32.06 L20.99 36.41 L20.28 38.23 L19.38 39.98 L17.25 43.27 Z";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(c);
  return e;
}

/**
 * The mark, 64 × 64 units. `animated`: the card slides in and the island
 * stands up (step 6); style.css plays it unless the reader prefers reduced
 * motion.
 */
export function logo(o: { animated?: boolean; className?: string } = {}): SVGSVGElement {
  const cardGroup = svg(
    "g",
    { class: "logo-card" },
    svg(
      "g",
      { transform: "rotate(-9 27 39)" },
      svg("rect", { x: "3", y: "24", width: "46", height: "30", rx: "5.5", class: "logo-card-body" }),
      svg("rect", { x: "9.5", y: "31", width: "10", height: "8", rx: "2", class: "logo-chip" }),
    ),
  );
  const island = svg("g", { class: "logo-island" }, svg("path", { d: TAIWAN, transform: "translate(31.5 3) scale(0.97)", class: "logo-island-body", "stroke-width": "2.6", "stroke-linejoin": "round", "paint-order": "stroke" }));
  const classes = ["logo", o.animated ? "logo-animated" : "", o.className ?? ""].filter(Boolean).join(" ");
  return svg("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", focusable: "false", class: classes }, cardGroup, island);
}
