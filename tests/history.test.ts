import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { dataDir, isRerunnable, type RunRecord, RunStore } from "../lib/history.ts";

test("dataDir picks the customary per-platform application data directory", () => {
  assert.equal(
    dataDir("darwin", {}, "/Users/me"),
    join("/Users/me", "Library", "Application Support", "whale-ci"),
  );
  assert.equal(
    dataDir("linux", {}, "/home/me"),
    join("/home/me", ".local", "share", "whale-ci"),
  );
  // XDG_DATA_HOME overrides the Linux default, but blank values are ignored.
  assert.equal(
    dataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/me"),
    join("/data", "whale-ci"),
  );
  assert.equal(
    dataDir("linux", { XDG_DATA_HOME: "  " }, "/home/me"),
    join("/home/me", ".local", "share", "whale-ci"),
  );
});

test("a started run is listed as running, then finished with its report", () => {
  const store = new RunStore(":memory:");
  const id = store.start({ branch: "main", commit: "abc123" });

  let [run] = store.recent();
  assert.ok(run);
  assert.equal(run.id, id);
  assert.equal(run.branch, "main");
  assert.equal(run.commit, "abc123");
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.hasReport, false);
  assert.ok(run.startedAt instanceof Date);

  store.finish(id, "success", "<html>ok</html>");
  [run] = store.recent();
  assert.ok(run);
  assert.equal(run.status, "success");
  assert.ok(run.finishedAt instanceof Date);
  assert.equal(run.hasReport, true);
  assert.equal(store.report(id), "<html>ok</html>");
  store.close();
});

test("update overwrites a running run's report without changing its status", () => {
  const store = new RunStore(":memory:");
  const id = store.start({ branch: "main", commit: "abc123" });

  store.update(id, "<html>pending</html>");
  let [run] = store.recent();
  assert.ok(run);
  // The run is still running, but its interim report is now available.
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.hasReport, true);
  assert.equal(store.report(id), "<html>pending</html>");

  // A later update replaces the earlier report, still without finishing.
  store.update(id, "<html>step 1 done</html>");
  [run] = store.recent();
  assert.equal(run!.status, "running");
  assert.equal(store.report(id), "<html>step 1 done</html>");

  // Finishing then records the final report and outcome.
  store.finish(id, "success", "<html>final</html>");
  assert.equal(store.recent()[0]!.status, "success");
  assert.equal(store.report(id), "<html>final</html>");
  store.close();
});

test("a run without a branch or report is handled", () => {
  const store = new RunStore(":memory:");
  const id = store.start({});
  store.finish(id, "failure");
  const [run] = store.recent();
  assert.ok(run);
  assert.equal(run.branch, undefined);
  assert.equal(run.commit, undefined);
  assert.equal(run.status, "failure");
  assert.equal(run.hasReport, false);
  assert.equal(store.report(id), undefined);
  store.close();
});

test("failRunning marks unfinished runs as errored, leaving finished ones", () => {
  const store = new RunStore(":memory:");
  const running1 = store.start({ branch: "main" });
  const running2 = store.queue({ branch: "dev" });
  const finished = store.start({ branch: "old" });
  store.finish(finished, "success", "<html>ok</html>");

  // A run still waiting in a queue is orphaned by a crash just as surely as
  // the one that was running.
  assert.equal(store.failRunning(), 2);

  const byId = new Map(store.recent().map((r) => [r.id, r]));
  assert.equal(byId.get(running1)!.status, "error");
  assert.ok(byId.get(running1)!.finishedAt instanceof Date);
  assert.equal(byId.get(running2)!.status, "error");
  // The already-finished run keeps its status and report.
  assert.equal(byId.get(finished)!.status, "success");
  assert.equal(store.report(finished), "<html>ok</html>");

  // With nothing left running a second call is a no-op.
  assert.equal(store.failRunning(), 0);
  store.close();
});

test("a queued run is recorded as pending until it begins", () => {
  const store = new RunStore(":memory:");
  const id = store.queue({
    branch: "main",
    commit: "abc123",
    repo: "owner/repo",
    fetchRef: "refs/heads/main",
  });

  const queued = store.run(id)!;
  assert.equal(queued.status, "pending");
  assert.equal(queued.branch, "main");
  assert.equal(queued.commit, "abc123");
  assert.equal(queued.finishedAt, undefined);
  assert.equal(queued.hasReport, false);
  // A run that has not started yet has nothing to retry.
  assert.equal(isRerunnable(queued), false);

  store.begin(id);
  assert.equal(store.run(id)!.status, "running");
  assert.ok(store.run(id)!.startedAt.getTime() >= queued.startedAt.getTime());

  store.finish(id, "success", "<html>ok</html>");
  assert.equal(store.run(id)!.status, "success");
  store.close();
});

test("begin only promotes a run that is still queued", () => {
  const store = new RunStore(":memory:");
  const finished = store.queue({ branch: "main" });
  store.finish(finished, "failure");
  const startedAt = store.run(finished)!.startedAt;

  store.begin(finished);

  // A finished run is not dragged back to running by a stray promotion.
  assert.equal(store.run(finished)!.status, "failure");
  assert.deepEqual(store.run(finished)!.startedAt, startedAt);
  store.close();
});

test("recent lists runs in arrival order, restamped starts included", () => {
  const store = new RunStore(":memory:");
  const first = store.queue({ branch: "one" });
  const second = store.queue({ branch: "two" });
  // The first run starts after the second was queued, so its start time is now
  // the later of the two; arrival order still decides the listing.
  store.begin(first);

  assert.deepEqual(store.recent().map((run) => run.id), [second, first]);
  store.close();
});

test("an unknown run has no report", () => {
  const store = new RunStore(":memory:");
  assert.equal(store.report(42), undefined);
  store.close();
});

test("recent returns newest first and honours the limit", () => {
  const store = new RunStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.start({ branch: `b${i}` });
  }
  const all = store.recent();
  assert.deepEqual(all.map((r) => r.branch), ["b4", "b3", "b2", "b1", "b0"]);
  const two = store.recent(2);
  assert.deepEqual(two.map((r) => r.branch), ["b4", "b3"]);
  store.close();
});

test("runs persist across reopening the database file", () => {
  // A nested path also proves the store creates its directory on demand.
  const path = join(mkdtempSync(tmpdir() + sep + "whaleci-"), "deep", "runs.db");
  const store = new RunStore(path);
  const id = store.start({ branch: "main" });
  store.finish(id, "success", "<html>persisted</html>");
  store.close();

  const reopened = new RunStore(path);
  const [run] = reopened.recent();
  assert.ok(run);
  assert.equal(run.branch, "main");
  assert.equal(run.status, "success");
  assert.equal(reopened.report(id), "<html>persisted</html>");
  reopened.close();
});

test("a run records the repository and ref needed to rerun it", () => {
  const store = new RunStore(":memory:");
  const id = store.start({
    branch: "feature/x",
    commit: "abc123",
    repo: "owner/repo",
    fetchRef: "refs/pull/7/head",
  });

  const run = store.run(id);
  assert.ok(run);
  assert.equal(run.repo, "owner/repo");
  assert.equal(run.fetchRef, "refs/pull/7/head");
  // The same fields come back from the dashboard listing.
  assert.equal(store.recent()[0]?.fetchRef, "refs/pull/7/head");
  // A run started without them (as the one-shot CLI does) has neither.
  const bare = store.run(store.start({ branch: "main" }));
  assert.equal(bare?.repo, undefined);
  assert.equal(bare?.fetchRef, undefined);
  store.close();
});

test("run() looks a single run up by id and is undefined for an unknown one", () => {
  const store = new RunStore(":memory:");
  const id = store.start({ branch: "main", commit: "abc" });
  store.finish(id, "failure", "<html>failed</html>");

  const run = store.run(id);
  assert.equal(run?.id, id);
  assert.equal(run?.status, "failure");
  assert.equal(run?.hasReport, true);
  assert.equal(store.run(id + 1), undefined);
  store.close();
});

/** A finished run record, with the fields a test wants to vary overridden. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 1,
    branch: "main",
    commit: "abc123",
    repo: "owner/repo",
    fetchRef: "main",
    status: "failure",
    startedAt: new Date(0),
    finishedAt: new Date(1000),
    hasReport: true,
    ...over,
  };
}

test("only a failed run that knows its repository and ref can be rerun", () => {
  assert.equal(isRerunnable(record()), true);
  // An `error` run failed too — a timeout or a git failure — and is repeatable.
  assert.equal(isRerunnable(record({ status: "error" })), true);
  // Nothing to retry about a run that passed, or one still under way.
  assert.equal(isRerunnable(record({ status: "success" })), false);
  assert.equal(isRerunnable(record({ status: "running" })), false);
  // A CLI run, or one recorded before these columns existed, lacks the details.
  assert.equal(isRerunnable(record({ repo: undefined })), false);
  assert.equal(isRerunnable(record({ fetchRef: undefined })), false);
  assert.equal(isRerunnable(record({ commit: undefined })), false);
  assert.equal(isRerunnable(record({ branch: undefined })), false);
});

test("a database from an earlier version gains the rerun columns on open", () => {
  const path = join(mkdtempSync(join(tmpdir(), "whaleci-")), "runs.db");
  // The pre-rerun schema, without the repo/fetch_ref columns.
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT,
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      report TEXT
    );
  `);
  old.prepare(
    "INSERT INTO runs (branch, commit_sha, status, started_at) VALUES ('main', 'abc', 'failure', 1)",
  ).run();
  old.close();

  // Opening it migrates in place, leaving the existing row readable but — with
  // no repository recorded for it — not rerunnable.
  const store = new RunStore(path);
  const run = store.run(1);
  assert.equal(run?.branch, "main");
  assert.equal(run?.repo, undefined);
  assert.equal(isRerunnable(run!), false);
  // New runs can use the added columns.
  const id = store.start({ branch: "x", commit: "d", repo: "o/r", fetchRef: "x" });
  assert.equal(store.run(id)?.repo, "o/r");
  store.close();
});
