// sessionStorage rather than localStorage: the key is gone when the tab closes, so a shared machine
// doesn't stay signed in. Storage can throw in private windows, in which case the key lives in memory only.
const KEY = "hookrelay.apiKey";

export function loadApiKey(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string) {
  try {
    sessionStorage.setItem(KEY, apiKey);
  } catch {
    // Fine, the key stays in React state for this page load.
  }
}

export function clearApiKey() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
