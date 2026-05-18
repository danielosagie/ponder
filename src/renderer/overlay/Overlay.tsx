/**
 * Trailing-cursor chat bubble — port of Clicky's CompanionResponseOverlay.
 *
 * Two modes:
 *   IDLE  — small interactive pill near the cursor with a single text input.
 *           User types a task; Enter dispatches.
 *   TAIL  — bubble follows the cursor at 60Hz (handled in main process).
 *           Shows the latest streaming agent thought / action.
 *           Click-through so the user can keep working.
 *
 * After a task completes, we keep the last response visible for 6s (Clicky's
 * `finishStreaming` behavior), then fade out. The Esc key dismisses at any time.
 *
 * Layout uses a single `.bubble` card; we measure it via ResizeObserver and
 * report its size up to the OS window so it shrinks/grows like Clicky's panel.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

type WarmupState = "cold" | "warming" | "ready" | "error";
type ProviderName = "remote" | "local" | "hcompany";

interface AgentState {
  warmup: WarmupState;
  provider: ProviderName;
  activeSessionId: string | null;
  errorMessage?: string;
}

type StepRow = {
  _id: string;
  kind: string;
  text?: string;
  coords?: { x: number; y: number };
  action?: { type: string; payload: Record<string, unknown> };
  index: number;
};

const FADE_DELAY_MS = 6_000; // Clicky: keep visible 6s after last token.

export function Overlay() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AgentState>({
    warmup: "cold",
    provider: "remote",
    activeSessionId: null,
  });
  const [warmStartedAt, setWarmStartedAt] = useState<number | null>(null);
  const [warmElapsed, setWarmElapsed] = useState(0);
  const [hidden, setHidden] = useState(false); // post-streaming auto-fade flag
  const inputRef = useRef<HTMLInputElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Subscribe to agent state push from main process.
  useEffect(() => {
    void window.agent.getState().then(setState);
    const unsub = window.agent.onState((s) => setState(s));
    return () => unsub();
  }, []);

  // Live tail from Convex — last 4 steps; we render the most recent
  // "thought"/"action"/"error" so the bubble reads like a chat reply.
  const sessionId = state.activeSessionId as Id<"sessions"> | null;
  const tail = useQuery(
    api.steps.tail,
    sessionId ? { sessionId, n: 4 } : "skip",
  );

  const mode: "idle" | "tail" = sessionId ? "tail" : "idle";

  // Whenever a session starts, ask main to flip to click-through tail mode;
  // when it ends, switch back to interactive input mode (the user wants to
  // type the next task). Renderer's "idle" maps to main's "input".
  useEffect(() => {
    void window.agent.setOverlayMode(mode === "idle" ? "input" : "tail");
    setHidden(false);
  }, [mode]);

  // Auto-fade after streaming idle: when we're in tail mode but the session
  // has ended (sessionId clears), wait FADE_DELAY_MS then hide.
  useEffect(() => {
    if (mode !== "idle") return;
    if (!tail?.length) return;
    const t = setTimeout(() => setHidden(true), FADE_DELAY_MS);
    return () => clearTimeout(t);
  }, [mode, tail]);

  // Warmup elapsed timer (cosmetic; matches Clicky's "warming" feel).
  useEffect(() => {
    if (state.warmup === "warming") {
      if (!warmStartedAt) setWarmStartedAt(Date.now());
      const t = setInterval(() => {
        if (warmStartedAt)
          setWarmElapsed(Math.floor((Date.now() - warmStartedAt) / 1000));
      }, 250);
      return () => clearInterval(t);
    }
    setWarmStartedAt(null);
    setWarmElapsed(0);
  }, [state.warmup, warmStartedAt]);

  // Focus the input on mount so the user can just start typing.
  useEffect(() => {
    if (mode === "idle") inputRef.current?.focus();
  }, [mode]);

  // Auto-size the OS window to fit the bubble. ResizeObserver runs whenever
  // content changes (text streams in, mode flips, hint expands).
  useLayoutEffect(() => {
    if (!bubbleRef.current) return;
    const el = bubbleRef.current;
    const report = () => {
      // Add a 1px buffer so we don't get sub-pixel clipping after rounding.
      const rect = el.getBoundingClientRect();
      void window.agent.resizeOverlay({ w: rect.width + 2, h: rect.height + 2 });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, hidden]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const r = await window.agent.runTask(prompt);
      if (!r.ok) console.error(r.error);
      setPrompt("");
    } finally {
      setBusy(false);
    }
  };

  const onEsc = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") void window.agent.hideOverlay();
  };

  // ---- The latest interesting step to show in tail mode ---------------------
  const latest: StepRow | null = useMemo(() => {
    if (!tail?.length) return null;
    // Prefer the most recent thought; fall back to action/error/status.
    const reversed = [...tail].reverse() as StepRow[];
    return (
      reversed.find((s) => s.kind === "thought") ??
      reversed.find((s) => s.kind === "action") ??
      reversed.find((s) => s.kind === "error") ??
      reversed[0] ??
      null
    );
  }, [tail]);

  if (hidden) return null;

  // ===========================================================================
  // RENDER
  // ===========================================================================
  return (
    <div
      ref={bubbleRef}
      className={`bubble bubble--${mode}`}
      onKeyDown={onEsc}
      role={mode === "tail" ? "status" : undefined}
      aria-live={mode === "tail" ? "polite" : undefined}
    >
      {/* Tiny header strip — status pill + actions */}
      <div className="bubble__head">
        <span className="status-pill" title={state.errorMessage ?? ""}>
          <Dot state={state.warmup} />
          {label(state, warmElapsed)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="ghost"
          onClick={() => window.agent.openAppWindow()}
          aria-label="Open history window"
          translate="no"
        >
          History
        </button>
      </div>

      {/* Body switches by mode */}
      {mode === "idle" ? (
        <IdleBody
          inputRef={inputRef}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={submit}
          busy={busy}
          warmupState={state.warmup}
        />
      ) : (
        <TailBody latest={latest} />
      )}
    </div>
  );
}

// ===========================================================================
// IDLE — interactive input pill + recipe hints
// ===========================================================================
function IdleBody({
  inputRef,
  prompt,
  onPromptChange,
  onSubmit,
  busy,
  warmupState,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  prompt: string;
  onPromptChange: (s: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  warmupState: WarmupState;
}) {
  const placeholder =
    warmupState === "ready"
      ? "Tell Ponder what to do…"
      : warmupState === "warming"
        ? "Warming up…"
        : warmupState === "error"
          ? "Provider error — open History"
          : "Type a task…";

  return (
    <>
      <form onSubmit={onSubmit} className="bubble__input-wrap">
        <input
          ref={inputRef}
          name="task"
          autoComplete="off"
          spellCheck={false}
          inputMode="search"
          aria-label="Task"
          translate="no"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
          className="bubble__input"
        />
        <button
          type="submit"
          className="bubble__send primary"
          disabled={busy || !prompt.trim()}
          aria-label="Run task"
        >
          <span aria-hidden>↵</span>
        </button>
      </form>
      <div className="bubble__hints" aria-hidden>
        <kbd translate="no">⌘E</kbd> summon · <kbd translate="no">Esc</kbd>{" "}
        dismiss
      </div>
    </>
  );
}

// ===========================================================================
// TAIL — streaming chat bubble (click-through, follows cursor)
// ===========================================================================
function TailBody({ latest }: { latest: StepRow | null }) {
  if (!latest) {
    return (
      <div className="bubble__streaming bubble__streaming--placeholder">
        Thinking<span className="ellipsis-dot">.</span>
        <span className="ellipsis-dot">.</span>
        <span className="ellipsis-dot">.</span>
      </div>
    );
  }
  if (latest.kind === "thought") {
    return <div className="bubble__streaming">{latest.text}</div>;
  }
  if (latest.kind === "action") {
    return (
      <div className="bubble__streaming bubble__streaming--action">
        <span className="kind">action</span>{" "}
        <code translate="no">
          {latest.action?.type}
          {latest.action?.payload &&
            ` ${truncate(JSON.stringify(latest.action.payload), 80)}`}
        </code>
      </div>
    );
  }
  if (latest.kind === "error") {
    return (
      <div className="bubble__streaming bubble__streaming--error">
        <span className="kind">error</span> {latest.text}
      </div>
    );
  }
  return (
    <div className="bubble__streaming bubble__streaming--muted">
      {latest.text}
    </div>
  );
}

// ===========================================================================
// Tiny pieces
// ===========================================================================
function Dot({ state }: { state: WarmupState }) {
  const color =
    state === "ready"
      ? "var(--good)"
      : state === "warming"
        ? "var(--warn)"
        : state === "error"
          ? "var(--bad)"
          : "var(--muted-2)";
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        boxShadow: state === "warming" ? `0 0 8px ${color}` : "none",
        animation:
          state === "warming" ? "pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function label(state: AgentState, elapsed: number): string {
  const provider = state.provider === "remote" ? "Modal" : "Local";
  switch (state.warmup) {
    case "ready":
      return `Ready · ${state.provider === "remote" ? "Holo3 (Modal)" : "Holo3 (Local)"}`;
    case "warming":
      return `Warming ${provider} · ${elapsed}s`;
    case "error":
      return "Error";
    default:
      return `Idle · ${provider}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
