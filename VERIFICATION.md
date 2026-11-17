# Verification — github-core-clone-01

Entry: a GitHub-compatible git forge in Node 22 stdlib only (no dependencies,
no git binary, no internet at runtime). In-memory, deterministic.

## Kit

- Kit downloaded from `https://make.fun/c/github-core-clone-01/kit`,
  `~/workspace/makefun/github-core-clone-01-kit.tar.gz`
  (7.1 MB, sha256 `4ec530d2f3fee3096aa91509e770de20daa4fcb1946cb779f6000721264b37e2`).
- **Digest note:** kit.json `bundle_sha256` is `e20a304d…`, which does NOT match
  the downloaded tarball's sha256. The download appears re-packaged. All
  **63 files listed in kit.json verify against their listed sha256**
  (ok=63, mismatch=0, missing=0), so the contents are verified and the
  tarball-hash difference is recorded, not a blocker.
- kit.json: harness `harness@9666cba9… node v26.13.1`,
  scorer `scorer@d049e1c7… program@99d09372…`, protocol `agent-fun/agent/v1`.

## Local suite (kit's own grader, `node --experimental-strip-types sdk/run.ts`)

- Run 1: 107/120 (found the nested-path tree bug: `buildTreeForFiles` sorted
  dirs by `split('/').length`, making the root tree empty for nested paths).
- Run 2: 117/120 (fixed tree depth; fixed depth-limited fetch walk;
  GraphQL inline `states: [OPEN]`).
- Run 3: **120/120, score 935** (feature 600, agent 200, perf 135:
  push 1013 ms, clone 200 ms, read 1418 ms, write 208 ms).
- Perf pass (`isAncestor` early-exit walk). Run 4: 120/120, score 934.
- Run 5 on a reused server: 36/120 — **not a code failure**: the suite
  expects a FRESH server per run; fixed scenario names collide on a reused
  store.
- Determinism: fresh-server runs 6 and 7, both **120/120 with byte-identical
  check outcomes** (feature 600, agent 200).
- Final run (fresh server): **120/120, score 968/1000** — feature 600,
  agent 200, perf 168 (push 504 ms/46, clone 184 ms/32, read 922 ms/45,
  write 118 ms/45). Suite JSON saved at `/tmp/suite-final.json`.

## Real-git interop (git 2.43.0, not just the kit's client)

- Clone (full history, nested files, correct content), push
  (`a5dd4da..7b0715f main -> main`, visible in the server's REST commits
  list), shallow clone (`--depth 1`, tip only), incremental fetch — all pass.
- Two protocol fixes found via git 2.43 source during this work:
  v2 fetch omits the `acknowledgments` section when there are no haves
  (git requires `packfile` first); receive-pack report is a pkt-line stream
  wrapped in sideband band 1 (git demuxes the inner stream).

## Smoke test

- 35/35 checks pass (`/tmp/smoke-forje.ts`): REST v3, issues/pulls, GraphQL,
  MCP, git smart HTTP, auth, error shapes.

## Repo

- https://github.com/Diest34/github-core-clone-01 (public, default branch
  `main`, created 2026-11-17T12:50:20Z, after the bounty opened).
- Pushed commit verified via the public GitHub API (recursive tree lists
  all 13 paths: `.makefun/owner.json`, LICENSE, README.md, app.ts, git.ts,
  graphql.ts, main.ts, mcp.ts, package.json, scenario.ts, store.ts,
  tsconfig.json).
- About verified via the public API: description names the forge + the
  make.fun bounty ($500 in USDC); homepage
  `https://make.fun/bounty/github-core-clone-01`; topics
  `ai-agents, bounties, code, makefun`.

## Bundle

- `~/workspace/makefun/github-core-clone-01-bundle.tar.gz`
  (1,546,161 bytes, sha256
  `9edd5532d69fc3390495bcc594818fa2090f40fc5e54ecfa56e0c08b772e5752`).
- Built with the kit CLI (`--muse-usage` from muse.db, 399 rows,
  30 attached; `--mcp none --harness muse-app --harness-version 1
  --provider meta --model muse-spark-1.3 --effort default`).
- 8 sessions bundled: the build session, the parent session, and 6 parallel
  subagent sessions that shared the GitHub helper files (collected by the
  CLI's read-source rule).
- Checked the extracted bundle: no `ghp_` / `af_` token values, no keypair
  material, credential redactions present in every session file. The only
  wallet address in it is the public payout address from
  `.makefun/owner.json`.

## What is NOT done

- **Not submitted.** Submit needs the parent agent's verification + the
  user's explicit yes, per the standing rule.
- Deadline: entries close 2026-11-21 13:30 WIB.
