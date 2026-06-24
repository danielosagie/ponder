/**
 * Anorha — the Ollama-style panel on the holo3-agent engine.
 *
 * Tabs (top row): Run · History · Automations, plus a Settings gear.
 *   - Run        → task input, live working narration, answer, Save-as-automation
 *   - History    → past sessions (Convex) with their steps
 *   - Automations→ saved recipes: replay (re-grounds, fast) + open .recipe.ts
 *   - Settings   → selling-channel sign-in + macOS permissions + brain
 * First launch shows a 3-card onboarding (persisted in localStorage).
 *
 * Everything runs through the EXISTING engine IPC (window.agent.*) on the
 * selected provider (default: the H Company API). No from-scratch loop.
 */
import { useState, useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useTaskHistory } from "../shared/taskHistory";

type ProviderName = "remote" | "local" | "hcompany";
type AgentState = {
  warmup: "cold" | "warming" | "ready" | "error";
  provider: ProviderName;
  activeSessionId: string | null;
  errorMessage?: string;
};
type PermStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
type PermissionsReport = {
  platform: string;
  accessibility: PermStatus;
  screenRecording: PermStatus;
  inputMonitoring: PermStatus;
};
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
type SessionRow = {
  _id: Id<"sessions">;
  prompt: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  provider: ProviderName;
  createdAt: number;
  endedAt?: number;
};
type View = "run" | "history" | "automations" | "settings";

const PROVIDER_ORDER: ProviderName[] = ["hcompany", "remote", "local"];
const PROVIDER_LABELS: Record<ProviderName, string> = { remote: "Modal", hcompany: "API", local: "Local" };
const PROVIDER_HINTS: Record<ProviderName, string> = {
  hcompany: "Hosted H Company API — fast, the default",
  remote: "Self-hosted Holo 3.1 on Modal — cold starts can be slow",
  local: "Ollama on this machine",
};

// Selling channels for sign-in. Auth lives in the user's real browser session,
// which the agent reuses. Connected state is local (no backend channel store yet).
const CHANNELS: Array<{ id: string; name: string; url: string; hint: string }> = [
  { id: "facebook", name: "Facebook Marketplace", url: "https://www.facebook.com/marketplace/you/selling", hint: "List & manage local sales" },
  { id: "ebay", name: "eBay", url: "https://www.ebay.com/sl/sell", hint: "Auctions & fixed-price" },
  { id: "poshmark", name: "Poshmark", url: "https://poshmark.com/feed", hint: "Fashion & accessories" },
  { id: "mercari", name: "Mercari", url: "https://www.mercari.com/sell/", hint: "General marketplace" },
  { id: "google", name: "Google", url: "https://accounts.google.com/", hint: "Sheets, Drive, Gmail" },
];

export function App() {
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [perms, setPerms] = useState<PermissionsReport | null>(null);
  const [liveLine, setLiveLine] = useState("");
  const [answer, setAnswer] = useState("");
  const [pendingTask, setPendingTask] = useState("");
  const [recipes, setRecipes] = useState<RecipeListEntry[] | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [view, setView] = useState<View>("run");
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem("anorha_onboarded") === "1");
  const [toast, setToast] = useState("");
  const mainScrollRef = useRef<HTMLDivElement>(null);

  // The main pane is one persistent scroll container, so its scrollTop survives
  // view switches — switching tabs would otherwise land you mid-page. Reset to
  // top whenever the view changes. (Detail open/close is handled per-view.)
  useEffect(() => { mainScrollRef.current?.scrollTo({ top: 0 }); }, [view]);

  useEffect(() => {
    let mounted = true;
    void window.agent.getState().then((s: AgentState) => mounted && setAgentState(s));
    const unsub = window.agent.onState((s: AgentState) => mounted && setAgentState(s));
    return () => { mounted = false; unsub(); };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const r = await window.agent.reprobePermissions();
      if (mounted) setPerms(r as PermissionsReport);
    };
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { mounted = false; window.removeEventListener("focus", onFocus); };
  }, []);

  useEffect(() => {
    const unsub = window.buddy.onSay((p) => {
      if (p.kind === "answer") { setAnswer(p.text); setLiveLine(""); }
      else if (p.kind === "error") setLiveLine(p.text);
      else if (p.kind !== "thought") setLiveLine(p.text);
    });
    return unsub;
  }, []);

  const refreshRecipes = async () => {
    const list = await window.agent.listRecipes().catch(() => []);
    setRecipes(list as RecipeListEntry[]);
  };
  useEffect(() => {
    void refreshRecipes();
    const onFocus = () => void refreshRecipes();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const flashToast = (t: string) => { setToast(t); setTimeout(() => setToast(""), 2600); };

  const working = !!agentState?.activeSessionId || replaying !== null;
  const provider = agentState?.provider ?? "hcompany";
  const warmup = agentState?.warmup ?? "cold";
  const permsMissing = perms?.platform === "darwin" && perms.accessibility !== "granted";

  const run = (task: string) => {
    if (!task.trim()) return;
    setPendingTask(task);
    setAnswer("");
    setLiveLine("Starting…");
    setView("run");
    void window.agent.runTask(task).then((r: { ok: boolean; error?: string }) => {
      if (!r.ok) setLiveLine(r.error ?? "couldn't start");
    });
  };

  const replay = (r: RecipeListEntry) => {
    setReplaying(r.task);
    setAnswer("");
    setLiveLine("Replaying…");
    setView("run");
    void window.agent.replayRecipe(r.id, { reground: true }).then((res: { ok: boolean; failed?: number; healed?: number; error?: string }) => {
      setReplaying(null);
      if (!res.ok) setLiveLine(res.error ?? "replay failed");
      else {
        const healed = res.healed ? ` · adapted ${res.healed} changed step(s)` : "";
        setAnswer((res.failed ? `Replay stopped — ${res.failed} step(s) failed` : "Replayed cleanly") + healed);
      }
    });
  };

  const saveAutomation = async () => {
    const res = await window.agent.saveLastAsRecipe(pendingTask);
    if (res.ok) { flashToast("Saved as automation"); void refreshRecipes(); }
    else flashToast(res.error ?? "couldn't save");
  };

  if (!onboarded) {
    return (
      <div className="anorha-root">
        <PanelStyles />
        <div className="panel">
          <Onboarding onDone={() => { localStorage.setItem("anorha_onboarded", "1"); setOnboarded(true); }} />
        </div>
      </div>
    );
  }

  const newTask = () => { setView("run"); setAnswer(""); setPendingTask(""); setReplaying(null); setLiveLine(""); };

  return (
    <div className="anorha-root">
      <PanelStyles />
      <div className="panel">
        <div className="topdrag" />
        <aside className="sidebar">
          <div className="side-brand">
            <span className="mark" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M5 19c0-7 6-13 14-13 0 8-6 13-14 13z" fill="#fff" />
                <path d="M5 19c3-5 7-8 11-9" stroke="#3B6D11" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {working && <span className="markdot" />}
            </span>
            <span className="brand">Anorha</span>
          </div>

          <button className="side-new" onClick={newTask}>
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            New task
          </button>

          <nav className="side-nav">
            <NavItem id="run" label="Run" view={view} setView={setView} working={working} />
            <NavItem id="history" label="History" view={view} setView={setView} />
            <NavItem id="automations" label="Automations" view={view} setView={setView} badge={recipes?.length ?? 0} />
          </nav>

          <span className="side-grow" />

          <div className="side-foot">
            <ProviderChip active={provider} warmup={warmup} />
            <NavItem id="settings" label="Settings" view={view} setView={setView} />
          </div>
        </aside>

        <main className="main">
          <div className="main-scroll" ref={mainScrollRef}>
            {view === "settings" ? (
              <div className="page"><Settings perms={perms} provider={provider} /></div>
            ) : view === "history" ? (
              <div className="page"><History onRun={run} onToast={flashToast} onRefreshRecipes={refreshRecipes} /></div>
            ) : view === "automations" ? (
              <Automations recipes={recipes} onReplay={replay} onRefresh={refreshRecipes} />
            ) : permsMissing ? (
              <div className="page"><Connect perms={perms} /></div>
            ) : working ? (
              <div className="page"><Working sessionId={(agentState?.activeSessionId ?? null) as Id<"sessions"> | null} live={liveLine} task={replaying ?? pendingTask} /></div>
            ) : (
              <RunIdle
                answer={answer}
                warmupHint={warmup === "warming" ? `Warming up ${PROVIDER_LABELS[provider]}…` : ""}
                canSave={!!answer && !!pendingTask && !replaying}
                onRun={run}
                onSave={saveAutomation}
              />
            )}
          </div>
        </main>

        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}

// ── Run / Idle ───────────────────────────────────────────────────────────────
function RunIdle({
  answer, warmupHint, canSave, onRun, onSave,
}: {
  answer: string; warmupHint: string; canSave: boolean;
  onRun: (t: string) => void; onSave: () => void;
}) {
  const [text, setText] = useState("");
  const history = useTaskHistory();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const fire = () => { const v = text.trim(); if (!v) return; history.push(v); onRun(v); setText(""); };

  const examples = [
    "List my Facebook Marketplace items in a Google Sheet",
    "Cross-post my newest listing to eBay",
    "Check Marketplace messages and summarize offers",
  ];

  // After a run completes, show the result in a clean page (not the hero).
  if (answer) {
    const tbl = parseTable(answer);
    return (
      <div className="page">
        <div className="page-h">Result</div>
        <div className={tbl ? "answer-table" : "answer"}>
          {tbl ? <DataTable table={tbl} /> : answer}
          {canSave && <button className="save-auto" onClick={onSave}>Save as automation</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="run-hero">
      <h1 className="run-title">What do you want done?</h1>
      <div className="composer">
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); fire(); return; } history.onKeyDown(e, text, setText); }}
          placeholder="Describe a task — Anorha drives your Mac + Chrome to do it…"
        />
        <div className="composer-bar">
          <span className="comp-hint">{warmupHint || "Press Enter to run · Shift+Enter for a new line"}</span>
          <span className="grow" />
          <button className="comp-send" onClick={fire} aria-label="Run" disabled={!text.trim()}>
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5M6 11l6-6 6 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <div className="run-suggest">
        {examples.map((ex) => (
          <button key={ex} className="suggest-chip" onClick={() => onRun(ex)}>
            <svg viewBox="0 0 24 24" fill="none" className="sc-ic"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Working ──────────────────────────────────────────────────────────────────
function Working({ sessionId, live, task }: { sessionId: Id<"sessions"> | null; live: string; task: string }) {
  const steps = useQuery(api.steps.listBySession, sessionId ? { sessionId } : "skip") as
    | Array<{ _id: string; kind: string; text?: string; index: number }> | undefined;
  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip") as { prompt: string } | null | undefined;
  const newest = steps && steps.length ? steps[steps.length - 1] : undefined;
  const now = live || (newest ? newest.text ?? newest.kind : "Looking at the page…");
  const sub = task || session?.prompt || "";
  const count = steps?.length ?? 0;
  return (
    <>
      <div className="live">
        <span className="spinner" />
        <div className="live-main">
          <div className="now">{now}</div>
          {sub && <div className="sub">{sub}</div>}
        </div>
        <button className="stop" onClick={() => void window.agent.cancel()} title="Stop">
          <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></svg>
        </button>
      </div>
      <div className="pmeta">{count > 0 ? `step ${count}` : "starting…"}</div>
      {(steps ?? []).slice(-8).reverse().map((s) => (
        <div className="logline" key={s._id}>
          <span className={`lk ${s.kind}`}>{s.kind}</span>
          <span className="lt">{s.text ?? s.kind}</span>
        </div>
      ))}
    </>
  );
}

// ── History (Convex sessions) ────────────────────────────────────────────────
type HistoryProps = { onRun: (t: string) => void; onToast: (t: string) => void; onRefreshRecipes: () => void };

function History({ onRun, onToast, onRefreshRecipes }: HistoryProps) {
  const sessions = useQuery(api.sessions.list, { limit: 50 }) as SessionRow[] | undefined;
  const [openId, setOpenId] = useState<Id<"sessions"> | null>(null);
  useEffect(() => { document.querySelector(".main-scroll")?.scrollTo({ top: 0 }); }, [openId]);
  if (openId) return <HistoryDetail sessionId={openId} onBack={() => setOpenId(null)} onRun={onRun} onToast={onToast} onRefreshRecipes={onRefreshRecipes} />;
  return (
    <>
      <div className="page-h">History</div>
      {sessions === undefined && <div className="muted-row">Loading history…</div>}
      {sessions !== undefined && sessions.length === 0 && (
        <div className="empty">No runs yet. Anything you run from the Run tab shows up here with its full step-by-step log.</div>
      )}
      {(sessions ?? []).map((s) => (
        <button className="hrow" key={s._id} onClick={() => setOpenId(s._id)}>
          <div className="hrow-main">
            <div className="ttl">{s.prompt}</div>
            <div className="meta">{relTime(s.createdAt)} · {s.provider}</div>
          </div>
          <span className={`badge ${s.status}`}>{s.status}</span>
        </button>
      ))}
    </>
  );
}

// One screenshot step → resolves its Convex storage id to a URL on its own.
function StepShot({ storageId }: { storageId: Id<"_storage"> }) {
  const url = useQuery(api.steps.getStorageUrl, { storageId }) as string | null | undefined;
  if (!url) return <div className="shot shot-ph" />;
  return (
    <a className="shot" href={url} target="_blank" rel="noreferrer" title="Open full screenshot">
      <img src={url} alt="step screenshot" loading="lazy" />
    </a>
  );
}

function HistoryDetail({
  sessionId, onBack, onRun, onToast, onRefreshRecipes,
}: { sessionId: Id<"sessions">; onBack: () => void } & HistoryProps) {
  const session = useQuery(api.sessions.get, { sessionId }) as
    | { prompt: string; status: string; provider: string; createdAt: number } | null | undefined;
  const steps = useQuery(api.steps.listBySession, { sessionId }) as
    | Array<{ _id: string; kind: string; text?: string; index: number; action?: { type: string }; screenshotId?: Id<"_storage"> }> | undefined;
  const [followUp, setFollowUp] = useState("");
  const [saving, setSaving] = useState(false);

  const shots = (steps ?? []).filter((s) => s.kind === "screenshot" && s.screenshotId);
  const logSteps = (steps ?? []).filter((s) => s.kind !== "screenshot");

  const runAgain = () => { if (session) onRun(session.prompt); };
  const saveAuto = async () => {
    setSaving(true);
    const res = await window.agent.saveSessionAsRecipe(sessionId, session?.prompt);
    setSaving(false);
    if (res.ok) { onToast("Saved as automation"); onRefreshRecipes(); }
    else onToast(res.error ?? "couldn't save");
  };
  const sendFollowUp = () => { const v = followUp.trim(); if (!v) return; onRun(v); setFollowUp(""); };

  return (
    <>
      <div className="detail-top">
        <Breadcrumb root="History" current={session?.prompt ?? "Run"} onBack={onBack} />
        <span className="grow" />
        <button className="mini" onClick={saveAuto} disabled={saving}>{saving ? "Saving…" : "Save as automation"}</button>
        <button className="run-now" onClick={runAgain} title="Run this task again">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          Run again
        </button>
      </div>
      {session && (
        <>
          <div className="detail-h">{session.prompt}</div>
          <div className="detail-meta">{new Date(session.createdAt).toLocaleString()} · {session.provider} · <span className={`badge ${session.status}`}>{session.status}</span></div>
        </>
      )}

      {shots.length > 0 && (
        <>
          <div className="sect">Screens ({shots.length})</div>
          <div className="shotstrip">
            {shots.map((s) => <StepShot key={s._id} storageId={s.screenshotId as Id<"_storage">} />)}
          </div>
        </>
      )}

      <div className="sect">Steps</div>
      {logSteps.length === 0 && <div className="muted-row">No steps recorded.</div>}
      {logSteps.map((s) => (
        <div className="logline" key={s._id}>
          <span className={`lk ${s.kind}`}>{s.kind}</span>
          <span className="lt">{s.text ?? s.action?.type ?? s.kind}</span>
        </div>
      ))}

      <div className="sect">Follow-up</div>
      <div className="composer compact">
        <textarea
          value={followUp}
          rows={1}
          onChange={(e) => setFollowUp(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFollowUp(); } }}
          placeholder="Refine or ask a follow-up — runs as a new task…"
        />
        <div className="composer-bar">
          <span className="comp-hint">Runs a fresh task on Anorha</span>
          <span className="grow" />
          <button className="comp-send" onClick={sendFollowUp} aria-label="Run" disabled={!followUp.trim()}>
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5M6 11l6-6 6 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </>
  );
}

// ── Automations (recipes) ────────────────────────────────────────────────────
function Automations({
  recipes, onReplay, onRefresh,
}: {
  recipes: RecipeListEntry[] | null;
  onReplay: (r: RecipeListEntry) => void;
  onRefresh: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { document.querySelector(".main-scroll")?.scrollTo({ top: 0 }); }, [openId]);
  const open = openId ? (recipes ?? []).find((r) => r.id === openId) ?? null : null;
  if (openId && open) return <AutomationDetail entry={open} onBack={() => setOpenId(null)} onReplay={onReplay} />;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-h">Automations</div>
        <button className="mini" onClick={onRefresh}>Refresh</button>
      </div>
      {recipes === null && <div className="muted-row">Loading…</div>}
      {recipes !== null && recipes.length === 0 && (
        <div className="empty">No automations yet. Run a task on the Run tab, then hit <b>Save as automation</b> on the result — it replays here in a fraction of the time, and self-heals when the site changes.</div>
      )}
      {recipes !== null && recipes.length > 0 && <div className="sect">Saved automations</div>}
      {(recipes ?? []).map((r) => (
        <button className="arow" key={r.id} onClick={() => setOpenId(r.id)}>
          <span className="ic">
            <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="M8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </span>
          <div className="row-main">
            <div className="ttl">{r.task}</div>
            <div className="meta">{r.steps} step{r.steps === 1 ? "" : "s"}{r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}</div>
          </div>
          <span className="arow-go" aria-hidden>›</span>
        </button>
      ))}
    </div>
  );
}

// ── Breadcrumb (detail back nav) ──────────────────────────────────────────────
function Breadcrumb({ root, current, onBack }: { root: string; current: string; onBack: () => void }) {
  return (
    <div className="crumb">
      <button className="crumb-root" onClick={onBack}>{root}</button>
      <span className="crumb-sep" aria-hidden>›</span>
      <span className="crumb-cur">{current}</span>
    </div>
  );
}

// ── Automation detail (editor-style: steps + metadata panel) ──────────────────
type RecipeDetail = {
  task: string; startedAt: string; durationMs?: number; outcome?: string; surface?: string; provider?: string;
  steps: Array<{ t: number; intent?: string; executed: { type: string; payload: Record<string, unknown> }; url?: string }>;
};

function AutomationDetail({
  entry, onBack, onReplay,
}: {
  entry: RecipeListEntry;
  onBack: () => void;
  onReplay: (r: RecipeListEntry) => void;
}) {
  const [detail, setDetail] = useState<RecipeDetail | null | "loading">("loading");
  useEffect(() => {
    let alive = true;
    void window.agent.getRecipe(entry.id).then((d) => { if (alive) setDetail((d as RecipeDetail | null) ?? null); });
    return () => { alive = false; };
  }, [entry.id]);

  const host = (u?: string) => { if (!u) return ""; try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
  const steps = detail && detail !== "loading" ? detail.steps : [];
  const dur = entry.durationMs ?? (detail && detail !== "loading" ? detail.durationMs : undefined);
  const provider = (detail && detail !== "loading" && detail.provider) || "—";
  const outcome = (detail && detail !== "loading" && detail.outcome) || "saved";

  return (
    <>
      <div className="detail-top">
        <Breadcrumb root="Automations" current={entry.task} onBack={onBack} />
        <span className="grow" />
        <button className="run-now" onClick={() => onReplay(entry)} title="Replay this automation now">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          Run now
        </button>
      </div>
      <div className="detail-2col">
        <div className="detail-main">
          <h1 className="detail-h">{entry.task}</h1>
          <div className="sect">Steps</div>
          {detail === "loading" && <div className="muted-row">Loading steps…</div>}
          {detail !== "loading" && steps.length === 0 && <div className="muted-row">No recorded steps.</div>}
          {steps.map((s, i) => (
            <div className="rstep" key={i}>
              <span className="rstep-n">{i + 1}</span>
              <div className="rstep-body">
                <div className="rstep-intent">{s.intent ?? s.executed.type.replace(/_/g, " ")}</div>
                <div className="rstep-meta">
                  <span className="rstep-tag">{s.executed.type.replace(/_/g, " ")}</span>
                  {s.url && <span className="rstep-url">{host(s.url)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <aside className="detail-side">
          <div className="side-sect">Status</div>
          <div className="meta-row"><span className="meta-k">Outcome</span><span className={`pill ${outcome === "done" ? "ok" : ""}`}>{outcome}</span></div>
          <div className="meta-row"><span className="meta-k">Last ran</span><span className="meta-v">{entry.startedAt ? new Date(entry.startedAt).toLocaleDateString() : "—"}</span></div>
          <div className="side-sect">Details</div>
          <div className="meta-row"><span className="meta-k">Steps</span><span className="meta-v">{entry.steps}</span></div>
          <div className="meta-row"><span className="meta-k">Duration</span><span className="meta-v">{dur !== undefined ? `${(dur / 1000).toFixed(1)}s` : "—"}</span></div>
          <div className="meta-row"><span className="meta-k">Brain</span><span className="meta-v">{provider}</span></div>
          <div className="meta-row"><span className="meta-k">Replay</span><span className="meta-v">re-grounded</span></div>
          <button className="mini detail-reveal" onClick={() => void window.agent.revealRecipe(entry.id)}>Reveal .recipe.ts in Finder</button>
        </aside>
      </div>
    </>
  );
}

// ── Engine toggle (local composite loop vs server-side AGP brain) ─────────────
function EngineToggle() {
  const [engine, setEngine] = useState<"composite" | "agp" | null>(null);
  useEffect(() => {
    let alive = true;
    void window.agent.getEngine().then((e) => {
      if (alive) setEngine(e);
    });
    return () => {
      alive = false;
    };
  }, []);
  const pick = (e: "composite" | "agp") => {
    setEngine(e);
    void window.agent.setEngine(e);
  };
  return (
    <div className="crow">
      <div className="crow-main">
        <div className="ttl">Engine</div>
        <div className="meta">
          {engine === "agp"
            ? "Server brain — fast Holo 3.1, Chrome tasks only (needs an attached tab)"
            : "Local loop — drives your Mac + Chrome"}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className={engine !== "agp" ? "mini primary" : "mini"}
          onClick={() => pick("composite")}
        >
          Local
        </button>
        <button
          className={engine === "agp" ? "mini primary" : "mini"}
          onClick={() => pick("agp")}
        >
          Server
        </button>
      </div>
    </div>
  );
}

// ── Settings (channel auth + perms + brain) ──────────────────────────────────
function Settings({
  perms, provider,
}: {
  perms: PermissionsReport | null;
  provider: ProviderName;
}) {
  const [connected, setConnected] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("anorha_channels") || "{}"); } catch { return {}; }
  });
  const setChan = (id: string, val: boolean) => {
    const next = { ...connected, [id]: val };
    setConnected(next);
    localStorage.setItem("anorha_channels", JSON.stringify(next));
  };
  const accessOk = perms?.platform !== "darwin" || perms.accessibility === "granted";
  const screenOk = perms?.platform !== "darwin" || perms.screenRecording === "granted";
  return (
    <>
      <div className="page-h">Settings</div>
      <div className="sect">Selling channels</div>
      <p className="settings-note">Sign in once in your browser — Anorha reuses that session to act for you. Connection status is local.</p>
      {CHANNELS.map((c) => (
        <div className="crow" key={c.id}>
          <div className="crow-main">
            <div className="ttl">{c.name}</div>
            <div className="meta">{c.hint}</div>
          </div>
          {connected[c.id] ? (
            <>
              <span className="conn">● connected</span>
              <button className="mini" onClick={() => setChan(c.id, false)}>Reset</button>
            </>
          ) : (
            <button className="mini primary" onClick={() => { void window.agent.openChannel(c.url); setChan(c.id, true); }}>Sign in</button>
          )}
        </div>
      ))}

      <div className="sect">Mac control</div>
      <div className="crow">
        <div className="crow-main"><div className="ttl">Accessibility</div><div className="meta">Required — lets Anorha click & type</div></div>
        {accessOk ? <span className="conn">● granted</span> : <button className="mini primary" onClick={() => void window.agent.openSystemSettings("accessibility")}>Grant</button>}
      </div>
      <div className="crow">
        <div className="crow-main"><div className="ttl">Screen Recording</div><div className="meta">Lets Anorha see the screen</div></div>
        {screenOk ? <span className="conn">● granted</span> : <button className="mini primary" onClick={() => void window.agent.openSystemSettings("screen")}>Grant</button>}
      </div>
      <button className="mini" style={{ margin: "8px 6px" }} onClick={() => void window.agent.reprobePermissions()}>Re-check permissions</button>

      <div className="sect">Brain</div>
      <EngineToggle />
      <AutoReplayToggle />
      <div className="crow">
        <div className="crow-main"><div className="ttl">{PROVIDER_LABELS[provider]}</div><div className="meta">Grounder for the Local engine · {PROVIDER_HINTS[provider]}</div></div>
        <span className="conn">● active</span>
      </div>
    </>
  );
}

// ── Connect (perms gate) ─────────────────────────────────────────────────────
function Connect({ perms }: { perms: PermissionsReport | null }) {
  return (
    <div className="intro">
      <h2>Give Anorha control of your Mac</h2>
      <p>Anorha drives your real apps and Chrome to do the work. macOS needs <b>Accessibility</b> (and Screen Recording) granted once — without it, clicks are silently dropped.</p>
      <button className="cta" onClick={() => void window.agent.openSystemSettings("accessibility")}>Open Accessibility settings</button>
      <div className="cta-row">
        <button className="ghost" onClick={() => void window.agent.openSystemSettings("screen")}>Screen Recording</button>
        <button className="ghost" onClick={() => void window.agent.revealBinary()}>Reveal app in Finder</button>
        <button className="ghost" onClick={() => void window.agent.reprobePermissions()}>Re-check</button>
      </div>
      {perms && <p className="fine">Accessibility: {perms.accessibility} · Screen: {perms.screenRecording}</p>}
    </div>
  );
}

// ── Onboarding (first run) ───────────────────────────────────────────────────
function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const slides = [
    { t: "Meet Anorha", b: "Tell it what you want sold — it drives your real apps and Chrome to make it happen, in the background, on the fast Holo 3.1 brain." },
    { t: "It learns your flows", b: "Every run is recorded. Save the good ones as Automations and replay them in a fraction of the time — no thinking required the second time." },
    { t: "Connect your channels", b: "Sign in once to Facebook Marketplace, eBay, Poshmark and more in Settings. Anorha reuses your browser session to act for you." },
  ];
  const last = i === slides.length - 1;
  return (
    <div className="onb">
      <span className="mark big" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 19c0-7 6-13 14-13 0 8-6 13-14 13z" fill="#fff" /><path d="M5 19c3-5 7-8 11-9" stroke="#3B6D11" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
      <h2>{slides[i].t}</h2>
      <p>{slides[i].b}</p>
      <div className="dots">{slides.map((_, n) => <span key={n} className={n === i ? "on" : ""} />)}</div>
      <button className="cta" onClick={() => (last ? onDone() : setI(i + 1))}>{last ? "Get started" : "Next"}</button>
      {!last && <button className="skip" onClick={onDone}>Skip</button>}
    </div>
  );
}

// ── Provider chip ─────────────────────────────────────────────────────────────
function ProviderChip({ active, warmup }: { active: ProviderName; warmup: AgentState["warmup"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="prov-wrap">
      <button className="prov" onClick={() => setOpen((o) => !o)} title={PROVIDER_HINTS[active]}>
        <span className={`pdot ${warmup}`} />{PROVIDER_LABELS[active]} ▾
      </button>
      {open && (
        <div className="prov-menu" onMouseLeave={() => setOpen(false)}>
          {PROVIDER_ORDER.map((p) => (
            <button key={p} className={p === active ? "active" : ""} onClick={() => { if (p !== active) void window.agent.setProvider(p); setOpen(false); }}>
              {PROVIDER_LABELS[p]}<span className="phint">{PROVIDER_HINTS[p]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function relTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(t).toLocaleDateString();
}

// ── Sidebar nav item (icon + label, left-aligned) ────────────────────────────
function NavIcon({ id }: { id: View }) {
  if (id === "run")
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" />
      </svg>
    );
  if (id === "history")
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (id === "automations")
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M19.4 13a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 1.6 1.6 0 01-3.2 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 004.6 13a1.6 1.6 0 01-1.6-1.6 1.6 1.6 0 011.6-1.6 1.6 1.6 0 001.5-1.1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H12a1.6 1.6 0 001-1.5 1.6 1.6 0 013.2 0 1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function NavItem({
  id, label, view, setView, working, badge,
}: {
  id: View; label: string; view: View; setView: (v: View) => void; working?: boolean; badge?: number;
}) {
  return (
    <button
      className={`navitem ${view === id ? "on" : ""}`}
      aria-current={view === id ? "page" : undefined}
      onClick={() => setView(id)}
    >
      <span className="navitem-ic"><NavIcon id={id} /></span>
      <span className="navitem-tx">{label}</span>
      {id === "run" && working && <span className="navitem-dot" />}
      {!!badge && badge > 0 && <span className="navitem-badge">{badge}</span>}
    </button>
  );
}

// ── Auto-replay toggle (recipe-first) ────────────────────────────────────────
function AutoReplayToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void window.agent.getAutoReplay().then((v) => alive && setOn(v));
    return () => { alive = false; };
  }, []);
  const toggle = () => { const next = !on; setOn(next); void window.agent.setAutoReplay(next); };
  return (
    <div className="crow">
      <div className="crow-main">
        <div className="ttl">Auto-replay automations</div>
        <div className="meta">Replay a saved automation when the task matches one (it self-heals). Start with "fresh …" to force a new run.</div>
      </div>
      <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={!!on} onClick={toggle} title="Auto-replay">
        <span className="knob" />
      </button>
    </div>
  );
}

// ── Tabular-answer detection + live data table ───────────────────────────────
type Table = { headers: string[]; rows: string[][] };

/** Detect a table inside an answer: JSON {headers,rows}, a markdown table, or TSV. */
function parseTable(text: string): Table | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as { headers?: unknown; rows?: unknown };
      if (Array.isArray(o.rows) && o.rows.length) {
        const rows = (o.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)]));
        const headers =
          Array.isArray(o.headers) && o.headers.length
            ? (o.headers as unknown[]).map(String)
            : rows[0]!.map((_, i) => `col${i + 1}`);
        return { headers, rows };
      }
    } catch { /* not JSON */ }
  }
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  // Markdown table — skip the |---| separator row.
  if (lines.length >= 2 && lines[0]!.includes("|")) {
    const cells = (l: string): string[] => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const isSep = (l: string): boolean => l.includes("-") && /^\|?[\s:|-]+\|?$/.test(l);
    const body = lines.filter((l) => !isSep(l));
    if (body.length >= 2 && body.every((l) => l.includes("|"))) {
      const headers = cells(body[0]!);
      const rows = body.slice(1).map(cells);
      if (headers.length >= 2 && rows.every((r) => r.length === headers.length)) return { headers, rows };
    }
  }
  // TSV.
  if (lines.length >= 2 && lines.every((l) => l.includes("\t"))) {
    const headers = lines[0]!.split("\t");
    const rows = lines.slice(1).map((l) => l.split("\t"));
    if (headers.length >= 2 && rows.every((r) => r.length === headers.length)) return { headers, rows };
  }
  return null;
}

function DataTable({ table }: { table: Table }) {
  const [copied, setCopied] = useState(false);
  const tsv = [table.headers, ...table.rows].map((r) => r.join("\t")).join("\n");
  const csv = [table.headers, ...table.rows]
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");
  const copyTsv = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  };
  const downloadCsv = (): void => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "export.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="dtable">
      <div className="dtable-head">
        <span className="dtable-count">
          {table.rows.length} row{table.rows.length === 1 ? "" : "s"} · {table.headers.length} cols
        </span>
        <span className="grow" />
        <button className="mini" onClick={() => void copyTsv()}>{copied ? "Copied" : "Copy for Sheets"}</button>
        <button className="mini" onClick={downloadCsv}>CSV</button>
      </div>
      <div className="dtable-scroll">
        <table>
          <thead>
            <tr>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 200).map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > 200 && (
        <div className="dtable-more">+{table.rows.length - 200} more rows (included in Copy / CSV)</div>
      )}
    </div>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .anorha-root { height: 100%; display: flex; box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui; }
      .anorha-root, .anorha-root * { letter-spacing: -0.005em; }
      .panel { flex: 1; display: flex; flex-direction: row; min-width: 0; position: relative;
        --olive: #7BB304; --olive-d: #5E8E3E; --ink: #131418; --soft: #2c2e36;
        --muted: #6c6f78; --muted2: #9aa0aa; --good: #2bb673; --bad: #d8434f; --bg2: #fff;
        --side: 248px; }
      .mark { width: 24px; height: 24px; border-radius: 7px; display: flex; align-items: center; justify-content: center; position: relative;
        background: linear-gradient(135deg, var(--olive), #9bd31f); box-shadow: 0 1px 2px rgba(15,17,22,.12); flex-shrink: 0; border: none; padding: 0; cursor: pointer; }
      .mark svg { width: 14px; height: 14px; }
      .markdot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--olive); border: 1.5px solid var(--bg2); animation: anpulse 1.5s infinite; }
      .grow { flex: 1; }
      .mark.big { width: 46px; height: 46px; border-radius: 13px; margin-bottom: 14px; } .mark.big svg { width: 26px; height: 26px; }
      .brand { font-size: 14.5px; font-weight: 600; color: var(--ink); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted2); flex-shrink: 0; }
      .dot.ready { background: var(--good); } .dot.work { background: var(--olive); animation: anpulse 1.5s infinite; }
      @keyframes anpulse { 0% { box-shadow: 0 0 0 0 rgba(123,179,4,.45);} 70% { box-shadow: 0 0 0 6px rgba(123,179,4,0);} 100% { box-shadow:0 0 0 0 rgba(123,179,4,0);} }
      .answer { margin: 10px 2px 2px; padding: 11px 13px; border-radius: 12px; font-size: 13px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; background: rgba(43,182,115,.08); border: 1px solid rgba(43,182,115,.25); }
      .save-auto { display: block; margin-top: 10px; padding: 7px 12px; border: 1px solid rgba(123,179,4,.4); background: rgba(123,179,4,.10); color: var(--olive-d); border-radius: 9px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
      .save-auto:hover { background: var(--olive); color: #fff; }
      .sect { font-size: 10.5px; text-transform: uppercase; letter-spacing: .7px; color: var(--muted2); padding: 14px 6px 6px; font-weight: 600; }
      .sect-row { display: flex; align-items: center; justify-content: space-between; padding-right: 6px; }
      .row { display: flex; align-items: center; gap: 9px; padding: 9px 8px; border-radius: 11px; }
      .row:hover { background: rgba(15,17,22,.045); }
      .row .ic { width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(123,179,4,.10); color: var(--olive-d); } .row .ic svg { width: 15px; height: 15px; }
      .row-main { flex: 1; min-width: 0; }
      .ttl { font-size: 13.5px; font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .meta { font-size: 11px; color: var(--muted2); margin-top: 1px; }
      .play { width: 28px; height: 28px; border-radius: 8px; border: none; flex-shrink: 0; cursor: pointer; background: rgba(123,179,4,.12); color: var(--olive-d); display: inline-flex; align-items: center; justify-content: center; } .play:hover { background: var(--olive); color: #fff; } .play svg { width: 13px; height: 13px; }
      .mini { flex-shrink: 0; padding: 5px 10px; border: 1px solid rgba(15,17,22,.12); background: var(--bg2); color: var(--soft); border-radius: 8px; font-size: 11.5px; font-weight: 500; cursor: pointer; }
      .mini:hover { border-color: var(--muted); } .mini.primary { background: var(--olive); color: #fff; border-color: var(--olive); }
      .empty, .muted-row { margin: 4px 4px; padding: 12px; border-radius: 11px; font-size: 12px; line-height: 1.5; color: var(--muted); border: 1px dashed rgba(15,17,22,.14); }
      .muted-row { border: none; padding: 10px 8px; }
      .live { display: flex; align-items: center; gap: 11px; margin: 2px; padding: 13px 14px; border-radius: 14px; background: rgba(123,179,4,.07); border: 1px solid rgba(123,179,4,.22); }
      .spinner { width: 15px; height: 15px; border: 2px solid rgba(123,179,4,.25); border-top-color: var(--olive); border-radius: 50%; animation: anspin .8s linear infinite; flex-shrink: 0; } @keyframes anspin { to { transform: rotate(360deg); } }
      .live-main { flex: 1; min-width: 0; } .live .now { font-size: 13.5px; font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live .sub { font-size: 11.5px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .stop { width: 30px; height: 30px; border-radius: 9px; border: 1px solid rgba(15,17,22,.10); background: var(--bg2); color: var(--bad); cursor: pointer; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; } .stop svg { width: 14px; height: 14px; }
      .pmeta { font-size: 11px; color: var(--muted2); padding: 8px 8px 4px; }
      .logline { display: flex; gap: 8px; align-items: baseline; padding: 5px 8px; font-size: 12px; }
      .lk { font-size: 9.5px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; flex-shrink: 0; width: 56px; color: var(--muted2); }
      .lk.thought { color: var(--ink); } .lk.action { color: var(--good); } .lk.ground { color: var(--olive-d); } .lk.error { color: var(--bad); }
      .lt { color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hrow { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 10px 8px; border: none; background: transparent; border-radius: 11px; cursor: pointer; }
      .hrow:hover { background: rgba(15,17,22,.045); } .hrow-main { flex: 1; min-width: 0; }
      .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; padding: 2px 7px; border-radius: 999px; flex-shrink: 0; color: var(--muted); background: rgba(15,17,22,.06); }
      .badge.done { color: var(--good); background: rgba(43,182,115,.12); } .badge.error { color: var(--bad); background: rgba(216,67,79,.12); }
      .badge.running, .badge.pending { color: var(--olive-d); background: rgba(123,179,4,.14); }
      .back { margin: 2px 0 8px; padding: 4px 8px; border: none; background: transparent; color: var(--muted); font-size: 12.5px; cursor: pointer; } .back:hover { color: var(--ink); }
      .detail-task { font-size: 14px; font-weight: 600; color: var(--ink); padding: 0 6px; }
      .detail-meta { font-size: 11px; color: var(--muted2); padding: 4px 6px 0; }
      .crow { display: flex; align-items: center; gap: 9px; padding: 10px 8px; border-radius: 11px; }
      .crow:hover { background: rgba(15,17,22,.03); } .crow-main { flex: 1; min-width: 0; }
      .conn { font-size: 11.5px; color: var(--good); font-weight: 500; flex-shrink: 0; }
      .settings-note { font-size: 11.5px; color: var(--muted); padding: 0 6px 4px; line-height: 1.45; }
      .intro { padding: 6px; } .intro h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--ink); }
      .intro p { font-size: 12.5px; color: var(--muted); margin: 8px 0 0; line-height: 1.55; }
      .cta { width: 100%; height: 42px; margin-top: 16px; border: none; border-radius: 13px; background: var(--olive); color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer; }
      .cta-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .ghost { flex: 1; height: 34px; border: 1px solid rgba(15,17,22,.12); background: var(--bg2); color: var(--soft); border-radius: 10px; font-size: 12px; cursor: pointer; }
      .fine { font-size: 11px; color: var(--muted2); margin-top: 10px; }
      .onb { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; }
      .onb h2 { font-size: 19px; font-weight: 600; color: var(--ink); margin: 0; } .onb p { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 10px 0 0; max-width: 300px; }
      .dots { display: flex; gap: 6px; margin: 20px 0 4px; } .dots span { width: 6px; height: 6px; border-radius: 50%; background: rgba(15,17,22,.15); } .dots span.on { background: var(--olive); width: 18px; border-radius: 3px; }
      .onb .cta { width: 240px; } .skip { margin-top: 8px; border: none; background: transparent; color: var(--muted2); font-size: 12px; cursor: pointer; }
      .foot { display: flex; align-items: center; gap: 6px; padding: 8px 10px 2px; font-size: 10.5px; color: var(--muted2); }
      .toast { position: absolute; bottom: 44px; left: 50%; transform: translateX(-50%); background: var(--ink); color: #fff; font-size: 12px; padding: 8px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(15,17,22,.25); white-space: nowrap; }
      .prov-wrap { position: relative; }
      .prov { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); padding: 4px 8px; border-radius: 999px; border: 1px solid rgba(15,17,22,.10); background: var(--bg2); cursor: pointer; }
      .pdot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted2); } .pdot.ready { background: var(--good); } .pdot.warming { background: #d39329; } .pdot.error { background: var(--bad); }
      .prov-menu { position: absolute; right: 0; top: 28px; z-index: 10; min-width: 210px; padding: 5px; background: var(--bg2); border: 1px solid rgba(15,17,22,.12); border-radius: 11px; box-shadow: 0 12px 32px rgba(15,17,22,.18); }
      .prov-menu button { display: block; width: 100%; text-align: left; padding: 7px 9px; border: none; background: transparent; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--ink); }
      .prov-menu button:hover { background: rgba(123,179,4,.10); } .prov-menu button.active { color: var(--olive-d); font-weight: 600; }
      .prov-menu .phint { display: block; font-size: 10.5px; font-weight: 400; color: var(--muted2); margin-top: 1px; }
      /* warm cream backdrop (calm, Granola-ish) — white cards sit on top */
      .anorha-root { background: #FAF8F3; }
      /* toggle switch (engine / auto-replay) */
      .switch { width: 38px; height: 22px; border-radius: 999px; border: none; padding: 0; background: rgba(15,17,22,.16); position: relative; cursor: pointer; flex-shrink: 0; transition: background .15s ease; }
      .switch.on { background: var(--olive); }
      .switch .knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(15,17,22,.28); transition: transform .15s ease; }
      .switch.on .knob { transform: translateX(16px); }
      /* live data table (extract results) */
      .answer-table { margin: 10px 2px 2px; }
      .dtable { border: 1px solid rgba(15,17,22,.10); border-radius: 12px; overflow: hidden; background: var(--bg2); box-shadow: 0 1px 3px rgba(15,17,22,.05); }
      .dtable-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 11px; border-bottom: 1px solid rgba(15,17,22,.08); background: rgba(15,17,22,.02); }
      .dtable-count { font-size: 11px; color: var(--muted2); font-weight: 500; }
      .dtable-head .grow { flex: 1; }
      .dtable-scroll { max-height: 280px; overflow: auto; }
      .dtable table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .dtable th { position: sticky; top: 0; z-index: 1; background: var(--bg2); text-align: left; font-weight: 600; color: var(--ink); padding: 7px 11px; border-bottom: 1px solid rgba(15,17,22,.12); white-space: nowrap; }
      .dtable td { padding: 6px 11px; color: var(--soft); border-bottom: 1px solid rgba(15,17,22,.05); vertical-align: top; }
      .dtable tbody tr:last-child td { border-bottom: none; }
      .dtable tbody tr:hover { background: rgba(123,179,4,.05); }
      .dtable-more { font-size: 11px; color: var(--muted2); padding: 7px 11px; border-top: 1px solid rgba(15,17,22,.06); }
      /* ── Codex-style shell: left sidebar + white main pane ─────────────── */
      .topdrag { position: absolute; top: 0; left: 0; right: 0; height: 30px; -webkit-app-region: drag; z-index: 5; }
      .sidebar { width: var(--side); flex-shrink: 0; display: flex; flex-direction: column; padding: 34px 10px 10px; box-sizing: border-box; }
      .side-brand { display: flex; align-items: center; gap: 9px; padding: 2px 8px 14px; }
      .side-brand .mark { width: 26px; height: 26px; } .side-brand .mark svg { width: 15px; height: 15px; }
      .side-brand .brand { font-size: 15px; font-weight: 650; color: var(--ink); }
      .side-new { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 11px; margin: 0 0 14px; border: 1px solid rgba(15,17,22,.10); background: var(--bg2); color: var(--ink); border-radius: 11px; font-size: 13px; font-weight: 550; cursor: pointer; box-shadow: 0 1px 2px rgba(15,17,22,.04); transition: border-color .12s ease, color .12s ease; }
      .side-new:hover { border-color: var(--olive); color: var(--olive-d); }
      .side-new svg { width: 16px; height: 16px; color: var(--olive-d); flex-shrink: 0; }
      .side-nav { display: flex; flex-direction: column; gap: 2px; }
      .navitem { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 11px; border: none; background: transparent; border-radius: 10px; color: var(--muted); cursor: pointer; position: relative; text-align: left; transition: background .12s ease, color .12s ease; }
      .navitem:hover { background: rgba(15,17,22,.05); color: var(--ink); }
      .navitem.on { background: rgba(123,179,4,.12); color: var(--olive-d); }
      .navitem-ic { display: inline-flex; flex-shrink: 0; } .navitem-ic svg { width: 17px; height: 17px; display: block; }
      .navitem-tx { font-size: 13px; font-weight: 500; flex: 1; } .navitem.on .navitem-tx { font-weight: 600; }
      .navitem-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--olive); animation: anpulse 1.5s infinite; flex-shrink: 0; }
      .navitem-badge { font-size: 10.5px; font-weight: 600; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: rgba(15,17,22,.07); color: var(--muted); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .navitem.on .navitem-badge { background: rgba(123,179,4,.18); color: var(--olive-d); }
      .side-grow { flex: 1; }
      .side-foot { display: flex; flex-direction: column; gap: 2px; padding-top: 8px; }
      .side-foot .prov-wrap { padding: 0 1px 4px; }
      .side-foot .prov { width: 100%; justify-content: flex-start; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; }
      .side-foot .prov-menu { top: auto; bottom: 34px; left: 0; right: auto; min-width: 210px; }
      .main { flex: 1; min-width: 0; background: var(--bg2); border-top-left-radius: 14px; border-bottom-left-radius: 14px; box-shadow: -1px 0 0 rgba(15,17,22,.06); display: flex; flex-direction: column; }
      .main-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 38px 34px 28px; box-sizing: border-box; }
      .page { max-width: 720px; margin: 0 auto; }
      .page-h { max-width: 720px; margin: 0 auto 16px; font-size: 26px; font-weight: 650; color: var(--ink); letter-spacing: -.02em; }
      /* run hero (centered) */
      .run-hero { min-height: 72vh; display: flex; flex-direction: column; align-items: center; justify-content: center; max-width: 660px; margin: 0 auto; }
      .run-title { font-size: 30px; font-weight: 650; color: var(--ink); letter-spacing: -.02em; text-align: center; margin: 0 0 22px; }
      .composer { width: 100%; border: 1px solid rgba(15,17,22,.12); background: var(--bg2); border-radius: 18px; padding: 14px 16px 10px; box-shadow: 0 4px 18px rgba(15,17,22,.06); transition: border-color .12s ease, box-shadow .12s ease; }
      .composer:focus-within { border-color: var(--olive); box-shadow: 0 0 0 3px rgba(123,179,4,.14), 0 4px 18px rgba(15,17,22,.06); }
      .composer textarea { width: 100%; border: none; outline: none; resize: none; background: transparent; font: inherit; font-size: 15px; line-height: 1.5; color: var(--ink); min-height: 26px; max-height: 200px; display: block; }
      .composer textarea::placeholder { color: var(--muted2); }
      .composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .comp-hint { font-size: 11.5px; color: var(--muted2); }
      .comp-send { width: 34px; height: 34px; border-radius: 11px; border: none; background: var(--olive); color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .12s ease, opacity .12s ease; }
      .comp-send:hover { background: var(--olive-d); } .comp-send:disabled { opacity: .4; cursor: default; } .comp-send svg { width: 17px; height: 17px; }
      .run-suggest { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 20px; }
      .suggest-chip { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 12px 14px; border: 1px solid rgba(15,17,22,.08); background: var(--bg2); color: var(--soft); border-radius: 12px; font-size: 13.5px; cursor: pointer; transition: border-color .12s ease, color .12s ease; }
      .suggest-chip:hover { border-color: var(--olive); color: var(--ink); }
      .suggest-chip .sc-ic { width: 13px; height: 13px; color: var(--olive-d); flex-shrink: 0; }
      /* page header row (title + action) */
      .page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .page-head .page-h { margin-bottom: 6px; }
      /* clickable automation row */
      .arow { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 12px 12px; border: 1px solid rgba(15,17,22,.07); background: var(--bg2); border-radius: 12px; cursor: pointer; margin-bottom: 8px; transition: border-color .12s ease, box-shadow .12s ease; }
      .arow:hover { border-color: rgba(123,179,4,.5); box-shadow: 0 1px 3px rgba(15,17,22,.06); }
      .arow .ic { width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(123,179,4,.10); color: var(--olive-d); } .arow .ic svg { width: 16px; height: 16px; }
      .arow-go { color: var(--muted2); font-size: 20px; line-height: 1; flex-shrink: 0; }
      /* breadcrumb + detail header */
      .crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; min-width: 0; }
      .crumb-root { border: none; background: transparent; color: var(--olive-d); font-size: 13px; font-weight: 500; cursor: pointer; padding: 2px 0; }
      .crumb-root:hover { text-decoration: underline; }
      .crumb-sep { color: var(--muted2); }
      .crumb-cur { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
      .detail-top { display: flex; align-items: center; gap: 10px; max-width: 920px; margin: 0 auto 6px; }
      .detail-h { font-size: 24px; font-weight: 650; color: var(--ink); letter-spacing: -.02em; margin: 8px 0 2px; }
      .run-now { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border: none; border-radius: 10px; background: var(--ink); color: #fff; font-size: 12.5px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
      .run-now:hover { background: #000; } .run-now svg { width: 13px; height: 13px; color: var(--olive); }
      /* two-column detail (steps + meta panel) */
      .detail-2col { display: flex; gap: 30px; max-width: 920px; margin: 0 auto; align-items: flex-start; }
      .detail-main { flex: 1; min-width: 0; }
      .detail-side { width: 250px; flex-shrink: 0; }
      .side-sect { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted2); font-weight: 600; padding: 16px 0 8px; }
      .meta-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(15,17,22,.05); font-size: 12.5px; }
      .meta-k { color: var(--muted); } .meta-v { color: var(--ink); font-weight: 500; }
      .pill { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: rgba(15,17,22,.06); color: var(--muted); }
      .pill.ok { background: rgba(43,182,115,.14); color: var(--good); }
      .detail-reveal { margin-top: 16px; width: 100%; }
      /* recipe steps (editor-style list) */
      .rstep { display: flex; gap: 11px; padding: 9px 2px; border-bottom: 1px solid rgba(15,17,22,.05); }
      .rstep-n { width: 22px; height: 22px; flex-shrink: 0; border-radius: 7px; background: rgba(15,17,22,.05); color: var(--muted); font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }
      .rstep-body { min-width: 0; flex: 1; } .rstep-intent { font-size: 13px; color: var(--ink); line-height: 1.4; }
      .rstep-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
      .rstep-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; font-weight: 600; color: var(--olive-d); background: rgba(123,179,4,.12); padding: 1px 6px; border-radius: 5px; }
      .rstep-url { font-size: 11px; color: var(--muted2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* screenshot filmstrip (history) */
      .shotstrip { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 8px; }
      .shot { flex-shrink: 0; width: 168px; height: 105px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(15,17,22,.10); background: rgba(15,17,22,.03); display: block; }
      .shot img { width: 100%; height: 100%; object-fit: cover; object-position: top left; display: block; }
      .shot:hover { border-color: var(--olive); } .shot-ph { animation: anpulse 1.5s infinite; }
      /* compact composer (history follow-up) */
      .composer.compact { padding: 11px 13px 8px; border-radius: 14px; box-shadow: none; }
      .composer.compact textarea { font-size: 13.5px; }
    `}</style>
  );
}
