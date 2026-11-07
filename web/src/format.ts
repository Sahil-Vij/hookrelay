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

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
