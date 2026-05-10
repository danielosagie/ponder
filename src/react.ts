/**
 * `ponder/react` — React hook for live-subscribing to a Ponder session's
 * step stream. Wraps `convex/react`'s `useQuery` so it integrates with a
 * ConvexProvider already present in the consumer's app.
 *
 * For non-React consumers, use `PonderClient.subscribe()` directly.
 */
import { useMemo } from "react";
import { useConvex, useQuery } from "convex/react";
import { anyApi } from "convex/server";
import type { SessionStatus, Step } from "./client";

interface UsePonderSessionResult {
  steps: Step[];
  status: SessionStatus;
  result?: string;
  cancel: () => Promise<void>;
}

/**
 * Subscribe to steps + session status for a Ponder session. Pass `null` to
 * disable the subscription (useful before the dispatch call resolves).
 */
export function usePonderSession(
  sessionId: string | null,
): UsePonderSessionResult {
  const convex = useConvex();

  const steps = useQuery(
    anyApi.steps.listBySession,
    sessionId ? { sessionId } : "skip",
  ) as Step[] | undefined;

  const session = useQuery(
    anyApi.sessions.get,
    sessionId ? { sessionId } : "skip",
  ) as { status: SessionStatus; error?: string } | null | undefined;

  const cancel = useMemo(
    () => async () => {
      if (!sessionId) return;
      await convex.mutation(anyApi.sessions.setStatus, {
        sessionId,
        status: "cancelled",
      });
    },
    [convex, sessionId],
  );

  const stepList = steps ?? [];
  const status: SessionStatus = session?.status ?? "pending";
  const resultStep = [...stepList].reverse().find((s) => s.kind === "result");

  return {
    steps: stepList,
    status,
    result: resultStep?.text,
    cancel,
  };
}
