# whale-ci
Continuous integration with docker containers

This runs CI jobs that are defined in docker containers. The containers 
are defined in a YAML file listing the various containers and their dockerfiles.

# configuration file

Example:

```yaml
build:
    dockerfile: ./Dockerfile.build

database:
    image: postgres
    service: true
    environment:
       POSTGRES_HOST_AUTH_METHOD: trust
    ports: 5432

test:
    dockerfile: ./Dockerfile.test
    depends:
      - build
      - database
    command: runtests

```

Each section is named container which has a docker file or a container name 
on the linked docker registry.

The valid keys in each section are:

* dockerfile: A path to a Docker file to build, relative to the yaml file
  locatiom. If the Dockerfile's first `FROM` instruction names another step that
  also builds from a `dockerfile`, that step's freshly-built image is used as the
  base image instead of being pulled from a registry, and an implicit dependency
  on that step is added (even without `depends`) so it is built first. For
  example, a `base` step building a common image and an `app` step whose
  Dockerfile starts `FROM base` will have `app` built on top of `base`. The
  base substitution is per-run, so several pipelines can build in parallel
  without clobbering one another's images.
* image: the image to pull if there is no docker file. If the value matches the
  name of another step that builds its own image (a step with a `dockerfile`),
  that step's generated image is used instead of pulling from the registry, and
  an implicit dependency on that step is added (even without `depends`).
  Otherwise the image is pulled from Docker Hub as usual.
* runtime: `docker` or `incus` (default `docker`). The container runtime the
  step runs under. A step with `runtime: incus` runs in an ephemeral [incus]
  (https://linuxcontainers.org/incus/) instance using the `incus` CLI, which is
  assumed to be installed and usable by the current user: the instance is
  launched from the step's `image` (an incus image reference such as
  `images:debian/12`), each command runs inside it with `incus exec` (the
  instance's filesystem persists between commands), and the instance is deleted
  when the step finishes. After launching, whale-ci waits (up to a minute) for
  the instance to be assigned an IPv4 address before running the first
  command, so commands that reach for the network do not race the instance's
  DHCP/DNS setup. An incus step must use `image` — incus cannot build
  a `dockerfile` — and its image always refers to an incus image, never to
  another step's built image. Incus steps cannot be services and cannot depend
  on services, because there is no shared network between incus and docker
  steps (see "Networking between steps" below). They may otherwise depend on
  and be depended on by any non-service step, and `--max-concurrency` applies
  jointly across both runtimes.
* service: `true` or `false` (default `false`). A service runs in the background
  for as long as at least one other step still depends on it, and is stopped as
  soon as it is no longer required. A non-service runs its command to completion.
* depends: the name (or list of names) of other steps that must be ready before
  this step runs. A dependency that is a service must be running first; a
  dependency that is not a service must have completed first.
* command: the command to run inside the container. May be a single string or a
  list of strings. A list runs in order, stopping at the first command that
  exits non-zero (which fails the step). Each command runs through the image's
  entrypoint just like a single command would, and the container's filesystem is
  committed between commands so changes from one carry forward to the next. A
  service step may have at most one command.

  A plain command is split into words (honouring quotes) and run directly,
  without a shell. A command containing unquoted shell syntax — pipes,
  `&&`/`;`, redirections, `$VAR` or `$(...)` substitutions, backquotes, globs
  (`*`, `?`, `[`), or `~` — is instead run as `sh -c "<command>"` inside the
  container, so something like
  `wget -qO - https://deb.nodesource.com/setup_24.x | bash -` works as
  written. Quoting a metacharacter (`grep "a|b" file`) keeps it a literal
  argument, except that `$` and backquotes keep their shell meaning inside
  double quotes, just as in a real shell.
* environment: environment variables for the container, given either as a
  mapping (`KEY: value`) or a list of `KEY=value` strings.
* extra_hosts: a list of `host:ip` mappings to add to the container's
  `/etc/hosts`, using the same syntax as docker compose. Each entry is passed to
  `docker run` as `--add-host`, so the step can resolve names that are not in
  DNS. Only applies to docker steps. Example:

  ```yaml
  test:
      image: alpine
      extra_hosts:
        - "somehost:162.242.195.82"
        - "otherhost:50.31.209.229"
  ```
* disable: `true` or `false` (default `false`). When `true` the step is
  completely ignored: it is dropped from the pipeline and is never built, run,
  reported, or available as a dependency of other steps.
* only-if: a string. Evaluated as a bash command on the host just before the
  step would run (after its dependencies are ready). If the command exits
  non-zero the step is skipped: it is not built or run, and it is reported as
  skipped. A skipped step still counts as completed, so steps that depend on
  it run as usual — note that dependents of a skipped *service* will not find
  it running. The command's output is discarded.
* push: a mapping (only valid on a step with a `dockerfile`). After the step
  succeeds, its built image is pushed to Docker Hub. The push happens with the
  host's docker credentials, so `docker login` must already have been run.
  Subkeys:
  * image: the repository to push to, e.g. `myorg/myapp`. Required.
  * tag: the tag (or list of tags) to push as; defaults to `latest`. A list
    pushes the image once per tag, in order. Each value of the form
    `$(command)` is evaluated as a shell command on the host and its trimmed
    output becomes the tag (for example `tag: $(git rev-parse --short HEAD)`).
    If the command fails or prints nothing, the step fails.
  * only-if: a bash command evaluated on the host after the step succeeds. The
    image is pushed only when it exits zero; a non-zero exit skips the push
    without failing the step (useful to push only from a particular branch).

  ```yaml
  build:
      dockerfile: ./Dockerfile
      command: make test
      push:
          image: myorg/myapp
          tag:
            - latest
            - $(git rev-parse --short HEAD)
          only-if: test "$(git branch --show-current)" = main
  ```
* ready-on: a string (only valid on a service). Any step that depends on this
  service is held until this exact string appears in the service's output, so
  you can wait for a slow-starting service to finish booting (for example a
  database printing its "ready to accept connections" banner). If the service
  stops before the string appears, the step fails. The string is matched against
  the service's combined stdout and stderr.
* delay: a non-negative number of seconds. The step waits this long after all of
  its dependencies are ready, and before it runs.
* timeout-minutes: a positive number of minutes. If the step does not complete
  its execution within this many minutes it is aborted and the step fails. The
  `delay` does not count against this budget.
* quiet: `true` or `false` (default `false`). When `true` the step's output is
  not echoed to the terminal. It is still captured for the HTML report (when one
  is requested with `--output`), so you can keep a noisy step off the console
  without losing its log.

# Networking between steps

All docker steps run on a single Docker network, and each container is
reachable from the others by its **step name as a hostname**. To connect from one step to
another, use the target step's name as the host — typically through an
environment variable — and `depends` on it so it is started first:

```yaml
database:
    image: postgres
    service: true
    environment:
       POSTGRES_HOST_AUTH_METHOD: trust
    ready-on: ready to accept connections

app:
    dockerfile: ./Dockerfile.app
    depends:
      - database
    environment:
       DB_HOST: database     # the step name resolves to the database container
       DB_PORT: 5432
    command: run-migrations
```

Inside the `app` container, connecting to host `database` reaches the `database`
step's container. Use `depends` (and, for services that take a moment to start,
`ready-on`) so the service is up before the client tries to connect.

Steps with `runtime: incus` never join this network: there is **no shared
network between incus and docker steps**, which is why an incus step can
neither be a service nor depend on one.

# Command-line interface

whale-ci is run from npx. It takes the name of the YML configuration file as
its argument. It assumes docker is installed on the host machine.

`npx whale-ci ci.yml`

An optional second argument names a single step to run:

`npx whale-ci ci.yml test`

When a step name is given, only that step is run, together with every step it
depends on, the steps those steps depend on, and so on (implicit dependencies
from `image`/Dockerfile `FROM` references included). All other steps are left
out of the pipeline entirely — they are not built, run, or reported. Naming a
step that does not exist in the config file is an error. The step argument
cannot be combined with `--serve`.

If no file is given it prints an error. If the argumnt is `--help` it prints a 
brief help message. It validates the input yaml file and prints an error if it does not
conform to the correct format.

If the file is valid, it builds all images, in parallel when possible (while respecting 
each step's dependencies). if any build or command returns an error, the test has failed 
and the overall command fails, with an error code of 1.

At the end, whether the test succeeded or not, all running containers are stopped.

## Options

* `-o`, `--output <file>`: write a self-contained HTML report to `<file>`. The
  report has one initially-closed accordion per step (services included) showing
  the step name, whether it passed or failed, its execution duration, and all of
  the captured build and container-run output.

`npx whale-ci -o report.html ci.yml`

* `--max-concurrency <n>`: the maximum number of test containers that run in
  parallel. The limit is shared jointly by docker and incus steps; service
  containers do not count toward it. Defaults to 4.

`npx whale-ci --max-concurrency 8 ci.yml`

* `--dump-yaml`: do not build. Instead validate the config and print it to
  stdout with every value whale-ci evaluates on the host shown in its evaluated
  form, to help debug a pipeline definition. The original file's key order,
  formatting and comments are preserved; only the evaluated parts change:
  * a `push.tag` of the form `$(command)` is replaced by the command's trimmed
    output (with the original kept as a trailing comment); a command that fails
    or prints nothing is left in place with a comment explaining why.
  * a step `only-if` and a push `only-if` are run and annotated with a comment
    saying whether they pass (and so whether the step would run / the image
    would be pushed).

  Disabled steps and bare `$VAR` references are left untouched, since the runner
  never evaluates them. Cannot be combined with `--serve`.

`npx whale-ci --dump-yaml ci.yml`

* `--serve`: run as a CI server instead of running once. This starts an HTTP
  server that acts as the backend for a GitHub push webhook (see below).

`npx whale-ci --serve ci.yml`

* `--job-timeout <minutes>`: server mode only. The number of minutes one
  commit's pipeline may run before it is aborted (stopping its containers) and
  the commit reported as failed. Defaults to 30. Since the server tests one
  commit at a time, this also bounds how long a queued commit waits behind the
  one in front of it.

`npx whale-ci --serve --job-timeout 60 ci.yml`

# Server mode (GitHub webhook backend)

With `--serve`, whale-ci runs as a long-lived HTTP server that GitHub can call as
a [webhook](https://docs.github.com/webhooks). The webhook is served on
the `/webhook` path (configure GitHub's payload URL as
`http://<host>:<port>/webhook`; `application/json` content type). Each accepted commit is built and tested, and
the result is reported back to GitHub as a commit status (so it shows up as a
check on the commit and pull request).

Subscribe the webhook to the **push** event. Pushes to branches in your own
repository — including the branches behind your own pull requests — are built
from that event alone. Pull requests opened from **forks** produce no push event
in your repository, and are built only if you additionally subscribe to the
**pull request** event and allowlist the fork's owner in `TRUSTED_PR_OWNERS`;
see [Fork pull requests](#fork-pull-requests-trusted_pr_owners), which explains
what you are trusting them with.

The server also serves a small dashboard:

* `/` lists the recent runs from the [run history](#run-history), newest
  first — still-running ones included — showing each run's branch, start date
  and outcome (pass/fail), with a link to its HTML report.
* `/runs/<id>` serves the stored HTML report of a run. The report is written the
  moment a run starts, with every step marked **pending**, and is rewritten as
  each step finishes — so reloading the page shows progress as it happens, even
  though the report is not streamed. A run still in flight shows a **running**
  header; the final pass/fail verdict appears once it completes.
* `/login` logs an operator in, so they can rerun a failed run — see
  [Rerunning a failed run](#rerunning-a-failed-run).
* `/runs/<id>/rerun` accepts the `POST` that the **rerun** button makes.

Requests to any other path get a `404`.

The command must be run **from the root of a git checkout** that contains the
named config file; it refuses to start otherwise. The server never builds in the
serving checkout itself, so a run can never disturb it. Instead, for each commit
it:

1. verifies the webhook's `X-Hub-Signature-256` against `WEBHOOK_SECRET`;
2. posts a `pending` commit status (linking to the run's report page when
   `PUBLIC_URL` is set);
3. fetches the commit — the branch for a push, or `refs/pull/<n>/head` for a
   fork pull request, whose head commit lives in the fork and is published in
   your repository only under that ref — and adds a detached **git worktree**,
   under `WORKTREE_ROOT`, checked out at the exact commit from the event;
4. loads the config file from that worktree and runs the pipeline there,
   publishing the run's report (all steps pending) as it starts and rewriting it
   as each step finishes;
5. posts a `success` or `failure` (or `error`) commit status; and
6. removes the worktree.

Using a separate worktree per run keeps each commit's build isolated from the
serving checkout and from the previous run's tree.

## One commit at a time

Commits are tested **strictly one at a time**. A webhook that arrives while a
pipeline is running is answered immediately (`202`) and its commit put on a
queue, then built once the commit in front of it has passed or failed. Building
several commits at once oversubscribes the host — each pipeline wants the docker
daemon, the disk, and up to `--max-concurrency` containers of its own — which is
what makes a busy server grind to a halt.

A queued commit is given a `pending` commit status as soon as it is accepted,
described as `Queued for CI (N runs ahead)`, so its check does not sit blank
while it waits.

Each job — the fetch, the checkout and the whole pipeline — is bounded by
`--job-timeout`, 30 minutes by default. On expiry the run is aborted: every
container it started is stopped and its network removed, the commit is reported
as **failed** with `CI timed out after N minutes`, its partial report is kept,
and the next queued commit starts. Without this a single wedged pipeline would
hold the queue, and every commit behind it, closed indefinitely.

On Ctrl-C the server stops listening and waits for the commit being tested to
finish. Commits still on the queue are **not** built — waiting for a full queue
could take hours — and are reported as `error` so their checks do not stay
pending; push them again once the server is back.

The server is configured entirely through environment variables:

* `GITHUB_TOKEN`: token used to post commit statuses to the GitHub API. This
  can be a [fine-grained personal access
  token](https://github.com/settings/personal-access-tokens) (or an equivalent
  GitHub App installation token). It only ever calls the commit-statuses
  endpoint, so it needs exactly one repository permission — **Commit statuses:
  Read and write** — scoped to the repository whose pushes you are building.
  (Fine-grained tokens also carry the mandatory, automatically granted
  **Metadata: Read-only** permission.) No `repo`/admin scope or organization
  permissions are required. Note this token is only for the status API; the
  credentials used to `git fetch` the pushed branch come from the serving
  checkout's git configuration, not from `GITHUB_TOKEN`.
* `WEBHOOK_SECRET`: shared secret used to verify webhook signatures. Requests
  with a missing or invalid signature are rejected with `401`.
* `WORKTREE_ROOT`: directory under which the per-push git worktrees are created
  (created if it does not exist).
* `LISTEN_PORT`: TCP port the webhook server listens on.
* `PUBLIC_URL` (optional): the externally-reachable base URL of the dashboard,
  e.g. `https://ci.example.com`. When set, each commit status is posted with a
  `target_url` of `<PUBLIC_URL>/runs/<id>`, so the **Details** link next to the
  check in the GitHub pull request opens that run's report page. When unset,
  statuses are posted without a link (unchanged behaviour).
* `ADMIN_PASSWORD` (optional): the password for the dashboard's operator login,
  which is what unlocks the **rerun** button on a failed run. **Unset by
  default, and there is no default value**: with no password set, `/login`
  always fails and the dashboard stays read-only. See
  [Rerunning a failed run](#rerunning-a-failed-run).
* `ADMIN_USERNAME` (optional): the account name that goes with
  `ADMIN_PASSWORD`. Defaults to `admin`.
* `TRUSTED_PR_OWNERS` (optional): comma-separated GitHub account logins whose
  **fork** pull requests are built, e.g. `alice,bob`. Compared
  case-insensitively. Unset or empty — the default — builds no fork pull request
  at all, and there is no wildcard. **Read
  [Fork pull requests](#fork-pull-requests-trusted_pr_owners) before setting
  this**: a fork pull request runs its author's code on this host, outside any
  container.

```sh
export GITHUB_TOKEN=ghp_...
export WEBHOOK_SECRET=$(openssl rand -hex 20)
export WORKTREE_ROOT=/var/tmp/whale-ci
export LISTEN_PORT=8080
export PUBLIC_URL=https://ci.example.com   # optional; links checks to reports
export ADMIN_PASSWORD=$(openssl rand -hex 16)  # optional; enables /login
export TRUSTED_PR_OWNERS=alice,bob         # optional; see the warning below
npx whale-ci --serve ci.yml
```

`ping` events are answered and unrecognised events are ignored. Branch deletions
and tag pushes are skipped. A `pull_request` event is built only on the
`opened`, `synchronize` and `reopened` actions (the others leave the head commit
unchanged), only from a fork whose owner is in `TRUSTED_PR_OWNERS`, and never
when the pull request comes from a branch in the repository itself — that branch
already produced a `push` event that built the same commit, and building both
would run every such commit twice. Press Ctrl-C to stop the server; it waits for
the in-flight CI job to finish before exiting (see
[One commit at a time](#one-commit-at-a-time)).

## Rerunning a failed run

A run that failed for a reason that has nothing to do with the commit — a flaky
test, a registry that was briefly down, a network blip during a fetch — can be
started again from the dashboard, without pushing anything or touching GitHub.
The button reruns the **whole** run; individual steps cannot be rerun on their
own, since a step's result depends on the images and services the steps before
it built.

Because a rerun executes the commit's pipeline on the CI host, it is behind a
login:

```sh
export ADMIN_USERNAME=admin              # optional; this is the default
export ADMIN_PASSWORD=$(openssl rand -hex 16)
```

Visiting `/login` produces the browser's own username/password dialog (HTTP
Basic authentication). On a match the server sets an **encrypted session
cookie** — AES-256-GCM, under a key derived from `ADMIN_PASSWORD` — and sends
you back to the dashboard, where every failed run now carries a **rerun**
button. The cookie is `HttpOnly`, `SameSite=Strict` (which is what stops another
site from posting a rerun on your behalf), lasts 12 hours, and is marked
`Secure` when `PUBLIC_URL` is an `https://` URL. Changing `ADMIN_PASSWORD`
changes the key, so every session issued under the old password stops working.

**If `ADMIN_PASSWORD` is not set there is no password at all** — no default, no
fallback — and every login attempt fails, so the dashboard is exactly the
read-only page it is without this feature. `ADMIN_USERNAME` alone is not enough
to log in.

Pressing **rerun** queues the run's commit exactly as a fresh webhook would: it
joins the back of the queue, is built [one commit at a
time](#one-commit-at-a-time) like any other, posts its own commit statuses, and
is recorded as a **new** run in the history. The original run and its report are
left untouched. The commit comes from the run history, not from the branch, so a
rerun builds the commit that failed even if the branch has moved on since.

The button appears only on runs the server can rebuild: a run that **failed**
(status `failed` or `error` — a run that passed has nothing to retry, and a
running one is already under way) and whose history records the repository and
the ref to fetch it from. One-shot CLI runs and runs recorded by a whale-ci
older than this feature carry neither, so they show a `—` instead.

## Fork pull requests (`TRUSTED_PR_OWNERS`)

Building a pull request means running the pipeline **as the contributor wrote
it**: the config file comes from their branch, and a step's `only-if` condition
and any `$(...)` push tag are executed with `bash -c` **on the host**, outside
any container, as documented under
[the configuration file](#configuration-file). A pull request that adds

```yaml
steps:
  x:
    image: alpine
    only-if: curl -d "$GITHUB_TOKEN" https://example.com
```

runs that command on your CI machine as the service user. Restricting what the
containers see does not help, because this never happens in a container: the
service user can read `/etc/whale-ci.env` directly, and — being in the `docker`
group, which is root-equivalent — can reach the whole host anyway.

So **listing a login in `TRUSTED_PR_OWNERS` extends that person the same trust
as push access to your repository.** It is not a sandbox, and it is not a way to
safely accept pull requests from strangers. Use it only for people you would
already give commit rights, and prefer simply giving them push access so their
branches build from the `push` event with no fork involved. Note also that the
allowlist names the fork's *owner*: anyone that owner grants push access to
their fork can run code here too.

Genuinely untrusted contributions need isolation this server does not provide —
an ephemeral VM per run, holding no secrets and no docker group membership, with
the status token held by a process the untrusted code cannot reach.

## Running as a systemd service

The instructions below set up whale-ci as a persistent, unprivileged systemd
service on a freshly installed **Debian 13 (trixie)** VM. They assume you are
starting from a bare system and have `root` (or `sudo`) access. All commands are
run as `root` unless noted otherwise.

### 1. Install the prerequisites

whale-ci needs Node.js (≥ 22.18), Docker, `git` and `openssl`. Debian 13 ships
Node.js 22, which is new enough. Start with the base tools:

```sh
# Base tools and Node.js from Debian
apt-get update
apt-get install -y nodejs npm git openssl ca-certificates curl
```

For Docker you have two options.

whale-ci only uses the core Docker Engine (`docker build`, `docker run`,
`docker network`, `docker logs`) — it does not use Compose — so a plain engine
install is all that is required.

**Option A — Docker's official apt repository (recommended).** This tracks the
current Docker Engine release rather than the version frozen at Debian's
release. Since whale-ci builds images, staying close to upstream is the safer
default:

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
systemctl enable --now docker
```

**Option B — Debian's own packages.** Simpler, all from the distro, but the
engine version is frozen at Debian's release and may lag upstream:

```sh
apt-get install -y docker.io
systemctl enable --now docker
```

Confirm the versions are recent enough:

```sh
node --version    # v22.18 or newer
docker --version
```

### 2. Create the `whaleci` service user

Create a dedicated system user to own and run the service. It needs a home
directory (the run-history database lives under it) and membership in the
`docker` group so it can talk to the Docker daemon.

```sh
# System account with a home dir and no login shell
adduser --system --group --home /home/whaleci --shell /usr/sbin/nologin whaleci

# Allow the user to use Docker
usermod -aG docker whaleci
```

### 3. Fetch a checkout to serve from

The server must be started **from the root of a git checkout** that contains the
config file. Clone the repository you want to build into a directory owned by
`whaleci`:

```sh
sudo -u whaleci git clone https://github.com/<you>/<your-repo>.git \
  /home/whaleci/checkout
```

### 4. Create the environment file

Store the server's configuration (see the variables listed above) in a
root-owned file that only `whaleci` can read, since it holds secrets:

```sh
umask 077
cat > /etc/whale-ci.env <<'EOF'
GITHUB_TOKEN=ghp_...
WEBHOOK_SECRET=replace-me
WORKTREE_ROOT=/var/lib/whale-ci/worktrees
LISTEN_PORT=8080
PUBLIC_URL=https://ci.example.com
ADMIN_PASSWORD=replace-me
EOF
chown root:whaleci /etc/whale-ci.env
chmod 640 /etc/whale-ci.env
```

Generate a fresh webhook secret with `openssl rand -hex 20` and use the same
value when you configure the webhook in GitHub. `ADMIN_PASSWORD` is what unlocks
the dashboard's [rerun button](#rerunning-a-failed-run); generate it with
`openssl rand -hex 16`, or leave the line out to keep the dashboard read-only.

Create the worktree root and hand it to the service user:

```sh
install -d -o whaleci -g whaleci /var/lib/whale-ci/worktrees
```

### 5. Install the systemd unit

Write the following to `/etc/systemd/system/whale-ci.service`:

```ini
[Unit]
Description=whale-ci GitHub webhook backend
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=whaleci
Group=whaleci
WorkingDirectory=/home/whaleci/checkout
EnvironmentFile=/etc/whale-ci.env
ExecStart=/usr/bin/npx whale-ci --serve ci.yml
Restart=on-failure
RestartSec=5
# Let the in-flight CI job finish on stop (matches Ctrl-C behaviour). Allow at
# least as long as --job-timeout, or systemd will kill a slow run mid-flight.
KillSignal=SIGINT
TimeoutStopSec=1860

[Install]
WantedBy=multi-user.target
```

Adjust `WorkingDirectory` and the `ci.yml` argument to match your checkout and
config filename. `npx` will download whale-ci on first start; to avoid the
network fetch (and pin a version) you can instead
`sudo -u whaleci npm install -g whale-ci` and set
`ExecStart=/usr/bin/whale-ci --serve ci.yml`.

### 6. Enable and start the service

```sh
systemctl daemon-reload
systemctl enable --now whale-ci.service

# Check status and follow the logs
systemctl status whale-ci.service
journalctl -u whale-ci.service -f
```

The dashboard is now reachable at `http://<host>:8080/` and the webhook endpoint
at `http://<host>:8080/webhook`. The run-history database is created under the
service user's home at `/home/whaleci/.local/share/whale-ci/runs.db`. To apply a
new `GITHUB_TOKEN`, `WEBHOOK_SECRET` or `ADMIN_PASSWORD`, edit
`/etc/whale-ci.env` and run `systemctl restart whale-ci.service`.

# Run history

Every run — one-shot CLI runs and webhook-triggered server runs alike — is
recorded in an SQLite database (using Node's built-in `node:sqlite`). A run is
inserted as `running` when it starts and updated with its outcome (`success`,
`failure` or `error`) when it finishes. A server run's self-contained HTML
report is stored as soon as the run starts (all steps pending) and rewritten in
place as each step finishes, so it is available while the run is still in flight;
a one-shot CLI run stores its report once, at the end. The server's dashboard at
`/` is rendered from this database.

The database lives at `runs.db` in the customary per-user application data
directory:

* Linux: `$XDG_DATA_HOME/whale-ci/runs.db`, defaulting to
  `~/.local/share/whale-ci/runs.db`
* macOS: `~/Library/Application Support/whale-ci/runs.db`

One-shot runs are tagged with the current git branch and commit when run from
inside a git checkout; server runs are tagged with the pushed branch and commit,
plus the repository and the ref the commit was fetched from — which is what lets
a failed server run be [rerun from the dashboard](#rerunning-a-failed-run)
later. A database written by an earlier version gains those two columns the
first time this version opens it; the runs already in it keep their reports but
cannot be rerun, having never recorded where they came from.