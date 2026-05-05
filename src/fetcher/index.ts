import { createHash } from "node:crypto";
import { fetchFormPage } from "./get.js";
import { postTramite } from "./post.js";
import {
  extractDataPanel,
  extractStatusText,
  normalizeFragment,
} from "./extract.js";

export interface TramiteSnapshot {
  statusText: string;
  fragmentHash: string;
  fetchedAt: string;
}

export async function fetchTramite(
  folio: string,
  email: string,
): Promise<TramiteSnapshot> {
  const page = await fetchFormPage();
  const { payload } = await postTramite(page, folio, email);

  const panel = extractDataPanel(payload);
  if (!panel) {
    throw new Error(
      "Could not locate .panelDatos in trámite response. Server markup may have changed.",
    );
  }

  const normalized = normalizeFragment(panel);
  const fragmentHash = createHash("sha256").update(normalized).digest("hex");
  const statusText = extractStatusText(panel);

  return {
    statusText,
    fragmentHash,
    fetchedAt: new Date().toISOString(),
  };
}

export { fetchFormPage } from "./get.js";
export { postTramite } from "./post.js";
export { extractDataPanel } from "./extract.js";
