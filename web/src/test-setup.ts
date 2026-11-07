import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The default 1s is too tight on a busy CI runner and makes the async tests flaky.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
