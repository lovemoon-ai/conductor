import { db } from '@/lib/db';
import type { AuthUser } from '@/lib/auth/service';
import { isHostAllowedForShare } from './service';

/**
 * RFC 0035 — enforcement for `daemon_share`-scoped tokens.
 *
 * Such a token authenticates as the grantee but physically lives on the
 * owner's machine. Everything here exists to make sure it can only do the one
 * job it was minted for: run one guest daemon.
 */

/**
 * Routes a share-scoped token may reach.
 *
 * The surface is wider than the daemon's own `fetch` calls suggest, because a
 * fire process talks to the backend through `conductor-sdk`'s client too
 * (`/tasks/:id/group`, `/insert`, `/scheduled-messages`, `/issues/:id`, ...).
 * Scoping this list to only what `cli/src/daemon.js` calls directly makes a
 * shared daemon *look* healthy while its fires silently 401 partway through a
 * task — so the list is derived from `modules/conductor-sdk/src/backend/client.ts`
 * as well.
 *
 * Do NOT reason that "these routes already filter by `project: { userId }`, so
 * the token can only reach the grantee's own rows, so the list can be wide."
 * That argument is backwards: reaching *all* of the grantee's rows IS the
 * escalation, because this credential sits on the machine owner's disk. What
 * actually contains it is `isResourceInShareScope` below, which pins every
 * addressable resource to this share's own guest host.
 *
 * Given that, this list has one job -- keep the token away from surfaces that
 * are not about doing work on the shared machine at all:
 *   - account management (`/api/auth/**` — especially `tokens/latest` and
 *     `config`, which hand out credentials; `/api/daemon-shares/**`, where a
 *     guest could read its siblings' plaintext tokens)
 *   - control of *other* daemons (`/api/ai-manager/**`, and `/api/agents/:host/*`
 *     for any host that is not this share's own -- the latter is enforced by
 *     host-pinning in `isResourceInShareScope`, not by omitting the route)
 *
 * Everything a daemon and its fires legitimately do on the shared machine IS
 * listed. A guest that cannot list projects or open a diagnostic is a worse
 * daemon than an ordinary one, which is not the trade this feature makes.
 */
const DAEMON_SHARE_ALLOWED_PATHS: RegExp[] = [
  // The daemon list, plus per-daemon control (`exec`, `restart`,
  // `custom-commands`). These are NOT withheld: driving your own machine is
  // what a daemon is for, and advertising `remote_exec` while 401ing the route
  // that invokes it is incoherent. What must not happen is driving a
  // *different* daemon -- `isResourceInShareScope` pins `<host>` to this
  // share's own guest host below.
  /^\/api\/agents\/?$/,
  /^\/api\/agents\/[^/]+(\/.*)?$/,
  // The task, project and issue surfaces a daemon and its fires actually use,
  // collections included: `resolveDefaultProjectId` in fire calls
  // `GET/POST /api/projects`, and `conductor issue` run by the AI inside a
  // guest task calls `/api/issues`. Denying the collections made a shared
  // daemon strictly less capable than an ordinary one for no security gain --
  // escalation is prevented by the row-level check below, not by hiding lists.
  /^\/api\/tasks(\/.*)?$/,
  /^\/api\/projects(\/.*)?$/,
  /^\/api\/issues(\/.*)?$/,
  /^\/api\/diagnostics\/tasks\/[^/]+\/?$/,
  // The daemon-only HTTP surface (upstream events, attachment transfer).
  /^\/api\/agent(\/.*)?$/,
];

/**
 * Subroutes that sit under an allowed prefix but must still be refused.
 *
 * Empty on purpose. `/api/tasks/:id/share` used to be here: it mints an
 * unauthenticated `SharedTask` link that outlives revocation. That mattered
 * while path allowlisting was the only layer, because the token could then
 * reach *any* of the grantee's tasks. Once row-level scoping landed, the only
 * transcripts reachable are those of tasks running on the shared machine --
 * whose logs the owner can already read off their own disk. Keeping the deny
 * stopped nothing and left a guest unable to share its own task, which an
 * ordinary daemon can do.
 *
 * Kept as a list so the next genuinely dangerous subroute has an obvious home.
 */
const DAEMON_SHARE_DENIED_PATHS: RegExp[] = [];

/**
 * The single normalization every layer must agree on.
 *
 * Case and duplicate slashes both matter: Next resolves routes
 * case-insensitively on macOS's default APFS, and `/api/tasks//x` still matches
 * a broad `/api/tasks(/.*)?` rule while missing a `[^/]+` one.
 *
 * Percent-decoding matters as much as the rest: `/api/tasks/1/%73hare` reaches
 * the share handler after Next decodes the segment, but a regex looking for the
 * literal `share` never sees it. Decoding here removes that whole class of
 * question -- there is no need to reason about what the router does downstream.
 *
 * Malformed escapes (`%ZZ`) throw; treat that as "cannot be understood", which
 * for a security decision means unusable rather than benign.
 */
export const normalizeSharePath = (pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.replace(/\/{2,}/g, '/').toLowerCase();
};

/**
 * Takes an ALREADY-normalized path. Callers must pass the same string they give
 * `isResourceInShareScope` -- two layers matching on different strings is not
 * layered defence, it is a gap, which is exactly how `/api/tasks//x` used to
 * pass the allowlist and then miss every resource branch.
 */
export const isPathAllowedForDaemonShare = (normalizedPath: string): boolean => {
  if (DAEMON_SHARE_DENIED_PATHS.some((pattern) => pattern.test(normalizedPath))) return false;
  return DAEMON_SHARE_ALLOWED_PATHS.some((pattern) => pattern.test(normalizedPath));
};

export const isDaemonShareUser = (user: Pick<AuthUser, 'tokenScope'>): boolean =>
  user.tokenScope === 'daemon_share';

export type ShareBinding = {
  shareId: string;
  guestHost: string;
  granteeUserId: string;
};

/**
 * Resolve the active share a token belongs to.
 *
 * Returns null when the share is missing, revoked, or not yet accepted — a
 * credential whose share is no longer active must fail closed even if the
 * token row itself has not been revoked yet (revocation writes two rows and
 * something could land between them).
 */
export async function resolveActiveShareForToken(
  token: string,
  userId?: string,
): Promise<ShareBinding | null> {
  // `tokenPrefix` is 8 hex chars = 32 bits, and this lookup deliberately does
  // not re-run the PBKDF2 verify that `authenticateToken` already did. So on a
  // prefix collision between two share tokens we could otherwise return the
  // *other* user's binding, and every downstream query would then run against
  // their rows. Filtering on the already-authenticated user id removes that
  // possibility without paying for a second hash.
  const tokenPrefix = token.slice(0, 8);
  const candidates = await db.userToken.findMany({
    where: {
      tokenPrefix,
      revokedAt: null,
      scope: 'daemon_share',
      ...(userId ? { userId } : {}),
    },
    select: { id: true, userId: true, daemonShareId: true },
  });
  for (const candidate of candidates) {
    if (!candidate.daemonShareId) continue;
    const share = await db.daemonShare.findFirst({
      where: {
        id: candidate.daemonShareId,
        status: 'active',
        granteeUserId: candidate.userId,
      },
      select: { id: true, guestHost: true, granteeUserId: true },
    });
    if (share?.guestHost && share.granteeUserId) {
      return {
        shareId: share.id,
        guestHost: share.guestHost,
        granteeUserId: share.granteeUserId,
      };
    }
  }
  return null;
}

/**
 * Is this connection allowed to claim `host`?
 *
 * This is the load-bearing check of the whole feature. `agentHost` is entirely
 * client-asserted (the `x-conductor-host` header; the server does no ownership
 * check), and on a duplicate host the gateway calls `takeOverAgentHost()`,
 * which *evicts the existing connection*. Without this binding the owner —
 * who holds the grantee's token on their own disk — could connect claiming to
 * be the grantee's personal laptop, kick that daemon offline, and receive the
 * tasks meant for it. That is not a marginal escalation; it is taking over the
 * grantee's other machines.
 *
 * Fire hosts are accepted too: a fire launched by the guest inherits the
 * guest's token and connects as a separate agent under
 * `conductor-fire-<guestHost>-<taskId>`. Rejecting those would let a shared
 * daemon start tasks but never report results.
 */
export const isShareHostAllowed = (binding: ShareBinding, host: string): boolean =>
  isHostAllowedForShare(host, binding.guestHost);

/**
 * Row-level scoping: a share token may only touch resources that live on its
 * own guest host.
 *
 * Path allowlisting alone is NOT sufficient, and reasoning that "these routes
 * already filter by `project: { userId }`, so the token can only reach the
 * grantee's own rows" gets it exactly backwards. Reaching *all* of the
 * grantee's rows is the escalation, because this credential sits on the
 * machine owner's disk by design. Without this layer the owner can read the
 * token out of the guest config and `POST /api/tasks` against a project bound
 * to the grantee's *personal laptop* -- the task routes to that daemon, and an
 * AI task is an arbitrary prompt handed to a CLI with shell access. That is
 * code execution on the grantee's own machine, which is the one thing sharing
 * a daemon must never grant.
 *
 * Returns true when the request may proceed.
 */
/**
 * Every field by which a caller can name a *destination daemon* in a request
 * body.
 *
 * This has to be checked on every route, not just task creation. Round 1 fixed
 * `POST /api/tasks` and left the identical escalation open through two other
 * verbs: `PATCH /api/tasks/:id` takes `agent_host` plus a `launch_config` whose
 * `command`/`args`/`env` are dispatched verbatim to a pty task, and
 * `POST /api/tasks/:id/restart` takes `target_daemon_host` (which additionally
 * *disables* the project-binding guard). Both resolve the target against
 * `getAgentsForUser(user.id)` -- any of the grantee's online daemons -- so
 * either one relocates work onto the grantee's personal machine and runs it
 * there.
 *
 * Enumerating the fields once, and applying the rule to every request, is the
 * only version of this that stays correct as routes are added.
 */
/**
 * Segments under `/api/tasks/` that are collection-shaped reads, not task ids.
 * They must not be looked up as a task (the lookup would miss and, now that
 * this layer fails closed, 401 every `list_tasks` the AI makes inside a shared
 * task).
 */
const TASK_COLLECTION_SEGMENTS = new Set(['achieved']);

const HOST_TARGET_BODY_FIELDS = new Set([
  'agentHost',
  'agent_host',
  'targetDaemonHost',
  'target_daemon_host',
  'executionHost',
  'execution_host',
  // `PATCH /api/projects/:id` rebinds a project to a machine, and the field
  // arrives nested under `binding`. Without it a share token can repoint the
  // grantee's project at another of their daemons -- caught downstream at task
  // creation, but still an unauthorized write, and it disproves the premise
  // that enumerating these once keeps the rule correct as routes are added.
  'daemonHost',
  'daemon_host',
]);

/**
 * Walk the body for any field naming a destination daemon.
 *
 * Recursive, because these are not always top-level: the project route nests
 * `daemonHost` under `binding`. Depth- and breadth-capped so a hostile body
 * cannot turn this check into a CPU sink.
 */
const isBodyHostRedirectAllowed = (
  binding: ShareBinding,
  body: unknown,
  depth = 0,
): boolean => {
  if (depth > 4 || !body || typeof body !== 'object') return true;
  let seen = 0;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (++seen > 200) break;
    if (typeof value === 'string') {
      if (
        HOST_TARGET_BODY_FIELDS.has(key) &&
        value.trim() &&
        !isHostAllowedForShare(value, binding.guestHost)
      ) {
        return false;
      }
    } else if (value && typeof value === 'object') {
      if (!isBodyHostRedirectAllowed(binding, value, depth + 1)) return false;
    }
  }
  return true;
};

export async function isResourceInShareScope(
  binding: ShareBinding,
  pathname: string,
  body: unknown,
): Promise<boolean> {
  // Applied first and unconditionally: no route may redirect work off this
  // share's own host, whatever else it does.
  if (!isBodyHostRedirectAllowed(binding, body)) return false;

  const hostFilter = { OR: [{ agentHost: binding.guestHost }, { executionHost: binding.guestHost }] };

  const taskMatch = /^\/api\/tasks\/([^/]+)/.exec(pathname);
  if (taskMatch && !TASK_COLLECTION_SEGMENTS.has(taskMatch[1])) {
    const task = await db.task.findFirst({
      where: {
        id: decodeURIComponent(taskMatch[1]),
        project: { userId: binding.granteeUserId },
        ...hostFilter,
      },
      select: { id: true },
    });
    return Boolean(task);
  }

  // Collection reads carry no destination to redirect, and collection writes
  // are already covered by the body host scan above (e.g. creating a project
  // bound to another of the grantee's daemons is refused there).
  if (/^\/api\/(projects|issues)\/?$/.test(pathname)) return true;

  const projectMatch = /^\/api\/projects\/([^/]+)/.exec(pathname);
  if (projectMatch) {
    const project = await db.project.findFirst({
      where: {
        id: decodeURIComponent(projectMatch[1]),
        userId: binding.granteeUserId,
        daemonHost: binding.guestHost,
      },
      select: { id: true },
    });
    return Boolean(project);
  }

  const issueMatch = /^\/api\/issues\/([^/]+)/.exec(pathname);
  if (issueMatch) {
    const issue = await db.issue.findFirst({
      where: {
        id: decodeURIComponent(issueMatch[1]),
        project: { userId: binding.granteeUserId, daemonHost: binding.guestHost },
      },
      select: { id: true },
    });
    return Boolean(issue);
  }

  // Collection routes carry the target in the body instead of the path. The
  // task-creation one is the dangerous direction: it is what would otherwise
  // let a share token start work on the grantee's other machines.
  if (/^\/api\/tasks\/?$/.test(pathname) || TASK_COLLECTION_SEGMENTS.has(taskMatch?.[1] ?? '')) {
    // A read of the collection has no destination to redirect. Refusing it
    // would 401 every `list_tasks` the AI makes inside a shared task, which is
    // exactly the "daemon looks healthy but its fires 401 mid-task" failure the
    // allowlist exists to avoid. `body` is null on GET, so this branch is the
    // only way to tell the two apart here.
    if (body === null || body === undefined) return true;

    const record = body as Record<string, unknown>;
    const projectId = record.projectId ?? record.project_id;
    if (typeof projectId !== 'string' || !projectId) {
      // No project means the backend picks a default host -- refuse rather
      // than let it pick one of the grantee's own daemons.
      return false;
    }
    const project = await db.project.findFirst({
      where: {
        id: projectId,
        userId: binding.granteeUserId,
        daemonHost: binding.guestHost,
      },
      select: { id: true },
    });
    if (!project) return false;
    // An explicit agent_host must also be ours, or the route would dispatch
    // the task somewhere else entirely.
    const requestedHost = record.agentHost ?? record.agent_host;
    if (typeof requestedHost === 'string' && requestedHost.trim()) {
      return isHostAllowedForShare(requestedHost, binding.guestHost);
    }
    return true;
  }

  // The bare list names no daemon; the route filters it to this share.
  if (/^\/api\/agents\/?$/.test(pathname)) return true;

  const agentHostMatch = /^\/api\/agents\/([^/]+)/.exec(pathname);
  if (agentHostMatch) {
    // Compared case-insensitively: `normalizeSharePath` lowercases the whole
    // path, but a guest host is not necessarily lowercase (it is built from an
    // owner label and a machine name). Task/project ids are lowercase UUIDs so
    // the other branches are unaffected. The route itself still matches the
    // host exactly against the live connection, so a case-tolerant gate here
    // cannot admit a host that does not exist.
    const requested = decodeURIComponent(agentHostMatch[1]);
    return isHostAllowedForShare(requested, binding.guestHost.toLowerCase());
  }

  const diagMatch = /^\/api\/diagnostics\/tasks\/([^/]+)/.exec(pathname);
  if (diagMatch) {
    const task = await db.task.findFirst({
      where: {
        id: decodeURIComponent(diagMatch[1]),
        project: { userId: binding.granteeUserId },
        ...hostFilter,
      },
      select: { id: true },
    });
    return Boolean(task);
  }

  // Fail closed. The allowlist admits `/api/tasks/**`, `/api/projects/:id` and
  // `/api/issues/:id` by prefix; if a URL got through it but matched none of
  // the resource shapes above, this layer does not know what it is being asked
  // to authorize. For a check the surrounding comment calls load-bearing, the
  // default has to be refusal -- letting it through is how `/api/tasks//x`
  // skipped host scoping entirely.
  if (/^\/api\/(tasks|projects|issues|diagnostics|agents)(\/|$)/.test(pathname)) return false;

  // Only `/api/agents` (the caller's own daemon list, filtered to this share in
  // the route itself) and `/api/agent/**` (host-pinned by
  // `authenticateAgentRequest` and the events route) reach here.
  return true;
}
