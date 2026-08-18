import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The commit-status states GitHub accepts. `pending` is posted when a check
 * starts, then one of the others when it finishes.
 */
export type CommitState = "pending" | "success" | "failure" | "error";

/** A commit that should trigger a CI run, extracted from a webhook payload. */
export interface CiEvent {
  /**
   * `owner/repo` of the repository commit statuses are posted to, used to
   * address the GitHub API. For a pull request this is the *base* repository —
   * the one this server builds — not the fork the commit came from.
   */
  repo: string;
  /**
   * The branch the commit sits on (no `refs/heads/` prefix); for a pull request
   * from a fork, the branch name within that fork. Used for the run history and
   * to name the worktree, never to fetch — see {@link fetchRef}.
   */
  branch: string;
  /** The commit SHA that CI runs against. */
  sha: string;
  /**
   * The ref to `git fetch` from `origin` to make {@link sha} available locally.
   * For a push this is just the branch. For a pull request it is
   * `refs/pull/<n>/head`: the head commit lives in a fork, which the serving
   * checkout has no remote for, and GitHub publishes it in the base repository
   * only under that ref.
   */
  fetchRef: string;
}

/**
 * Posts commit statuses back to GitHub. Abstracted behind an interface so the
 * server can be tested without making real API calls.
 */
export interface StatusReporter {
  report(
    repo: string,
    sha: string,
    state: CommitState,
    description: string,
    /**
     * URL GitHub links to as the status's "Details" — the run's dashboard
     * report page. Omitted when the server has no configured public URL.
     */
    targetUrl?: string,
  ): Promise<void>;
}

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` header against the raw request
 * body using the shared secret. GitHub sends `sha256=<hex hmac>`; we recompute
 * the HMAC and compare in constant time. Returns false for a missing or
 * malformed header rather than throwing.
 */
export function verifySignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined || !signature.startsWith("sha256=")) {
    return false;
  }
  const expected = "sha256=" +
    createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; unequal length means no match.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A non-empty string property of `object`, or undefined when absent. */
function text(object: unknown, name: string): string | undefined {
  if (typeof object !== "object" || object === null) return undefined;
  const value = (object as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A nested object property of `object`, or undefined when absent. */
function nested(object: unknown, name: string): unknown {
  if (typeof object !== "object" || object === null) return undefined;
  return (object as Record<string, unknown>)[name];
}

/**
 * Extract the CI-relevant fields from a parsed `push` webhook payload, or
 * `undefined` when the push should be ignored: a branch deletion, a tag (or any
 * non-branch ref), or a payload missing the fields we need.
 */
export function parsePushEvent(payload: unknown): CiEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as Record<string, unknown>;

  // A branch deletion has nothing to build.
  if (body["deleted"] === true) return undefined;

  const ref = body["ref"];
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    return undefined;
  }
  const branch = ref.slice("refs/heads/".length);

  const sha = body["after"];
  // The all-zero SHA is GitHub's sentinel for a deleted ref.
  if (typeof sha !== "string" || /^0+$/.test(sha)) return undefined;

  const repo = text(body["repository"], "full_name");
  if (repo === undefined) return undefined;

  // The pushed branch exists in origin, so it is fetched by name.
  return { repo, branch, sha, fetchRef: branch };
}

/**
 * Pull request actions that mean the head commit is new or newly proposed, and
 * so should be built. Every other action (`closed`, `labeled`, `edited`, ...)
 * leaves the head commit unchanged and is ignored, so that relabelling a pull
 * request does not rebuild it. `synchronize` is the one that fires when a
 * contributor pushes further commits to an open pull request.
 */
const BUILDABLE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** The ref under which a pull request's head commit is published in the base repo. */
export function pullRequestRef(number: number): string {
  return `refs/pull/${number}/head`;
}

/**
 * Parse a `TRUSTED_PR_OWNERS` value into the set of GitHub account logins whose
 * fork pull requests may be built. Logins are compared case-insensitively, so
 * they are folded to lower case here. An unset, empty, or all-blank value yields
 * an empty set — which builds no fork pull request at all. There is deliberately
 * no wildcard: see {@link decidePullRequest} for why this list is a list of
 * people you would grant a shell to.
 */
export function parseTrustedOwners(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((owner) => owner.trim().toLowerCase())
      .filter((owner) => owner !== ""),
  );
}

/**
 * Parse a comma-separated list of branch names into the set of branches whose
 * webhooks are ignored entirely. Blank entries are dropped and surrounding
 * whitespace trimmed; case is kept as written, since git branch names are
 * case-sensitive. An unset or all-blank value yields an empty set, which
 * ignores nothing.
 */
export function parseIgnoredBranches(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((branch) => branch.trim())
      .filter((branch) => branch !== ""),
  );
}

/** Whether a `pull_request` payload should be built, and if not, why not. */
export type PullRequestDecision =
  | { run: true; event: CiEvent }
  | { run: false; reason: string };

/**
 * Decide whether a parsed `pull_request` webhook payload should be built.
 *
 * Building a pull request runs the *contributor's* config file, including its
 * `only-if` and `$(...)` commands, which execute on this host outside any
 * container. Building a fork pull request is therefore equivalent to giving its
 * author a shell on the CI machine, and is allowed only for the account logins
 * in `trustedOwners` (from `TRUSTED_PR_OWNERS`). With that set empty — the
 * default — no fork pull request is ever built and this server behaves exactly
 * as it did before pull request support existed.
 *
 * A pull request opened from a branch in the base repository itself is not
 * built here: pushing that branch already produced a `push` event that built
 * the same commit, and building both would run every such commit twice.
 */
export function decidePullRequest(
  payload: unknown,
  trustedOwners: ReadonlySet<string>,
): PullRequestDecision {
  const action = text(payload, "action");
  if (action === undefined) {
    return { run: false, reason: "malformed pull request payload" };
  }
  if (!BUILDABLE_ACTIONS.has(action)) {
    return { run: false, reason: `action "${action}" leaves the head commit unchanged` };
  }

  const pull = nested(payload, "pull_request");
  const head = nested(pull, "head");
  const headRepo = nested(head, "repo");

  const number = nested(pull, "number");
  const sha = text(head, "sha");
  const branch = text(head, "ref");
  // The base repository: the one whose webhook this is, and whose API the
  // resulting commit statuses are posted to.
  const repo = text(nested(payload, "repository"), "full_name");
  const headFullName = text(headRepo, "full_name");
  const owner = text(nested(headRepo, "owner"), "login");

  if (
    typeof number !== "number" || !Number.isInteger(number) || number <= 0 ||
    sha === undefined || branch === undefined || repo === undefined ||
    headFullName === undefined || owner === undefined
  ) {
    return { run: false, reason: "malformed pull request payload" };
  }

  // Checked before the trust check so that the maintainer's own pull requests
  // are reported as the duplicates they are rather than as untrusted forks.
  if (headFullName.toLowerCase() === repo.toLowerCase()) {
    return {
      run: false,
      reason: "same-repo pull request; its push event already built this commit",
    };
  }

  if (!trustedOwners.has(owner.toLowerCase())) {
    return {
      run: false,
      reason: `fork owner "${owner}" is not in TRUSTED_PR_OWNERS`,
    };
  }

  return {
    run: true,
    event: { repo, branch, sha, fetchRef: pullRequestRef(number) },
  };
}

/** The GitHub API URL for setting a commit's status. */
export function statusUrl(repo: string, sha: string): string {
  return `https://api.github.com/repos/${repo}/statuses/${sha}`;
}

/** A StatusReporter that calls the GitHub commit-statuses API with a token. */
export class GitHubStatusReporter implements StatusReporter {
  readonly #token: string;
  readonly #context: string;

  constructor(token: string, context = "whale-ci") {
    this.#token = token;
    this.#context = context;
  }

  async report(
    repo: string,
    sha: string,
    state: CommitState,
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    const response = await fetch(statusUrl(repo, sha), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.#token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "whale-ci",
        "Content-Type": "application/json",
      },
      // GitHub truncates descriptions at 140 characters.
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: this.#context,
        // Only sent when a public URL is configured; GitHub renders it as the
        // status's "Details" link.
        ...(targetUrl !== undefined ? { target_url: targetUrl } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GitHub status update failed (${response.status}): ${text.trim()}`,
      );
    }
  }
}
