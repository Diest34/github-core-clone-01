// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp), JSON-RPC 2.0.
//
// The suite speaks revision 2026-07-28 (server/discover, no handshake, no session) and falls
// back to the handshake era (initialize + notifications/initialized) when a server predates it.
// This server speaks the modern era and answers initialize too, so either path works.
//
// Tools act on the same store as REST: a repository or issue created over MCP reads back over
// /api/v3 as the same object, with the same id.

import { VIEWER_LOGIN } from './scenario.ts';
import type { Repo, Store } from './store.ts';
import { createIssueInStore, createPullInStore } from './graphql.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list: one constant object, serialized identically on every tools/list call. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[]; id: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullJson(pull: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; id: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
  };
}

/** Resolve owner/repo from tool arguments (also accepts a full_name "owner/repo"). */
function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repoName === '') && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    if (owner === '') owner = o ?? '';
    if (repoName === '') repoName = r ?? '';
  }
  if (owner === '' || repoName === '') return null;
  return store.getRepo(owner, repoName) ?? null;
}

/** Dispatch one tools/call. Returns a tool result object (never throws for a tool failure). */
export function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown>; isError: boolean } {
  const missing = (required: string[]): string | null => {
    for (const key of required) {
      if (args[key] === undefined || args[key] === null || args[key] === '') return key;
    }
    return null;
  };
  const toolDef = MCP_TOOLS.find((tool) => tool.name === name);
  if (toolDef === undefined) return { result: toolResult(`Unknown tool: ${name}`, true), isError: true };
  const missingKey = missing(toolDef.inputSchema.required);
  if (missingKey !== null) {
    return { result: toolResult(`Missing required argument: ${missingKey}`, true), isError: true };
  }

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return { result: toolResult(`Repository ${VIEWER_LOGIN}/${repoName} already exists.`, true), isError: true };
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, isPrivate, description);
      return { result: toolResult(repoJson(repo)), isError: false };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Repository not found.', true), isError: true };
      return { result: toolResult(repoJson(repo)), isError: false };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Repository not found.', true), isError: true };
      const issue = createIssueInStore(store, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      return { result: toolResult(issueJson(repo, issue)), isError: false };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Repository not found.', true), isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
      return { result: toolResult(issues), isError: false };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Repository not found.', true), isError: true };
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      if (headSha === '' || baseSha === '') return { result: toolResult('The head or base branch does not exist.', true), isError: true };
      const pull = createPullInStore(store, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return { result: toolResult(pullJson(pull)), isError: false };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Repository not found.', true), isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { result: toolResult(`Pull request #${number} not found.`, true), isError: true };
      const mergedSha = store.mergePull(repo, pull);
      if (mergedSha === null) return { result: toolResult(`Pull request #${number} cannot be merged (conflicted).`, true), isError: true };
      return { result: toolResult({ merged: true, number: pull.number, sha: mergedSha, state: 'closed' }), isError: false };
    }
    default:
      return { result: toolResult(`Unknown tool: ${name}`, true), isError: true };
  }
}

/**
 * Handle one parsed JSON-RPC request object. Returns null for a notification (no response).
 * `httpStatus` is the HTTP status to answer with (200 normally; 400 for a parse error is
 * decided by the caller, which cannot parse the body at all).
 */
export function handleMcpRequest(store: Store, request: unknown): JsonRpcResponse | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return error(null, -32600, 'Invalid Request.');
  }
  const record = request as Record<string, unknown>;
  const id: JsonRpcId = typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  const isNotification = record.id === undefined;

  if (method === 'server/discover') {
    return result(id, {
      resultType: 'discover',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return result(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized') {
    return null; // A notification: no response.
  }
  if (method === 'ping') {
    return result(id, {});
  }
  if (method === 'tools/list') {
    return result(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return error(id, -32602, 'tools/call needs a tool name.');
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) return error(id, -32602, `Unknown tool: ${toolName}`);
    const { result: toolRes } = callTool(store, toolName, args);
    return result(id, toolRes);
  }
  if (method === '') {
    if (isNotification) return null;
    return error(id, -32600, 'Invalid Request: no method.');
  }
  return error(id, -32601, `Method not found: ${method}`);
}

export { error as mcpError, result as mcpResult };
