# Project API snake_case serialization broke CreateTaskDialog

**Bug type:** arch
**Date:** 2026-04-09
**Commit introducing bug:** `e5ebf86` (review fix batch)
**Commit fixing bug:** `441e7fc`

## Symptom

After creating a project from the web UI, opening the "Create Task" dialog did not show the new project, and task creation failed with "Project not found" (or selected no project at all). Existing projects loaded before the regression also disappeared from the selector after a page refresh.

## Root cause

`web/src/app/api/projects/route.ts` and `web/src/app/api/projects/[projectId]/route.ts` emitted project responses in different casings: the list route used camelCase (`daemonHost`, `isDefault`), the detail route used snake_case (`daemon_host`, `is_default`). A code review flagged this as "inconsistent casing" and the fix standardized both on **snake_case** to match the rest of the REST API surface.

The web client had never been snake_case. `shared/types/index.ts` declared `Project` with camelCase fields. `useProjectsStore` stored responses verbatim. `CreateTaskDialog` then filtered:

```ts
const selectableProjects = projects.filter(
  (project) => Boolean(project.isDefault) || Boolean(project.daemonHost),
);
```

With the server now returning `is_default` / `daemon_host`, `project.isDefault` and `project.daemonHost` were `undefined`, the filter rejected every project, and the selector was empty. The same bug hit `ProjectItem` (showing every project as "pending binding") and any other client that touched those fields.

## Fix

`serializeProject` in `web/src/app/api/projects/shared.ts` now emits **both** casings:

```ts
return {
  id, name,
  daemonHost, workspacePath, repoRoot, worktreeBranch, lastCommit, fileCount, isDefault, createdAt, updatedAt,      // primary, camelCase
  daemon_host, workspace_path, repo_root, worktree_branch, last_commit, file_count, is_default, created_at, updated_at,  // aliases
  metadata,
};
```

Client code continues to read camelCase. Older consumers (tests, SDK) that read snake_case still work. No case conversion happens in the API client itself — the server is authoritative.

## How to avoid next time

1. **API response casing is a contract.** Before "standardizing" a server-side serializer, grep the whole repo for every consumer of each field name. Client stores that type their response objects do not tolerate silent field renames.
2. **Tests must check the fields the real client reads.** `route.test.ts` covered only the snake_case output; there was no test that fed the response through `useProjectsStore` + `CreateTaskDialog.selectableProjects`. When a test file only asserts the shape the route emits, it cannot catch a rename that moves the break downstream.
3. **A code-review note about "inconsistency" is not the same as a bug report.** The original branch had `route.ts` in camelCase (matching the client) and `[projectId]/route.ts` in snake_case (matching tests). The correct fix was to bring `[projectId]/route.ts` up to camelCase, not the other way around. When two modules disagree, check which one the production consumers depend on before picking the "standard".
4. For this codebase, the convention going forward: **project API responses are camelCase primary with snake_case aliases.** Any new field on `Project` should be added to both sets in `serializeProject`.
