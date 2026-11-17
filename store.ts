// store.ts — the forge's whole state, in memory. One process, one store, no disk: a trial's
// suite drives one fresh server, so nothing needs to persist between runs.
//
// Determinism: nothing here reads the wall clock or Math.random for anything that reaches a
// response. Commit timestamps come from a deterministic clock seeded by MAKEFUN_TRIAL_NOW (the
// trial's opening time, identical on a live pass and its replay) plus one second per commit the
// server itself creates; ordering uses a monotonic creation counter. Request ids are
// `req-<counter>`. Global ids are base64url of a stable type-scoped key, so they are opaque,
// stable across reads, and never the plain database id or number.

import {
  buildCommit,
  buildTree,
  hashObject,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './git.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: { id: number; body: string; createdSeq: number }[];
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: string;
  databaseId: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Creation order of each commit oid (for GET /commits newest-first ordering). */
  commitSeq: Map<string, number>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextDatabaseId = 5000;
  private seq = 0;
  private requestSeq = 0;
  private commitClock: number;

  constructor() {
    // MAKEFUN_TRIAL_NOW is the trial's opening time (seconds, or an ISO string); the same on a
    // live pass and its replay. Without it, a fixed epoch: never the wall clock.
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let base = 1735689600; // 2025-01-01T00:00:00Z
    if (/^\d+$/.test(raw)) base = Number(raw);
    else if (raw !== '') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
    }
    this.commitClock = base;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** The next deterministic commit timestamp (seconds), advancing one second per commit. */
  nextCommitTime(): number {
    const t = this.commitClock;
    this.commitClock += 1;
    return t;
  }

  isoOf(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const databaseId = this.nextDatabaseId;
    this.nextDatabaseId += 1;
    const repo: Repo = {
      id: globalId('repo', `${owner}/${name}`),
      databaseId,
      owner,
      name,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      commitSeq: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  findRepoByGlobalId(id: string): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
    }
    return undefined;
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
    }
    return undefined;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** All ancestors of `roots` (commit oids), following parents. */
  reachableCommits(repo: Repo, roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** All objects reachable from `roots` (commits and tags), following commits, trees and tags. */
  reachableObjects(repo: Repo, roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const info = parseCommit(object.data);
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** The flat file map (path -> {oid, mode}) of the tree at `treeOid`. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree objects for a flat file map; returns the root tree oid. */
  buildTreeForFiles(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    // Group paths by directory, bottom-up.
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const ensureDir = (dir: string): Map<string, { oid: string; mode: string }> => {
      let map = dirs.get(dir);
      if (map === undefined) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    ensureDir('');
    for (const [path, entry] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      ensureDir(dir).set(name, entry);
    }
    // Directories, deepest first. ('' is depth 0: ''.split('/') is [''], length 1, so count it by hand.)
    const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const dirNames = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
    const treeOidOf = new Map<string, string>();
    for (const dir of dirNames) {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of dirs.get(dir) as Map<string, { oid: string; mode: string }>) {
        entries.push({ mode: entry.mode, name, oid: entry.oid });
      }
      // Subdirectories of this dir.
      for (const [sub, oid] of treeOidOf) {
        const parent = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
        if (parent === dir) {
          const name = sub.includes('/') ? sub.slice(sub.lastIndexOf('/') + 1) : sub;
          entries.push({ mode: '40000', name, oid });
        }
      }
      const oid = this.putObject(repo, 'tree', buildTree(entries));
      treeOidOf.set(dir, oid);
    }
    return treeOidOf.get('') as string;
  }

  /** Create a commit on `repo` with the given flat file map; returns the commit oid. */
  createCommit(
    repo: Repo,
    files: ReadonlyMap<string, { oid: string; mode: string }>,
    parents: readonly string[],
    message: string,
  ): string {
    const treeOid = this.buildTreeForFiles(repo, files);
    const epoch = this.nextCommitTime();
    const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${epoch} +0000`;
    const oid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents: [...parents], author: ident, committer: ident, message }),
    );
    repo.commitSeq.set(oid, this.nextSeq());
    return oid;
  }

  /** Record commits that arrived over git (push) in creation order. */
  recordPushedCommits(repo: Repo, oids: readonly string[]): void {
    for (const oid of oids) {
      if (!repo.commitSeq.has(oid)) repo.commitSeq.set(oid, this.nextSeq());
    }
  }

  /** Commits reachable from `refOid`, newest first (by creation order). */
  listCommits(repo: Repo, refOid: string): { sha: string; message: string; author: string; committer: string; epoch: number }[] {
    const reachable = this.reachableCommits(repo, [refOid]);
    const list = [...reachable].map((oid) => {
      const info = parseCommit((repo.objects.get(oid) as GitObject).data);
      return { sha: oid, message: info.message, author: info.author, committer: info.committer, epoch: this.commitEpoch(info) };
    });
    list.sort((a, b) => (repo.commitSeq.get(b.sha) ?? 0) - (repo.commitSeq.get(a.sha) ?? 0));
    return list;
  }

  commitEpoch(info: { author: string; committer: string }): number {
    const match = / (\d+) \+0000$/.exec(info.committer) ?? / (\d+) \+0000$/.exec(info.author);
    return match === null ? 0 : Number(match[1]);
  }

  /** The merge-base of two commits (first common ancestor by creation order), or '' when none. */
  mergeBase(repo: Repo, a: string, b: string): string {
    const aAncestors = this.reachableCommits(repo, [a]);
    const bAncestors = this.reachableCommits(repo, [b]);
    let best = '';
    let bestSeq = -1;
    for (const oid of aAncestors) {
      if (!bAncestors.has(oid)) continue;
      const seq = repo.commitSeq.get(oid) ?? 0;
      if (seq > bestSeq) {
        bestSeq = seq;
        best = oid;
      }
    }
    return best;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? Walks parents from the descendant and stops as soon as the ancestor is found. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** Line-diff counts between two blobs (old -> new), by lines. */
  diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    // LCS over lines (files here are small; the 100-file push is git-side, not PR files).
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
      }
    }
    const lcs = dp[0]![0] as number;
    return { additions: n - lcs, deletions: m - lcs };
  }

  /** The changed paths between two trees: {path, status, additions, deletions}. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string,
    headTreeOid: string,
  ): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const base = baseTreeOid === ZERO_OID ? new Map() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === ZERO_OID ? new Map() : this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const oldText = this.blobText(repo, b.oid);
        const counts = this.diffLines(oldText, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      } else if (b === undefined && h !== undefined) {
        const newText = this.blobText(repo, h.oid);
        const counts = this.diffLines('', newText);
        out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const counts = this.diffLines(this.blobText(repo, b.oid), this.blobText(repo, h.oid));
        out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return out;
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** The files changed by a pull request (merge-base tree -> head tip tree). */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const baseCommit = repo.objects.get(pull.mergeBase);
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit === undefined || headCommit.type !== 'commit') return [];
    const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : ZERO_OID;
    const headTree = parseCommit(headCommit.data).tree;
    return this.diffTrees(repo, baseTree, headTree);
  }

  /** Would merging `pull` conflict with the current base tip? (three-way, per path.) */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return false;
    const baseCommit = repo.objects.get(baseTip);
    const mergeBaseCommit = pull.mergeBase === '' ? undefined : repo.objects.get(pull.mergeBase);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit === undefined || headCommit === undefined || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const ancestorTree = mergeBaseCommit !== undefined && mergeBaseCommit.type === 'commit' ? parseCommit(mergeBaseCommit.data).tree : ZERO_OID;
    const headTree = parseCommit(headCommit.data).tree;
    const ancestorFiles = ancestorTree === ZERO_OID ? new Map() : this.flattenTree(repo, ancestorTree);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid;
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const baseChanged = b !== a;
      const headChanged = h !== a;
      if (baseChanged && headChanged && b !== h) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return null;
    const baseCommit = repo.objects.get(baseTip);
    const mergeBaseCommit = pull.mergeBase === '' ? undefined : repo.objects.get(pull.mergeBase);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit === undefined || headCommit === undefined || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return null;
    const baseTree = parseCommit(baseCommit.data).tree;
    const ancestorTree = mergeBaseCommit !== undefined && mergeBaseCommit.type === 'commit' ? parseCommit(mergeBaseCommit.data).tree : ZERO_OID;
    const headTree = parseCommit(headCommit.data).tree;
    const ancestorFiles = ancestorTree === ZERO_OID ? new Map() : this.flattenTree(repo, ancestorTree);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    // Three-way merge: start from the base tip's files, apply the head's changes vs the ancestor.
    const merged = new Map(baseFiles);
    for (const [path, entry] of headFiles) {
      const a = ancestorFiles.get(path)?.oid;
      if (a !== entry.oid) merged.set(path, entry);
    }
    for (const [path, entry] of ancestorFiles) {
      if (!headFiles.has(path) && baseFiles.get(path)?.oid === entry.oid) merged.delete(path);
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = this.createCommit(repo, merged, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoOf(this.commitClock);
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }
}
