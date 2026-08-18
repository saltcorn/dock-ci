import { isRerunnable, type RunRecord, type RunStatus } from "./history.ts";

/**
 * State of a single step in a pipeline run. `pending` is a step that has not
 * finished yet: it appears in the incremental report a server writes as soon as
 * a run starts, and is replaced by a terminal state once the step settles.
 */
export type StepStatus = "success" | "failure" | "skipped" | "pending";

/** The captured result of one step, used to build the HTML report. */
export interface StepReport {
  name: string;
  /** Whether the step is a long-running service. */
  service: boolean;
  status: StepStatus;
  /** Wall-clock time the step took, in milliseconds. */
  durationMs: number;
  /** Combined stdout/stderr captured while the step ran. */
  output: string;
}

export interface ReportMeta {
  /** Whether the overall pipeline passed. */
  ok: boolean;
  /** Config file the run came from, shown in the heading. */
  configFile?: string;
  /** Timestamp of the run; defaults to now. */
  generatedAt?: Date;
}

const STATUS_LABEL: Record<StepStatus, string> = {
  success: "passed",
  failure: "failed",
  skipped: "skipped",
  pending: "pending",
};

/** Render a complete, self-contained HTML report document. */
export function renderReport(steps: StepReport[], meta: ReportMeta): string {
  const generatedAt = meta.generatedAt ?? new Date();
  const heading = meta.configFile
    ? `dockerci report — ${escapeHtml(meta.configFile)}`
    : "dockerci report";
  const plural = steps.length === 1 ? "" : "s";
  const pending = steps.filter((s) => s.status === "pending").length;
  const failed = steps.filter((s) => s.status === "failure").length;
  // A report with any pending step is a run still in progress: show how far it
  // has got rather than a (premature) pass/fail verdict.
  const running = pending > 0;
  const headerClass = running ? "running" : meta.ok ? "ok" : "fail";
  const summary = running
    ? `Running · ${steps.length - pending} of ${steps.length} step${plural} done`
    : meta.ok
    ? `Passed · ${steps.length} step${plural}`
    : `Failed · ${failed} of ${steps.length} step${plural} failed`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="${headerClass}">
  <h1>${heading}</h1>
  <p class="summary">${summary}</p>
  <p class="meta">Generated ${escapeHtml(generatedAt.toISOString())}</p>
</header>
<main>
${steps.map(renderStep).join("\n")}
</main>
</body>
</html>
`;
}

function renderStep(step: StepReport): string {
  const output = step.output.length > 0
    ? escapeHtml(step.output)
    : "<em>(no output)</em>";
  const serviceTag = step.service ? `<span class="tag">service</span>` : "";
  // A pending step has not run, so it has no meaningful duration yet.
  const duration = step.status === "pending"
    ? "…"
    : formatDuration(step.durationMs);
  return `  <details class="step ${step.status}">
    <summary>
      <span class="badge ${step.status}">${STATUS_LABEL[step.status]}</span>
      <span class="name">${escapeHtml(step.name)}</span>
      ${serviceTag}
      <span class="duration">${duration}</span>
    </summary>
    <pre>${output}</pre>
  </details>`;
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: "pending",
  running: "running",
  success: "passed",
  failure: "failed",
  error: "error",
};

/** CSS badge class for a run's status, reusing the step badge palette. */
const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  pending: "pending",
  running: "running",
  success: "success",
  failure: "failure",
  error: "failure",
};

/** Who is viewing the dashboard, which decides whether it offers reruns. */
export interface DashboardOptions {
  /**
   * The logged-in operator's name, when the request carried a valid session
   * cookie. Only a logged-in viewer is offered the rerun button.
   */
  user?: string;
  /**
   * Whether logging in is possible at all — false when no `ADMIN_PASSWORD` is
   * configured, in which case the page does not advertise a `/login` link that
   * could never succeed.
   */
  loginEnabled?: boolean;
}

/**
 * Render the server's front page: a table of recent runs (queued and running
 * ones included), newest first, each showing its branch, start date and outcome
 * and linking to the stored HTML report when one exists. A logged-in operator also
 * gets a **rerun** button on every failed run, which posts back to
 * `/runs/<id>/rerun` to queue the same commit again.
 */
export function renderDashboard(
  runs: RunRecord[],
  options: DashboardOptions = {},
): string {
  // The rerun column exists only for a logged-in viewer; everyone else sees
  // exactly the read-only dashboard as before.
  const canRerun = options.user !== undefined;
  const rows = runs.map((run) => renderRunRow(run, canRerun)).join("\n");
  const body = runs.length === 0
    ? `<p class="empty">No runs recorded yet.</p>`
    : `<table>
  <thead><tr><th>Status</th><th>Branch</th><th>Date</th><th>Duration</th><th>Report</th>${
      canRerun ? "<th>Rerun</th>" : ""
    }</tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whale-ci — recent runs</title>
<style>${STYLE}${DASHBOARD_STYLE}</style>
</head>
<body>
<header class="ok">
  <h1>whale-ci — recent runs</h1>
  <p class="meta">${renderSession(options)}</p>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The header's one-line account status: who is logged in, or how to log in. */
function renderSession(options: DashboardOptions): string {
  if (options.user !== undefined) {
    return `Signed in as ${escapeHtml(options.user)}`;
  }
  return options.loginEnabled === true
    ? `<a href="/login">Log in</a> to rerun failed runs`
    : `Read-only: no ADMIN_PASSWORD is configured`;
}

function renderRunRow(run: RunRecord, canRerun: boolean): string {
  const branch = run.branch !== undefined
    ? escapeHtml(run.branch)
    : `<span class="muted">—</span>`;
  const commit = run.commit !== undefined
    ? ` <span class="muted">${escapeHtml(run.commit.slice(0, 12))}</span>`
    : "";
  // A queued run has not started, so it has no elapsed time to show yet; a
  // running one has, but no total until it finishes.
  const duration = run.status === "pending"
    ? `<span class="muted">—</span>`
    : run.finishedAt !== undefined
    ? formatDuration(run.finishedAt.getTime() - run.startedAt.getTime())
    : "…";
  const report = run.hasReport
    ? `<a href="/runs/${run.id}">report</a>`
    : `<span class="muted">—</span>`;
  // A plain form post, so the button works without any JavaScript; the session
  // cookie it carries is SameSite=Strict, which is what keeps another site from
  // posting it on the operator's behalf.
  const rerun = !canRerun ? "" : isRerunnable(run)
    ? `\n      <td><form method="post" action="/runs/${run.id}/rerun"><button type="submit">rerun</button></form></td>`
    : `\n      <td><span class="muted">—</span></td>`;
  return `    <tr>
      <td><span class="badge ${RUN_STATUS_CLASS[run.status]}">${
    RUN_STATUS_LABEL[run.status]
  }</span></td>
      <td>${branch}${commit}</td>
      <td>${escapeHtml(formatDate(run.startedAt))}</td>
      <td>${duration}</td>
      <td>${report}</td>${rerun}
    </tr>`;
}

/** Compact UTC timestamp for the dashboard, e.g. `2026-06-12 09:31 UTC`. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Human-readable duration, e.g. `840 ms`, `2.4 s`, `1 m 05 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} m ${String(rest).padStart(2, "0")} s`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const STYLE = `
:root {
  --ok: #1a7f37;
  --fail: #cf222e;
  --skip: #9a6700;
  --run: #1f6feb;
  --bg: #0d1117;
  --panel: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
header {
  padding: 2rem 1.5rem 1.25rem;
  border-bottom: 1px solid var(--border);
  border-top: 4px solid var(--ok);
}
header.fail { border-top-color: var(--fail); }
header.running { border-top-color: var(--run); }
h1 { margin: 0 0 .5rem; font-size: 1.25rem; word-break: break-all; }
.summary { margin: 0; font-weight: 600; }
header.ok .summary { color: var(--ok); }
header.fail .summary { color: var(--fail); }
header.running .summary { color: var(--run); }
.meta { margin: .25rem 0 0; color: var(--muted); font-size: .85rem; }
main { max-width: 60rem; margin: 0 auto; padding: 1rem 1.5rem 3rem; }
.step {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  margin-bottom: .6rem;
  overflow: hidden;
}
summary {
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: .7rem .9rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: "▶";
  color: var(--muted);
  font-size: .7rem;
  transition: transform .15s ease;
}
.step[open] summary::before { transform: rotate(90deg); }
.name { font-weight: 600; }
.duration { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.badge {
  font-size: .72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .03em;
  padding: .15rem .5rem;
  border-radius: 999px;
  color: #fff;
}
.badge.success { background: var(--ok); }
.badge.failure { background: var(--fail); }
.badge.skipped { background: var(--skip); }
.badge.pending { background: var(--muted); }
.tag {
  font-size: .72rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: .1rem .5rem;
}
pre {
  margin: 0;
  padding: .9rem 1rem;
  border-top: 1px solid var(--border);
  background: #010409;
  color: #d1d7e0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .82rem;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
`;

const DASHBOARD_STYLE = `
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
td { font-variant-numeric: tabular-nums; }
a { color: #58a6ff; }
.muted { color: var(--muted); }
.empty { color: var(--muted); }
.badge.running { background: #1f6feb; }
form { margin: 0; }
button {
  font: inherit;
  font-size: .8rem;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: .2rem .7rem;
  cursor: pointer;
}
button:hover { border-color: #58a6ff; color: #58a6ff; }
header .meta a { color: #58a6ff; }
`;
