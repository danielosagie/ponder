/**
 * AppWindow — ollama-style sessions list + detail view.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ Sessions │ <session prompt>                   │
 *   │   ───    │ <meta>                             │
 *   │   row    │                                    │
 *   │   row    │ <step>                             │
 *   │   row    │ <step>                             │
 *   │          │ ...                                │
 *   └──────────────────────────────────────────────┘
 *
 * Convex provides reactive subscriptions, so newly streamed steps appear
 * without a refresh. Visual hierarchy follows the shared light-theme
 * tokens in `../shared/styles.css` (.app, .step, .status-pill).
 */
import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useTaskHistory } from "../shared/taskHistory";

type ProviderName = "remote" | "local" | "hcompany";

type SessionRow = {
  _id: Id<"sessions">;
  prompt: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  provider: ProviderName;
  createdAt: number;
  endedAt?: number;
};

type AgentState = {
  warmup: "cold" | "warming" | "ready" | "error";
  provider: ProviderName;
  activeSessionId: string | null;
  errorMessage?: string;
};

type PermStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

type PermissionsReport = {
  platform: string;
  accessibility: PermStatus;
  screenRecording: PermStatus;
  inputMonitoring: PermStatus;
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  hcompany: "API",
  remote: "Modal",
  local: "Local",
};

const PROVIDER_HINTS: Record<ProviderName, string> = {
  hcompany: "Hosted H Company API · pay per token",
  remote: "Self-hosted on Modal · L4 GPU",
  local: "Ollama on this machine",
};

type TopView = "sessions" | "recipes";

export function App() {
  const sessions = useQuery(api.sessions.list, { limit: 100 }) as
    | SessionRow[]
    | undefined;
  const [selected, setSelected] = useState<Id<"sessions"> | null>(null);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [perms, setPerms] = useState<PermissionsReport | null>(null);
  const [backgroundMode, setBackgroundMode] = useState<boolean | null>(null);
  /**
   * Top-level view of the main pane. "sessions" is the live-history view
   * (the original behavior — Convex-backed log of agent_do runs).
   * "recipes" surfaces every saved automation from ~/.ponder/recipes/ so
   * the user can browse, replay, and edit recordings without leaving
   * the app. Switched via the tab strip above the main content.
   */
  const [topView, setTopView] = useState<TopView>("sessions");

  // Subscribe to provider/warmup state from main so the sidebar pill always
  // shows the live truth (and the active provider is highlighted).
  useEffect(() => {
    let mounted = true;
    void window.agent.getState().then((s: AgentState) => {
      if (mounted) setAgentState(s);
    });
    const unsub = window.agent.onState((s: AgentState) => {
      if (mounted) setAgentState(s);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // Probe macOS perms on mount + on window focus, so the banner clears the
  // moment the user grants access and tabs back. Without Accessibility,
  // nut-js's mouse.click() silently no-ops — the agent looks broken even
  // though the loop is firing correctly.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const r = await window.agent.reprobePermissions();
      if (mounted) setPerms(r as PermissionsReport);
    };
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Background-mode flag — true if cliclick is on PATH. When false, the
  // agent hijacks the OS cursor on each click. We surface a hint so the
  // user knows how to switch on background mode.
  useEffect(() => {
    let mounted = true;
    void window.agent.getEnv().then((e: { backgroundMode: boolean }) => {
      if (mounted) setBackgroundMode(e.backgroundMode);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selected && sessions?.length) setSelected(sessions[0]!._id);
  }, [sessions, selected]);

  // When a new agent run starts, jump to it so the user sees live steps
  // instead of staring at the previous session. activeSessionId is broadcast
  // from main whenever a session is created.
  useEffect(() => {
    const id = agentState?.activeSessionId;
    if (id) setSelected(id as Id<"sessions">);
  }, [agentState?.activeSessionId]);

  return (
    <div className="app">
      <aside>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "16px 16px 8px",
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background:
                "linear-gradient(135deg, var(--accent), var(--accent-2))",
              boxShadow: "var(--shadow-1)",
            }}
          />
          <div style={{ fontSize: 14, fontWeight: 600 }}>Ponder</div>
        </div>

        {/* One-click provider switcher right under the brand. The active
            provider is highlighted; clicking another fires the IPC and
            state flips immediately (no second click needed). */}
        <ProviderSwitcher state={agentState} />

        <div className="section-label">Sessions</div>
        {(sessions ?? []).map((s) => (
          <button
            key={s._id}
            className={`session-row ${selected === s._id ? "active" : ""}`}
            onClick={() => setSelected(s._id)}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {s.prompt}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "var(--muted)",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span>{relTime(s.createdAt)}</span>
              <span style={{ color: "var(--muted-2)" }}>·</span>
              <span>{s.provider}</span>
              <span style={{ flex: 1 }} />
              <StatusPill status={s.status} />
            </div>
          </button>
        ))}
        {!sessions?.length && (
          <div
            style={{
              margin: "8px 16px",
              padding: 14,
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--r-md)",
              color: "var(--muted)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            No sessions yet. Press{" "}
            <kbd
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                padding: "1px 6px",
                background: "var(--bg-elev)",
                borderRadius: 4,
                border: "1px solid var(--border)",
              }}
            >
              ⌘E
            </kbd>{" "}
            to summon the cursor companion.
          </div>
        )}
      </aside>
      <main>
        {/* Tab strip — flip between live Sessions (Convex history) and
            Automations (saved recipes from ~/.ponder/recipes/). The
            chosen tab is the active styled pill; the other is muted.
            Keeps the rest of the chrome (perms banner, background hint)
            below so they stay visible regardless of which view is on. */}
        <TabStrip view={topView} onChange={setTopView} />

        {/* Pinned to the top of the main pane so the user sees missing perms
            before they wonder why the agent isn't moving the cursor. */}
        <PermsBanner perms={perms} />
        <BackgroundModeHint enabled={backgroundMode} />

        {topView === "sessions" ? (
          selected ? <Detail sessionId={selected} /> : <Welcome />
        ) : (
          <RecipesView />
        )}
      </main>
    </div>
  );
}

/**
 * Two-pill tab strip pinned to the top of the main pane. Mirrors the
 * Plugins/Skills shape from the Codex reference UI but localized to
 * Ponder's two top-level surfaces.
 */
function TabStrip({
  view,
  onChange,
}: {
  view: TopView;
  onChange: (v: TopView) => void;
}): JSX.Element {
  const tabs: Array<{ id: TopView; label: string }> = [
    { id: "sessions", label: "Sessions" },
    { id: "recipes", label: "Automations" },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        marginBottom: 16,
        padding: 4,
        borderRadius: "var(--r-md)",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        width: "fit-content",
      }}
    >
      {tabs.map((t) => {
        const active = t.id === view;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              color: active ? "var(--text)" : "var(--muted)",
              background: active ? "var(--bg)" : "transparent",
              border: "1px solid",
              borderColor: active ? "var(--border)" : "transparent",
              borderRadius: "var(--r-sm)",
              cursor: "pointer",
              boxShadow: active ? "var(--shadow-1)" : "none",
              transition: "background 120ms, color 120ms",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function BackgroundModeHint({ enabled }: { enabled: boolean | null }) {
  // Don't render until we've heard from main; suppress when already enabled.
  if (enabled === null || enabled === true) return null;
  return (
    <div
      role="status"
      style={{
        marginBottom: 16,
        padding: 12,
        border: "1px solid var(--border)",
        background: "var(--bg-elev)",
        borderRadius: "var(--r-md)",
        color: "var(--text-soft)",
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Tip · enable background mode
      </div>
      <div style={{ color: "var(--muted)" }}>
        The agent currently moves your real cursor on each click — that's
        nut-js's only way to click on macOS. Install{" "}
        <code style={codeStyle}>cliclick</code> and the agent will click in
        the background instead, leaving your mouse exactly where you put it.
        The blue agent cursor in the buddy overlay will fly to each target
        on its own.
        <br />
        <code style={codeStyle}>brew install cliclick</code>, then restart
        the dev server.
      </div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11.5,
  background: "rgba(15, 17, 22, 0.06)",
  padding: "1px 6px",
  borderRadius: 4,
};

function PermsBanner({ perms }: { perms: PermissionsReport | null }) {
  if (!perms || perms.platform !== "darwin") return null;
  const missing: Array<{ key: "accessibility" | "screen" | "input"; label: string; status: PermStatus }> = [];
  if (perms.accessibility !== "granted")
    missing.push({ key: "accessibility", label: "Accessibility", status: perms.accessibility });
  if (perms.screenRecording !== "granted")
    missing.push({ key: "screen", label: "Screen Recording", status: perms.screenRecording });
  if (perms.inputMonitoring !== "granted")
    missing.push({ key: "input", label: "Input Monitoring", status: perms.inputMonitoring });
  if (!missing.length) return null;

  // Accessibility is the make-or-break one — without it nut-js mouse events
  // are dropped on the floor by macOS and the agent appears frozen.
  const blocking = missing.some((m) => m.key === "accessibility");

  return (
    <div
      role="alert"
      style={{
        marginBottom: 16,
        padding: 14,
        border: `1px solid ${blocking ? "var(--bad)" : "var(--warn)"}`,
        background: blocking ? "rgba(216, 67, 79, 0.06)" : "rgba(211, 147, 41, 0.06)",
        borderRadius: "var(--r-md)",
        color: "var(--text)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {blocking
          ? "macOS is blocking the agent from controlling your cursor"
          : "macOS permissions incomplete"}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-soft)", lineHeight: 1.5 }}>
        {blocking ? (
          <>
            Without <strong>Accessibility</strong>, mouse moves and clicks issued by the agent
            are silently dropped — the loop looks like it's working in the
            console but nothing happens on screen.
            <br />
            <span style={{ color: "var(--muted)", fontSize: 11.5 }}>
              In dev, look for an entry literally named <code>Electron</code>{" "}
              (not "Ponder Agent" — that only exists in packaged builds). If
              it's not in the list, click "Reveal Electron.app in Finder"
              below and drag it into the Privacy panel via the <kbd>+</kbd>{" "}
              button. Then quit the dev process and relaunch.
            </span>
          </>
        ) : (
          <>Some optional permissions are missing. The agent will still work, but features tied to them won't.</>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {missing.map((m) => (
          <button
            key={m.key}
            onClick={() => void window.agent.openSystemSettings(m.key)}
            className={m.key === "accessibility" ? "primary" : ""}
            style={{ fontSize: 12 }}
          >
            Open {m.label}
          </button>
        ))}
        <button
          onClick={() => void window.agent.revealBinary()}
          style={{ fontSize: 12 }}
          title="Reveal the Electron.app binary in Finder so you can drag it into the Privacy panel"
        >
          Reveal Electron.app in Finder
        </button>
        <button
          onClick={() => void window.agent.reprobePermissions()}
          className="ghost"
          style={{ fontSize: 12 }}
        >
          Re-check
        </button>
      </div>
    </div>
  );
}

function ProviderSwitcher({ state }: { state: AgentState | null }) {
  const active = state?.provider ?? "hcompany";
  const warmup = state?.warmup ?? "cold";
  const error = state?.errorMessage;

  const swap = (name: ProviderName) => {
    if (name === active) return;
    void window.agent.setProvider(name);
  };

  const order: ProviderName[] = ["hcompany", "remote", "local"];

  return (
    <div style={{ padding: "0 16px 12px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 4,
          padding: 4,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          boxShadow: "var(--shadow-1)",
        }}
        role="tablist"
        aria-label="Provider"
      >
        {order.map((p) => {
          const isActive = p === active;
          return (
            <button
              key={p}
              role="tab"
              aria-selected={isActive}
              onClick={() => swap(p)}
              title={PROVIDER_HINTS[p]}
              style={{
                padding: "6px 0",
                border: "none",
                borderRadius: 999,
                background: isActive ? "var(--accent)" : "transparent",
                color: isActive ? "#fff" : "var(--text-soft)",
                fontWeight: isActive ? 600 : 500,
                fontSize: 11.5,
                letterSpacing: 0.3,
                cursor: isActive ? "default" : "pointer",
                boxShadow: isActive ? "var(--shadow-1)" : "none",
                transition:
                  "background 120ms var(--ease), color 120ms var(--ease)",
              }}
            >
              {PROVIDER_LABELS[p]}
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          padding: "0 6px",
          fontSize: 10.5,
          color: warmup === "error" ? "var(--bad)" : "var(--muted)",
          minHeight: 14,
        }}
      >
        <WarmupDot state={warmup} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {warmup === "error"
            ? error ?? "error"
            : warmup === "warming"
              ? "warming up…"
              : warmup === "ready"
                ? "ready"
                : "cold"}
        </span>
      </div>
    </div>
  );
}

function WarmupDot({ state }: { state: AgentState["warmup"] }) {
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
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
        animation: state === "warming" ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
      aria-hidden
    />
  );
}

function Welcome() {
  return (
    <div style={{ maxWidth: 720, margin: "8vh auto 0" }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background:
            "linear-gradient(135deg, var(--accent), var(--accent-2))",
          boxShadow: "var(--shadow-2)",
          marginBottom: 16,
        }}
      />
      <h1
        style={{
          margin: 0,
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        Welcome to Ponder Agent
      </h1>
      <p style={{ color: "var(--muted)", marginTop: 6 }}>
        Press{" "}
        <kbd
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            padding: "1px 8px",
            background: "var(--bg-elev)",
            borderRadius: 4,
            border: "1px solid var(--border)",
          }}
        >
          ⌘E
        </kbd>{" "}
        anywhere to summon the cursor companion. Tell it what to do —
        screenshots, plans, clicks, and outcomes will land in this window in
        real time.
      </p>

      <div
        style={{
          marginTop: 28,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        {[
          [
            "Open Safari and search for Modal cold start",
            "Bookmark a tab",
          ],
          [
            "Upload a photo from my WeTransfer folder to Google Drive",
            "Cross-app file move",
          ],
          [
            "Open System Preferences and turn on Night Shift",
            "OS settings",
          ],
          [
            "Find the Q3 budget PDF in Documents and email it to dad",
            "Multi-step",
          ],
        ].map(([prompt, label], i) => (
          <div
            key={i}
            style={{
              padding: 14,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              boxShadow: "var(--shadow-1)",
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                color: "var(--muted-2)",
                marginBottom: 6,
              }}
            >
              {label}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-soft)" }}>
              {prompt}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: SessionRow["status"] }) {
  const color =
    status === "done"
      ? "var(--good)"
      : status === "running" || status === "pending"
        ? "var(--warn)"
        : status === "error"
          ? "var(--bad)"
          : "var(--muted)";
  return (
    <span
      style={{
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color,
      }}
    >
      {status}
    </span>
  );
}

function Detail({ sessionId }: { sessionId: Id<"sessions"> }) {
  const session = useQuery(api.sessions.get, { sessionId });
  const steps = useQuery(api.steps.listBySession, { sessionId });

  if (!session) return null;

  return (
    <div style={{ maxWidth: 880 }}>
      <div className="meta">
        <span>{new Date(session.createdAt).toLocaleString()}</span>
        <span style={{ color: "var(--muted-2)", padding: "0 6px" }}>·</span>
        <span>{session.provider}</span>
        <span style={{ color: "var(--muted-2)", padding: "0 6px" }}>·</span>
        <StatusPill status={session.status} />
      </div>
      <h1>{session.prompt}</h1>

      <div
        style={{
          marginTop: 16,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-1)",
          overflow: "hidden",
        }}
      >
        {(steps ?? []).map((s: any) => (
          <StepRow key={s._id} step={s} />
        ))}
        {!steps?.length && (
          <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>
            No steps yet — agent loop is starting…
          </div>
        )}
      </div>

      {/* Retry / continue bar — pinned under the step list. Mirrors the
          Buddy input pill: type a new prompt + Enter to fire, or hit Retry
          to re-run the same prompt without retyping. */}
      <RetryBar
        prompt={session.prompt}
        status={session.status}
      />
    </div>
  );
}

function RetryBar({
  prompt,
  status,
}: {
  prompt: string;
  status: SessionRow["status"];
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const isRunning = status === "pending" || status === "running";
  // Shared with Buddy via localStorage (same origin) — entries pushed here
  // appear when the user hits ⌘E + ArrowUp on the buddy pill, and vice versa.
  const taskHistory = useTaskHistory();

  const fire = async (taskText: string) => {
    if (!taskText.trim() || busy) return;
    setBusy(true);
    try {
      const r = await window.agent.runTask(taskText);
      if (!r.ok) console.error("[app] runTask:", r.error);
    } finally {
      setBusy(false);
      setText("");
      // Push regardless of ok/error so a typo'd prompt is still recallable.
      taskHistory.push(taskText);
    }
  };

  return (
    <div
      style={{
        marginTop: 16,
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: 10,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <button
        onClick={() => void fire(prompt)}
        disabled={busy || isRunning}
        title={`Retry: ${prompt}`}
        style={{ flexShrink: 0 }}
      >
        {busy ? "Sending…" : "↻ Retry"}
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void fire(text);
            return;
          }
          // ↑/↓ recalls earlier prompts (this window's + Buddy's, shared
          // via localStorage). Hook is a no-op for any other key.
          taskHistory.onKeyDown(e, text, setText);
        }}
        placeholder={
          isRunning
            ? "Agent is running… (cancel from tray)"
            : "Continue — what next? (↑↓ to recall)"
        }
        disabled={isRunning || busy}
        style={{ flex: 1 }}
      />
      <button
        className="primary"
        onClick={() => void fire(text)}
        disabled={!text.trim() || busy || isRunning}
      >
        Send
      </button>
      {isRunning && (
        <button
          onClick={() => void window.agent.cancel()}
          style={{ flexShrink: 0 }}
          title="Stop the running agent"
        >
          ⏹ Stop
        </button>
      )}
    </div>
  );
}

function StepRow({
  step,
}: {
  step: {
    _id: string;
    kind: string;
    text?: string;
    coords?: { x: number; y: number };
    action?: { type: string; payload: Record<string, unknown> };
    screenshotId?: Id<"_storage">;
    index: number;
  };
}) {
  const url = useQuery(
    api.steps.getStorageUrl,
    step.screenshotId ? { storageId: step.screenshotId } : "skip",
  );

  const palette: Record<string, string> = {
    thought: "var(--text)",
    ground: "var(--accent)",
    action: "var(--good)",
    error: "var(--bad)",
    status: "var(--muted)",
    screenshot: "var(--muted)",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "40px 88px 1fr",
        alignItems: "start",
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          color: "var(--muted-2)",
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
        }}
      >
        {String(step.index).padStart(2, "0")}
      </div>
      <div
        style={{
          color: palette[step.kind] ?? "var(--muted)",
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          fontWeight: 500,
        }}
      >
        {step.kind}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-soft)" }}>
        {step.kind === "thought" && step.text}
        {step.kind === "status" && step.text}
        {step.kind === "error" && step.text}
        {step.kind === "ground" && step.coords && (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            ({step.coords.x}, {step.coords.y})
          </span>
        )}
        {step.kind === "action" && step.action && (
          <code
            style={{
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              background: "rgba(15, 17, 22, 0.04)",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {step.action.type}({truncate(JSON.stringify(step.action.payload), 80)})
          </code>
        )}
        {step.kind === "screenshot" && url && (
          <img
            src={url}
            alt=""
            style={{
              maxWidth: 420,
              borderRadius: 6,
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-1)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function relTime(t: number): string {
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return new Date(t).toLocaleDateString();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Automations tab ────────────────────────────────────────────────────
//
// Surfaces every saved recipe under ~/.ponder/recipes/ as a row list on
// the left with a detail pane on the right. The .recipe.ts file is the
// editable artifact; "Open" pops it in $EDITOR via shell.openPath.
//
// Data path: window.agent.listRecipes (one-shot index) + window.agent.
// getRecipe(id) (full manifest). Both go through electron/main.ts IPC
// handlers → src/agent/recorder.ts (listRecipes / loadRecipe), so the
// renderer sees the same recipes the CLI / MCP do.

type RecipeListEntry = {
  id: string;
  task: string;
  startedAt: string;
  steps: number;
  outcome?: string;
  durationMs?: number;
  recipePath: string;
  jsonPath: string;
};

type RecipeDetail = {
  task: string;
  startedAt: string;
  durationMs?: number;
  outcome?: string;
  surface?: string;
  provider?: string;
  steps: Array<{
    t: number;
    intent?: string;
    executed: { type: string; payload: Record<string, unknown> };
    url?: string;
  }>;
};

function RecipesView(): JSX.Element {
  const [entries, setEntries] = useState<RecipeListEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const list = (await (window as unknown as {
        agent: { listRecipes(): Promise<RecipeListEntry[]> };
      }).agent.listRecipes()) ?? [];
      setEntries(list);
      if (!selectedId && list.length > 0) setSelectedId(list[0]!.id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Refresh on focus — when the user records a new recipe from MCP or
    // the CLI and tabs back, the list catches up without a manual click.
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      const d = await (window as unknown as {
        agent: { getRecipe(id: string): Promise<RecipeDetail | null> };
      }).agent.getRecipe(selectedId);
      setDetail(d);
    })();
  }, [selectedId]);

  const filtered = (entries ?? []).filter((e) =>
    query
      ? e.task.toLowerCase().includes(query.toLowerCase()) ||
        e.id.toLowerCase().includes(query.toLowerCase())
      : true,
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* Left: search + list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search automations"
          style={{
            padding: "8px 12px",
            fontSize: 13,
            border: "1px solid var(--border)",
            borderRadius: "var(--r-sm)",
            background: "var(--bg-elev)",
            color: "var(--text)",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {entries === null && (
            <div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>
              Loading…
            </div>
          )}
          {entries !== null && filtered.length === 0 && (
            <div
              style={{
                margin: "4px 0",
                padding: 14,
                border: "1px dashed var(--border-strong)",
                borderRadius: "var(--r-md)",
                color: "var(--muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {entries.length === 0
                ? "No automations yet. Drive a flow via MCP (browser_*, screen_*, agent_do) and call ponder_recipe_save. The recipe lands at ~/.ponder/recipes/ and appears here."
                : "No automations match the search."}
            </div>
          )}
          {filtered.map((e) => (
            <button
              key={e.id}
              className={`session-row ${selectedId === e.id ? "active" : ""}`}
              onClick={() => setSelectedId(e.id)}
              style={{ textAlign: "left" }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {e.task}
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "var(--muted)",
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <span>{relTime(Date.parse(e.startedAt))}</span>
                <span style={{ color: "var(--muted-2)" }}>·</span>
                <span>
                  {e.steps} step{e.steps === 1 ? "" : "s"}
                </span>
                {e.durationMs !== undefined && (
                  <>
                    <span style={{ color: "var(--muted-2)" }}>·</span>
                    <span>{(e.durationMs / 1000).toFixed(1)}s</span>
                  </>
                )}
                <span style={{ flex: 1 }} />
                {e.outcome && <StatusPill status={e.outcome as never} />}
              </div>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {entries
            ? `${entries.length} automation${entries.length === 1 ? "" : "s"} · refresh on window focus`
            : ""}
          {loading && entries && " · refreshing"}
        </div>
      </div>

      {/* Right: detail */}
      <div>
        {selectedId && detail ? (
          <RecipeDetailView id={selectedId} detail={detail} />
        ) : selectedId && !detail ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: 16 }}>
            Loading recipe…
          </div>
        ) : (
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--r-md)",
              color: "var(--muted)",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            Pick an automation on the left to see its steps and code.
          </div>
        )}
      </div>
    </div>
  );
}

function RecipeDetailView({
  id,
  detail,
}: {
  id: string;
  detail: RecipeDetail;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)" }}>
          {detail.task}
        </div>
        <div
          style={{
            marginTop: 6,
            display: "flex",
            gap: 10,
            color: "var(--muted)",
            fontSize: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span>{new Date(detail.startedAt).toLocaleString()}</span>
          <span style={{ color: "var(--muted-2)" }}>·</span>
          <span>
            {detail.steps.length} step{detail.steps.length === 1 ? "" : "s"}
          </span>
          {detail.durationMs !== undefined && (
            <>
              <span style={{ color: "var(--muted-2)" }}>·</span>
              <span>{(detail.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
          {detail.provider && (
            <>
              <span style={{ color: "var(--muted-2)" }}>·</span>
              <span>{detail.provider}</span>
            </>
          )}
          {detail.surface && (
            <>
              <span style={{ color: "var(--muted-2)" }}>·</span>
              <span>{detail.surface}</span>
            </>
          )}
          {detail.outcome && <StatusPill status={detail.outcome as never} />}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--muted-2)",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          id: {id}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            void (window as unknown as {
              agent: { revealRecipe(id: string): Promise<unknown> };
            }).agent.revealRecipe(id);
          }}
          style={pillBtn(false)}
        >
          Open .recipe.ts
        </button>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(
              `ponder run ${id}`,
            );
          }}
          style={pillBtn(false)}
        >
          Copy `ponder run`
        </button>
      </div>

      {/* Steps */}
      <div>
        <div
          style={{
            fontSize: 12,
            color: "var(--muted)",
            margin: "10px 0 6px",
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          Steps
        </div>
        {detail.steps.length === 0 && (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--r-md)",
              color: "var(--muted)",
              fontSize: 12,
            }}
          >
            (no recorded steps)
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            background: "var(--bg-elev)",
            padding: 10,
          }}
        >
          {detail.steps.map((s, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "40px 110px 1fr",
                alignItems: "start",
                gap: 10,
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                {i + 1}.
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--accent)",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {s.executed.type}
              </div>
              <div style={{ fontSize: 12, color: "var(--text)" }}>
                {s.intent ?? truncate(JSON.stringify(s.executed.payload), 120)}
                {s.url && (
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 10.5,
                      color: "var(--muted)",
                    }}
                  >
                    {s.url}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function pillBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 12.5,
    fontWeight: 500,
    color: active ? "var(--text)" : "var(--text-soft)",
    background: active ? "var(--bg)" : "var(--bg-elev)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    cursor: "pointer",
  };
}
