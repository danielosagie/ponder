import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { AgentEvents } from "../types";

export interface ConvexEventsOptions {
  client: ConvexHttpClient;
  sessionId: string;
  /**
   * Optional decorators that fire AFTER the matching Convex mutation. Use
   * these from the Electron desktop app to also push the event to a buddy
   * window — keeps the UI-side IPC out of this shared module.
   */
  decorate?: Partial<AgentEvents>;
}

/**
 * Build an AgentEvents implementation that streams every callback into the
 * dev's Convex deployment as `steps` rows. Used by `serveHeadless()` and
 * (eventually) by the Electron orchestrator once it migrates off its hand-
 * rolled buildEvents.
 *
 * Mirrors the Convex side of electron/main.ts:300-368 so the two paths stay
 * in sync — the Electron version also tees to the buddy overlay via IPC,
 * which is what `decorate` is for.
 */
export function createConvexEvents(opts: ConvexEventsOptions): AgentEvents {
  const { client, sessionId, decorate } = opts;
  const sid = sessionId as never;

  return {
    onThought: async (text) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "thought",
        text,
      });
      await decorate?.onThought?.(text);
    },
    onGround: async (coords) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "ground",
        coords,
      });
      await decorate?.onGround?.(coords);
    },
    onAction: async (action) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "action",
        action,
      });
      await decorate?.onAction?.(action);
    },
    onScreenshot: async (png) => {
      try {
        const url = (await client.mutation(
          anyApi.steps.generateUploadUrl,
          {},
        )) as string;
        const upload = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: new Uint8Array(png),
        });
        const { storageId } = (await upload.json()) as { storageId: string };
        await client.mutation(anyApi.steps.append, {
          sessionId: sid,
          kind: "screenshot",
          screenshotId: storageId as never,
        });
      } catch (e) {
        console.warn(
          `[events] screenshot upload skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      await decorate?.onScreenshot?.(png);
    },
    onError: async (message) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "error",
        text: message,
      });
      await decorate?.onError?.(message);
    },
    onStatus: async (text) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "status",
        text,
      });
      await decorate?.onStatus?.(text);
    },
    onResult: async (text) => {
      await client.mutation(anyApi.steps.append, {
        sessionId: sid,
        kind: "result",
        text,
      });
      await decorate?.onResult?.(text);
    },
  };
}
