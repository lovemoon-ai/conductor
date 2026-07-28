/**
 * Fake `BackendApiClient` for CLI integration tests.
 *
 * The CLI tests instantiate the real `ProjectsApi` / `IssuesApi` / `TasksApi`
 * classes (review M4: stubs that mirror the wrong signatures hide CLI ↔ SDK
 * drift). We feed those real Api classes a `FakeBackendApi` whose method
 * surface matches what `modules/conductor-sdk/src/api/shared.ts ApiClient`
 * documents — so a signature drift on either side breaks the tests.
 */

import {
  BackendApiError,
  ProjectSummary,
  TaskSummary,
} from "../../../modules/conductor-sdk/dist/index.js";

const SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR =
  "Scheduled message is already completed, canceled, or does not exist";

export class FakeBackendApi {
  constructor(initial = {}) {
    this.projects = (initial.projects ?? []).map((project) => ({ ...project }));
    this.issues = (initial.issues ?? []).map((issue) => ({ ...issue }));
    this.tasks = (initial.tasks ?? []).map((task) => ({ ...task }));
    this.messages = (initial.messages ?? []).map((message) => ({ ...message }));
    this.scheduledMessages = (initial.scheduledMessages ?? []).map((schedule) => ({ ...schedule }));
    this.createTaskGrouping = initial.createTaskGrouping ?? null;
    this.createAppTaskError = initial.createAppTaskError ?? null;
    this.calls = [];
    this.matchProjectByPathResult = initial.matchProjectByPathResult ?? {
      project: null,
      matchedPath: null,
    };
  }

  // ---- ProjectsApi backing ----

  asProjectSummary(record) {
    const summary = ProjectSummary.fromJSON({
      id: record.id,
      name: record.name ?? undefined,
      daemonHost: record.daemonHost ?? null,
      workspacePath: record.workspacePath ?? null,
      isDefault: record.isDefault ?? false,
    });
    summary.asObject = () => ({
      id: record.id,
      name: record.name ?? null,
      daemonHost: record.daemonHost ?? null,
      workspacePath: record.workspacePath ?? null,
      isDefault: record.isDefault ?? false,
      hidden: record.hidden ?? false,
      hiddenAt: record.hiddenAt ?? null,
      metadata: record.metadata ?? null,
    });
    return summary;
  }

  async listProjects() {
    this.calls.push({ method: "listProjects" });
    return this.projects.map((record) => this.asProjectSummary(record));
  }

  async getProject(idOrName) {
    this.calls.push({ method: "getProject", idOrName });
    const project = this.projects.find((entry) => entry.id === idOrName);
    if (!project) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    return {
      id: project.id,
      name: project.name ?? null,
      daemonHost: project.daemonHost ?? null,
      workspacePath: project.workspacePath ?? null,
      isDefault: project.isDefault ?? false,
      hidden: project.hidden ?? false,
      hiddenAt: project.hiddenAt ?? null,
    };
  }

  async createProject(params) {
    this.calls.push({ method: "createProject", body: params });
    const record = {
      id: `proj-${this.projects.length + 1}`,
      name: params.name ?? "New Project",
      daemonHost: params.daemonHost ?? null,
      workspacePath: params.workspacePath ?? null,
      isDefault: Boolean(params.isDefault ?? params.is_default),
      hidden: false,
    };
    this.projects.push(record);
    return this.asProjectSummary(record);
  }

  async setDefaultProject(projectId, extraBody = {}) {
    this.calls.push({ method: "setDefaultProject", projectId, body: extraBody });
    const record = this.projects.find((project) => project.id === projectId);
    if (!record) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    return {
      id: record.id,
      name: record.name ?? null,
      isDefault: true,
      hidden: false,
      ...extraBody,
    };
  }

  async patchProjectByQuery(projectId, body) {
    this.calls.push({ method: "patchProjectByQuery", projectId, body });
    const record = this.projects.find((project) => project.id === projectId);
    if (!record) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    if (typeof body.hidden === "boolean") {
      record.hidden = body.hidden;
      record.hiddenAt = body.hidden ? new Date().toISOString() : null;
    }
    return {
      id: record.id,
      name: record.name ?? null,
      daemonHost: record.daemonHost ?? null,
      workspacePath: record.workspacePath ?? null,
      isDefault: record.isDefault ?? false,
      hidden: record.hidden,
      hiddenAt: record.hiddenAt,
    };
  }

  async matchProjectByPath(params) {
    this.calls.push({ method: "matchProjectByPath", params });
    return this.matchProjectByPathResult;
  }

  async updateProject() {
    throw new Error("updateProject: not used in CLI tests");
  }

  // ---- IssuesApi backing ----

  async listIssues(params = {}) {
    this.calls.push({ method: "listIssues", params });
    let result = this.issues.slice();
    if (params.projectId) {
      result = result.filter((issue) => issue.projectId === params.projectId);
    }
    if (params.status) {
      result = result.filter((issue) => issue.status === params.status);
    }
    return result.map((issue) => ({ ...issue }));
  }

  async getIssue(issueId) {
    this.calls.push({ method: "getIssue", issueId });
    const issue = this.issues.find((entry) => entry.id === issueId);
    if (!issue) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    return { ...issue };
  }

  async createIssue(params) {
    this.calls.push({ method: "createIssue", body: params });
    const issue = {
      id: `issue-${this.issues.length + 1}`,
      projectId: params.projectId,
      title: params.title,
      description: params.description ?? null,
      status: params.status ?? "todo",
      priority: params.priority ?? "P1",
      metadata: params.metadata ?? null,
    };
    this.issues.push(issue);
    return { ...issue };
  }

  async patchIssue(issueId, body) {
    this.calls.push({ method: "patchIssue", issueId, body });
    const issue = this.issues.find((entry) => entry.id === issueId);
    if (!issue) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    if (body.title !== undefined) issue.title = body.title;
    if (body.description !== undefined) issue.description = body.description;
    if (body.status !== undefined) issue.status = body.status;
    if (body.priority !== undefined) issue.priority = body.priority;
    if (body.metadata !== undefined) issue.metadata = body.metadata;
    return { issue: { ...issue }, activeTask: null };
  }

  async deleteIssue(issueId) {
    this.calls.push({ method: "deleteIssue", issueId });
    const idx = this.issues.findIndex((entry) => entry.id === issueId);
    if (idx === -1) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    this.issues.splice(idx, 1);
  }

  // ---- TasksApi backing ----

  asTaskSummary(record) {
    const summary = TaskSummary.fromJSON({
      id: record.id,
      project_id: record.projectId,
      title: record.title,
      status: record.status,
      ...(record.grouping
        ? {
            grouping: {
              parent_task_id: record.grouping.parentTaskId,
              grouped: record.grouping.grouped,
              warning: record.grouping.warning ?? null,
            },
          }
        : {}),
    });
    summary.asObject = () => ({
      id: record.id,
      projectId: record.projectId,
      issueId: record.issueId ?? null,
      title: record.title,
      status: record.status,
      grouping: record.grouping ?? null,
    });
    return summary;
  }

  async listTasks(params = {}) {
    this.calls.push({ method: "listTasks", params });
    let result = this.tasks.slice();
    if (params.projectId) {
      result = result.filter((task) => task.projectId === params.projectId);
    }
    return result.map((task) => this.asTaskSummary(task));
  }

  async getTask(taskId) {
    this.calls.push({ method: "getTask", taskId });
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    return this.asTaskSummary(task);
  }

  async createAppTask(params) {
    this.calls.push({ method: "createAppTask", body: params });
    if (this.createAppTaskError) {
      throw this.createAppTaskError;
    }
    const task = {
      id: `task-${this.tasks.length + 1}`,
      projectId: params.projectId,
      title: params.title,
      status: params.status ?? "init",
      backendType: params.backendType ?? null,
      sessionId: params.sessionId ?? null,
      sessionFilePath: params.sessionFilePath ?? null,
      grouping: params.parentTaskId
        ? this.createTaskGrouping ?? {
            parentTaskId: params.parentTaskId,
            grouped: true,
          }
        : null,
    };
    this.tasks.push(task);
    return this.asTaskSummary(task);
  }

  async getTaskGroup(taskId) {
    this.calls.push({ method: "getTaskGroup", taskId });
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new BackendApiError("not found", 404, { error: "Not found" });
    }
    const groupId = task.groupId ?? null;
    return {
      group_id: groupId,
      members: groupId
        ? this.tasks
            .filter((entry) => entry.groupId === groupId)
            .map((entry) => ({
              task_id: entry.id,
              role: entry.role ?? null,
              agent: entry.agent ?? null,
              title: entry.title ?? null,
              status: entry.status ?? null,
              backend_type: entry.backendType ?? null,
              is_self: entry.id === taskId,
            }))
        : [],
    };
  }

  async listTaskMessages(taskId, params = {}) {
    this.calls.push({ method: "listTaskMessages", taskId, params });
    return this.messages.filter((message) => message.taskId === taskId).map((message) => ({ ...message }));
  }

  async postTaskMessage(taskId, body) {
    this.calls.push({ method: "postTaskMessage", taskId, body });
    const message = {
      id: `msg-${this.messages.length + 1}`,
      task_id: taskId,
      role: body.role ?? "sdk",
      content: body.content,
      metadata: body.metadata ?? null,
      created_at: new Date().toISOString(),
    };
    this.messages.push(message);
    return { ...message };
  }

  async listScheduledMessages(taskId) {
    this.calls.push({ method: "listScheduledMessages", taskId });
    return this.scheduledMessages
      .filter((schedule) => (schedule.taskId ?? schedule.task_id) === taskId)
      .map((schedule) => ({ ...schedule }));
  }

  async createScheduledMessage(taskId, body) {
    this.calls.push({ method: "createScheduledMessage", taskId, body });
    const schedule = {
      id: `sched-${this.scheduledMessages.length + 1}`,
      task_id: taskId,
      source_message_id: body.sourceMessageId ?? null,
      content: body.content,
      kind: body.schedule?.mode === "interval" ? "interval" : "once_delay",
      condition: body.schedule?.condition ?? "none",
      interval_ms: null,
      timezone: body.schedule?.timezone ?? null,
      status: "active",
      next_run_at: "2026-01-01T01:00:00.000Z",
      run_count: 0,
      skip_count: 0,
      failure_count: 0,
      max_runs: null,
      max_skips: null,
      stop_at: null,
      stop_when_task_not_running: true,
      last_run_at: null,
      last_error: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    this.scheduledMessages.push(schedule);
    return { ...schedule };
  }

  async deleteScheduledMessage(taskId, scheduleId) {
    this.calls.push({ method: "deleteScheduledMessage", taskId, scheduleId });
    const index = this.scheduledMessages.findIndex((schedule) =>
      (schedule.id === scheduleId) && ((schedule.taskId ?? schedule.task_id) === taskId),
    );
    if (index === -1 || this.scheduledMessages[index].status !== "active") {
      throw new BackendApiError(SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR, 404, {
        error: SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR,
      });
    }
    this.scheduledMessages.splice(index, 1);
  }

  async postTaskInsert(taskId, body) {
    this.calls.push({ method: "postTaskInsert", taskId, body });
    const message = {
      id: `msg-${this.messages.length + 1}`,
      task_id: taskId,
      role: "user",
      content: body.content,
      metadata: body.metadata ?? null,
      created_at: new Date().toISOString(),
    };
    this.messages.push(message);
    return {
      delivered: true,
      interrupted: true,
      task_id: taskId,
      message_id: message.id,
      target_reply_to: body.target_reply_to ?? null,
      message: { ...message },
    };
  }
}

/**
 * The CLI's `loadSdk` accepts an injected sdk module. Importing the real
 * package gets us the production Api classes — that's the whole point of
 * M4. We re-export it so each test file has a single import line.
 */
export const realSdk = await import("../../../modules/conductor-sdk/dist/index.js");

export const baseEnv = {
  CONDUCTOR_AGENT_TOKEN: "test-token",
  CONDUCTOR_BACKEND_URL: "https://backend.example",
};

/**
 * Builds the deps object the CLI `main()` accepts. Inject the same
 * `FakeBackendApi` instance + the real SDK so the test exercises the same
 * code path production users do.
 */
export function makeCliDeps(backend, overrides = {}) {
  return {
    sdk: realSdk,
    backendApi: backend,
    env: { ...baseEnv, ...(overrides.env || {}) },
    cwd: overrides.cwd || "/tmp/cli-test",
    stdin: overrides.stdin,
  };
}
