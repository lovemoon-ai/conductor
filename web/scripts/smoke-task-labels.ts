/**
 * Manual smoke check for the task-label feature against a running server.
 *
 * Seeds a two-daemon MERGED project (same name, different daemons, same git
 * remote) where only one member defines labels, then drives the real HTTP
 * endpoint to prove the cross-daemon sync contract holds end to end.
 *
 * Usage:
 *   DATABASE_URL=file:/tmp/x.db BASE=http://localhost:6199 npx tsx scripts/smoke-task-labels.ts
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const db = new PrismaClient();
const BASE = process.env.BASE ?? 'http://localhost:6199';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log('      detail:', JSON.stringify(detail));
    process.exitCode = 1;
  }
};

const main = async () => {
  const stamp = Date.now();
  const user = await db.user.create({
    data: {
      email: `labels-smoke-${stamp}@example.com`,
      passwordHash: 'x',
      passwordSalt: 'y',
      subscriptionStatus: 'ACTIVE',
      subscriptionTier: 'PLUS',
      subscriptionEndsAt: new Date(Date.now() + 86_400_000),
    },
  });

  // Member A defines the labels; member B is the merged sibling that never had
  // them written (simulating a daemon that joined after configuration).
  const projectA = await db.project.create({
    data: {
      userId: user.id,
      name: 'conductor',
      daemonHost: 'mac-mini',
      gitRemoteUrl: 'github.com/acme/conductor',
      metadata: JSON.stringify({
        taskLabels: [
          { id: 'lbl-bug', name: 'bug' },
          { id: 'lbl-infra', name: 'infra' },
        ],
      }),
    },
  });
  const projectB = await db.project.create({
    data: {
      userId: user.id,
      name: 'conductor',
      daemonHost: 'linux-box',
      gitRemoteUrl: 'github.com/acme/conductor',
      metadata: null,
    },
  });
  // A same-named project that must NOT merge (different git remote).
  const projectForeign = await db.project.create({
    data: {
      userId: user.id,
      name: 'conductor',
      daemonHost: 'other-box',
      gitRemoteUrl: 'github.com/someone-else/conductor',
      metadata: JSON.stringify({
        taskLabels: [{ id: 'lbl-foreign', name: 'foreign' }],
      }),
    },
  });

  // The task lives on member B — the sibling with no labels of its own.
  const task = await db.task.create({
    data: {
      projectId: projectB.id,
      title: 'Smoke task',
      metadata: JSON.stringify({ daemonName: 'linux-box', backendType: 'claude' }),
    },
  });

  // Must match `signJwt` in lib/auth/service.ts — the claim is `sub`, not
  // `userId` (the unit-test helper's shape is only understood by the mocks).
  const token = jwt.sign({ sub: user.id, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
  const putLabels = async (labelIds: string[]) => {
    const response = await fetch(`${BASE}/api/tasks/${task.id}/labels`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ label_ids: labelIds }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // 1. A label defined only on the MERGED SIBLING is accepted for this task.
  const attach = await putLabels(['lbl-bug']);
  check(attach.status === 200, 'accepts a label defined on a merged sibling', attach);
  check(
    JSON.stringify(attach.body?.metadata?.labelIds) === JSON.stringify(['lbl-bug']),
    'persists the label id',
    attach.body?.metadata,
  );
  check(
    attach.body?.metadata?.daemonName === 'linux-box'
      && attach.body?.metadata?.backendType === 'claude',
    'preserves daemon-owned metadata keys',
    attach.body?.metadata,
  );

  // 2. Multiple labels on one task.
  const multi = await putLabels(['lbl-bug', 'lbl-infra']);
  check(
    JSON.stringify(multi.body?.metadata?.labelIds) === JSON.stringify(['lbl-bug', 'lbl-infra']),
    'a task can carry several labels',
    multi.body?.metadata,
  );

  // 3. A label from a same-named but NON-merging project is rejected.
  const foreign = await putLabels(['lbl-foreign']);
  check(foreign.status === 400, 'rejects a label from a non-merging same-name project', foreign);

  // 4. An unknown id is rejected rather than silently dropped.
  const unknown = await putLabels(['made-up']);
  check(unknown.status === 400, 'rejects an unknown label id', unknown);

  // 5. Labels survive an unrelated daemon-style metadata PATCH (stickiness).
  const patch = await fetch(`${BASE}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ metadata: { daemonName: 'linux-box-renamed' } }),
  });
  const patched = await patch.json().catch(() => null);
  check(
    JSON.stringify(patched?.metadata?.labelIds) === JSON.stringify(['lbl-bug', 'lbl-infra']),
    'labels survive an unrelated metadata PATCH',
    patched?.metadata,
  );

  // 6. Labels survive a full metadata wipe.
  const wipe = await fetch(`${BASE}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ metadata: null }),
  });
  const wiped = await wipe.json().catch(() => null);
  check(
    JSON.stringify(wiped?.metadata?.labelIds) === JSON.stringify(['lbl-bug', 'lbl-infra']),
    'labels survive a metadata: null wipe',
    wiped?.metadata,
  );

  // 7. Clearing works.
  const cleared = await putLabels([]);
  check(
    cleared.status === 200 && !cleared.body?.metadata?.labelIds,
    'clears every label with an empty list',
    cleared.body?.metadata,
  );

  await db.task.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id, projectForeign.id] } } });
  await db.project.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  await db.$disconnect();
};

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
