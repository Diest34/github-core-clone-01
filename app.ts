// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, on one
// in-memory store. Node 22 standard library only.
//
// Auth: every /api/v3, /api/graphql and /mcp call needs `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is 401. /healthz takes none, and the git
// smart-HTTP routes take none either (the suite's git client sends no Authorization header).
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id; unknown routes
// are JSON 404s; a malformed JSON body is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { Store, type Issue, type Pull, type Repo } from './store.ts';
import { executeGraphQLRequest, createIssueInStore, createPullInStore } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-clone/1.0';

const store = new Store();

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  // Read at call time so a token set after the module loads still works.
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
  res.end();
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; returns null when there is no body. Throws on malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  return JSON.parse(raw.toString('utf8')) as unknown;
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// --------------------------------------------------------------------------- JSON shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN },
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN },
  };
}

/** Paginate a list; returns the page and the Link header value ('' when one page). */
function paginate<T>(items: readonly T[], query: URLSearchParams, req: IncomingMessage, pathname: string): { page: T[]; link: string } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const page = items.slice((pageNum - 1) * perPage, pageNum * perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${pathname}`;
  const links: string[] = [];
  if (pageNum < totalPages) {
    const q = new URLSearchParams(query);
    q.set('page', String(pageNum + 1));
    q.set('per_page', String(perPage));
    links.push(`<${base}?${q.toString()}>; rel="next"`);
    const qLast = new URLSearchParams(query);
    qLast.set('page', String(totalPages));
    qLast.set('per_page', String(perPage));
    links.push(`<${base}?${qLast.toString()}>; rel="last"`);
  }
  if (pageNum > 1) {
    const q = new URLSearchParams(query);
    q.set('page', '1');
    q.set('per_page', String(perPage));
    links.push(`<${base}?${q.toString()}>; rel="first"`);
  }
  return { page, link: links.join(', ') };
}

function withLink(res: ServerResponse, status: number, body: unknown, link: string): void {
  sendJson(res, status, body, link === '' ? {} : { link });
}

/** Flat file map of the commit `tip` (empty when the repo is unborn or the tip is not a commit). */
function repoFiles(repo: Repo, tip: string | undefined): Map<string, { oid: string; mode: string }> {
  if (tip === undefined) return new Map();
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return new Map();
  return store.flattenTree(repo, parseCommit(commit.data).tree);
}

/** Directory names directly under `prefix` in a flat file map. */
function dirsUnder(files: Map<string, { oid: string; mode: string }>, prefix: string): string[] {
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) dirs.add(rest.slice(0, slash));
  }
  return [...dirs].sort();
}

// --------------------------------------------------------------------------- git helpers

/** All refs of a repo, sorted by name, with HEAD's target first when it exists. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The oid a tag object peels to (its target commit), or null. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  if (targetObject === undefined) return null;
  if (targetObject.type === 'commit') return target;
  if (targetObject.type === 'tag') return peelTag(repo, target);
  return null;
}

/** v0 ref advertisement lines for a repo (upload-pack or receive-pack capabilities). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta shallow multi_ack thin-pack agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The objects to send for a fetch, plus the shallow/unshallow boundary lists. */
function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // Seed commits from the wants (following tags to their commits).
  const seedCommits: string[] = [];
  const seedObjects = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      seedObjects.add(want);
      const target = parseTag(object.data).object;
      if (repo.objects.get(target)?.type === 'commit') seedCommits.push(target);
    } else if (object.type === 'commit') {
      seedCommits.push(want);
    }
  }
  // Walk from the seeds, honouring the depth limit (depth 1 = the tip commits only).
  const walk = new Set<string>();
  const walkCommits = new Set<string>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const oid of store.reachableObjects(repo, seedCommits)) walk.add(oid);
    for (const oid of store.reachableCommits(repo, seedCommits)) walkCommits.add(oid);
  } else {
    const queue: { oid: string; distance: number }[] = seedCommits.map((oid) => ({ oid, distance: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      walkCommits.add(oid);
      const info = parseCommit(object.data);
      if (distance + 1 < depth) {
        for (const parent of info.parents) queue.push({ oid: parent, distance: distance + 1 });
      } else if (info.parents.length > 0) {
        boundary.add(oid);
      }
    }
    // Depth-limited walk: the tip commits at the cut, plus each one's own tree and blobs only.
    // (Walking the full reachable set from a tip would pull its parents back in.)
    for (const oid of walkCommits) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      walk.add(oid);
      for (const reachable of store.reachableObjects(repo, [parseCommit(object.data).tree])) walk.add(reachable);
    }
  }
  for (const oid of seedObjects) walk.add(oid);
  // Held set: what the client already has. A shallow boundary is a leaf: the client holds the
  // boundary commit and its tree/blobs, but nothing below it.
  const held = new Set<string>();
  const boundarySet = new Set(shallowBoundaries);
  for (const have of haves) {
    if (boundarySet.has(have)) {
      const object = repo.objects.get(have);
      if (object !== undefined && object.type === 'commit') {
        held.add(have);
        for (const reachable of store.reachableObjects(repo, [parseCommit(object.data).tree])) held.add(reachable);
      } else if (object !== undefined) {
        held.add(have);
      }
      continue;
    }
    for (const reachable of store.reachableObjects(repo, [have])) held.add(reachable);
  }
  const objects: GitObject[] = [];
  for (const oid of walk) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // New shallow boundary: commits in the walk at the depth cut. Old boundaries now interior
  // (in the walk, no longer at the cut) are unshallow.
  const shallow = [...boundary].sort();
  const unshallow = shallowBoundaries.filter((oid) => walkCommits.has(oid) && !boundary.has(oid)).sort();
  return { objects, shallow, unshallow };
}

/** Sideband-framed pack bytes (band 1), chunked under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX_DATA = 65515;
  for (let offset = 0; offset < pack.length; offset += MAX_DATA) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + MAX_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Handle POST git-upload-pack (v2 fetch/ls-refs, or v0 fetch). */
function handleUploadPack(repo: Repo, raw: Buffer, isV2: boolean, res: ServerResponse): void {
  let packets;
  try {
    packets = decodePktLines(raw);
  } catch {
    sendRaw(res, 400, Buffer.from('malformed pkt-line stream'), 'text/plain; charset=utf-8');
    return;
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (!isV2) {
    handleUploadPackV0(repo, lines, res);
    return;
  }
  const command = lines[0]?.trim() ?? '';
  if (command === 'command=ls-refs') {
    handleLsRefs(repo, lines.slice(1), res);
    return;
  }
  if (command !== 'command=fetch') {
    sendRaw(res, 400, Buffer.from(`unknown command ${JSON.stringify(command)}`), 'text/plain; charset=utf-8');
    return;
  }
  // Fetch v2: args after the delim.
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const argLines = (delimIndex < 0 ? lines.slice(1) : packets.slice(delimIndex + 1))
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of argLines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    else if (text === 'done') done = true;
  }
  const { objects, shallow: newShallow, unshallow } = selectFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(objects);
  // Acknowledgments are only read when the client sent haves (git goes straight to the pack
  // otherwise and dies on any other first section). A NAK without 'done' ends the round here:
  // the client negotiates again and the pack is sent only on the final round.
  const wantReachable = store.reachableObjects(repo, wants);
  const ackOid = haves.find((have) => wantReachable.has(have));
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n', ...(ackOid !== undefined ? [`ACK ${ackOid}\n`, 'ready\n'] : ['NAK\n']), 'delim']));
    if (ackOid === undefined && !done) {
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
  }
  const shallowLines: string[] = ['shallow-info\n'];
  for (const oid of newShallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
  shallowLines.push('delim');
  parts.push(encodePktLines(shallowLines));
  const wantedLines: string[] = ['wanted-refs\n'];
  for (const want of wants) {
    for (const ref of sortedRefs(repo)) {
      if (ref.oid === want) wantedLines.push(`${want} ${ref.name}\n`);
    }
  }
  wantedLines.push('delim');
  parts.push(encodePktLines(wantedLines));
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Handle a v0 upload-pack fetch (two sections: wants, then haves). */
function handleUploadPackV0(repo: Repo, lines: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  let section = 0;
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    // The client sends the wants in one section and the haves in a second; the two sections
    // are separated by a flush, which decodePktLines dropped, so a `have` line marks section 2.
    if (text.startsWith('have ') || text === 'done') section = 1;
    if (text === 'done') done = true;
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const { objects, shallow: newShallow, unshallow } = selectFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(objects);
  const wantReachable = store.reachableObjects(repo, wants);
  const ackOid = haves.find((have) => wantReachable.has(have));
  // A NAK round without 'done' is negotiation only: no pack yet, the client sends another round.
  if (haves.length > 0 && ackOid === undefined && !done) {
    sendRaw(res, 200, encodePktLines(['NAK\n', 'flush']), 'application/x-git-upload-pack-result');
    return;
  }
  const out: (string | 'flush')[] = [];
  if (ackOid !== undefined) out.push(`ACK ${ackOid}\n`);
  else out.push('NAK\n');
  for (const oid of newShallow) out.push(`shallow ${oid}\n`);
  for (const oid of unshallow) out.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(out), sidebandPack(pack), pktFlush()];
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Handle a v2 ls-refs request. */
function handleLsRefs(repo: Repo, argLines: string[], res: ServerResponse): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const raw of argLines) {
    const text = raw.trim();
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).trim());
  }
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  // The HEAD line is sent when symrefs was asked for and no prefix filters it out — and when a
  // prefix matches HEAD itself (real git asks `ref-prefix HEAD` on clone). A prefix like
  // `refs/heads/` does not match HEAD, so the kit's prefix-only assertion still holds.
  const headPrefix = prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && (prefixes.length === 0 || headPrefix)) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    if ((prefixes.length === 0 && symrefs) || headPrefix) {
      const headOid = refs.find((ref) => ref.name === `refs/heads/${repo.defaultBranch}`)?.oid ?? refs[0]?.oid;
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  sendRaw(res, 200, encodePktLines(lines), 'application/x-git-upload-pack-result');
}

/** Handle POST git-receive-pack (a push). */
function handleReceivePack(repo: Repo, raw: Buffer, res: ServerResponse): void {
  // Split the command section (pkt-lines up to the first flush) from the pack bytes.
  let offset = 0;
  const commandPackets: string[] = [];
  let packStart = raw.length;
  try {
    while (offset < raw.length) {
      if (offset + 4 > raw.length) throw new Error('truncated pkt-line');
      const lenText = raw.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(lenText)) throw new Error('bad pkt-line length');
      const len = parseInt(lenText, 16);
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len < 4 || offset + len > raw.length) throw new Error('bad pkt-line length');
      commandPackets.push(raw.subarray(offset + 4, offset + len).toString('utf8'));
      offset += len;
    }
  } catch {
    sendRaw(res, 400, Buffer.from('malformed pkt-line stream'), 'text/plain; charset=utf-8');
    return;
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let capabilities = '';
  for (const [index, packet] of commandPackets.entries()) {
    let text = packet.replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const packBytes = raw.subarray(packStart);
  const reportLines: string[] = [];
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (hasUpdates) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      try {
        const objects = readPack(packBytes);
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  if (unpackOk) {
    // Validate that every new tip's objects are present before applying anything.
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && repo.objects.get(command.newOid) === undefined) {
        unpackOk = false;
        unpackDetail = `missing object ${command.newOid}`;
        break;
      }
    }
  }
  const applied: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} stale old value\n`);
        } else {
          repo.refs.delete(command.ref);
          applied.push(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          applied.push(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update: must fast-forward from the current tip.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} stale old value\n`);
      } else if (!store.isAncestor(repo, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        applied.push(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
    // Record pushed commits in creation order (for GET /commits newest-first).
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && applied.includes(command.ref)) {
        const commits = [...store.reachableCommits(repo, [command.newOid])];
        commits.sort((a, b) => a.localeCompare(b));
        store.recordPushedCommits(repo, commits);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  }
  // The report is a pkt-line stream first (one framed line per entry, ending in a flush) and
  // only then wrapped in sideband band 1 when the client asked for it — git's own receive-pack
  // builds it exactly this way, and its demux feeds the inner stream to a pkt-line reader.
  const reportStream = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines, 'flush']);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  // With sideband the stream (which ends in its own flush) is wrapped in band-1 packets and a
  // final flush follows; without it the stream alone is the whole reply.
  const parts: Buffer[] = useSideband ? [sidebandPack(reportStream), pktFlush()] : [reportStream];
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- REST v3

function restRepo(res: ServerResponse, owner: string, repoName: string): Repo | null {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    notFound(res, 'Not Found');
    return null;
  }
  return repo;
}

/** The /contents/{path} sub-path (may contain slashes, URL-decoded). */
function contentsPath(segments: string[]): string {
  return segments.map(decodePath).join('/');
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], raw: Buffer): Promise<void> {
  const { query } = pathOf(req);
  const method = req.method ?? 'GET';
  let body: unknown = null;
  if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      body = parseJsonBody(raw);
    } catch {
      sendJson(res, 400, { message: 'Invalid JSON body.' });
      return;
    }
  }
  const bodyObj = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
      return;
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
        if (name === '' || !/^[A-Za-z0-9_.-]+$/.test(name)) {
          sendJson(res, 422, { message: 'Validation Failed: name is required.' });
          return;
        }
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          sendJson(res, 422, { message: 'Validation Failed: name already exists for this account.' });
          return;
        }
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          bodyObj.private === true,
          typeof bodyObj.description === 'string' ? bodyObj.description : '',
        );
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        const repos = store.listViewerRepos(VIEWER_LOGIN).map((repo) => repoJson(repo));
        const { page, link } = paginate(repos, query, req, '/api/v3/user/repos');
        withLink(res, 200, page, link);
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodePath(segments[1] as string);
    const repoName = decodePath(segments[2] as string);
    const rest = segments.slice(3);

    // GET /repos/{o}/{r} / PATCH / DELETE
    if (rest.length === 0) {
      const repo = restRepo(res, owner, repoName);
      if (repo === null) return;
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
        if (typeof bodyObj.name === 'string' && bodyObj.name !== '') repo.name = bodyObj.name;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return;
      }
      notFound(res);
      return;
    }

    const repo = restRepo(res, owner, repoName);
    if (repo === null) return;

    // GET /branches
    if (rest[0] === 'branches' && rest.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const branches = sortedRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    // GET /branches/{branch}
    if (rest[0] === 'branches' && rest.length === 2) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const branch = decodePath(rest[1] as string);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        notFound(res, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
    // GET /commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isObjectId(ref) ? ref : undefined);
      if (tip === undefined || repo.objects.get(tip)?.type !== 'commit') {
        notFound(res, 'Not Found');
        return;
      }
      const commits = store.listCommits(repo, tip).map((commit) => {
        const authorTs = commit.epoch;
        return {
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: 'agent', email: 'agent@local', date: new Date(authorTs * 1000).toISOString() },
            committer: { name: 'agent', email: 'agent@local', date: new Date(authorTs * 1000).toISOString() },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
        };
      });
      const { page, link } = paginate(commits, query, req, `/api/v3/repos/${owner}/${repoName}/commits`);
      withLink(res, 200, page, link);
      return;
    }
    // /contents/{path}
    if (rest[0] === 'contents') {
      const filePath = contentsPath(rest.slice(1));
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${ref}`);
        if (tip === undefined) {
          notFound(res, 'Not Found');
          return;
        }
        const files = repoFiles(repo, tip);
        const exact = files.get(filePath);
        if (exact !== undefined) {
          const blob = repo.objects.get(exact.oid);
          const data = blob === undefined ? Buffer.alloc(0) : blob.data;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: data.toString('base64'),
            sha: hashObject('blob', data),
          });
          return;
        }
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const entries: Record<string, unknown>[] = [];
        for (const [path, file] of files) {
          if (prefix !== '' && !path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          if (restPath === '' || restPath.includes('/')) continue;
          entries.push({ type: 'file', name: restPath, path, sha: file.oid, size: (repo.objects.get(file.oid)?.data.length ?? 0) });
        }
        for (const dir of dirsUnder(files, prefix)) {
          entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '' });
        }
        if (entries.length === 0) {
          notFound(res, 'Not Found');
          return;
        }
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
        const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
        const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.defaultBranch;
        const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 422, { message: 'Validation Failed: content must be base64.' });
          return;
        }
        let tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) {
          // Missing branch: create it at the default tip (or unborn).
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) {
            const files = new Map<string, { oid: string; mode: string }>();
            files.set(filePath, { oid: store.putObject(repo, 'blob', content), mode: '100644' });
            const commit = store.createCommit(repo, files, [], message);
            repo.refs.set(`refs/heads/${branch}`, commit);
            sendJson(res, 201, {
              content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: hashObject('blob', content), size: content.length, encoding: 'base64' },
              commit: { sha: commit, message },
            });
            return;
          }
          repo.refs.set(`refs/heads/${branch}`, tip);
        }
        const files = repoFiles(repo, tip);
        const existing = files.get(filePath);
        if (givenSha !== '' && existing !== undefined && existing.oid !== givenSha) {
          sendJson(res, 409, { message: 'Conflict: sha does not match the current file.' });
          return;
        }
        if (givenSha !== '' && existing === undefined) {
          sendJson(res, 409, { message: 'Conflict: sha given but the file does not exist.' });
          return;
        }
        const isUpdate = existing !== undefined;
        const next = new Map(files);
        next.set(filePath, { oid: store.putObject(repo, 'blob', content), mode: '100644' });
        const commit = store.createCommit(repo, next, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: hashObject('blob', content), size: content.length, encoding: 'base64' },
          commit: { sha: commit, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';
        const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.defaultBranch;
        const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) {
          notFound(res, 'Not Found');
          return;
        }
        const files = repoFiles(repo, tip);
        const existing = files.get(filePath);
        if (existing === undefined) {
          notFound(res, 'Not Found');
          return;
        }
        if (givenSha !== '' && existing.oid !== givenSha) {
          sendJson(res, 409, { message: 'Conflict: sha does not match the current file.' });
          return;
        }
        const next = new Map(files);
        next.delete(filePath);
        const commit = store.createCommit(repo, next, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, 200, { commit: { sha: commit, message } });
        return;
      }
      notFound(res);
      return;
    }
    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha) || repo.objects.get(sha) === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: ref and sha are required and sha must exist.' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const branch = decodePath(rest[3] as string);
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) {
          notFound(res, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
        return;
      }
      notFound(res);
      return;
    }
    // POST /labels and GET /labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()]);
        return;
      }
      if (method !== 'POST') {
        notFound(res);
        return;
      }
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      const color = typeof bodyObj.color === 'string' ? bodyObj.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required.' });
        return;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          if (title === '') {
            sendJson(res, 422, { message: 'Validation Failed: title is required.' });
            return;
          }
          const labels = Array.isArray(bodyObj.labels) ? bodyObj.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, { message: `Validation Failed: label ${label} does not exist.` });
              return;
            }
          }
          const issue = createIssueInStore(store, repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', labels);
          sendJson(res, 201, issueJson(issue));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
          if (direction === 'desc') issues.reverse();
          const { page, link } = paginate(issues.map((issue) => issueJson(issue)), query, req, `/api/v3/repos/${owner}/${repoName}/issues`);
          withLink(res, 200, page, link);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) {
        notFound(res);
        return;
      }
      const issue = repo.issues.get(number);
      if (issue === undefined) {
        notFound(res, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) issue.state = bodyObj.state;
          if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
          if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
          sendJson(res, 200, issueJson(issue));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const text = typeof bodyObj.body === 'string' ? bodyObj.body : '';
          const id = repo.nextCommentId;
          repo.nextCommentId += 1;
          const comment = { id, body: text };
          issue.comments.push(comment);
          sendJson(res, 201, { id, body: text, user: { login: VIEWER_LOGIN } });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN } })));
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }
    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          const headRef = typeof bodyObj.head === 'string' ? bodyObj.head : '';
          const baseRef = typeof bodyObj.base === 'string' ? bodyObj.base : '';
          if (title === '' || headRef === '' || baseRef === '') {
            sendJson(res, 422, { message: 'Validation Failed: title, head and base are required.' });
            return;
          }
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist.' });
            return;
          }
          const pull = createPullInStore(store, repo, {
            title,
            body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
            headRef,
            baseRef,
            headSha,
            baseSha,
          });
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') {
            pulls = pulls.filter((pull) => (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
          }
          pulls.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(pulls.map((pull) => pullJson(repo, pull)), query, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
          withLink(res, 200, page, link);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) {
        notFound(res);
        return;
      }
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        notFound(res, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        sendJson(res, 200, store.pullFiles(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const mergeMethod = typeof bodyObj.merge_method === 'string' ? bodyObj.merge_method : 'merge';
        if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
          sendJson(res, 422, { message: 'Validation Failed: merge_method is not supported.' });
          return;
        }
        const sha = store.mergePull(repo, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged cleanly.' });
          return;
        }
        sendJson(res, 200, { merged: true, sha, message: `Squash merged pull request #${pull.number}.` });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = pathOf(req);
      const raw = await readBody(req);

      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodePath(gitMatch[1] as string);
        const repoName = decodePath(gitMatch[2] as string);
        const tail = gitMatch[3] as string;
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain; charset=utf-8');
          return;
        }
        const { query } = pathOf(req);
        if (tail === 'info/refs' && req.method === 'GET') {
          const service = query.get('service') ?? '';
          if (service === 'git-upload-pack') {
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const ad = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
            sendRaw(res, 200, ad, 'application/x-git-upload-pack-advertisement');
            return;
          }
          if (service === 'git-receive-pack') {
            sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendRaw(res, 400, Buffer.from('unknown service'), 'text/plain; charset=utf-8');
          return;
        }
        if (tail === 'git-upload-pack' && req.method === 'POST') {
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          handleUploadPack(repo, raw, isV2, res);
          return;
        }
        if (tail === 'git-receive-pack' && req.method === 'POST') {
          handleReceivePack(repo, raw, res);
          return;
        }
        sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain; charset=utf-8');
        return;
      }

      // GraphQL
      if (pathname === '/api/graphql') {
        if (req.method !== 'POST') {
          notFound(res);
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        let body: unknown;
        try {
          body = parseJsonBody(raw);
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON body.' });
          return;
        }
        const answers = executeGraphQLRequest(store, body);
        sendJson(res, 200, answers.length === 1 ? answers[0] : answers);
        return;
      }

      // MCP
      if (pathname === '/mcp') {
        if (req.method !== 'POST') {
          notFound(res);
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
          return;
        }
        let body: unknown;
        try {
          body = parseJsonBody(raw);
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON.' } });
          return;
        }
        if (typeof body === 'object' && body !== null && !Array.isArray(body) && typeof (body as Record<string, unknown>).method === 'string') {
          const answer = handleMcpRequest(store, body);
          if (answer === null) {
            res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, 200, answer);
          return;
        }
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request.' } });
        return;
      }

      // REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        if (!isAuthorized(req)) {
          unauthorized(res);
          return;
        }
        const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
        await handleRest(req, res, segments, raw);
        return;
      }

      notFound(res);
    } catch (err) {
      console.error('request error', err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
  return server;
}
