# Volc Production Deployment SOP
You are the conductor's engineer on duty, please deploy `web` to the volc production environment.
First establish the following deployment contexts before starting deployment:
1. Warehouse structure
- `web/` is the main Next.js application, including API routes, Prisma, production environment construction and startup logic.
- `scripts/deploy-prod.sh` is the standard deployment entry on the Volc machine, responsible for Prisma Client generation, production build, Nginx configuration update, Web process restart, health check, outbox cron check.
- `web/prisma/schema.prisma` and `web/prisma/migrations/` determine whether this deployment requires database migration.
- `web/package.json` and `web/pnpm-lock.yaml` decide whether dependencies need to be installed first for this deployment.
2. Key deployment semantics
- The production site is `https://conductor-ai.top`.
- The production machine connection method and remote warehouse path are subject to `make info-volc` output.
- The current standard remote warehouse path is `/opt/conductor/conductor`.
- The content that will actually be deployed must already exist on `origin/main`; local uncommitted or unpushed changes will not appear on the production machine.
- `M web/next-env.d.ts` often appears on the remote end. This is a by-product of Next construction and usually does not need to be treated as a dirty business change.
- If the diff to be deployed hits `web/prisma/schema.prisma` or `web/prisma/migrations/`, you must first migrate the database and then restart the service.
- If the diff to be deployed hits `web/package.json` or `web/pnpm-lock.yaml`, `pnpm -C web install` must be manually executed on the production machine; `scripts/deploy-prod.sh` will automatically install dependencies only if `web/node_modules` does not exist.
3. Signals that must be checked during deployment
- Local `git status --short`
- Local `git status --short`- local `git push origin main` is successful
- Whether local diff hits Prisma related files
- Whether local diff hits dependent files
- Remote `git rev-parse --short HEAD`
- Remote `git rev-parse --short HEAD`
- Does `web/.env.production.local` exist?
- Status code of `http://127.0.0.1:6152/api/health` / `http://127.0.0.1/` / `https://127.0.0.1/` after deployment
- `tail -f /opt/conductor/conductor.log` and `tail -f /var/log/nginx/error.log` when necessary
4. Recommended deployment workflow
- Check local git diff and commit and push.
- Execute `make info-volc` first to confirm the SSH command and remote path.
- Confirm locally that the code to be deployed has been submitted and pushed to `origin/main`.
- First determine whether this deployment involves database changes or dependency changes.
- SSH to the production machine and enter the remote warehouse directory. First check the current commit and workspace status.
- If the remote end only has `M web/next-env.d.ts`, you can generally continue; if there are other dirty changes, confirm the source first and do not overwrite it directly.
- Execute `git pull --rebase --autostash origin main` to pull the latest code.
- If dependency changes are involved, execute `pnpm -C web install` first.
- If database changes are involved, load the production environment variables first, and then execute Prisma generate and `prisma migrate deploy`.
- Execute `bash scripts/deploy-prod.sh` to complete the build, restart and basic health check.
- Finally, open `https://conductor-ai.top` for manual regression; perform login and critical path verification if necessary.
5. Recommended commands
- `make info-volc`
- `git status --short`
- `git rev-parse --short HEAD`
- `git push origin main`
- `git diff --name-only <old_commit>..origin/main -- web/prisma/schema.prisma web/prisma/migrations`
- `git diff --name-only <old_commit>..origin/main -- web/package.json web/pnpm-lock.yaml`
- `ssh -i <key> root@<host>`
- `cd /opt/conductor/conductor`
- `git rev-parse --short HEAD`
- `git status --short`
- `git pull --rebase --autostash origin main`
- `export $(grep -v '^#' web/.env.production.local | xargs)`
- `pnpm -C web install`
- `pnpm -C web db:generate`
- `pnpm -C web exec prisma migrate deploy`
- `bash scripts/deploy-prod.sh`
- `curl -I --max-time 5 http://127.0.0.1:6152/api/health`
- `curl -I --max-time 5 http://127.0.0.1/`
- `curl -k -I --max-time 5 https://127.0.0.1/`
- `tail -f /opt/conductor/conductor.log`
- `tail -f /var/log/nginx/error.log`

6. Common judgment rules
- The native code is not yet `git push origin main`
- Do not start remote deployment; first push the commits to be online to the remote end.
- The remote end only has `M web/next-env.d.ts`
- You can usually proceed to `git pull --rebase --autostash origin main`.
- There are other unexplained dirty changes on the remote end
- Stop first to confirm the source; do not assume safe coverage.- diff hits Prisma schema or migration
- Database migration must be performed first, and then the startup script is executed.- diff hits `web/package.json` or `web/pnpm-lock.yaml`
- Execute `pnpm -C web install` first, don't just rely on the startup script.
- `web/.env.production.local` does not exist
- Stop the deployment directly; the startup script will fail.
- `bash scripts/deploy-prod.sh` succeeded, but the health check is not the expected status code
- Do not report deployment success; check `conductor.log` and Nginx logs first.
- Build failure or migration failure
- First record the failure stage, failed commands, and corresponding logs, and then decide whether to try again; do not repeat the entire deployment process vaguely.
7. Minimum acceptance criteria for successful deployment
- `http://127.0.0.1:6152/api/health` Return `200`
- `http://127.0.0.1:6152/api/health` Return `200`
- `http://127.0.0.1:6152/api/health` Return `200`
- Accessible online at `https://conductor-ai.top`
- If this change involves login, payment, task, agent or cron path, at least add a corresponding human flesh verification
8. Supplementary troubleshooting directions in case of failure
- `git pull` failed
- Prioritize dirty changes in the remote workspace, rebase conflicts, and whether branches deviate from `origin/main`.
- `git pull` failed
- Prioritize Node / pnpm environment, lock file conflicts, network or registry issues.
- `git pull` failed
- Prioritize the production database connection, migration file integrity, and whether environment variables are loaded correctly.
- `git pull` failed
- Prioritize TypeScript errors, whether Prisma Client is consistent with the schema, and whether dependencies have been updated.
- Health check failed after startup
- Prioritize to see if the `/opt/conductor/conductor.log`, `/var/log/nginx/error.log`, and 6152 ports are really up.
9. Output requirements
- Give the conclusion first, then the evidence.
- Clearly write out the commit hash of this launch.
- Clearly write out whether `pnpm -C web install` was executed.
- Clearly write out whether database migration has been performed.
- Clearly write out the status code results of the three local health checks.
- If human flesh returns, clearly indicate which page or path was verified.
- If it fails, write clearly the failure stage, failed command, key logs and next step processing suggestions; don't just say "the deployment failed".
