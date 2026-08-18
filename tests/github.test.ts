import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  decidePullRequest,
  parsePushEvent,
  parseIgnoredBranches,
  parseTrustedOwners,
  pullRequestRef,
  statusUrl,
  verifySignature,
} from "../lib/github.ts";

/** Compute the header GitHub would send for `body` signed with `secret`. */
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

test("verifySignature accepts a correct signature", () => {
  const body = '{"hello":"world"}';
  assert.equal(verifySignature("s3cret", body, sign("s3cret", body)), true);
});

test("verifySignature rejects wrong secret, body, or missing header", () => {
  const body = '{"hello":"world"}';
  assert.equal(verifySignature("s3cret", body, sign("other", body)), false);
  assert.equal(verifySignature("s3cret", "tampered", sign("s3cret", body)), false);
  assert.equal(verifySignature("s3cret", body, undefined), false);
  assert.equal(verifySignature("s3cret", body, "garbage"), false);
  // A sha1-style prefix is not accepted.
  assert.equal(verifySignature("s3cret", body, "sha1=deadbeef"), false);
});

test("parsePushEvent extracts repo, branch and sha, fetching by branch", () => {
  const event = parsePushEvent({
    ref: "refs/heads/feature/x",
    after: "abc123",
    repository: { full_name: "owner/repo" },
  });
  assert.deepEqual(event, {
    repo: "owner/repo",
    branch: "feature/x",
    sha: "abc123",
    // A pushed branch exists in origin, so it is fetched under its own name.
    fetchRef: "feature/x",
  });
});

test("parsePushEvent ignores tags, deletions and malformed payloads", () => {
  // A tag push (not refs/heads/).
  assert.equal(
    parsePushEvent({
      ref: "refs/tags/v1",
      after: "abc",
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // A branch deletion via the `deleted` flag.
  assert.equal(
    parsePushEvent({
      ref: "refs/heads/main",
      after: "abc",
      deleted: true,
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // A branch deletion via the all-zero SHA sentinel.
  assert.equal(
    parsePushEvent({
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // Missing repository full_name.
  assert.equal(
    parsePushEvent({ ref: "refs/heads/main", after: "abc" }),
    undefined,
  );
  assert.equal(parsePushEvent(null), undefined);
  assert.equal(parsePushEvent("nope"), undefined);
});

/** Logins the fork pull request tests trust. */
const TRUSTED = new Set(["bob"]);

/**
 * A `pull_request` payload for PR #42, opened from `bob/repo` against
 * `owner/repo`, with `patch` merged over the pull request object.
 */
function pullPayload(
  action: string,
  patch: Record<string, unknown> = {},
): unknown {
  return {
    action,
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 42,
      head: {
        ref: "feature/x",
        sha: "deadbeefcafe",
        repo: { full_name: "bob/repo", owner: { login: "bob" } },
      },
      ...patch,
    },
  };
}

test("decidePullRequest builds a trusted fork PR from its pull ref", () => {
  const decision = decidePullRequest(pullPayload("synchronize"), TRUSTED);
  assert.deepEqual(decision, {
    run: true,
    event: {
      // Statuses go to the base repo, not the fork the commit came from.
      repo: "owner/repo",
      branch: "feature/x",
      sha: "deadbeefcafe",
      // The fork is not a remote of the serving checkout, so the commit is
      // reachable only under the base repo's pull ref.
      fetchRef: "refs/pull/42/head",
    },
  });
});

test("decidePullRequest builds every action that moves the head commit", () => {
  for (const action of ["opened", "synchronize", "reopened"]) {
    assert.equal(decidePullRequest(pullPayload(action), TRUSTED).run, true, action);
  }
});

test("decidePullRequest ignores actions that leave the head commit alone", () => {
  for (const action of ["closed", "labeled", "edited", "assigned"]) {
    const decision = decidePullRequest(pullPayload(action), TRUSTED);
    assert.equal(decision.run, false, action);
  }
});

test("decidePullRequest refuses a fork whose owner is not trusted", () => {
  const decision = decidePullRequest(pullPayload("synchronize"), new Set(["alice"]));
  assert.equal(decision.run, false);
  assert.match((decision as { reason: string }).reason, /bob.*TRUSTED_PR_OWNERS/);
});

test("decidePullRequest refuses every fork when no owner is trusted", () => {
  // The default: an operator who adds the webhook event but no allowlist gets
  // exactly the old behaviour rather than an open door.
  assert.equal(decidePullRequest(pullPayload("synchronize"), new Set()).run, false);
});

test("decidePullRequest compares owner logins case-insensitively", () => {
  const payload = pullPayload("synchronize", {
    number: 42,
    head: {
      ref: "feature/x",
      sha: "deadbeefcafe",
      repo: { full_name: "Bob/repo", owner: { login: "BoB" } },
    },
  });
  assert.equal(decidePullRequest(payload, new Set(["bob"])).run, true);
});

test("decidePullRequest skips a same-repo PR the push event already built", () => {
  const payload = pullPayload("synchronize", {
    number: 42,
    head: {
      ref: "feature/x",
      sha: "deadbeefcafe",
      repo: { full_name: "owner/repo", owner: { login: "owner" } },
    },
  });
  // Even with the owner trusted, this must not produce a second run.
  const decision = decidePullRequest(payload, new Set(["owner"]));
  assert.equal(decision.run, false);
  assert.match((decision as { reason: string }).reason, /same-repo/);
});

test("decidePullRequest refuses malformed payloads", () => {
  const malformed: unknown[] = [
    null,
    "nope",
    {},
    // No pull_request object.
    { action: "opened", repository: { full_name: "owner/repo" } },
    // No head repo, so no owner to check against the allowlist.
    pullPayload("opened", {
      number: 42,
      head: { ref: "x", sha: "abc" },
    }),
    // Head repo without an owner login.
    pullPayload("opened", {
      number: 42,
      head: { ref: "x", sha: "abc", repo: { full_name: "bob/repo" } },
    }),
    // A non-integer PR number would build a nonsense pull ref.
    pullPayload("opened", { number: "42" }),
  ];
  for (const payload of malformed) {
    assert.equal(decidePullRequest(payload, TRUSTED).run, false, JSON.stringify(payload));
  }
});

test("parseTrustedOwners splits, trims and folds case; blank means nobody", () => {
  assert.deepEqual(parseTrustedOwners("alice, BoB ,carol"), new Set(["alice", "bob", "carol"]));
  assert.deepEqual(parseTrustedOwners(undefined), new Set());
  assert.deepEqual(parseTrustedOwners(""), new Set());
  assert.deepEqual(parseTrustedOwners("  "), new Set());
  // Stray separators must not become an empty-string login that matches a
  // payload with a missing owner.
  assert.deepEqual(parseTrustedOwners("alice,,"), new Set(["alice"]));
});

test("pullRequestRef names the base repo's ref for a PR head", () => {
  assert.equal(pullRequestRef(42), "refs/pull/42/head");
});

test("statusUrl addresses the commit-statuses API", () => {
  assert.equal(
    statusUrl("owner/repo", "abc123"),
    "https://api.github.com/repos/owner/repo/statuses/abc123",
  );
});

test("parseIgnoredBranches splits and trims but keeps case", () => {
  assert.deepEqual(
    parseIgnoredBranches("gh-pages, Feature/X ,wip"),
    new Set(["gh-pages", "Feature/X", "wip"]),
  );
  assert.deepEqual(parseIgnoredBranches(undefined), new Set());
  assert.deepEqual(parseIgnoredBranches(""), new Set());
  assert.deepEqual(parseIgnoredBranches("  "), new Set());
  // Empty entries from a trailing or doubled comma are dropped.
  assert.deepEqual(parseIgnoredBranches("gh-pages,,"), new Set(["gh-pages"]));
});
