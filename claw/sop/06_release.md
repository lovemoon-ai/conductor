# Ship New Version SOP

You are the release agent for the conductor repository. The goal is to release a new npm version and deploy `web` to the volc production environment.
## Key semantics
- The released version is subject to the version number in `cli/package.json`, `modules/ai-sdk/package.json`, `modules/conductor-sdk/package.json`.- The last officially released anchor is the most recent commit message with a message in the form of `release x.y.z`.- `scripts/publish-npm.sh` must be executed by the user himself, and the agent cannot run it on his behalf.- Don't just look at the exit code of `scripts/publish-npm.sh`; this script will continue to execute when a single package publish fails, so you must additionally verify whether the publish on npm is actually successful.- Production deployments must follow `claw/sop/deploy-to-prod.md`.- The code that will actually be deployed to production machines must already be on `origin/main`.
## Suggested workflow
1. First locate the latest `bomp to x.y.z` or `release x.y.z` commit.2. Use `git log <last_bump>..HEAD --oneline` to summarize the commits included in this version.3. Check the files in the current workspace that are directly related to the release:   - `CHANGELOG.md`
   - `cli/package.json`
   - `modules/ai-sdk/package.json`
   - `modules/conductor-sdk/package.json`
   - `scripts/publish-npm.sh`
4. Update `CHANGELOG.md`:- Add this version number and date- Organize content by `Added / Changed / Fixed / Removed / Security / Commits`- The content should be user-oriented as much as possible, don't just write implementation details5. Clarify the target version number, and then let the user execute:   - `./scripts/publish-npm.sh <target_version>`
- Must include a clear version number, do not omit it; otherwise the script will automatically bump patch6. After the user executes it, check whether the release is really successful:- First read the logs posted by users- Then use `npm view <pkg>@<version> version --registry=https://registry.npmjs.org` to verify- Check `gitCommitId` if necessary7. If npm publish fails:- Prioritize whether it is a registry / auth problem- If web page login confirmation or `npm adduser` is required, explicitly let the user handle it.- After repairing, let the user execute publish again.- Do not declare the ship to be successful before npm confirms the success.8. After npm is successfully released, press `claw/sop/deploy-to-prod.md` to deploy production:- Determine whether `web/package.json` / `web/pnpm-lock.yaml` is involved- Determine whether Prisma schema / migrations are involved- Perform production deployments and health checks9. If production deployment fails:- First reproduce and locate the failure- Make minimal repairs- If the fix involves code changes, submit it first and push it to `origin/main`- Then re-execute the production deployment10. When npm release and production deployment are successful:- `git add` Related documents for this release- commit message using `release x.y.z`- push to remote- If additional hotfix commits are generated to fix the release blocking problem, they are also allowed to be retained; but there still needs to be a `release x.y.z` in the end11. Last reply `Ship successfully!`
## Recommended check items
- `git log --oneline --decorate -n 30`
- `git log --reverse --oneline <last_bump>..HEAD`
- `git status --short`
- `git diff --name-only <last_bump>..HEAD`
- `npm config get registry`
- `npm whoami --registry=https://registry.npmjs.org`
- `npm view @love-moon/ai-sdk@<version> version --registry=https://registry.npmjs.org`
- `npm view @love-moon/conductor-sdk@<version> version --registry=https://registry.npmjs.org`
- `npm view @love-moon/conductor-cli@<version> version --registry=https://registry.npmjs.org`

## Common judgment rules
- `npm publish failed ... continuing` appears in publish log- It cannot be regarded as successful, and you must continue to verify whether the version already exists on the npm registry.- The local default npm registry is `npmmirror`, but the token is configured in `registry.npmjs.org`- Most likely publish failed; need to fix registry explicitly or let user handle npm login first.- Build failure found during production deployment- First repair the local code and verify it, then push it, and then redeploy it.- The changes to fix the release/deployment blocking problem are code bugs, not bugs encountered by users in daily use- There is no need to specifically patch the `claw/lessons/` document for this temporary release blocking, unless the user explicitly requests it.- There are changes in the workspace that are not related to this release.- Do not submit casually; only submit documents directly related to this release.
## Minimum acceptance criteria
1. Can be found on npm:   - `@love-moon/ai-sdk@x.y.z`
   - `@love-moon/conductor-sdk@x.y.z`
   - `@love-moon/conductor-cli@x.y.z`
2. The production deployment is successful and meets the health check standards in `claw/sop/deploy-to-prod.md`.3. There is a `release x.y.z` commit on `origin/main`.4. Final reply includes:- Final release commit hash- Production deployment commit hash- Whether `pnpm -C web install` was executed- Whether database migration was performed- Three local health check status codes-Whether artificial regression has been performed; if not, please explain clearly
## Output requirements
- Give the conclusion first, then the evidence.- If it fails, explicitly write:- Failure stage- failed command- Key log- Suggestions for next steps- If successful, the last fixed reply is:  - `Ship successfully!`
