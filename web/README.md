# Conductor Web (Next.js)

## Development

```bash
# Install dependencies
pnpm install

# Generate the Prisma client
pnpm db:generate

# Initialize the database
pnpm db:push

# Start the development server
pnpm dev
```

## Switching Databases

SQLite is the default. To switch to PostgreSQL, update the environment variables:

```bash
# SQLite (default)
DATABASE_URL=file:./conductor.db

# PostgreSQL
DB_DIALECT=postgres
DATABASE_URL=postgresql://user:pass@localhost:5432/conductor
```

After switching databases, regenerate the Prisma client:

```bash
# Use the matching schema
DB_DIALECT=postgres pnpm db:generate
```

## Build

```bash
pnpm build
pnpm start
```

## Self-host bootstrap login

If you are self-hosting and do not want to configure SMS before the first login, run:

```bash
pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com
```

This command:

- creates or reuses the user for that phone number
- ensures the default project exists
- issues a new API token
- prints a `Login URL` you can open once in the browser

Treat the printed API token and login URL as secrets.

## Feishu Channel Gateway

Minimum setup steps:

```bash
# 1. Generate the Prisma client and sync the database
pnpm db:generate
pnpm db:push

# 2. Start the service
pnpm dev
```

Available endpoints:

- `POST /api/channel/bind-code`: generate a one-time bind code for the signed-in user
- `POST /api/channel/feishu/config`: upload the user's `config.yaml` Feishu config to the server
- `POST /api/channel/feishu/webhook`: Feishu event callback entrypoint
- `POST /api/cron/channel-outbox`: flush pending channel outbox messages

Current MVP scope:

- Bind Feishu direct messages with `/bind <code>` to an existing Conductor account
- Create a task from the first plain-text message in a direct message thread
- Continue the same task with later messages in the same thread
- Support `/new`, `/tasks`, `/tasks active`, `/tasks recent`, `/task <id>`, and `/stop`
- Push the assistant's final reply and task status back through the channel outbox

User-managed Feishu bot config:

- User-level `verification_token` and `tenant_access_token` are no longer read from `web/.env`
- Users must maintain the following in their own `config.yaml`:

```yaml
channels:
  feishu:
    app_id: your_app_id
    app_secret: your_app_secret
    verification_token: your_verification_token
    encrypt_key: your_encrypt_key
```

- Then POST the full YAML to `/api/channel/feishu/config`
- The server persists the Feishu bot config per user
- The webhook looks up the matching user config through `verification_token`
- Reply and outbox delivery use the user-supplied `app_id` and `app_secret` to exchange for `tenant_access_token`

Recommendations before production rollout:

- Wire `/api/cron/channel-outbox` into a scheduled job
- Run `DB_DIALECT=postgres pnpm db:generate` to verify the PostgreSQL schema in a production-like setup
- Make sure the Feishu event subscription token matches the imported `channels.feishu.verification_token`
