import { spawn } from "node:child_process";

/**
 * The git operations the CI server needs. Abstracted behind an interface so the
 * server can be tested without a real git repository.
 */
export interface GitClient {
  /**
   * Absolute path of the top-level directory of the git checkout containing
   * `dir`, or `undefined` when `dir` is not inside a git checkout.
   */
  repoRoot(dir: string): Promise<string | undefined>;
  /**
   * Fetch `ref` (a branch name or commit) from `origin` into the checkout at
   * `dir`, so a just-pushed commit is available locally before we check it out.
   * Aborting `signal` kills the fetch, so a hung network operation cannot hold
   * a job (and the commits queued behind it) open forever.
   */
  fetch(dir: string, ref: string, signal?: AbortSignal): Promise<void>;
  /**
   * Create a detached worktree at `path` checked out to `commit`. The repo is
   * the checkout rooted at `dir`. Aborting `signal` kills the checkout.
   */
  addWorktree(
    dir: string,
    path: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Remove the worktree at `path` (best effort; never rejects). */
  removeWorktree(dir: string, path: string): Promise<void>;
}

/** Result of running a git subprocess. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Build the argv for `git fetch origin <ref>`. */
export function fetchArgs(ref: string): string[] {
  return ["fetch", "origin", ref];
}

/** Build the argv for creating a detached worktree at `path` on `commit`. */
export function addWorktreeArgs(path: string, commit: string): string[] {
  return ["worktree", "add", "--detach", path, commit];
}

/** Build the argv for force-removing the worktree at `path`. */
export function removeWorktreeArgs(path: string): string[] {
  return ["worktree", "remove", "--force", path];
}

/**
 * Turn a branch name into a filesystem-safe slug for use in a worktree
 * directory name. Anything outside `[A-Za-z0-9._-]` (e.g. the slashes in
 * `feature/foo`) becomes a dash, and leading dots/dashes are trimmed so the
 * result is never hidden or option-like.
 */
export function slugifyBranch(branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return slug.length > 0 ? slug : "branch";
}

/** A GitClient that shells out to the real `git` binary. */
export class CliGitClient implements GitClient {
  readonly #git: string;

  constructor(git = "git") {
    this.#git = git;
  }

  async repoRoot(dir: string): Promise<string | undefined> {
    const result = await this.#run(dir, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return undefined;
    return result.stdout.trim();
  }

  async fetch(dir: string, ref: string, signal?: AbortSignal): Promise<void> {
    await this.#run(dir, fetchArgs(ref), { check: true, signal });
  }

  async addWorktree(
    dir: string,
    path: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#run(dir, addWorktreeArgs(path, commit), { check: true, signal });
  }

  async removeWorktree(dir: string, path: string): Promise<void> {
    // Best effort: a job may fail before the worktree is even created.
    await this.#run(dir, removeWorktreeArgs(path));
  }

  /**
   * Spawn `git -C <dir>` with the given args, capturing stdout/stderr. Rejects
   * on a non-zero exit only when `check` is set; otherwise resolves with the
   * captured result so callers can inspect the exit code themselves. An
   * aborted `signal` kills the subprocess, which rejects with its abort error.
   */
  #run(
    dir: string,
    args: string[],
    opts: { check?: boolean; signal?: AbortSignal } = {},
  ): Promise<GitResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.#git, ["-C", dir, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        const exitCode = code ?? 1;
        if (exitCode !== 0 && opts.check) {
          reject(
            new Error(
              `git ${args.join(" ")} exited with ${exitCode}: ${stderr.trim()}`,
            ),
          );
        } else {
          resolvePromise({ code: exitCode, stdout, stderr });
        }
      });
    });
  }
}
