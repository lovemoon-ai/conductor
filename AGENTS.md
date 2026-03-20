# Repository Guidelines

## Project Structure & Module Organization
- `web/` is a unified Next.js application with a custom server (`server.ts`), API routes (`src/app/api/`), pages (`src/app/`), and shared components (`src/components/`, `src/lib/`).
- `cli/` is the `conductor` CLI tool.
- `modules/` contains custom TypeScript packages. It currently includes `ai-sdk`, `conductor-sdk`, and `volc-sms`.

## Build, Test, and Development Commands
- `cd web && pnpm install` installs web dependencies; `pnpm db:generate` generates the Prisma client; `pnpm db:push` initializes the database.
- `cd web && pnpm dev` starts the Next.js development server on `http://localhost:6152` with WebSocket support.
- `cd web && pnpm build && pnpm start` builds and runs the production server.
- `cd web && pnpm test` runs web tests with Vitest.
- `cd modules/conductor-sdk && pnpm test` runs SDK tests with Vitest.
- Tight-loop helpers: `cd web && npx prisma studio`, `cd web && pnpm test`, and `cd modules/conductor-sdk && pnpm test`.

## Coding Style & Naming Conventions
- TypeScript (Next.js): 2-space indent, `PascalCase` for components and types, `camelCase` for functions and variables, and Next.js App Router conventions (`page.tsx`, `route.ts`, `layout.tsx`). Validate inputs with Zod schemas.
- Prisma: define models in `web/prisma/schema.prisma`, use `camelCase` field names, and map snake_case database columns with `@map()`.

## Testing Guidelines
- Next.js API routes can be tested with integration tests; use Prisma test helpers to seed data and clean up afterward.
- SDK tests live in `modules/conductor-sdk/tests` and should be run with `cd modules/conductor-sdk && pnpm test`.
- Every feature needs at least one API route test plus either a widget or SDK test to guard the end-to-end path.

## Review Lessons Before Commit
- For bugfix commits, write a review document before committing.
- The document should summarize the symptom, root cause, fix, and how to avoid the issue next time. Save it under `claw/lessons/`. Prefix the markdown filename with the bug type so different issue classes are easy to distinguish.
- Bug types:
  - `stable`: instability issues, session interruption, session disconnection, no AI reply received, and similar problems
  - `arch`: architecture bugs
  - `ui`: UI interaction bugs
  - `misc`: other bugs
- Each bug should have its own markdown file.
- This requirement applies to bugs encountered by users in normal product usage, not to temporary mistakes made while implementing code.

## Commit & Pull Request Guidelines
- Follow the existing imperative, one-line commit style (`update app`, `add sdk`); keep the subject within 72 characters and describe what changed.
- PRs must summarize intent, list the commands run (for example `cd web && pnpm test` and `cd modules/conductor-sdk && pnpm test`), link issues, and attach screenshots or logs for UI and infra work.
- Flag schema changes or new environment variables so reviewers can apply DB or deploy steps before rollout.

## E2E Test in Local Development
1. Start the server locally: `cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && pnpm build && pnpm start`
2. Use `chrome-devtools` MCP to open `http://localhost:6152/`, then use `env:CONDUCTOR_PHONE` to complete sign-in
3. Update the CLI locally: `make install-cli`
4. Start the Conductor daemon and connect it to the local server: `conductor daemon --config-file ~/.conductor/config-dev.yaml`
5. Start Conductor fire and connect it to the local server: `conductor fire --config-file ~/.conductor/config-dev.yaml -- "hi"`

## How to Release
Refer to `claw/sop/06_release.md`.

## Skills
A skill is a set of local instructions stored in a `SKILL.md` file. Below is the list of skills available in this session. Each entry includes a name, description, and file path so you can open the source for the full instructions when needed.

### Available skills
- algorithm-research: End-to-end algorithm direction research, baseline analysis, option comparison, priority discussion, and task-document generation. Use when the user gives any algorithmic or technical method direction and wants a complete workflow: define search scope, build source lists, screen options, compare against a baseline or existing repo, discuss tradeoffs and constraints with the user, update the plan as priorities change, and output research reports plus executable task documents. (file: /Users/bytedance/code/scripts/ai/skills/algorithm-research/SKILL.md)
- android-dev: Android adb helper scripts for launching an activity, collecting logcat, taking screenshots, recording screen video, and toggling screen state. Use when you need to run an Android app activity with optional capture, recording, logging, or screen management through adb. (file: /Users/bytedance/code/scripts/ai/skills/android-dev/SKILL.md)
- autofix: Automatic workflow for fixing build failures, runtime crashes, and test failures. Use when the user mentions crash, runtime errors, failed tests, or build failures, or when you need to run make or pytest loops to diagnose and repair issues. (file: /Users/bytedance/code/scripts/ai/skills/autofix/SKILL.md)
- chatgpt-share-to-md: Export public ChatGPT shared conversation URLs (`chatgpt.com/share/...`) to local Markdown with diagnostics and optional Chrome-profile fallback. Use when a user provides a ChatGPT share link and wants the conversation parsed, saved, archived, or inspected locally, especially when the export should preserve raw HTML, SSR payloads, and failure diagnostics. (file: /Users/bytedance/code/scripts/ai/skills/chatgpt-share-to-md/SKILL.md)
- codemap: Analyze codebase structure, dependencies, and changes. Use when the user asks about project structure, where code is located, how files connect, what changed, or before starting any coding task. Provides instant architectural context. (file: /Users/bytedance/code/scripts/ai/skills/codemap/SKILL.md)
- create-app: Use this skill when you need to create a brand new application scaffold from scratch. (file: /Users/bytedance/code/scripts/ai/skills/create-app/SKILL.md)
- create-task: Turn a vague or high-level user request into a complete, executable task document that maximizes LLM task completion success. The output clarifies the goal, scope, inputs, outputs, constraints, execution steps, and acceptance criteria. (file: /Users/bytedance/code/scripts/ai/skills/create-task/SKILL.md)
- github-linear-workflow: Design and apply a GitHub + Linear engineering workflow for RFCs, ADRs, feature specs, issues, PRs, sprints, roadmaps, and evaluations. Also use it for Chinese requests about GitHub + Linear best practices, SOPs, RFCs, ADRs, specs, issues, PRs, sprints, roadmaps, and evaluation systems. (file: /Users/bytedance/code/scripts/ai/skills/github-linear-workflow/SKILL.md)
- install: Use installation scripts to install tools, libraries, or software. If no matching script exists, tell the user briefly and fall back to another install path. (file: /Users/bytedance/code/scripts/ai/skills/install/SKILL.md)
- rtk-toolcall: Use when AI is about to run tests, lint, builds, git inspection, logs, broad searches, directory listings, or file reads that may produce noisy output, or when the user explicitly asks to use RTK. (file: /Users/bytedance/code/scripts/ai/skills/rtk-toolcall/SKILL.md)
- vln-debug: Debug and deploy `vln_exec` on the dog s100 chip, including stopping services, copying binaries and config, setting environment variables, and checking logs. (file: /Users/bytedance/code/scripts/ai/skills/vln-debug/SKILL.md)
- skill-creator: Guide for creating effective skills. Use when users want to create a new skill, or update an existing one, to extend Codex with specialized knowledge, workflows, or tool integrations. (file: /Users/bytedance/code/scripts/ai/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into `$CODEX_HOME/skills` from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo, including private repos. (file: /Users/bytedance/code/scripts/ai/skills/.system/skill-installer/SKILL.md)

### How to use skills
- Discovery: the list above is the set of skills available in this session. Skill bodies live on disk at the listed paths.
- Trigger rules: if the user names a skill (with `$SkillName` or plain text), or if the task clearly matches a skill description shown above, you must use that skill for the turn. If multiple skills apply, use all relevant ones. Do not carry skills across turns unless they are mentioned again.
- Missing or blocked: if a named skill is not in the list or the path cannot be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1. After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2. When `SKILL.md` references relative paths such as `scripts/foo.py`, resolve them relative to the skill directory first and only look elsewhere if needed.
  3. If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request. Do not bulk-load everything.
  4. If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  5. If `assets/` or templates exist, reuse them instead of recreating them.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the task and state the order you will use them.
  - Announce which skill or skills you are using and why in one short line. If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them, and load extra files only when needed.
  - Avoid deep reference chasing: prefer opening only files directly linked from `SKILL.md` unless you are blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference files and note that choice.
- Safety and fallback: if a skill cannot be applied cleanly because files are missing or instructions are unclear, say so, choose the next-best approach, and continue.
