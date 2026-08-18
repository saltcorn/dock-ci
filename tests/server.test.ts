import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CiServer, type CiServerOptions, DEFAULT_JOB_TIMEOUT_MINUTES, type JobResult, rerunEvent, type RunJob, serverConfigFromEnv, verifyCheckout } from "../lib/server.ts";
import { SESSION_COOKIE } from "../lib/auth.ts";
import type { CommitState, StatusReporter } from "../lib/github.ts";
import type { GitClient } from "../lib/git.ts";
import { RunStore } from "../lib/history.ts";
import { ConfigError } from "../lib/types.ts";

const SECRET = "topsecret";

/** Records the git operations a CI job performs, with optional injected faults. */
class FakeGit implements GitClient {
  readonly calls: string[] = [];
  fetchError: Error | undefined;
  /** Artificial duration of each git op, so concurrent ops would overlap. */
  opDelayMs = 0;
  /** Git ops running right now, and the high-water mark across the run. */
  inFlight = 0;
  maxInFlight = 0;
  #root: string | undefined;

  constructor(root: string | undefined) {
    this.#root = root;
  }

  async repoRoot(): Promise<string | undefined> {
    return this.#root;
  }
  async fetch(_dir: string, ref: string): Promise<void> {
    await this.#op(`fetch ${ref}`, this.fetchError);
  }
  async addWorktree(_dir: string, path: string, commit: string): Promise<void> {
    await this.#op(`add ${commit} ${path}`);
  }
  async removeWorktree(_dir: string, path: string): Promise<void> {
    await this.#op(`remove ${path}`);
  }

  /** Record a call and track concurrency, optionally pausing then faulting. */
  async #op(label: string, fault?: Error): Promise<void> {
    this.calls.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.opDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.opDelayMs));
      }
      if (fault) throw fault;
    } finally {
      this.inFlight--;
    }
  }
}

/** Records every commit status posted. */
class FakeStatus implements StatusReporter {
  readonly states: CommitState[] = [];
  readonly reports: Array<
    { sha: string; state: CommitState; description: string; targetUrl?: string }
  > = [];
  async report(
    _repo: string,
    sha: string,
    state: CommitState,
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    this.states.push(state);
    this.reports.push({ sha, state, description, targetUrl });
  }
}

interface Harness {
  server: CiServer;
  git: FakeGit;
  status: FakeStatus;
  store: RunStore;
  runDirs: string[];
}

/** Start a CiServer on an ephemeral port with the given run outcome. */
async function startServer(
  run: RunJob,
  git = new FakeGit("/repo"),
  publicUrl?: string,
  trustedPrOwners?: ReadonlySet<string>,
  extra: Partial<CiServerOptions> = {},
): Promise<Harness> {
  const status = new FakeStatus();
  const store = new RunStore(":memory:");
  const runDirs: string[] = [];
  const server = new CiServer({
    repoRoot: "/repo",
    configFile: "ci.yml",
    secret: SECRET,
    worktreeRoot: "/tmp/dockci-worktrees",
    git,
    status,
    store,
    publicUrl,
    trustedPrOwners,
    run: (dir, onReport, signal) => {
      runDirs.push(dir);
      return run(dir, onReport, signal);
    },
    log: () => {},
    ...extra,
  });
  await server.listen(0);
  return { server, git, status, store, runDirs };
}

/** A run stub that always finishes with `ok` and a small fixed report. */
function fixedRun(ok: boolean): RunJob {
  return async () => ({ ok, report: `<html>report ${ok}</html>` });
}

/** A gate a test can hold a run at, then release. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}

/** POST a webhook to the running server with a (correct by default) signature. */
async function postWebhook(
  server: CiServer,
  event: string,
  payload: unknown,
  opts: { secret?: string; signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = opts.signature ??
    "sha256=" +
      createHmac("sha256", opts.secret ?? SECRET).update(body).digest("hex");
  return await fetch(`http://127.0.0.1:${server.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

const PUSH = {
  ref: "refs/heads/feature/x",
  after: "deadbeefcafe1234",
  repository: { full_name: "owner/repo" },
};

/** A `pull_request` payload for PR #7 from `bob/repo` against `owner/repo`. */
const FORK_PR = {
  action: "synchronize",
  repository: { full_name: "owner/repo" },
  pull_request: {
    number: 7,
    head: {
      ref: "fork-feature",
      sha: "f0rkc0mm1t",
      repo: { full_name: "bob/repo", owner: { login: "bob" } },
    },
  },
};

test("serverConfigFromEnv reads and validates the four env vars", () => {
  const env = serverConfigFromEnv({
    GITHUB_TOKEN: "tok",
    WEBHOOK_SECRET: "sec",
    WORKTREE_ROOT: "/wt",
    LISTEN_PORT: "8080",
  });
  assert.deepEqual(env, {
    githubToken: "tok",
    webhookSecret: "sec",
    worktreeRoot: "/wt",
    listenPort: 8080,
    publicUrl: undefined,
    // Unset TRUSTED_PR_OWNERS builds no fork pull request.
    trustedPrOwners: new Set(),
    // The admin username has a default; the password deliberately has none.
    auth: { username: "admin", password: undefined },
  });
});

test("serverConfigFromEnv reads the optional admin credentials", () => {
  const base = {
    GITHUB_TOKEN: "tok",
    WEBHOOK_SECRET: "sec",
    WORKTREE_ROOT: "/wt",
    LISTEN_PORT: "8080",
  };
  assert.deepEqual(
    serverConfigFromEnv({ ...base, ADMIN_USERNAME: " ci ", ADMIN_PASSWORD: "hunter2" }).auth,
    { username: "ci", password: "hunter2" },
  );
  // A blank username falls back to the default; a blank password is no password.
  assert.deepEqual(
    serverConfigFromEnv({ ...base, ADMIN_USERNAME: "  ", ADMIN_PASSWORD: "" }).auth,
    { username: "admin", password: undefined },
  );
});

test("serverConfigFromEnv reads the optional TRUSTED_PR_OWNERS", () => {
  const env = serverConfigFromEnv({
    GITHUB_TOKEN: "tok",
    WEBHOOK_SECRET: "sec",
    WORKTREE_ROOT: "/wt",
    LISTEN_PORT: "8080",
    TRUSTED_PR_OWNERS: "alice, BoB",
  });
  assert.deepEqual(env.trustedPrOwners, new Set(["alice", "bob"]));
});

test("serverConfigFromEnv reads the optional PUBLIC_URL", () => {
  const env = serverConfigFromEnv({
    GITHUB_TOKEN: "tok",
    WEBHOOK_SECRET: "sec",
    WORKTREE_ROOT: "/wt",
    LISTEN_PORT: "8080",
    PUBLIC_URL: "https://ci.example.com",
  });
  assert.equal(env.publicUrl, "https://ci.example.com");
});

test("serverConfigFromEnv rejects a missing variable", () => {
  assert.throws(
    () =>
      serverConfigFromEnv({
        WEBHOOK_SECRET: "sec",
        WORKTREE_ROOT: "/wt",
        LISTEN_PORT: "8080",
      }),
    /GITHUB_TOKEN/,
  );
});

test("serverConfigFromEnv rejects a non-numeric or out-of-range port", () => {
  const base = { GITHUB_TOKEN: "t", WEBHOOK_SECRET: "s", WORKTREE_ROOT: "/wt" };
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "abc" }), /LISTEN_PORT/);
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "0" }), /LISTEN_PORT/);
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "99999" }), /LISTEN_PORT/);
});

test("verifyCheckout requires a git checkout rooted at cwd with the config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dockci-"));
  writeFileSync(join(dir, "ci.yml"), "build:\n  image: alpine\n");

  // Not a git checkout at all.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(undefined), dir, "ci.yml"),
    ConfigError,
  );
  // A checkout whose root is somewhere else.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(tmpdir()), dir, "ci.yml"),
    /root of the git checkout/,
  );
  // The config file is missing from the checkout root.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(dir), dir, "missing.yml"),
    /not found/,
  );
  // Happy path returns the resolved root.
  assert.equal(await verifyCheckout(new FakeGit(dir), dir, "ci.yml"), dir);
});

test("a non-POST request to the webhook is rejected", async () => {
  const { server } = await startServer(fixedRun(true));
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/webhook`);
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test("an unknown path is not found and a POST to a page is not allowed", async () => {
  const { server, git } = await startServer(fixedRun(true));
  try {
    const notFound = await fetch(`http://127.0.0.1:${server.port}/other`, {
      method: "POST",
    });
    assert.equal(notFound.status, 404);
    const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
    });
    assert.equal(wrongMethod.status, 405);
    // A query string does not change the route.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/webhook?x=1`,
    );
    assert.equal(res.status, 405);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a ping is answered without starting a job", async () => {
  const { server, git } = await startServer(fixedRun(true));
  try {
    const res = await postWebhook(server, "ping", { zen: "hi" });
    assert.equal(res.status, 200);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("an invalid signature is rejected and starts no job", async () => {
  const { server, git, status } = await startServer(fixedRun(true));
  try {
    const res = await postWebhook(server, "push", PUSH, { signature: "sha256=bad" });
    assert.equal(res.status, 401);
    await server.drain();
    assert.deepEqual(git.calls, []);
    assert.deepEqual(status.states, []);
  } finally {
    await server.close();
  }
});

test("a successful push runs CI in a worktree and reports success", async () => {
  const { server, git, status, runDirs } = await startServer(fixedRun(true));
  try {
    const res = await postWebhook(server, "push", PUSH);
    assert.equal(res.status, 202);
    await server.drain();

    // Fetched the branch, added a worktree on the exact sha, ran it, removed it.
    assert.deepEqual(git.calls, [
      "fetch feature/x",
      `add deadbeefcafe1234 ${runDirs[0]}`,
      `remove ${runDirs[0]}`,
    ]);
    // The worktree directory carries a slug of the branch and the short sha.
    assert.match(runDirs[0]!, /feature-x-deadbeefcafe-0$/);
    assert.deepEqual(status.states, ["pending", "success"]);
  } finally {
    await server.close();
  }
});

test("a trusted fork PR is fetched from its pull ref and reported on the base repo", async () => {
  const { server, git, status, runDirs } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["bob"]),
  );
  try {
    const res = await postWebhook(server, "pull_request", FORK_PR);
    assert.equal(res.status, 202);
    await server.drain();

    // The fork is not a remote here, so the head commit comes from the base
    // repo's pull ref rather than from a branch name that does not exist.
    assert.deepEqual(git.calls, [
      "fetch refs/pull/7/head",
      `add f0rkc0mm1t ${runDirs[0]}`,
      `remove ${runDirs[0]}`,
    ]);
    assert.match(runDirs[0]!, /fork-feature-f0rkc0mm1t-0$/);
    assert.deepEqual(status.states, ["pending", "success"]);
    assert.deepEqual(status.reports.map((r) => r.sha), ["f0rkc0mm1t", "f0rkc0mm1t"]);
  } finally {
    await server.close();
  }
});

test("an untrusted fork PR touches neither git nor the run history", async () => {
  const { server, git, status, store } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["alice"]),
  );
  try {
    const res = await postWebhook(server, "pull_request", FORK_PR);
    // Refused before any of the contributor's code is fetched, let alone run.
    assert.equal(res.status, 200);
    assert.match(await res.text(), /not in TRUSTED_PR_OWNERS/);
    await server.drain();

    assert.deepEqual(git.calls, []);
    assert.deepEqual(status.states, []);
    assert.deepEqual(store.recent(), []);
  } finally {
    await server.close();
  }
});

test("a fork PR is refused when no owner is allowlisted", async () => {
  // The default construction: subscribing to the webhook event without setting
  // TRUSTED_PR_OWNERS must not start running strangers' code.
  const { server, git } = await startServer(fixedRun(true));
  try {
    const res = await postWebhook(server, "pull_request", FORK_PR);
    assert.equal(res.status, 200);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a same-repo PR is not built a second time on top of its push event", async () => {
  const { server, git } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["owner"]),
  );
  try {
    const payload = {
      ...FORK_PR,
      pull_request: {
        ...FORK_PR.pull_request,
        head: {
          ...FORK_PR.pull_request.head,
          repo: { full_name: "owner/repo", owner: { login: "owner" } },
        },
      },
    };
    const res = await postWebhook(server, "pull_request", payload);
    assert.equal(res.status, 200);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a pull_request with an unbuildable action starts no job", async () => {
  const { server, git } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["bob"]),
  );
  try {
    const res = await postWebhook(server, "pull_request", { ...FORK_PR, action: "closed" });
    assert.equal(res.status, 200);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a fork PR webhook with a bad signature is rejected before the trust check", async () => {
  const { server, git } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["bob"]),
  );
  try {
    const res = await postWebhook(server, "pull_request", FORK_PR, { secret: "wrong" });
    assert.equal(res.status, 401);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a failing pipeline reports failure but still cleans up", async () => {
  const { server, git, status } = await startServer(fixedRun(false));
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.deepEqual(status.states, ["pending", "failure"]);
    assert.ok(git.calls.some((c) => c.startsWith("remove ")));
  } finally {
    await server.close();
  }
});

test("with a public URL, statuses link to the run's report page", async () => {
  const { server, status, store } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    "https://ci.example.com/",
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    const runId = store.recent()[0]!.id;
    // Trailing slash on the public URL is normalised away.
    const expected = `https://ci.example.com/runs/${runId}`;
    assert.deepEqual(
      status.reports.map((r) => r.targetUrl),
      [expected, expected],
    );
  } finally {
    await server.close();
  }
});

test("without a public URL, statuses carry no target URL", async () => {
  const { server, status } = await startServer(fixedRun(true));
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.deepEqual(
      status.reports.map((r) => r.targetUrl),
      [undefined, undefined],
    );
  } finally {
    await server.close();
  }
});

test("a git/pipeline error reports error and skips a never-made worktree", async () => {
  const git = new FakeGit("/repo");
  git.fetchError = new Error("network down");
  const { server, status } = await startServer(fixedRun(true), git);
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.deepEqual(status.states, ["pending", "error"]);
    // The worktree was never created, so it must not be removed.
    assert.ok(!git.calls.some((c) => c.startsWith("remove ")));
  } finally {
    await server.close();
  }
});

const OTHER_PUSH = {
  ...PUSH,
  ref: "refs/heads/other",
  after: "f00df00df00d",
};

test("a push arriving during a run is queued, not run concurrently", async () => {
  // A run that blocks until released, so the second push arrives mid-run.
  const first = gate();
  const { server, runDirs, status } = await startServer(async () => {
    await first.wait;
    return { ok: true };
  });
  try {
    await postWebhook(server, "push", PUSH);
    const res = await postWebhook(server, "push", OTHER_PUSH);
    // The webhook is still answered promptly even though nothing can run yet.
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    // Only the first commit is being tested; the second waits its turn.
    assert.equal(runDirs.length, 1);
    assert.equal(server.queued, 1);
    // The queued commit already shows up as pending on GitHub.
    assert.ok(
      status.reports.some((r) =>
        r.sha === OTHER_PUSH.after && r.state === "pending" &&
        r.description === "Queued for CI (1 run ahead)"
      ),
    );

    first.release();
    await server.drain();
    // Both commits ran, in arrival order, in worktrees of their own.
    assert.equal(runDirs.length, 2);
    assert.notEqual(runDirs[0], runDirs[1]);
    assert.equal(server.queued, 0);
  } finally {
    await server.close();
  }
});

test("queued commits are counted and run one at a time in arrival order", async () => {
  const first = gate();
  let started = 0;
  let concurrent = 0;
  const { server, status } = await startServer(async () => {
    concurrent = Math.max(concurrent, ++started);
    if (started === 1) await first.wait;
    started--;
    return { ok: true };
  });
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", OTHER_PUSH);
    await postWebhook(server, "push", { ...PUSH, after: "beefbeefbeef" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.queued, 2);
    // The third commit is told how many runs it is waiting behind.
    assert.ok(
      status.reports.some((r) =>
        r.sha === "beefbeefbeef" &&
        r.description === "Queued for CI (2 runs ahead)"
      ),
    );

    first.release();
    await server.drain();
    // No two pipelines ever overlapped.
    assert.equal(concurrent, 1);
    // Each commit reached a final state, in the order the pushes arrived.
    assert.deepEqual(
      status.reports.filter((r) => r.state === "success").map((r) => r.sha),
      [PUSH.after, OTHER_PUSH.after, "beefbeefbeef"],
    );
  } finally {
    await server.close();
  }
});

test("git operations on the shared checkout never overlap across pushes", async () => {
  const git = new FakeGit("/repo");
  // Stretch each git op so two unsynchronised jobs would overlap in time.
  git.opDelayMs = 20;
  const { server } = await startServer(fixedRun(true), git);
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", OTHER_PUSH);
    await server.drain();
    // Serialising whole jobs keeps fetch/add/remove one-at-a-time as well.
    assert.equal(git.maxInFlight, 1);
    // Both jobs still completed their full git sequence.
    assert.equal(git.calls.filter((c) => c.startsWith("fetch ")).length, 2);
    assert.equal(git.calls.filter((c) => c.startsWith("remove ")).length, 2);
  } finally {
    await server.close();
  }
});

test("a job that outlives its timeout is aborted and fails the commit", async () => {
  let fire!: () => void;
  const cancelled: boolean[] = [];
  // Capture the job's timeout instead of waiting for a real one.
  const timer = (_ms: number, onFire: () => void): (() => void) => {
    fire = onFire;
    return () => cancelled.push(true);
  };
  // A run that only settles once its signal aborts, like a wedged pipeline
  // whose containers are torn down on the way out.
  const { server, status, store } = await startServer(
    (_dir, _onReport, signal) =>
      new Promise((r) =>
        signal.addEventListener("abort", () => r({ ok: false, report: "<p>partial" }), {
          once: true,
        })
      ),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { timer, jobTimeoutMinutes: 7 },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await new Promise((r) => setTimeout(r, 50));
    fire();
    await server.drain();

    assert.deepEqual(status.states, ["pending", "failure"]);
    assert.equal(
      status.reports.at(-1)?.description,
      "CI timed out after 7 minutes",
    );
    // The partial report is still stored, and the run recorded as failed.
    assert.equal(store.recent()[0]?.status, "failure");
    assert.equal(store.report(1), "<p>partial");
  } finally {
    await server.close();
  }
});

test("a timeout releases the queue for the next commit", async () => {
  let fire!: () => void;
  const timer = (_ms: number, onFire: () => void): (() => void) => {
    fire = onFire;
    return () => {};
  };
  const runs: string[] = [];
  const { server } = await startServer(
    (dir, _onReport, signal) => {
      runs.push(dir);
      // The first run hangs until aborted; the second finishes normally.
      if (runs.length > 1) return Promise.resolve({ ok: true });
      return new Promise((r) =>
        signal.addEventListener("abort", () => r({ ok: false }), { once: true })
      );
    },
    new FakeGit("/repo"),
    undefined,
    undefined,
    { timer },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", OTHER_PUSH);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runs.length, 1);
    fire();
    await server.drain();
    assert.equal(runs.length, 2);
  } finally {
    await server.close();
  }
});

test("the timer is cancelled when a job finishes in time", async () => {
  let cancels = 0;
  const timer = (): (() => void) => () => cancels++;
  const { server } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { timer },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.equal(cancels, 1);
  } finally {
    await server.close();
  }
});

test("the job timeout defaults to 30 minutes", () => {
  assert.equal(DEFAULT_JOB_TIMEOUT_MINUTES, 30);
});

test("shutting down drops queued commits and reports them", async () => {
  const first = gate();
  const { server, status, runDirs } = await startServer(async () => {
    await first.wait;
    return { ok: true };
  });
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", OTHER_PUSH);
    await new Promise((r) => setTimeout(r, 50));

    // close() waits for the running job, so let it finish once it is under way.
    const closed = server.close();
    await new Promise((r) => setTimeout(r, 20));
    first.release();
    await closed;

    // Only the running commit was built; the queued one was told it will not be.
    assert.equal(runDirs.length, 1);
    const dropped = status.reports.filter((r) => r.sha === OTHER_PUSH.after);
    assert.equal(dropped.at(-1)?.state, "error");
    assert.match(dropped.at(-1)?.description ?? "", /shut down/);
  } finally {
    await server.close();
  }
});

test("a push to an ignored branch leaves no run, status or git call", async () => {
  const { server, git, status, store } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { ignoredBranches: new Set(["gh-pages", "feature/x"]) },
  );
  try {
    const res = await postWebhook(server, "push", PUSH);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Ignored \(branch "feature\/x"\)/);
    await server.drain();

    // Completely ignored: nothing fetched, nothing reported to GitHub, and
    // nothing for the dashboard's run list to show.
    assert.deepEqual(git.calls, []);
    assert.deepEqual(status.states, []);
    assert.deepEqual(store.recent(), []);
    assert.equal(server.queued, 0);
  } finally {
    await server.close();
  }
});

test("a push to a branch not on the ignore list still runs", async () => {
  const { server, git, store } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { ignoredBranches: new Set(["gh-pages"]) },
  );
  try {
    const res = await postWebhook(server, "push", PUSH);
    assert.equal(res.status, 202);
    await server.drain();

    assert.deepEqual(git.calls[0], "fetch feature/x");
    assert.equal(store.recent().length, 1);
  } finally {
    await server.close();
  }
});

test("branch names are matched exactly, case and all", async () => {
  const { server, git } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    undefined,
    // Neither a differently-cased name nor a prefix of the pushed branch.
    { ignoredBranches: new Set(["Feature/X", "feature"]) },
  );
  try {
    const res = await postWebhook(server, "push", PUSH);
    assert.equal(res.status, 202);
    await server.drain();
    assert.deepEqual(git.calls[0], "fetch feature/x");
  } finally {
    await server.close();
  }
});

test("a pull request from an ignored head branch is dropped too", async () => {
  const { server, git, status, store } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    new Set(["bob"]),
    { ignoredBranches: new Set(["fork-feature"]) },
  );
  try {
    const res = await postWebhook(server, "pull_request", FORK_PR);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Ignored \(branch "fork-feature"\)/);
    await server.drain();

    assert.deepEqual(git.calls, []);
    assert.deepEqual(status.states, []);
    assert.deepEqual(store.recent(), []);
  } finally {
    await server.close();
  }
});

test("an unhandled event type is ignored", async () => {
  const { server, git } = await startServer(fixedRun(true));
  try {
    const res = await postWebhook(server, "issues", { action: "opened" });
    assert.equal(res.status, 204);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("the dashboard lists recent runs with branch, date and outcome", async () => {
  const { server } = await startServer(fixedRun(true));
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    await postWebhook(server, "push", {
      ...PUSH,
      ref: "refs/heads/other",
      after: "f00df00df00d",
    });
    await server.drain();

    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /feature\/x/);
    assert.match(html, /other/);
    assert.match(html, /passed/);
    // Each finished run links to its stored report.
    assert.match(html, /href="\/runs\/1"/);
    assert.match(html, /href="\/runs\/2"/);
    // A date is shown for the runs (today, in the dashboard's UTC format).
    assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  } finally {
    await server.close();
  }
});

test("the dashboard shows a job that is still running, without a report link", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { server } = await startServer(async () => {
    await gate;
    return { ok: false, report: "<html>failed run</html>" };
  });
  try {
    await postWebhook(server, "push", PUSH);
    // Let the job reach the blocked run() so it is recorded as running.
    await new Promise((r) => setTimeout(r, 50));

    let html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.match(html, /running/);
    assert.doesNotMatch(html, /href="\/runs\//);

    release();
    await server.drain();
    html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.match(html, /failed/);
    assert.match(html, /href="\/runs\/1"/);
  } finally {
    await server.close();
  }
});

test("a finished run's report is served and an unknown run is 404", async () => {
  const { server } = await startServer(fixedRun(true));
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();

    const res = await fetch(`http://127.0.0.1:${server.port}/runs/1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await res.text(), "<html>report true</html>");

    const missing = await fetch(`http://127.0.0.1:${server.port}/runs/99`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("the run's report is published and updated while the run is still in flight", async () => {
  // A run that publishes an initial report, then a second one, and blocks so
  // the interim report can be observed before the run finishes.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run: RunJob = async (_dir, onReport) => {
    onReport("<html>pending</html>");
    onReport("<html>step 1 done</html>");
    await gate;
    return { ok: true, report: "<html>final</html>" };
  };
  const { server, store } = await startServer(run);
  try {
    await postWebhook(server, "push", PUSH);
    // Let the job reach the blocked run() so both interim reports are stored.
    await new Promise((r) => setTimeout(r, 50));

    const runId = store.recent()[0]!.id;
    // The run is still running, yet its latest interim report is already served.
    assert.equal(store.recent()[0]!.status, "running");
    const interim = await fetch(`http://127.0.0.1:${server.port}/runs/${runId}`);
    assert.equal(await interim.text(), "<html>step 1 done</html>");

    release();
    await server.drain();
    // Once finished, the final report replaces the interim one.
    const final = await fetch(`http://127.0.0.1:${server.port}/runs/${runId}`);
    assert.equal(await final.text(), "<html>final</html>");
    assert.equal(store.recent()[0]!.status, "success");
  } finally {
    await server.close();
  }
});

test("starting the server marks runs orphaned by a previous crash as errored", () => {
  // Simulate a crash: two runs left `running` in the history plus one finished.
  const store = new RunStore(":memory:");
  const orphanA = store.start({ branch: "main", commit: "aaa" });
  const orphanB = store.start({ branch: "feature/x", commit: "bbb" });
  const done = store.start({ branch: "main", commit: "ccc" });
  store.finish(done, "success", "<html>ok</html>");

  // Constructing a server (as happens on startup) reconciles the orphans.
  new CiServer({
    repoRoot: "/repo",
    configFile: "ci.yml",
    secret: SECRET,
    worktreeRoot: "/tmp/dockci-worktrees",
    git: new FakeGit("/repo"),
    status: new FakeStatus(),
    store,
    run: fixedRun(true),
    log: () => {},
  });

  const byId = new Map(store.recent().map((run) => [run.id, run]));
  assert.equal(byId.get(orphanA)!.status, "error");
  assert.equal(byId.get(orphanA)!.finishedAt !== undefined, true);
  assert.equal(byId.get(orphanB)!.status, "error");
  // A run that had already finished is left untouched.
  assert.equal(byId.get(done)!.status, "success");
});

test("a job that errors is recorded as an error in the run history", async () => {
  const git = new FakeGit("/repo");
  git.fetchError = new Error("network down");
  const { server, store } = await startServer(fixedRun(true), git);
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    const runs = store.recent();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "error");
    assert.equal(runs[0]!.branch, "feature/x");
    assert.equal(runs[0]!.hasReport, false);
  } finally {
    await server.close();
  }
});

/** The admin credentials the login tests use. */
const ADMIN = { username: "admin", password: "hunter2" };

/** GET /login with optional Basic credentials, never following the redirect. */
async function login(
  server: CiServer,
  credentials?: { username: string; password: string },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (credentials !== undefined) {
    headers["authorization"] = "Basic " +
      Buffer.from(`${credentials.username}:${credentials.password}`)
        .toString("base64");
  }
  return await fetch(`http://127.0.0.1:${server.port}/login`, {
    headers,
    redirect: "manual",
  });
}

/** Log in and return the session cookie to send on subsequent requests. */
async function session(server: CiServer): Promise<string> {
  const res = await login(server, ADMIN);
  assert.equal(res.status, 303);
  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0]!;
}

/** POST a rerun of `id`, with the given session cookie when one is supplied. */
async function postRerun(
  server: CiServer,
  id: number,
  cookie?: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}/runs/${id}/rerun`, {
    method: "POST",
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
}

test("GET /login challenges for Basic credentials when none are sent", async () => {
  const { server } = await startServer(fixedRun(true), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    const res = await login(server);
    assert.equal(res.status, 401);
    // The challenge header is what makes the browser show its login dialog.
    assert.match(res.headers.get("www-authenticate") ?? "", /^Basic realm="whale-ci"/);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    await server.close();
  }
});

test("GET /login sets an encrypted session cookie for the right credentials", async () => {
  const { server } = await startServer(fixedRun(true), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    const res = await login(server, ADMIN);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    // Served over plain http here, so the cookie must not be Secure-only.
    assert.doesNotMatch(cookie, /Secure/);
    // The password is not echoed back into the cookie.
    assert.doesNotMatch(cookie, /hunter2/);
  } finally {
    await server.close();
  }
});

test("GET /login rejects a wrong username or password", async () => {
  const { server } = await startServer(fixedRun(true), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    for (
      const bad of [
        { username: "admin", password: "wrong" },
        { username: "root", password: "hunter2" },
      ]
    ) {
      const res = await login(server, bad);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  } finally {
    await server.close();
  }
});

test("with no password configured every login fails and the dashboard says so", async () => {
  // The default construction: no ADMIN_PASSWORD, so there is nothing to log in
  // with and no session can exist.
  const { server } = await startServer(fixedRun(true));
  try {
    for (
      const attempt of [
        undefined,
        { username: "admin", password: "" },
        { username: "admin", password: "guess" },
      ]
    ) {
      const res = await login(server, attempt);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // The dashboard does not offer a login link that could never succeed.
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.match(html, /no ADMIN_PASSWORD is configured/);
    assert.doesNotMatch(html, /href="\/login"/);
  } finally {
    await server.close();
  }
});

test("a POST to /login is not allowed", async () => {
  const { server } = await startServer(fixedRun(true), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/login`, { method: "POST" });
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test("the rerun button is shown on failed runs only once logged in", async () => {
  const { server } = await startServer(fixedRun(false), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();

    // Logged out, the dashboard is the read-only page it always was: it points
    // at /login, but offers no button to post a rerun with.
    const anonymous = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.doesNotMatch(anonymous, /<form/);
    assert.doesNotMatch(anonymous, /action="\/runs\/1\/rerun"/);
    assert.match(anonymous, /href="\/login"/);

    const cookie = await session(server);
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie },
    })).text();
    assert.match(html, /action="\/runs\/1\/rerun"/);
    assert.match(html, /Signed in as admin/);
  } finally {
    await server.close();
  }
});

test("a passing run gets no rerun button even when logged in", async () => {
  const { server } = await startServer(fixedRun(true), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    const cookie = await session(server);
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie },
    })).text();
    assert.doesNotMatch(html, /action="\/runs\/1\/rerun"/);
  } finally {
    await server.close();
  }
});

test("a logged-in rerun queues the same commit as a new run", async () => {
  const { server, git, status, store } = await startServer(
    fixedRun(false),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { auth: ADMIN },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    git.calls.length = 0;

    const cookie = await session(server);
    const res = await postRerun(server, 1, cookie);
    // 303 so reloading the dashboard afterwards does not post the rerun again.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    await server.drain();

    // The same commit was fetched from the same ref and built again.
    assert.ok(git.calls.some((c) => c === "fetch feature/x"));
    assert.ok(git.calls.some((c) => c.startsWith(`add ${PUSH.after} `)));
    // It is a run of its own, recorded alongside the original.
    const runs = store.recent();
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.commit, PUSH.after);
    assert.equal(runs[0]!.branch, "feature/x");
    // GitHub is told about the rerun exactly as about any other run.
    assert.deepEqual(status.states, ["pending", "failure", "pending", "failure"]);
  } finally {
    await server.close();
  }
});

test("a rerun of a fork pull request run refetches its pull ref", async () => {
  const { server, git, store } = await startServer(
    fixedRun(false),
    new FakeGit("/repo"),
    undefined,
    new Set(["bob"]),
    { auth: ADMIN },
  );
  try {
    await postWebhook(server, "pull_request", FORK_PR);
    await server.drain();
    git.calls.length = 0;

    await postRerun(server, 1, await session(server));
    await server.drain();

    // The head commit still only exists under the base repo's pull ref.
    assert.ok(git.calls.some((c) => c === "fetch refs/pull/7/head"));
    assert.equal(store.recent()[0]!.commit, "f0rkc0mm1t");
  } finally {
    await server.close();
  }
});

test("a rerun without a valid session is refused and starts no job", async () => {
  const { server, git, store } = await startServer(
    fixedRun(false),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { auth: ADMIN },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    git.calls.length = 0;

    // No cookie at all, and a forged one.
    for (const cookie of [undefined, `${SESSION_COOKIE}=v1.a.b.c`]) {
      const res = await postRerun(server, 1, cookie);
      assert.equal(res.status, 401);
    }
    await server.drain();
    assert.deepEqual(git.calls, []);
    assert.equal(store.recent().length, 1);
  } finally {
    await server.close();
  }
});

test("a session issued under a previous password is no longer accepted", async () => {
  const { server } = await startServer(fixedRun(false), new FakeGit("/repo"), undefined, undefined, {
    auth: ADMIN,
  });
  let cookie: string;
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    cookie = await session(server);
    assert.equal((await postRerun(server, 1, cookie)).status, 303);
  } finally {
    await server.close();
  }

  // Restarting with a different password invalidates the old cookie, because
  // the key it was encrypted with is derived from the password.
  const rotated = await startServer(fixedRun(false), new FakeGit("/repo"), undefined, undefined, {
    auth: { username: "admin", password: "hunter3" },
  });
  try {
    await postWebhook(rotated.server, "push", PUSH);
    await rotated.server.drain();
    assert.equal((await postRerun(rotated.server, 1, cookie)).status, 401);
  } finally {
    await rotated.server.close();
  }
});

test("rerunning a passing, unknown or wrong-method run is refused", async () => {
  const { server, git } = await startServer(
    fixedRun(true),
    new FakeGit("/repo"),
    undefined,
    undefined,
    { auth: ADMIN },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    git.calls.length = 0;
    const cookie = await session(server);

    // A run that passed has nothing to retry.
    assert.equal((await postRerun(server, 1, cookie)).status, 409);
    assert.equal((await postRerun(server, 99, cookie)).status, 404);
    const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/runs/1/rerun`, {
      headers: { cookie },
    });
    assert.equal(wrongMethod.status, 405);

    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a rerun that arrives mid-run is queued behind it", async () => {
  const first = gate();
  let runs = 0;
  const { server, store } = await startServer(
    async () => {
      runs++;
      if (runs === 1) return { ok: false, report: "<html>failed</html>" };
      await first.wait;
      return { ok: false };
    },
    new FakeGit("/repo"),
    undefined,
    undefined,
    { auth: ADMIN },
  );
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    const cookie = await session(server);

    // The second push occupies the runner, so the rerun has to wait its turn.
    await postWebhook(server, "push", OTHER_PUSH);
    await new Promise((r) => setTimeout(r, 50));
    const res = await postRerun(server, 1, cookie);
    assert.equal(res.status, 303);
    assert.equal(server.queued, 1);

    first.release();
    await server.drain();
    assert.equal(store.recent().length, 3);
  } finally {
    await server.close();
  }
});

test("rerunEvent rebuilds the recorded commit, or refuses to", () => {
  const store = new RunStore(":memory:");
  const id = store.start({
    branch: "feature/x",
    commit: "deadbeef",
    repo: "owner/repo",
    fetchRef: "feature/x",
  });
  store.finish(id, "failure", "<html>failed</html>");
  assert.deepEqual(rerunEvent(store.run(id)!), {
    repo: "owner/repo",
    branch: "feature/x",
    sha: "deadbeef",
    fetchRef: "feature/x",
  });

  // A one-shot CLI run knows no repository, so it cannot be repeated here.
  const cli = store.start({ branch: "main", commit: "abc" });
  store.finish(cli, "failure");
  assert.equal(rerunEvent(store.run(cli)!), undefined);
  store.close();
});
