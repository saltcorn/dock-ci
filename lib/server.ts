import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { type GitClient, slugifyBranch } from "./git.ts";
import {
  type CiEvent,
  decidePullRequest,
  parsePushEvent,
  parseTrustedOwners,
  type StatusReporter,
  verifySignature,
} from "./github.ts";
import type { RunHistory } from "./history.ts";
import { renderDashboard, renderReport, type StepReport } from "./report.ts";
import { runPipeline } from "./runner.ts";
import { ConfigError } from "./types.ts";

/** The configuration read from the environment when starting the server. */
export interface ServerEnv {
  /** Token used to post commit statuses back to GitHub. */
  githubToken: string;
  /** Shared secret used to verify webhook signatures. */
  webhookSecret: string;
  /** Directory under which per-run git worktrees are created. */
  worktreeRoot: string;
  /** TCP port the webhook server listens on. */
  listenPort: number;
  /**
   * Externally-reachable base URL of the dashboard, used to link commit
   * statuses to their run reports. Undefined when `PUBLIC_URL` is unset.
   */
  publicUrl?: string;
  /**
   * GitHub account logins whose fork pull requests are built, from
   * `TRUSTED_PR_OWNERS`. Empty when unset, which builds no fork pull request.
   */
  trustedPrOwners: ReadonlySet<string>;
}

/**
 * Read and validate the server's settings from environment variables
 * (`GITHUB_TOKEN`, `WEBHOOK_SECRET`, `WORKTREE_ROOT`, `LISTEN_PORT`). Throws a
 * {@link ConfigError} naming the first missing or invalid variable.
 */
export function serverConfigFromEnv(
  env: Record<string, string | undefined>,
): ServerEnv {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new ConfigError(`Missing required environment variable ${name}`);
    }
    return value;
  };

  const githubToken = required("GITHUB_TOKEN");
  const webhookSecret = required("WEBHOOK_SECRET");
  const worktreeRoot = required("WORKTREE_ROOT");

  const portText = required("LISTEN_PORT");
  const listenPort = Number(portText);
  if (
    !Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535
  ) {
    throw new ConfigError(
      `LISTEN_PORT must be a port number between 1 and 65535, got "${portText}"`,
    );
  }

  // Optional: when set, commit statuses link back to the run's dashboard page.
  const publicUrlRaw = env["PUBLIC_URL"];
  const publicUrl = publicUrlRaw !== undefined && publicUrlRaw.trim() !== ""
    ? publicUrlRaw.trim()
    : undefined;

  // Optional, and empty by default: a fork pull request runs its author's code
  // on this host, so none is built until an owner is named here.
  const trustedPrOwners = parseTrustedOwners(env["TRUSTED_PR_OWNERS"]);

  return {
    githubToken,
    webhookSecret,
    worktreeRoot,
    listenPort,
    publicUrl,
    trustedPrOwners,
  };
}

/**
 * Verify that `cwd` is the root of a git checkout that contains `configFile`,
 * returning the resolved checkout root. Throws a {@link ConfigError} when the
 * directory is not a checkout, is not the checkout's top level, or the config
 * file is missing — the preconditions for serving from this directory.
 */
export async function verifyCheckout(
  git: GitClient,
  cwd: string,
  configFile: string,
): Promise<string> {
  const root = await git.repoRoot(cwd);
  if (root === undefined) {
    throw new ConfigError(`Working directory is not a git checkout: ${cwd}`);
  }
  if (realpathSync(root) !== realpathSync(cwd)) {
    throw new ConfigError(
      `--serve must be run from the root of the git checkout (its root is ${root})`,
    );
  }
  if (!existsSync(resolve(cwd, configFile))) {
    throw new ConfigError(
      `Config file "${configFile}" not found in the checkout root`,
    );
  }
  return root;
}

/** Outcome of one CI job: whether it passed, plus its HTML report. */
export interface JobResult {
  ok: boolean;
  /** Self-contained HTML report of the run, stored in the run history. */
  report?: string;
}

/** Default minutes a single commit's pipeline may run before it is aborted. */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 30;

/**
 * How a checked-out worktree is built and run; injectable for tests. `onReport`
 * may be called any number of times with successive versions of the run's HTML
 * report — once when the run starts (all steps pending) and again as each step
 * finishes — so the server can publish an incrementally updating report. The
 * final report is returned in the {@link JobResult}. `signal` aborts when the
 * job exceeds its timeout; the run is expected to stop its containers and
 * resolve (with `ok: false`) rather than keep working.
 */
export type RunJob = (
  worktreeDir: string,
  onReport: (report: string) => void,
  signal: AbortSignal,
) => Promise<JobResult>;

export interface CiServerOptions {
  /** Root of the git checkout to create worktrees from. */
  repoRoot: string;
  /** Config file name, resolved inside each worktree. */
  configFile: string;
  /** Shared secret for verifying webhook signatures. */
  secret: string;
  /** Directory under which per-run worktrees are created. */
  worktreeRoot: string;
  /** Git client; defaults to the real `git` CLI when constructed by the caller. */
  git: GitClient;
  /** Reporter for posting commit statuses back to GitHub. */
  status: StatusReporter;
  /** Run history every job is recorded in, served on the dashboard at `/`. */
  store: RunHistory;
  /**
   * Externally-reachable base URL of this dashboard (no trailing slash), used
   * to build the `target_url` linking each commit status to its run's report.
   * When omitted, statuses are posted without a "Details" link.
   */
  publicUrl?: string;
  /**
   * GitHub account logins whose fork pull requests are built. Defaults to empty,
   * which builds none: a pull request is built from the contributor's config
   * file, whose `only-if` and `$(...)` commands run on this host outside any
   * container, so listing an owner here extends them the same trust as push
   * access to the repository.
   */
  trustedPrOwners?: ReadonlySet<string>;
  /**
   * Build and run the pipeline for a worktree, resolving with the outcome and
   * the final HTML report and calling `onReport` with each interim report as the
   * run progresses. Defaults to loading `configFile` from the worktree and
   * running it with output capture, publishing a report that starts all-pending
   * and is rewritten as each step finishes.
   */
  run?: RunJob;
  /**
   * Minutes one commit's job (fetch, checkout and the whole pipeline) may take
   * before it is aborted and reported as failed. Defaults to
   * {@link DEFAULT_JOB_TIMEOUT_MINUTES}. Because commits are tested one at a
   * time, this also bounds how long a queued commit waits behind the one in
   * front of it.
   */
  jobTimeoutMinutes?: number;
  /**
   * Schedule `fire` after `ms` milliseconds, returning a canceller that
   * prevents it from firing. Used to enforce the job timeout; defaults to
   * setTimeout/clearTimeout. Injectable for tests.
   */
  timer?: (ms: number, fire: () => void) => () => void;
  /** Sink for progress messages; defaults to console.error. */
  log?: (message: string) => void;
}

/**
 * An HTTP server that acts as the backend for a GitHub `push` and
 * `pull_request` webhook. Each accepted commit is checked out into its own git
 * worktree and run as an independent CI pipeline, keeping the serving checkout
 * untouched.
 *
 * Commits are tested strictly **one at a time**: a webhook that arrives while a
 * pipeline is running is answered immediately and its commit queued, then built
 * when the commit in front of it passes or fails. Building several commits at
 * once oversubscribes the host — every pipeline wants the docker daemon, the
 * disk and `maxConcurrency` containers of its own — which is what used to bring
 * a busy server to a halt. Each job is also bounded by a timeout so one wedged
 * pipeline cannot hold the queue closed indefinitely.
 */
export class CiServer {
  readonly #repoRoot: string;
  readonly #configFile: string;
  readonly #secret: string;
  readonly #worktreeRoot: string;
  readonly #git: GitClient;
  readonly #status: StatusReporter;
  readonly #store: RunHistory;
  readonly #publicUrl?: string;
  readonly #trustedPrOwners: ReadonlySet<string>;
  readonly #run: RunJob;
  readonly #jobTimeoutMinutes: number;
  readonly #timer: (ms: number, fire: () => void) => () => void;
  readonly #log: (message: string) => void;
  readonly #server: Server;
  /**
   * Work in flight — the running job, plus any status posts made outside it —
   * tracked so shutdown can wait for it to finish.
   */
  readonly #jobs = new Set<Promise<void>>();
  /** Accepted commits waiting for the runner, oldest first. */
  readonly #queue: CiEvent[] = [];
  /** The job running right now, if any. Only one commit is tested at a time. */
  #active: Promise<void> | undefined;
  /** Monotonic counter making each worktree directory name unique. */
  #counter = 0;

  constructor(options: CiServerOptions) {
    this.#repoRoot = options.repoRoot;
    this.#configFile = options.configFile;
    this.#secret = options.secret;
    this.#worktreeRoot = options.worktreeRoot;
    this.#git = options.git;
    this.#status = options.status;
    this.#store = options.store;
    // Normalise away a trailing slash so `${publicUrl}/runs/<id>` is well-formed.
    this.#publicUrl = options.publicUrl?.replace(/\/+$/, "");
    this.#trustedPrOwners = options.trustedPrOwners ?? new Set();
    this.#jobTimeoutMinutes = options.jobTimeoutMinutes ??
      DEFAULT_JOB_TIMEOUT_MINUTES;
    this.#timer = options.timer ??
      ((ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
      });
    this.#log = options.log ?? ((m) => console.error(m));
    // Reconcile runs left `running` by a previous crash: this process now owns
    // the history, and any run still marked running was orphaned when the old
    // process died, so it can never finish. Mark them as errored on startup.
    const orphaned = this.#store.failRunning();
    if (orphaned > 0) {
      this.#log(`Marked ${orphaned} orphaned running job(s) as errored`);
    }
    this.#run = options.run ?? (async (dir, onReport, signal) => {
      const config = await loadConfig(resolve(dir, this.#configFile));
      const render = (steps: StepReport[], ok: boolean): string =>
        renderReport(steps, { ok, configFile: this.#configFile });
      const result = await runPipeline(config, {
        captureOutput: true,
        // On a timeout the pipeline stops every container and tears the network
        // down before resolving, so the next queued commit starts on a clean host.
        signal,
        // A run in progress has no verdict yet, so render interim reports as not
        // ok; renderReport shows a "running" header while any step is pending.
        onProgress: (steps) => onReport(render(steps, false)),
      });
      return { ok: result.ok, report: render(result.steps, result.ok) };
    });
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  /** Start listening on `port`, resolving once the socket is bound. */
  listen(port: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, () => {
        this.#server.removeListener("error", reject);
        resolvePromise();
      });
    });
  }

  /** The bound port, useful for tests that listen on an ephemeral port. */
  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") return 0;
    return address.port;
  }

  /** Number of accepted commits waiting behind the one being tested. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Wait for the queue to empty and every job in it to finish. The loop matters
   * because finishing one job starts the next, which joins the set after the
   * snapshot the previous `Promise.all` was taken from.
   */
  async drain(): Promise<void> {
    while (this.#jobs.size > 0) {
      await Promise.all([...this.#jobs]);
    }
  }

  /**
   * Stop accepting connections and wait for the job in flight to finish.
   * Commits still queued are dropped — waiting for a full queue could take
   * hours — and reported to GitHub so their checks do not sit pending forever.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.#server.close(() => resolvePromise());
    });
    for (const event of this.#queue.splice(0)) {
      this.#log(
        `CI dropped at shutdown: ${event.repo} ${event.branch}@${
          event.sha.slice(0, 12)
        }`,
      );
      this.#track(
        this.#report(
          event.repo,
          event.sha,
          "error",
          "whale-ci shut down before this commit was built",
        ),
      );
    }
    await this.drain();
  }

  /**
   * Route one request: the webhook on POST /webhook, the run dashboard on
   * GET /, and stored run reports on GET /runs/<id>.
   */
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path === "/") {
      if (req.method !== "GET") return reply(res, 405, "Method Not Allowed");
      return replyHtml(res, renderDashboard(this.#store.recent()));
    }

    const runId = path.match(/^\/runs\/(\d+)$/);
    if (runId !== null) {
      if (req.method !== "GET") return reply(res, 405, "Method Not Allowed");
      const report = this.#store.report(Number(runId[1]));
      if (report === undefined) return reply(res, 404, "No report for this run");
      return replyHtml(res, report);
    }

    if (path !== "/webhook") {
      return reply(res, 404, "Not Found");
    }
    if (req.method !== "POST") {
      return reply(res, 405, "Method Not Allowed");
    }

    const body = await readBody(req);
    const signature = header(req, "x-hub-signature-256");
    if (!verifySignature(this.#secret, body, signature)) {
      this.#log("Rejected webhook with an invalid signature");
      return reply(res, 401, "Invalid signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(res, 400, "Invalid JSON");
    }

    const event = header(req, "x-github-event");
    if (event === "ping") {
      return reply(res, 200, "pong");
    }

    if (event === "pull_request") {
      const decision = decidePullRequest(payload, this.#trustedPrOwners);
      if (!decision.run) {
        this.#log(`Ignoring pull request: ${decision.reason}`);
        return reply(res, 200, `Ignored (${decision.reason})`);
      }
      // Accept now and queue the commit so the webhook returns promptly.
      this.#enqueue(decision.event);
      return reply(res, 202, "Accepted");
    }

    if (event !== "push") {
      return reply(res, 204, "");
    }

    const push = parsePushEvent(payload);
    if (push === undefined) {
      return reply(res, 200, "Ignored (no buildable branch push)");
    }

    this.#enqueue(push);
    return reply(res, 202, "Accepted");
  }

  /** Add a job to the in-flight set, removing it once it settles. */
  #track(job: Promise<void>): void {
    const tracked = job.finally(() => this.#jobs.delete(tracked));
    this.#jobs.add(tracked);
  }

  /**
   * Accept a commit for testing: append it to the queue and start it if nothing
   * is running. A commit that has to wait gets a `pending` status right away,
   * since otherwise its check would show nothing at all for as long as the
   * queue takes to reach it.
   */
  #enqueue(event: CiEvent): void {
    const ahead = this.#queue.length + (this.#active === undefined ? 0 : 1);
    this.#queue.push(event);
    if (ahead > 0) {
      const runs = ahead === 1 ? "1 run" : `${ahead} runs`;
      this.#log(
        `CI queued: ${event.repo} ${event.branch}@${
          event.sha.slice(0, 12)
        } (${runs} ahead)`,
      );
      this.#track(
        this.#report(
          event.repo,
          event.sha,
          "pending",
          `Queued for CI (${runs} ahead)`,
        ),
      );
    }
    this.#pump();
  }

  /**
   * Start the next queued commit if the runner is idle. Called when a commit is
   * accepted and again whenever a job settles, so the queue keeps draining one
   * commit at a time.
   */
  #pump(): void {
    if (this.#active !== undefined) return;
    const event = this.#queue.shift();
    if (event === undefined) return;
    const job = this.#runJob(event)
      // #runJob reports its own failures; this only catches something thrown
      // around them (a broken run history, say), which must not wedge the queue.
      .catch((err: unknown) => {
        this.#log(`CI job aborted unexpectedly: ${(err as Error).message}`);
      })
      .finally(() => {
        this.#active = undefined;
        this.#pump();
      });
    this.#active = job;
    this.#track(job);
  }

  /**
   * Run one commit through CI in its own worktree: report `pending`, fetch the
   * event's ref, check the exact commit out into a fresh worktree, run the
   * pipeline, then report the outcome and remove the worktree. Any failure of
   * git or the pipeline is reported to GitHub as `error`/`failure`;
   * status-reporting failures are logged but never abort cleanup.
   *
   * The whole job is bounded by the configured timeout. Exceeding it aborts the
   * git operation or pipeline in flight — the pipeline stops its containers on
   * the way out — and fails the commit, so the next queued commit can start.
   */
  async #runJob(event: CiEvent): Promise<void> {
    const { repo, branch, sha, fetchRef } = event;
    const short = sha.slice(0, 12);
    const worktreeDir = resolve(
      this.#worktreeRoot,
      `${slugifyBranch(branch)}-${short}-${this.#counter++}`,
    );
    this.#log(`CI start: ${repo} ${branch}@${short} -> ${worktreeDir}`);

    const runId = this.#store.start({ branch, commit: sha });
    // Links GitHub's status "Details" straight to this run's report page.
    const targetUrl = this.#publicUrl === undefined
      ? undefined
      : `${this.#publicUrl}/runs/${runId}`;
    await this.#report(
      repo,
      sha,
      "pending",
      `Running CI for ${branch}`,
      targetUrl,
    );

    // Bound the job: a pipeline that never finishes would otherwise hold the
    // queue — and every commit behind it — closed forever.
    const controller = new AbortController();
    let timedOut = false;
    const expired = `CI timed out after ${
      this.#jobTimeoutMinutes === 1 ? "1 minute" : `${this.#jobTimeoutMinutes} minutes`
    }`;
    const cancelTimeout = this.#timer(this.#jobTimeoutMinutes * 60_000, () => {
      timedOut = true;
      this.#log(`${expired}: ${repo} ${branch}@${short}`);
      controller.abort();
    });

    let created = false;
    try {
      await this.#git.fetch(this.#repoRoot, fetchRef, controller.signal);
      // Always the SHA from the event, never the tip of what was just
      // fetched: a push racing this run must not swap in a commit that never
      // passed the checks in `decidePullRequest`. If the ref has since moved
      // and the object is gone, the worktree add fails and the run errors,
      // which is the safe direction to fail in.
      await this.#git.addWorktree(
        this.#repoRoot,
        worktreeDir,
        sha,
        controller.signal,
      );
      created = true;

      // Publish each interim report as the run progresses, so the report page
      // at /runs/<id> updates live even though we do not stream.
      const result = await this.#run(
        worktreeDir,
        (interim) => this.#store.update(runId, interim),
        controller.signal,
      );
      // An aborted pipeline resolves with ok: false and a partial report; the
      // commit failed either way, but say which so the check is not a mystery.
      const ok = result.ok && !timedOut;
      this.#store.finish(runId, ok ? "success" : "failure", result.report);
      this.#log(
        `CI ${ok ? "passed" : "failed"}: ${repo} ${branch}@${short}`,
      );
      await this.#report(
        repo,
        sha,
        ok ? "success" : "failure",
        timedOut ? expired : ok ? "CI passed" : "CI failed",
        targetUrl,
      );
    } catch (err) {
      // A timeout that lands during fetch or checkout surfaces as git's abort
      // error, which says nothing useful; report the timeout instead.
      const message = timedOut ? expired : (err as Error).message;
      this.#store.finish(runId, "error");
      this.#log(`CI error: ${repo} ${branch}@${short}: ${message}`);
      await this.#report(repo, sha, "error", message, targetUrl);
    } finally {
      cancelTimeout();
      if (created) {
        // Cleanup is deliberately not bound by the timeout: leaving the
        // worktree behind would leak disk for every timed-out commit.
        await this.#git.removeWorktree(this.#repoRoot, worktreeDir);
      }
    }
  }

  /** Post a commit status, logging (not throwing) if GitHub rejects it. */
  async #report(
    repo: string,
    sha: string,
    state: Parameters<StatusReporter["report"]>[2],
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    try {
      await this.#status.report(repo, sha, state, description, targetUrl);
    } catch (err) {
      this.#log(`Failed to report ${state} status: ${(err as Error).message}`);
    }
  }
}

/** Read the entire request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolvePromise(body));
    req.on("error", reject);
  });
}

/** A single request header value, or undefined when absent or repeated. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Send a plain-text response with the given status code. */
function reply(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(text);
}

/** Send a 200 HTML response. */
function replyHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
