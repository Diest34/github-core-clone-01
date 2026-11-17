# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Diest34/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Diest34/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node 22 stdlib only: git smart HTTP (protocol v2), REST v3, GraphQL v4 and MCP, in memory and deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program is a long-lived HTTP server. It binds an ephemeral port, registers it with the
environment at `MAKEFUN_ENV_URL`, answers the suite, and exits 0 when the environment says the
trial is done. There is nothing to install: it imports `node:http` and its own modules only.

What it implements:

- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 `ls-refs`/`fetch`, plus a v0
  fallback) and `git-receive-pack` (pushes with fast-forward checks, `non-fast-forward`
  refusals, sideband status reports). SHA-1 object store, pack v2 read/write, deterministic
  pack ordering.
- **REST v3** — repositories, branches, commits, contents (create/update/delete with SHA
  conflict checks), git refs, labels, issues, comments, pull requests, files and squash merges,
  with `Link` pagination and `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** — the viewer, repository, issue, pull-request and search documents `gh` and
  `github-mcp-server` send, including node ids, cursor pagination and batched operations.
- **MCP** — `server/discover` (2026-07-28 era) plus `initialize`, `tools/list` and `tools/call`
  for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`, all on the same store as REST.

State is in memory and every reply is deterministic: no wall clock, no randomness — dates come
from `MAKEFUN_TRIAL_NOW` and request ids are counters — so a replay leaves the same state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qdjpn7xw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
