import type { Delivery } from "./api.ts";

export type StatusTone = "neutral" | "pending" | "success" | "danger";

export function deliveryLabel(delivery: Delivery | null): { label: string; tone: StatusTone } {
  if (!delivery) return { label: "Stored only", tone: "neutral" };
  switch (delivery.status) {
    case "delivered":
      return { label: "Delivered", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "pending":
      return delivery.attempts > 0 ? { label: "Retrying", tone: "pending" } : { label: "Pending", tone: "pending" };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Removes whitespace between JSON tokens, leaving strings untouched. */
function stripJsonWhitespace(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      out += ch;
    }
  }
  return out;
}

/**
 * Pretty-prints a JSON body. Re-serialising can change what was received: big numbers lose precision, duplicate
 * keys collapse and escapes are rewritten. `lossless` says whether the formatted text means exactly the same bytes,
 * so the UI can avoid showing a misleading version by default.
 */
export function formatJson(raw: string): { formatted: string; lossless: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return {
    formatted: JSON.stringify(parsed, null, 2),
    lossless: JSON.stringify(parsed) === stripJsonWhitespace(raw),
  };
}

const dateTime =new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
