import { parse, type HTMLElement } from "node-html-parser";

/**
 * Concatenate every <div class="panelDatos"> subtree in the response payload.
 * The trámite results page renders several of these (vehicle info, trámite
 * status, etc.). Joining them gives a single stable fragment that captures any
 * field change worth hashing, regardless of which panel it lives in.
 *
 * Returns null if no panelDatos blocks are found.
 */
export function extractDataPanel(payload: string): string | null {
  const root = parse(payload);
  const panels = root.querySelectorAll(".panelDatos");
  if (panels.length === 0) return null;
  return panels.map((p) => p.toString()).join("\n");
}

/**
 * Normalize an HTML fragment for hashing — collapse whitespace runs and trim.
 * Hashing the panelDatos block (not the full ViewRoot payload) keeps the hash
 * stable across calls; the surrounding page rotates ViewState and may inject
 * other dynamic ids.
 */
export function normalizeFragment(fragment: string): string {
  return fragment.replace(/\s+/g, " ").trim();
}

/**
 * Status text extractor tuned to the live markup, where rows look like:
 *   <label>ESTATUS:</label>  ...  <label>En proceso de revisión</label>
 *
 * Strategy: find every <label> whose text matches a known field key, then read
 * the next <label> in document order as that field's value.
 *
 * REFINE: if the markup changes (e.g. <span> instead of <label>, or accent
 * variants of "estatus"), widen the selector here.
 */
export function extractStatusText(payload: string): string {
  const root = parse(payload);
  const panels = root.querySelectorAll(".panelDatos");
  const scope = panels.length > 0 ? panels : [root];
  const labels = scope.flatMap((el) => el.querySelectorAll("label"));

  const status = readFieldByLabel(labels, /^estatus\s*:?$/i)
    ?? readFieldByLabel(labels, /^estado(\s+del?\s+tr[aá]mite)?\s*:?$/i);
  if (status) return status;

  // Fall back to a flattened-text regex if the structural read failed.
  const text = collapse(scope.map((el) => el.text).join(" "));
  const m = /(?:estatus|estado)\s*:?\s*([^\n\r|]+?)(?:\s{2,}|$)/i.exec(text);
  if (m && m[1]) return collapse(m[1]);

  return "(estado no reconocido — revisar fragmento)";
}

function readFieldByLabel(
  labels: HTMLElement[],
  keyPattern: RegExp,
): string | null {
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const text = collapse(label.text);
    if (keyPattern.test(text)) {
      // Adjacent value <label> — usually the next one in document order.
      for (let j = i + 1; j < labels.length; j++) {
        const candidate = collapse(labels[j]!.text);
        if (!candidate) continue;
        // Skip another key-style label ("OBSERVACIONES:" etc.).
        if (/^[A-ZÁÉÍÓÚÑ ]+:$/.test(candidate)) continue;
        return candidate;
      }
    }
  }
  return null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
