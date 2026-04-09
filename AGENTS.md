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

## How to review code
Refer to `claw/sop/04_review-code.md`.

## How to Release
Refer to `claw/sop/06_release.md`.
