/**
 * GraphQL query string constants — verbatim ports of corpus/graphql.py (#95).
 *
 * These are the six query templates used by the GitHub GraphQL transport.
 * No logic lives here; callers import the constants they need.
 */

const ISSUES_QUERY_NODES = `
        number
        state
        url
        createdAt
        updatedAt
        closedAt
        milestone { title }
        assignees(first: 10) { nodes { login } }
        labels(first: 30) { nodes { name } }
        subIssues(first: 50) { nodes { number repository { nameWithOwner } } }
        parent { number repository { nameWithOwner } }
        blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
        blocking(first: 50) { nodes { number repository { nameWithOwner } } }
`;

export const ISSUES_QUERY = `
query($owner: String!, $name: String!, $cursor: String, $since: DateTime) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $cursor
      filterBy: { since: $since }
      orderBy: { field: UPDATED_AT, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
${ISSUES_QUERY_NODES}      }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

/** Structure-only variant — omits `title` on issue nodes (#216 PR 6). */
export const ISSUES_QUERY_STRUCTURE_ONLY = `
query($owner: String!, $name: String!, $cursor: String, $since: DateTime) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $cursor
      filterBy: { since: $since }
      orderBy: { field: UPDATED_AT, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
${ISSUES_QUERY_NODES}      }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export function pickIssuesQuery(structureOnly: boolean): string {
  return structureOnly ? ISSUES_QUERY_STRUCTURE_ONLY : ISSUES_QUERY;
}

export const REPOS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(
      first: 100
      after: $cursor
      isArchived: false
      orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { name owner { login } isArchived isPrivate }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export const ARCHIVED_REPOS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(
      first: 100
      after: $cursor
      isArchived: true
      orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export const REFS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export const PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        # first: 25 — PRs closing more issues are out of scope for this tool
        # (Roxabi convention: 1 PR ≈ 1 epic)
        closingIssuesReferences(first: 25) {
          nodes { number repository { nameWithOwner } }
        }
        labels(first: 20) { nodes { name } }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

/**
 * Bundled per-repo query — collapses ISSUES_QUERY + REFS_QUERY + PRS_QUERY into
 * one subrequest per repo (3 independent GraphQL connections, each with its own
 * cursor).  Reduces subreq count from 3×N+1 to N+1, staying under the Workers
 * Free 50-subrequest cap for any org with ≤49 repos.
 */
const REPO_BUNDLE_ISSUES_NODES = `
        number
        state
        url
        createdAt
        updatedAt
        closedAt
        milestone { title }
        assignees(first: 10) { nodes { login } }
        labels(first: 30) { nodes { name } }
        subIssues(first: 50) { nodes { number repository { nameWithOwner } } }
        parent { number repository { nameWithOwner } }
        blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
        blocking(first: 50) { nodes { number repository { nameWithOwner } } }
`;

export const REPO_BUNDLE_QUERY = `
query(
  $owner: String!
  $name: String!
  $issuesCursor: String
  $refsCursor: String
  $prsCursor: String
  $since: DateTime
) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $issuesCursor
      filterBy: { since: $since }
      orderBy: { field: UPDATED_AT, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
${REPO_BUNDLE_ISSUES_NODES}      }
    }
    refs(refPrefix: "refs/heads/", first: 100, after: $refsCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
    pullRequests(states: OPEN, first: 50, after: $prsCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        # first: 25 — PRs closing more issues are out of scope for this tool
        # (Roxabi convention: 1 PR ≈ 1 epic)
        closingIssuesReferences(first: 25) {
          nodes { number repository { nameWithOwner } }
        }
        labels(first: 20) { nodes { name } }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

/** Structure-only variant — omits `title` on issue nodes (#216 PR 6). */
export const REPO_BUNDLE_QUERY_STRUCTURE_ONLY = `
query(
  $owner: String!
  $name: String!
  $issuesCursor: String
  $refsCursor: String
  $prsCursor: String
  $since: DateTime
) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $issuesCursor
      filterBy: { since: $since }
      orderBy: { field: UPDATED_AT, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
${REPO_BUNDLE_ISSUES_NODES}      }
    }
    refs(refPrefix: "refs/heads/", first: 100, after: $refsCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
    pullRequests(states: OPEN, first: 50, after: $prsCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        # first: 25 — PRs closing more issues are out of scope for this tool
        # (Roxabi convention: 1 PR ≈ 1 epic)
        closingIssuesReferences(first: 25) {
          nodes { number repository { nameWithOwner } }
        }
        labels(first: 20) { nodes { name } }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export function pickRepoBundleQuery(structureOnly: boolean): string {
  return structureOnly ? REPO_BUNDLE_QUERY_STRUCTURE_ONLY : REPO_BUNDLE_QUERY;
}

export const STUB_ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title state url createdAt updatedAt closedAt
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

/** Structure-only variant — omits `title` on the stub issue node (#216 PR 6). */
export const STUB_ISSUE_QUERY_STRUCTURE_ONLY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number state url createdAt updatedAt closedAt
    }
  }
  rateLimit { cost remaining resetAt }
}
`;

export function pickStubIssueQuery(structureOnly: boolean): string {
  return structureOnly ? STUB_ISSUE_QUERY_STRUCTURE_ONLY : STUB_ISSUE_QUERY;
}

export const SINGLE_ISSUE_DEPS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
      blocking(first: 50) { nodes { number repository { nameWithOwner } } }
    }
  }
  rateLimit { cost remaining resetAt }
}
`;
