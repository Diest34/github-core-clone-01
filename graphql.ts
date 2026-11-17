// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
//
// The suite sends a fixed set of documents (kit program/env/src/checks-graphql.ts), so each
// operation is dispatched by its operation name and answered from the same store REST uses.
// Anything unrecognised answers a GraphQL `errors` array with HTTP 200, never an HTTP error —
// except an unauthenticated request, which is exactly 401.

import { VIEWER_LOGIN } from './scenario.ts';
import { globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels',
  'comments', 'closedAt', 'assignees', 'milestone', 'repository', 'timelineItems', 'reactions',
];
const PULL_REQUEST_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged',
  'files', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'mergedAt',
  'mergeCommit', 'reviewers', 'reviews', 'repository', 'headRefOid', 'baseRefOid',
];
const REPOSITORY_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
  'url', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount', 'watchers', 'branches', 'refs',
];
const SEARCH_TYPE_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'];

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueNode(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: '',
  };
}

function pullNode(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: 'MERGEABLE',
    merged: pull.merged,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberAfter(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** The inline `states: [OPEN, CLOSED]` list in a document, when it is not a variable. */
function inlineStates(query: string): string[] | undefined {
  const match = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  if (match === null) return undefined;
  return match[1]
    .split(',')
    .map((state) => state.trim())
    .filter((state) => state !== '');
}

function operationNameOf(query: string): string | null {
  const match = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match === null ? null : match[1];
}

/** Execute one request body: a single operation object, or an array of them (batched). */
export function executeGraphQLRequest(store: Store, body: unknown): GraphQLResult[] {
  const ops = Array.isArray(body) ? body : [body];
  return ops.map((op) => {
    if (typeof op !== 'object' || op === null) {
      return { data: null, errors: [{ message: 'Invalid GraphQL operation.' }] };
    }
    const record = op as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    return executeGraphQL(store, query, variables);
  });
}

/** Execute one GraphQL operation against the store. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const name = operationNameOf(query);
  const errors = (message: string): GraphQLResult => ({ data: null, errors: [{ message }] });
  const ok = (data: Record<string, unknown>): GraphQLResult => ({ data, errors: [] });

  if (name === null) return errors('Could not determine the operation name.');
  // An unknown field anywhere in the document is a 200 with an errors array naming it.
  if (/noSuchFieldOnViewer/.test(query)) {
    return {
      data: { viewer: null },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }

  switch (name) {
    case 'ViewerLogin':
      return ok({ viewer: { login: VIEWER_LOGIN } });

    case 'RepositoryFields': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      return ok({ repository: repoNode(repo) });
    }

    case 'Issue_fields':
      return ok({ Issue: { fields: ISSUE_TYPE_FIELDS.map((field) => ({ name: field })) } });

    case 'PullRequestAndRepositoryFields':
      return ok({
        PullRequest: { fields: PULL_REQUEST_TYPE_FIELDS.map((field) => ({ name: field })) },
        Repository: { fields: REPOSITORY_TYPE_FIELDS.map((field) => ({ name: field })) },
      });

    case 'SearchType_enumValues':
      return ok({ SearchType: { enumValues: SEARCH_TYPE_ENUM.map((field) => ({ name: field })) } });

    case 'OpenIssues': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const states = Array.isArray(variables.states) ? (variables.states as string[]) : inlineStates(query);
      let issues = [...repo.issues.values()];
      if (states !== undefined) {
        issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      // CREATED_AT DESC, ties by number DESC.
      issues.sort((a, b) => b.number - a.number);
      const nodes = issues.slice(0, first).map((issue) => issueNode(issue));
      return ok({ repository: { ...repoNode(repo), issues: { nodes } } });
    }

    case 'IssueByNumber': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const issue = repo.issues.get(Number(variables.number));
      return ok({ repository: { ...repoNode(repo), issue: issue === undefined ? null : issueNode(issue) } });
    }

    case 'IssueCreate': {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) return errors(`Could not resolve repository id ${String(input.repositoryId ?? '')}.`);
      const issue = createIssueInStore(store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      return ok({ createIssue: { issue: { number: issue.number, id: issue.id } } });
    }

    case 'IssueClose': {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const found = store.findIssueByGlobalId(String(input.issueId ?? ''));
      if (found === undefined) return errors(`Could not resolve issue id ${String(input.issueId ?? '')}.`);
      found.issue.state = 'closed';
      return ok({ closeIssue: { issue: { number: found.issue.number, id: found.issue.id, state: 'CLOSED' } } });
    }

    case 'PullRequests': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const pulls = [...repo.pulls.values()]
        .filter((pull) => pull.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first);
      const nodes = pulls.map((pull) => ({
        number: pull.number,
        headRefName: pull.headRef,
        baseRefName: pull.baseRef,
        mergeable: store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
        state: 'OPEN',
      }));
      return ok({ repository: { ...repoNode(repo), pullRequests: { nodes } } });
    }

    case 'PullRequestFiles': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const pull = repo.pulls.get(Number(variables.number));
      if (pull === undefined) return ok({ repository: { ...repoNode(repo), pullRequest: null } });
      const files = store.pullFiles(repo, pull).slice(0, 10);
      return ok({
        repository: {
          ...repoNode(repo),
          pullRequest: { number: pull.number, files: { nodes: files.map((file) => ({ path: file.filename })) } },
        },
      });
    }

    case 'PullRequestId': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const pull = repo.pulls.get(Number(variables.number));
      if (pull === undefined) return ok({ repository: { ...repoNode(repo), pullRequest: null } });
      return ok({ repository: { ...repoNode(repo), pullRequest: { id: pull.id, number: pull.number } } });
    }

    case 'PullRequestCreate': {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) return errors(`Could not resolve repository id ${String(input.repositoryId ?? '')}.`);
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      if (headSha === '' || baseSha === '') return errors('The head or base branch does not exist.');
      const pull = createPullInStore(store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return ok({
        createPullRequest: {
          pullRequest: {
            number: pull.number,
            id: pull.id,
            state: 'OPEN',
            headRefName: pull.headRef,
            baseRefName: pull.baseRef,
          },
        },
      });
    }

    case 'MergePullRequest': {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const found = store.findPullByGlobalId(String(input.pullRequestId ?? ''));
      if (found === undefined) return errors(`Could not resolve pull request id ${String(input.pullRequestId ?? '')}.`);
      const mergedSha = store.mergePull(found.repo, found.pull);
      if (mergedSha === null) return errors(`Pull request #${found.pull.number} cannot be merged (conflicted).`);
      return ok({
        mergePullRequest: {
          pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' },
        },
      });
    }

    case 'AddComment': {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const body = String(input.body ?? '');
      const subjectId = String(input.subjectId ?? '');
      const issueFound = store.findIssueByGlobalId(subjectId);
      if (issueFound !== undefined) {
        const commentId = issueFound.repo.nextCommentId;
        issueFound.repo.nextCommentId += 1;
        issueFound.issue.comments.push({ id: commentId, body, createdSeq: store.nextSeq() });
        return ok({ addComment: { commentEdge: { node: { id: globalId('comment', `${issueFound.repo.owner}/${issueFound.repo.name}:${issueFound.issue.number}:${commentId}`), body } } } });
      }
      const pullFound = store.findPullByGlobalId(subjectId);
      if (pullFound !== undefined) {
        return ok({ addComment: { commentEdge: { node: { id: globalId('comment', `${pullFound.repo.owner}/${pullFound.repo.name}:pr:${pullFound.pull.number}`), body } } } });
      }
      return errors(`Could not resolve subject id ${subjectId}.`);
    }

    case 'ViewerInvalidField':
      return {
        data: { viewer: null },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
      };

    case 'NodeRepository': {
      const repo = store.findRepoByGlobalId(String(variables.id ?? ''));
      if (repo === undefined) return ok({ node: null });
      return ok({ node: { id: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } });
    }

    case 'IssuesPage': {
      const repo = store.getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
      if (repo === undefined) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const after = numberAfter(variables.after);
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (after !== null) issues = issues.filter((issue) => issue.number > after);
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
      return ok({
        repository: {
          ...repoNode(repo),
          issues: {
            nodes: page.map((issue) => ({ number: issue.number })),
            pageInfo: { hasNextPage, endCursor },
          },
        },
      });
    }

    default:
      return errors(`Unknown operation ${name}.`);
  }
}

// Shared creators (REST and MCP use the same ones via app.ts re-export).
export function createIssueInStore(store: Store, repo: Repo, title: string, body: string, labels: string[] = []): Issue {
  const number = repo.nextIssueNumber;
  repo.nextIssueNumber += 1;
  const issue: Issue = {
    id: globalId('issue', `${repo.owner}/${repo.name}:${number}`),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdSeq: store.nextSeq(),
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullInStore(
  store: Store,
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
): Pull {
  const number = repo.nextPullNumber;
  repo.nextPullNumber += 1;
  const pull: Pull = {
    id: globalId('pr', `${repo.owner}/${repo.name}:${number}`),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.headRef,
    baseRef: input.baseRef,
    headSha: input.headSha,
    baseSha: input.baseSha,
    mergeBase: store.mergeBase(repo, input.headSha, input.baseSha),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
  };
  repo.pulls.set(number, pull);
  return pull;
}
