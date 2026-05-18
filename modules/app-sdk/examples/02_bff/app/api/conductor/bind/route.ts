/**
 * POST /api/conductor/bind → find-or-create the Conductor project for this
 * app, then create a fresh task inside it. Returns `{ projectId, taskId }`
 * for the browser to bootstrap the chat against.
 *
 * In a real app you'd probably persist projectId on the user record (it
 * stays the same forever) and only mint a new task when the user clicks
 * "start a new conversation". For the demo we mint a task on every bind.
 */
import { NextResponse } from 'next/server';
import { bindDemoProject, getClient } from '@/lib/conductor';
import { isConductorAppError } from '@love-moon/app-sdk';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const project = await bindDemoProject();
    const client = await getClient();
    const task = await client.tasks.create({
      projectId: project.id,
      title: 'Demo chat',
    });
    return NextResponse.json({
      projectId: project.id,
      taskId: task.id,
      daemonHost: project.daemonHost,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (isConductorAppError(err)) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status ?? 500 },
    );
  }
  return NextResponse.json(
    { error: (err as Error)?.message ?? 'Internal error' },
    { status: 500 },
  );
}
