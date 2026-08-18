#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  binary,
  command,
  extendType,
  flag,
  number,
  option,
  optional,
  positional,
  run,
  string,
} from "cmd-ts";
import { loadConfig, restrictToStep } from "../lib/config.ts";
import { dumpEvaluatedConfig } from "../lib/dump.ts";
import { CliGitClient } from "../lib/git.ts";
import { GitHubStatusReporter } from "../lib/github.ts";
import { RunStore } from "../lib/history.ts";
import { runShell } from "../lib/proc.ts";
import { renderReport } from "../lib/report.ts";
import { runPipeline } from "../lib/runner.ts";
import {
  CiServer,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  serverConfigFromEnv,
  verifyCheckout,
} from "../lib/server.ts";
import { ConfigError } from "../lib/types.ts";

/** A whole number of containers, at least one. */
const positiveInteger = extendType(number, {
  async from(value) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("must be a positive integer");
    }
    return value;
  },
});

/**
 * The whale-ci command. cmd-ts handles `--help`/`-h` and argument validation
 * (missing config file, unknown options) for us, exiting with the right code
 * and message. The handler runs the pipeline and returns the process exit code.
 */
export const app = command({
  name: "whale-ci",
  description:
    "Continuous integration with linked docker containers. Builds the images " +
    "described by the YAML config (in parallel where dependencies allow), runs " +
    "each step's command, and stops every container when the run finishes. " +
    "Exits non-zero if any build or command fails.",
  args: {
    output: option({
      type: optional(string),
      long: "output",
      short: "o",
      description:
        "Write a self-contained HTML report (per-step output, pass/fail and " +
        "duration) to this file.",
    }),
    maxConcurrency: option({
      type: positiveInteger,
      long: "max-concurrency",
      defaultValue: () => 4,
      defaultValueIsSerializable: true,
      description:
        "Maximum number of test containers running in parallel, shared " +
        "jointly by docker and incus steps (service containers do not count " +
        "toward the limit).",
    }),
    dumpYaml: flag({
      long: "dump-yaml",
      description:
        "Do not build. Instead print the config file to stdout with every " +
        "value the runner evaluates on the host shown in its evaluated form: " +
        "$(...) push tags are replaced by their command output, and step and " +
        "push only-if conditions are annotated with whether they pass. Useful " +
        "for debugging a pipeline definition.",
    }),
    jobTimeout: option({
      type: positiveInteger,
      long: "job-timeout",
      defaultValue: () => DEFAULT_JOB_TIMEOUT_MINUTES,
      defaultValueIsSerializable: true,
      description:
        "Server mode only: the number of minutes one commit's pipeline may " +
        "run before it is aborted and the commit reported as failed. The " +
        "server tests one commit at a time, so this also bounds how long a " +
        "queued commit waits behind the one in front of it.",
    }),
    serve: flag({
      long: "serve",
      description:
        "Run as a CI server: a GitHub push-webhook backend that checks each " +
        "pushed commit out into its own git worktree and runs the pipeline. " +
        "Must be run from the root of the git checkout containing the config " +
        "file. Reads GITHUB_TOKEN, WEBHOOK_SECRET, WORKTREE_ROOT and " +
        "LISTEN_PORT from the environment, plus the optional ADMIN_USERNAME " +
        "and ADMIN_PASSWORD that guard rerunning a failed run from the " +
        "dashboard.",
    }),
    configFile: positional({
      type: string,
      displayName: "config.yml",
      description: "Path to the YAML pipeline configuration file.",
    }),
    step: positional({
      type: optional(string),
      displayName: "step",
      description:
        "Run only this step, plus the steps it (transitively) depends on. " +
        "All other steps are skipped entirely.",
    }),
  },
  handler: (
    { output, serve, dumpYaml, configFile, step, maxConcurrency, jobTimeout },
  ) => {
    if (serve && step !== undefined) {
      console.error("Error: a step name cannot be combined with --serve");
      return Promise.resolve(1);
    }
    if (dumpYaml && serve) {
      console.error("Error: --dump-yaml cannot be combined with --serve");
      return Promise.resolve(1);
    }
    if (dumpYaml) {
      return runDumpYaml(configFile);
    }
    return serve
      ? runServe(configFile, jobTimeout)
      : runCli(configFile, maxConcurrency, output, step);
  },
});

/**
 * Load the config, run the pipeline and (optionally) write the HTML report.
 * Returns the process exit code: 0 on success, 1 on failure, 130 if interrupted.
 */
async function runCli(
  configFile: string,
  maxConcurrency: number,
  output?: string,
  step?: string,
): Promise<number> {
  try {
    let config = await loadConfig(configFile);
    if (step !== undefined) {
      config = restrictToStep(config, step);
    }

    // On Ctrl-C, abort the run so every container is stopped before exiting; a
    // second Ctrl-C force-quits in case teardown itself hangs.
    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = (): void => {
      interrupts += 1;
      if (interrupts === 1) {
        console.error(
          "\nInterrupted — stopping containers (press Ctrl-C again to force quit)...",
        );
        controller.abort();
      } else {
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);

    // Every run is recorded in the shared run history, tagged with the
    // branch/commit when run from a git checkout. Output is always captured so
    // the stored record carries the full HTML report.
    const store = new RunStore();
    const runId = store.start(await gitContext());

    let result;
    try {
      result = await runPipeline(config, {
        captureOutput: true,
        signal: controller.signal,
        maxConcurrency,
      });
    } catch (err) {
      store.finish(runId, "error");
      store.close();
      throw err;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    const html = renderReport(result.steps, { ok: result.ok, configFile });
    store.finish(runId, result.ok ? "success" : "failure", html);
    store.close();

    if (output !== undefined) {
      await writeFile(output, html, "utf8");
      console.error(`Report written to ${output}`);
    }

    // 130 is the conventional exit code for a SIGINT-interrupted process.
    if (controller.signal.aborted) return 130;
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * Print the config file to stdout with every host-evaluated value (push tags,
 * only-if conditions) shown in its evaluated form, without running the build.
 * The config is validated first so the usual errors still surface. Returns the
 * process exit code: 0 on success, 1 on a config error.
 */
async function runDumpYaml(configFile: string): Promise<number> {
  try {
    // Validate the config (and resolve implicit dependencies) so a malformed
    // file is reported just as it would be for a real run.
    await loadConfig(configFile);
    const text = await readFile(configFile, "utf8");
    process.stdout.write(await dumpEvaluatedConfig(text));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * The branch and commit of the current working directory's git checkout, for
 * tagging a one-shot run in the run history. Both are best effort: outside a
 * checkout (or on a detached HEAD, for the branch) they are left undefined.
 */
async function gitContext(): Promise<{ branch?: string; commit?: string }> {
  const value = async (command: string): Promise<string | undefined> => {
    const { code, stdout } = await runShell(command);
    const text = stdout.trim();
    return code === 0 && text !== "" ? text : undefined;
  };
  return {
    branch: await value("git branch --show-current"),
    commit: await value("git rev-parse HEAD"),
  };
}

/**
 * Run as a GitHub webhook CI server. Validates that the current directory is the
 * root of a git checkout containing `configFile`, reads its settings from the
 * environment, and serves until interrupted (Ctrl-C), letting the CI job in
 * flight finish before returning. Commits are tested one at a time, each bounded
 * by `jobTimeoutMinutes`. Returns the process exit code.
 */
async function runServe(
  configFile: string,
  jobTimeoutMinutes: number,
): Promise<number> {
  try {
    const env = serverConfigFromEnv(process.env);
    const git = new CliGitClient();
    const repoRoot = await verifyCheckout(git, process.cwd(), configFile);

    // The worktree root must exist before git can add worktrees under it.
    await mkdir(env.worktreeRoot, { recursive: true });

    const store = new RunStore();
    const server = new CiServer({
      repoRoot,
      configFile,
      secret: env.webhookSecret,
      worktreeRoot: env.worktreeRoot,
      git,
      status: new GitHubStatusReporter(env.githubToken),
      store,
      publicUrl: env.publicUrl,
      trustedPrOwners: env.trustedPrOwners,
      auth: env.auth,
      jobTimeoutMinutes,
    });

    await server.listen(env.listenPort);
    console.error(
      `whale-ci serving webhooks on port ${env.listenPort} ` +
        `(dashboard at ${env.publicUrl ?? `http://localhost:${env.listenPort}`}/, ` +
        `checkout ${repoRoot}, worktrees under ${env.worktreeRoot}, ` +
        `one commit at a time, ${jobTimeoutMinutes} minute job timeout)`,
    );
    if (env.auth.password === undefined) {
      console.error(
        "ADMIN_PASSWORD is not set: /login always fails and the dashboard is " +
          "read-only (no rerun buttons)",
      );
    }

    // Run until Ctrl-C, then stop listening and let the running job finish.
    await new Promise<void>((resolvePromise) => {
      const onSigint = (): void => {
        console.error("\nShutting down; waiting for the in-flight CI job...");
        process.removeListener("SIGINT", onSigint);
        void server.close().then(resolvePromise);
      };
      process.on("SIGINT", onSigint);
    });
    store.close();
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * True when this module is the process entry point (rather than imported, e.g.
 * by tests). Portable across Node 22+ — `import.meta.main` only exists on Node
 * 24.2+. `realpathSync` resolves the npx bin symlink so it matches the module
 * URL.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked as the CLI entry point, so the module can also be
// imported (e.g. by tests) without executing the pipeline. cmd-ts's `run`
// handles `--help` and parse errors by printing and exiting directly; the
// handler's resolved value is the exit code for a successful parse.
if (isEntryPoint()) {
  run(binary(app), process.argv).then(
    async (code) => {
      process.exitCode = await code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
