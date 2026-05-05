import { tramiteUrl, USER_AGENT, type FormPage } from "./get.js";

export interface PartialResponse {
  /** The update id the server actually used: either `<prefix>:datos` or `javax.faces.ViewRoot`. */
  updateId: string;
  /** Raw HTML payload from the matched <update> CDATA. */
  payload: string;
  newViewState: string | null;
}

export async function postTramite(
  page: FormPage,
  folio: string,
  email: string,
): Promise<PartialResponse> {
  const sourceId = `${page.prefix}:${page.buttonId}`;
  const renderTarget = `${page.prefix}:datos`;

  const body = new URLSearchParams();
  body.append("javax.faces.partial.ajax", "true");
  body.append("javax.faces.source", sourceId);
  body.append("javax.faces.partial.execute", "@all");
  body.append("javax.faces.partial.render", renderTarget);
  body.append(sourceId, sourceId);
  body.append(page.formId, page.formId);
  body.append(`${page.prefix}:folio`, folio);
  body.append(`${page.prefix}:codigoSeguridad`, email);
  body.append("javax.faces.ViewState", page.viewState);

  const url = tramiteUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/xml, text/xml, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://sfpya.edomexico.gob.mx",
      Referer: url,
      "User-Agent": USER_AGENT,
      Cookie: page.cookies,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`POST tramite failed: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  return parsePartialResponse(xml, renderTarget);
}

export function parsePartialResponse(
  xml: string,
  preferredId: string,
): PartialResponse {
  // Server sometimes returns a partial :datos update; in practice today it
  // returns a full javax.faces.ViewRoot re-render. Accept either.
  const datos = extractCdataForUpdate(xml, preferredId);
  if (datos !== null) {
    return {
      updateId: preferredId,
      payload: datos,
      newViewState: extractCdataForUpdate(xml, "javax.faces.ViewState")
        ?? extractCdataForUpdate(xml, "j_id1:javax.faces.ViewState:0"),
    };
  }

  const viewRoot = extractCdataForUpdate(xml, "javax.faces.ViewRoot");
  if (viewRoot !== null) {
    return {
      updateId: "javax.faces.ViewRoot",
      payload: viewRoot,
      newViewState: extractCdataForUpdate(xml, "javax.faces.ViewState")
        ?? extractCdataForUpdate(xml, "j_id1:javax.faces.ViewState:0"),
    };
  }

  const ids = [...xml.matchAll(/<update\s+id="([^"]+)"/g)].map((m) => m[1]);
  throw new Error(
    `partial-response had no usable <update>. Saw ids: ${ids.join(", ") || "(none)"}. Raw head: ${xml.slice(0, 500)}`,
  );
}

function extractCdataForUpdate(xml: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<update\\s+id="${escapedId}"\\s*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</update>`,
  );
  const m = re.exec(xml);
  return m ? m[1]! : null;
}
