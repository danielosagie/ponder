/**
 * Per-window task-history hook for the input pills (Buddy ⌘E and RetryBar).
 *
 * Why a shared module: both renderer windows want the same up/down arrow
 * shell-style recall behavior, and we want them to share the SAME backing
 * list (localStorage) so a task fired from the buddy is recallable in the
 * retry bar and vice-versa.
 *
 * Why localStorage and not Convex: this is a UX nicety, not a record. We
 * don't need cross-device sync, we don't need to outlive an uninstall, and
 * we don't want a network round-trip for every keystroke. Each renderer
 * window has its own localStorage; that's acceptable — both Buddy and App
 * windows are loaded from the same Vite dev server origin in dev and from
 * file:// in prod, so they share storage in both cases.
 *
 * Behavior:
 *   • push(text) on submit appends if it's not the same as the most-recent
 *     entry (avoid neighboring duplicates the way bash HISTCONTROL=ignoredups
 *     does); we do NOT dedupe across the whole list because order matters
 *     for recall.
 *   • Arrow-up walks BACKWARD through history (newest first → older), arrow-
 *     down walks forward. Reaching the bottom restores whatever the user
 *     was typing before they entered recall mode (the "draft").
 *   • Cap at MAX_ENTRIES so the list doesn't grow without bound; oldest
 *     entries fall off when the cap is hit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "holo3.taskHistory.v1";
const MAX_ENTRIES = 200;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

function saveHistory(list: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    // Quota / disabled storage / private mode — silently degrade. No history
    // is strictly better than crashing the renderer on submit.
  }
}

export interface UseTaskHistory {
  /** Append a new entry (call this on successful submit). */
  push: (text: string) => void;
  /**
   * Keydown handler to wire onto the input. Consumes ArrowUp / ArrowDown
   * and rewrites the input value via setText. No-op for any other key.
   */
  onKeyDown: (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    currentText: string,
    setText: (next: string) => void,
  ) => void;
  /** Reset recall position — call after a successful submit so the next
   *  ArrowUp starts fresh from the latest entry. */
  reset: () => void;
}

export function useTaskHistory(): UseTaskHistory {
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  // -1 means "not currently in recall mode" — the input shows the user's own
  // typing (the draft). 0 means "showing the most-recent entry", N means
  // "showing the Nth-from-end entry". We use this as an index from the END
  // so newer pushes don't shift the user's recall position out from under them.
  const cursorRef = useRef<number>(-1);
  // Saved draft from before recall began, so ArrowDown past the bottom can
  // restore it. Cleared on recall exit (reset() or successful submit).
  const draftRef = useRef<string>("");

  // Keep history in sync if another window pushes while we're mounted.
  // 'storage' fires for cross-tab/window writes only — perfect for keeping
  // Buddy and RetryBar's lists in sync without an IPC bridge.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) setHistory(loadHistory());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      // Skip if this duplicates the last entry — common when the user hits
      // ↻ Retry and then submits the same prompt again.
      if (prev.length > 0 && prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed].slice(-MAX_ENTRIES);
      saveHistory(next);
      return next;
    });
    cursorRef.current = -1;
    draftRef.current = "";
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = -1;
    draftRef.current = "";
  }, []);

  const onKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
      currentText: string,
      setText: (next: string) => void,
    ): void => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      // Ignore the arrow when an IME composition is in flight — navigating
      // history mid-composition would clobber the user's pending characters.
      if (e.nativeEvent.isComposing) return;
      if (history.length === 0) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        // Entering recall: stash whatever the user was drafting so ArrowDown
        // past the bottom can restore it.
        if (cursorRef.current === -1) draftRef.current = currentText;
        // Walk backward (towards older entries) until we hit the start.
        const nextCursor = Math.min(cursorRef.current + 1, history.length - 1);
        cursorRef.current = nextCursor;
        setText(history[history.length - 1 - nextCursor]!);
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (cursorRef.current <= 0) {
          // At the most-recent entry (or below) — exit recall mode and
          // restore the user's draft.
          cursorRef.current = -1;
          setText(draftRef.current);
          return;
        }
        cursorRef.current -= 1;
        setText(history[history.length - 1 - cursorRef.current]!);
      }
    },
    [history],
  );

  return { push, onKeyDown, reset };
}
