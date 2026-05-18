/**
 * Buddy — single full-screen overlay hosting EVERY visible companion element.
 *
 * Ports Clicky's BlueCursorView (OverlayWindow.swift L105–L407) and
 * collapses Clicky's separate response panel into the same surface.
 *
 *   • Triangle (+35x +25y from cursor) — always visible, lerp-smoothed at 60fps
 *   • Speech bubble — pops next to triangle during agent tasks
 *   • Input pill — appears at cursor when ⌘E is pressed, dismisses on Enter/Esc
 *
 * Everything renders as absolutely-positioned children of the click-through
 * window. CSS transforms drive motion → no OS-level window moves → smooth.
 *
 * Click-through is toggled at the main-process level only when the input pill
 * is active (so the user can click + type into it). Otherwise the entire
 * window forwards mouse events to whatever is below.
 */
import { useEffect, useRef, useState } from "react";
import { useTaskHistory } from "../shared/taskHistory";

// Clicky's exact offsets from BlueCursorView L121–L123, L439–L440.
const TRIANGLE_OFFSET_X = 35;
const TRIANGLE_OFFSET_Y = 25;
const BUBBLE_OFFSET_X = 10;
const BUBBLE_OFFSET_Y = 18;

// Spring smoothing: per-frame lerp t≈0.25 mirrors
// SwiftUI's .spring(response: 0.2, dampingFraction: 0.6).
const LERP_T = 0.25;

const WELCOME_TEXT = "hey! i'm ponder";

type BubbleKind =
  | "thought"
  | "action"
  | "error"
  | "welcome"
  | "status"
  // "answer" is the extractor's end-of-run textual answer to the user's
  // original question — variable length, the actual deliverable. Renders
  // similarly to "thought" today (the existing bubble accommodates any
  // kind), but kept distinct so we can style the answer differently
  // later (e.g. persistent until clicked, list formatting).
  | "answer";

export function Buddy() {
  // Cursor state (window-local coords pushed from main at 60Hz).
  // The trailing cursor follows the OS cursor by default. When the agent
  // fires a click, we OVERRIDE the target temporarily so the same triangle
  // flies to the click point and back. No second cursor.
  const targetRef = useRef({ x: -200, y: -200 }); // OS cursor (60Hz push)
  const overrideRef = useRef<{ x: number; y: number } | null>(null);
  const currentRef = useRef({ x: -200, y: -200 });
  const [renderPos, setRenderPos] = useState({ x: -200, y: -200 });
  const [cursorOnScreen, setCursorOnScreen] = useState(false);
  // Pulse state for the click halo, anchored at the AGENT click target.
  // The halo plays once per ground event, at the target screen coords.
  const [haloAt, setHaloAt] = useState<{ x: number; y: number; key: number } | null>(null);
  const releaseTimerRef = useRef<number | null>(null);

  // Speech bubble (shown during agent activity).
  const [bubbleText, setBubbleText] = useState("");
  const [bubbleKind, setBubbleKind] = useState<BubbleKind>("welcome");
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const fadeRef = useRef<number | null>(null);
  // True while the agent loop is actively running. Drives the "press ⌘. to
  // stop" hint that pins beneath the speech bubble — the only on-screen
  // affordance reminding the user how to abort without leaving their app.
  const [running, setRunning] = useState(false);


  // Input pill (shown only when ⌘E is pressed). Position follows the lerped
  // cursor (renderPos), Clicky-style — no static anchor.
  const [inputVisible, setInputVisible] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Shell-style up/down task history. Recalls past prompts entered in this
  // window OR in the App window (both share localStorage under the same
  // origin). Push happens after a successful runTask.
  const taskHistory = useTaskHistory();

  // ---------------------------------------------------------------------------
  // Subscribe to main → renderer push channels.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unsubCursor = window.buddy.onCursor((p) => {
      targetRef.current = p;
    });

    const unsubMode = window.buddy.onMode((m) => {
      // "active" = agent task started. We DON'T play the welcome here anymore
      // (that would spam "hi i'm holo3" every task). Welcome is one-shot via
      // the `buddy:welcome` channel below, fired once at app boot.
      // "hidden" = task ended. We DON'T immediately hide the bubble either —
      // the last message ("Done" / error) needs its 6s fade so the user
      // actually reads it. The fade timer in onSay handles that.
      setRunning(m === "active");
    });

    // One-shot welcome on app boot.
    const unsubWelcome = window.buddy.onWelcome(() => {
      playWelcome();
    });

    const unsubSay = window.buddy.onSay(({ kind, text }) => {
      setBubbleKind(kind);
      setBubbleText(text);
      setBubbleVisible(true);
      if (fadeRef.current) clearTimeout(fadeRef.current);
      // The extractor "answer" can be a multi-line list (e.g. 5 FB
      // Marketplace items with prices) — 6s isn't enough to read.
      // Errors deserve longer too. Other kinds keep the snappy 6s fade so
      // the bubble doesn't loiter during a flow of thoughts/actions.
      const fadeMs =
        kind === "answer" ? 60_000 : kind === "error" ? 15_000 : 6_000;
      fadeRef.current = window.setTimeout(
        () => setBubbleVisible(false),
        fadeMs,
      );
    });

    const unsubAgent = window.buddy.onAgentCursor((c) => {
      if (c) {
        // Hijack the trailing cursor: aim it at the click target. The 60Hz
        // tick reads `overrideRef ?? targetRef`, so the SAME triangle flies
        // there. Halo plays once at the target. After the click animation
        // completes we release the override so the triangle returns to
        // following the user's mouse.
        overrideRef.current = { x: c.x, y: c.y };
        setHaloAt({ x: c.x, y: c.y, key: Date.now() });
        if (releaseTimerRef.current) {
          window.clearTimeout(releaseTimerRef.current);
        }
        // 800ms = enough time for the lerp to land + the halo to play +
        // the user to register "the agent clicked here". Then back to user.
        releaseTimerRef.current = window.setTimeout(() => {
          overrideRef.current = null;
        }, 800);
      } else {
        // Task ended — release immediately.
        overrideRef.current = null;
        setHaloAt(null);
      }
    });

    const unsubInput = window.buddy.onInputMode((p) => {
      if (p.visible) {
        setInputVisible(true);
        // macOS panel windows are flaky: keyboard focus can fail to land on
        // the second+ summon if another app stole focus during the previous
        // task. Retry across multiple frames + delayed timers so whichever
        // moment the window actually becomes key is when we focus the input.
        const tryFocus = () => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.select();
        };
        requestAnimationFrame(tryFocus);
        setTimeout(tryFocus, 30);
        setTimeout(tryFocus, 120);
        setTimeout(tryFocus, 280);
      } else {
        setInputVisible(false);
        setPrompt("");
      }
    });

    return () => {
      unsubCursor();
      unsubMode();
      unsubSay();
      unsubInput();
      unsubWelcome();
      unsubAgent();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 60Hz lerp loop — single trailing triangle that either follows the user
  // OR (when overridden) flies to the agent's click target and back.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    // Slower lerp when under agent override so the travel is visibly traced
    // across the screen instead of snapping.
    const AGENT_LERP_T = 0.13;
    const tick = () => {
      const overridden = overrideRef.current !== null;
      const t = overrideRef.current ?? targetRef.current;
      const c = currentRef.current;
      const k = overridden ? AGENT_LERP_T : LERP_T;
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      setRenderPos({ x: c.x, y: c.y });

      // Hide triangle when cursor is off this screen (out of window bounds).
      // We use the OS cursor target for this — the override may put the
      // triangle on-screen even when the user's mouse is on a second display.
      const w = window.innerWidth;
      const h = window.innerHeight;
      const ot = targetRef.current;
      const onScreen =
        overridden ||
        (ot.x >= 0 && ot.y >= 0 && ot.x < w && ot.y < h);
      if (onScreen !== cursorOnScreen) setCursorOnScreen(onScreen);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // cursorOnScreen omitted to avoid restart; the closure reads via ref-style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Welcome typing animation — same pacing as Clicky.
  // ---------------------------------------------------------------------------
  const playWelcome = () => {
    setBubbleKind("welcome");
    setBubbleText("");
    setBubbleVisible(true);
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setBubbleText(WELCOME_TEXT.slice(0, i));
      if (i >= WELCOME_TEXT.length) {
        clearInterval(id);
        if (fadeRef.current) clearTimeout(fadeRef.current);
        fadeRef.current = window.setTimeout(
          () => setBubbleVisible(false),
          2_500,
        );
      }
    }, 30);
  };

  // ---------------------------------------------------------------------------
  // Submit / dismiss handlers.
  // ---------------------------------------------------------------------------
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    const submitted = prompt;
    const r = await window.agent.runTask(submitted);
    setBusy(false);
    setPrompt("");
    // Add to recall list AFTER the runTask returns, regardless of ok/error —
    // the user typed it, they may want to recall it whether it succeeded
    // or not (e.g. to fix a typo and resubmit).
    taskHistory.push(submitted);
    void window.agent.dismissInputMode();
    if (!r.ok) console.error(r.error);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      taskHistory.reset();
      void window.agent.dismissInputMode();
      return;
    }
    // Arrow-up / arrow-down recall. The hook only consumes those keys; any
    // other key falls through to the input's normal behavior.
    taskHistory.onKeyDown(e, prompt, setPrompt);
  };

  const triX = renderPos.x + TRIANGLE_OFFSET_X;
  const triY = renderPos.y + TRIANGLE_OFFSET_Y;

  return (
    <>
      {/* The triangle is ALWAYS rendered when the cursor is on this screen.
          When the cursor is on a different display we hide it (Clicky does
          the same with `buddyIsVisibleOnThisScreen`). */}
      {cursorOnScreen && <Triangle x={triX} y={triY} />}

      {/* Bubble + StopHint share an anchored flex column so the hint always
          sits BELOW the bubble's actual rendered bottom — not at a fixed 30px
          offset that long, multi-line thoughts would punch through. The
          column also enforces stacking order: instruction (z-index 2) wins
          over hint (z-index 1) if the bubble's enter animation overlaps the
          hint mid-flight. Anchor moves at 60Hz with the cursor (triX/triY).
          The whole stack is non-interactive — buddy window is click-through;
          stop is the ⌘. hotkey, which works from any app. */}
      {(bubbleVisible && bubbleText) || running ? (
        <div
          className="buddy-bubble-stack"
          style={{
            left: triX + BUBBLE_OFFSET_X,
            top: triY + BUBBLE_OFFSET_Y,
          }}
          aria-hidden
        >
          {bubbleVisible && bubbleText && (
            <Bubble kind={bubbleKind} text={bubbleText} />
          )}
          {running && <StopHint />}
        </div>
      ) : null}

      {/* Click halo — one-shot pulse at the agent's click target. The
          trailing triangle flies to this same point and returns; the halo
          marks the actual click moment. */}
      {haloAt && <ClickHalo key={haloAt.key} x={haloAt.x} y={haloAt.y} />}

      {/* Input pill — only when ⌘E was pressed. A backdrop catches stray
          clicks and dismisses. The pill follows the cursor (same lerped
          position as the triangle) so it tracks your mouse, Clicky-style. */}
      {inputVisible && (
        <>
          <div
            className="buddy-backdrop"
            onClick={() => void window.agent.dismissInputMode()}
            aria-hidden
          />
          <form
            onSubmit={submit}
            className="buddy-input"
            style={{ left: renderPos.x, top: renderPos.y }}
          >
            <input
              ref={inputRef}
              name="task"
              autoComplete="off"
              spellCheck={false}
              inputMode="search"
              aria-label="Task"
              translate="no"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKey}
              placeholder="Tell Ponder what to do…"
              disabled={busy}
            />
            <span className="buddy-input__hint" aria-hidden>
              <kbd>↵</kbd> send · <kbd>↑↓</kbd> recall · <kbd>Esc</kbd> dismiss
            </span>
          </form>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Triangle({ x, y }: { x: number; y: number }) {
  // Clicky's blue (#7BB304), -35° rotation, soft halo.
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      style={{
        position: "absolute",
        left: x - 10,
        top: y - 10,
        transform: "rotate(-35deg)",
        filter: "drop-shadow(0 0 8px rgba(51, 128, 255, 0.65))",
        pointerEvents: "none",
        willChange: "left, top",
      }}
      aria-hidden
    >
      <polygon points="10,2 18,16 2,16" fill="#7BB304" />
    </svg>
  );
}

function Bubble({
  kind,
  text,
}: {
  kind: BubbleKind;
  text: string;
}) {
  // Show a tiny spinner whenever the agent is in a "still working" state
  // (thought, status). Action and error are terminal-ish — no spinner.
  const showSpinner = kind === "thought" || kind === "status";
  return (
    <div
      className={`buddy-bubble buddy-bubble--${kind}`}
      role="status"
      aria-live="polite"
    >
      {showSpinner && <Spinner />}
      <span className="buddy-bubble__text">{text}</span>
    </div>
  );
}

function Spinner() {
  // 12px CSS spinner — keyframes defined in shared/styles.css.
  return <span className="buddy-spinner" aria-hidden />;
}

function ClickHalo({ x, y }: { x: number; y: number }) {
  // Pinned at the click target. The trailing triangle (moving via the lerp
  // loop) lands inside it shortly after this halo appears; both fade.
  return (
    <span
      style={{
        position: "absolute",
        left: x - 18,
        top: y - 18,
        width: 36,
        height: 36,
        pointerEvents: "none",
        borderRadius: "50%",
        border: "2px solid #7BB304",
        opacity: 0.6,
        animation: "agent-halo 750ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
      }}
      aria-hidden
    />
  );
}

function StopHint() {
  // Position is owned by the parent flex column (.buddy-bubble-stack).
  // We sit at z-index 1 so the bubble (z-index 2) renders on top during
  // any momentary overlap from the bubble's pop-in animation.
  return (
    <div
      style={{
        position: "relative",
        zIndex: 1,
        pointerEvents: "none",
        fontSize: 11,
        color: "rgba(255, 255, 255, 0.92)",
        background: "rgba(15, 17, 22, 0.78)",
        padding: "3px 8px",
        borderRadius: 999,
        boxShadow: "0 4px 12px rgba(15, 17, 22, 0.18)",
        whiteSpace: "nowrap",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "bubble-pop 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        alignSelf: "flex-start",
      }}
      aria-hidden
    >
      Press <kbd style={kbdStyle}>⌘</kbd>
      <kbd style={kbdStyle}>.</kbd> to stop
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  background: "rgba(255, 255, 255, 0.18)",
  padding: "0 4px",
  borderRadius: 3,
  margin: "0 1px",
};
