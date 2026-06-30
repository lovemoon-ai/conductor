# misc: deploy script xargs env loading breaks structured values (2026-06-30)
## Problem performance
- During the Volc production deploy for the 0.7.0 release, `scripts/deploy-prod.sh` completed the Next.js production build and Nginx reload, then failed while starting the web service.
- The failing line tried to load every line from `web/.env.production.local` with `export $(grep -v '^#' ... | xargs)`.
- A structured production env value contained spaces, so `xargs` split it into invalid shell identifiers and aborted the deploy before the web process restart.

## Cause analysis
- `.env` files are not shell scripts. Values can be unquoted strings with spaces or structured content that `dotenv` parses correctly but shell word splitting does not.
- The web server already loads `web/.env.production.local` with `dotenv`; the deploy script only needed a small subset of values for operator tasks such as port cleanup and cron setup.
- Loading the entire env file into the shell also increased the chance of accidental secret exposure in deploy logs.

## Solution
- Replace the broad shell export with a helper that parses `web/.env.production.local` through the app's installed `dotenv` package.
- Read only `PORT` and `CRON_SECRET`, which are the values the deployment shell actually needs.
- Redact cron secrets when printing the current crontab after deployment.

## How to avoid it next time
- Do not parse `.env` files with `xargs`, `source`, or shell word splitting unless the file is explicitly maintained as shell syntax.
- Keep deployment scripts aligned with the application's own env loader and read only the values the script needs.
- Treat deploy output as potentially shareable: never print full secret-bearing cron lines or env entries.
