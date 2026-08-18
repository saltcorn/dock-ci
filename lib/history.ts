import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Lifecycle state of a recorded run. `pending` is a run the server has accepted
 * but not begun — it is waiting in the queue behind the one being tested —
 * and `running` is the one under way; neither has finished yet.
 */
export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "error";

/** One recorded CI run, past or still in flight. */
export interface RunRecord {
  id: number;
  /** Branch the run was for; undefined when unknown (e.g. not a git checkout). */
  branch?: string;
  /** Commit sha the run was for, when known. */
  commit?: string;
  /**
   * `owner/repo` the run's commit statuses were posted to. Only set for runs
   * started by the server from a webhook; a one-shot CLI run has no repository
   * recorded. Together with {@link fetchRef} it is what makes a run repeatable.
   */
  repo?: string;
  /**
   * The ref the commit was fetched from — a branch for a push, or
   * `refs/pull/<n>/head` for a pull request. Recorded so the run can be
   * repeated later: the commit may no longer be reachable by branch name.
   */
  fetchRef?: string;
  status: RunStatus;
  /**
   * When the run entered the history: the moment it was queued while it is
   * still `pending`, and the moment it actually began once it starts running.
   */
  startedAt: Date;
  /** Unset while the run is still in flight. */
  finishedAt?: Date;
  /** Whether a stored HTML report is available via {@link RunStore.report}. */
  hasReport: boolean;
}

/** A run the history remembers enough about to build its commit again. */
export type RerunnableRun = RunRecord & {
  repo: string;
  branch: string;
  commit: string;
  fetchRef: string;
};

/**
 * Whether a run can be started again from the dashboard: it has to have failed
 * (a passing run has nothing to retry, and a queued or running one is already
 * under way),
 * and the history has to remember enough about it to rebuild the same commit —
 * which runs recorded by the one-shot CLI, and runs from before the rerun
 * button existed, do not.
 */
export function isRerunnable(run: RunRecord): run is RerunnableRun {
  return (run.status === "failure" || run.status === "error") &&
    run.repo !== undefined && run.branch !== undefined &&
    run.commit !== undefined && run.fetchRef !== undefined;
}

/**
 * The customary per-user application data directory for whale-ci:
 * `~/Library/Application Support/whale-ci` on macOS and
 * `$XDG_DATA_HOME/whale-ci` (default `~/.local/share/whale-ci`) elsewhere.
 * The parameters default to the real platform/environment; injectable for tests.
 */
export function dataDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "whale-ci");
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "whale-ci");
  }
  return join(home, ".local", "share", "whale-ci");
}

/** Where the run-history database lives by default: `<dataDir>/runs.db`. */
export function defaultDatabasePath(): string {
  return join(dataDir(), "runs.db");
}

/**
 * The run-history operations the server and CLI need; satisfied by
 * {@link RunStore} and fakeable in tests.
 */
export interface RunHistory {
  start(
    run: { branch?: string; commit?: string; repo?: string; fetchRef?: string },
  ): number;
  /**
   * Record a run that has been accepted but not started, returning its id. The
   * server calls this as soon as it queues a commit, so a run waiting behind
   * another shows on the dashboard instead of appearing only once it begins.
   */
  queue(
    run: { branch?: string; commit?: string; repo?: string; fetchRef?: string },
  ): number;
  /**
   * Promote a queued run to `running`, restamping its start time so its
   * recorded duration covers the run itself and not the wait before it.
   */
  begin(id: number): void;
  /**
   * Overwrite a still-running run's stored HTML report, leaving its status and
   * timestamps untouched. A server calls this repeatedly as steps finish so the
   * report served at `/runs/<id>` updates while the run is in flight.
   */
  update(id: number, report: string): void;
  finish(id: number, status: RunStatus, report?: string): void;
  /**
   * Mark every unfinished run — queued or running — as `error`, returning how
   * many were changed. Used on server startup to clear runs orphaned by a
   * previous crash, which would otherwise sit unfinished forever.
   */
  failRunning(): number;
  recent(limit?: number): RunRecord[];
  /** One run by id, or undefined when there is no such run. */
  run(id: number): RunRecord | undefined;
  report(id: number): string | undefined;
}

/**
 * Persistent history of CI runs, backed by an SQLite database (via node's
 * built-in `node:sqlite`). Every run — one-shot CLI runs and webhook-triggered
 * server runs alike — is recorded here: a server run first as `pending` when it
 * is queued and `running` once it begins, a one-shot run as `running` straight
 * away, and both with their final status and HTML report when they finish. Pass
 * `":memory:"` as the path for a throwaway in-memory store (used in tests).
 */
export class RunStore implements RunHistory {
  readonly #db: DatabaseSync;

  constructor(path: string = defaultDatabasePath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT,
        commit_sha TEXT,
        repo TEXT,
        fetch_ref TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        report TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
    `);
    this.#migrate();
  }

  /**
   * Add columns introduced after a database was first created. `repo` and
   * `fetch_ref` came with the rerun button, so a history written by an earlier
   * version has neither; the rows already there stay NULL and are simply not
   * rerunnable.
   */
  #migrate(): void {
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(runs)").all() as Array<
        { name: string }
      >).map((column) => column.name),
    );
    for (const column of ["repo", "fetch_ref"]) {
      if (!existing.has(column)) {
        this.#db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
      }
    }
  }

  /** Record the start of a run, returning its id for the later finish call. */
  start(
    run: { branch?: string; commit?: string; repo?: string; fetchRef?: string },
  ): number {
    return this.#insert(run, "running");
  }

  /** Record a run that is queued but not started, returning its id. */
  queue(
    run: { branch?: string; commit?: string; repo?: string; fetchRef?: string },
  ): number {
    return this.#insert(run, "pending");
  }

  #insert(
    run: { branch?: string; commit?: string; repo?: string; fetchRef?: string },
    status: "pending" | "running",
  ): number {
    const result = this.#db
      .prepare(
        `INSERT INTO runs (branch, commit_sha, repo, fetch_ref, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.branch ?? null,
        run.commit ?? null,
        run.repo ?? null,
        run.fetchRef ?? null,
        status,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Promote a queued run to `running` and restamp its start time, so the
   * duration the dashboard shows is the run itself rather than the run plus
   * however long it sat in the queue. Only a `pending` run is touched: a run
   * that somehow already started or finished keeps the times it has.
   */
  begin(id: number): void {
    this.#db
      .prepare(
        `UPDATE runs SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(Date.now(), id);
  }

  /**
   * Replace a run's stored HTML report without changing its status or finish
   * time. Used to publish the incremental report as each step of an in-flight
   * run completes.
   */
  update(id: number, report: string): void {
    this.#db
      .prepare("UPDATE runs SET report = ? WHERE id = ?")
      .run(report, id);
  }

  /** Record a run's outcome and (when one was produced) its HTML report. */
  finish(id: number, status: RunStatus, report?: string): void {
    this.#db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, report = ? WHERE id = ?",
      )
      .run(status, Date.now(), report ?? null, id);
  }

  /**
   * Mark every unfinished run — one still `pending` in a queue as well as the
   * one that was `running` — as `error`, stamping it with the current time as
   * its finish time. A server calls this at startup to reconcile runs left
   * dangling by a previous crash: the process that owned them is gone, so they
   * can never start or finish and would otherwise sit unfinished indefinitely.
   * Returns the number of runs updated.
   */
  failRunning(): number {
    const result = this.#db
      .prepare(
        `UPDATE runs SET status = 'error', finished_at = ?
         WHERE status IN ('pending', 'running')`,
      )
      .run(Date.now());
    return Number(result.changes);
  }

  /** The columns {@link toRecord} maps, shared by the row queries below. */
  static readonly #COLUMNS =
    `id, branch, commit_sha, repo, fetch_ref, status, started_at, finished_at,
     report IS NOT NULL AS has_report`;

  /**
   * The most recent runs (queued and running ones included), newest first.
   * Ordered by id — the order runs arrived in — rather than by start time,
   * which {@link begin} restamps: ordering by the latter would let a run that
   * has just started jump above the ones queued after it.
   */
  recent(limit = 50): RunRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT ${RunStore.#COLUMNS} FROM runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as RunRow[];
    return rows.map(toRecord);
  }

  /** One run by id, or undefined when no run has that id. */
  run(id: number): RunRecord | undefined {
    const row = this.#db
      .prepare(`SELECT ${RunStore.#COLUMNS} FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** The stored HTML report for a run, or undefined when there is none. */
  report(id: number): string | undefined {
    const row = this.#db
      .prepare("SELECT report FROM runs WHERE id = ?")
      .get(id) as { report: string | null } | undefined;
    return row?.report ?? undefined;
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * One row of the `runs` table, as the queries above select it. A type alias
 * rather than an interface so it stays assignable from node:sqlite's
 * `Record<string, SQLOutputValue>` row type.
 */
type RunRow = {
  id: number;
  branch: string | null;
  commit_sha: string | null;
  repo: string | null;
  fetch_ref: string | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  has_report: number;
};

/** Convert a database row into the {@link RunRecord} callers see. */
function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    branch: row.branch ?? undefined,
    commit: row.commit_sha ?? undefined,
    repo: row.repo ?? undefined,
    fetchRef: row.fetch_ref ?? undefined,
    status: row.status as RunStatus,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null
      ? undefined
      : new Date(row.finished_at),
    hasReport: row.has_report !== 0,
  };
}
