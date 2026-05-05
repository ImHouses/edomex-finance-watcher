import { parse } from "node-html-parser";

const DEFAULT_TRAMITE_URL =
  "https://sfpya.edomexico.gob.mx/controlv/faces/tramiteselectronicos/cv/portalPublico/consultaTramite.xhtml";

/** Resolved at call time so validation tests can override via TRAMITE_URL env. */
export function tramiteUrl(): string {
  return process.env.TRAMITE_URL ?? DEFAULT_TRAMITE_URL;
}

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export interface FormPage {
  viewState: string;
  formId: string;       // e.g. "j_idt29"
  prefix: string;       // e.g. "j_idt29:j_idt32:j_idt33"
  buttonId: string;     // e.g. "j_idt38" (last segment, sibling of :folio)
  cookies: string;      // serialized "name=value; name=value" for the next request
}

export async function fetchFormPage(): Promise<FormPage> {
  const res = await fetch(tramiteUrl(), {
    method: "GET",
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": USER_AGENT,
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`GET form page failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const cookies = collectCookies(res.headers);
  const { viewState, formId, prefix, buttonId } = parseFormFields(html);

  return { viewState, formId, prefix, buttonId, cookies };
}

function collectCookies(headers: Headers): string {
  // Node's undici exposes Set-Cookie via headers.getSetCookie() (Node 20+).
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : extractSetCookieFallback(headers);

  const pairs: string[] = [];
  for (const raw of setCookies) {
    const firstSemi = raw.indexOf(";");
    const pair = (firstSemi === -1 ? raw : raw.slice(0, firstSemi)).trim();
    if (pair) pairs.push(pair);
  }
  return pairs.join("; ");
}

function extractSetCookieFallback(headers: Headers): string[] {
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

interface ParsedForm {
  viewState: string;
  formId: string;
  prefix: string;
  buttonId: string;
}

export function parseFormFields(html: string): ParsedForm {
  const root = parse(html);

  const viewStateEl = root.querySelector('input[name="javax.faces.ViewState"]');
  const viewState = viewStateEl?.getAttribute("value");
  if (!viewState) {
    throw new Error("Could not find javax.faces.ViewState in form page");
  }

  const folioInput = root
    .querySelectorAll("input")
    .find((el) => (el.getAttribute("name") ?? "").endsWith(":folio"));
  if (!folioInput) {
    throw new Error("Could not find input whose name ends in ':folio'");
  }
  const folioName = folioInput.getAttribute("name") ?? "";
  // e.g. "j_idt29:j_idt32:j_idt33:folio" → prefix "j_idt29:j_idt32:j_idt33"
  const prefix = folioName.slice(0, folioName.lastIndexOf(":"));
  if (!prefix || !prefix.includes(":")) {
    throw new Error(`Unexpected folio input name: ${folioName}`);
  }
  const formId = prefix.split(":")[0]!;

  // The submit button is a sibling of :folio inside the same panel.
  // It's a <button> or <input type="submit"> whose name shares the prefix.
  const candidates = root
    .querySelectorAll("button, input[type=submit]")
    .map((el) => el.getAttribute("name") ?? "")
    .filter((n) => n.startsWith(prefix + ":") && n !== folioName);

  // Pick the candidate that matches the prefix + one extra segment (the j_idtN button).
  const button = candidates.find(
    (n) => n.slice(prefix.length + 1).indexOf(":") === -1,
  );
  if (!button) {
    throw new Error(
      `Could not find submit button under prefix '${prefix}'. Candidates: ${candidates.join(", ")}`,
    );
  }
  const buttonId = button.slice(prefix.length + 1);

  return { viewState, formId, prefix, buttonId };
}
