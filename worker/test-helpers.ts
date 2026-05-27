import type { RouteContext } from "./types";

export function fakeCtx(): RouteContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    }
  };
}
