import { useSyncExternalStore } from "react";

// Hash routes keep the dashboard a set of static files, with links and the back button still working.
const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export const eventHref = (id: number) => `#/events/${id}`;
export const listHref = "#/";

/** The event id in the URL, or null on the list. */
export function useEventIdFromHash(): number | null {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const match = /^#\/events\/([1-9]\d{0,15})$/.exec(hash);
  return match ? Number(match[1]) : null;
}
