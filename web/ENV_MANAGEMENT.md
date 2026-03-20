# Environment Variable Management Guide

## File Structure

```text
web/
├── .env.example                 # Template file committed to Git
├── .env.local                   # Local development config, not committed
├── .env.local.4090              # Machine-specific local config, not committed
├── .env.production.vercel       # Vercel production config, not committed
└── .env.production.volcengine   # Volcengine production config, not committed
```

## Environment Descriptions

### 1. Local Development

**File**: `.env.local` or `.env.local.4090`

**How to create it**:

```bash
cp .env.example .env.local
# Then edit .env.local and fill in your local development values
```

**Key settings**:

- `HOST=localhost`
- `API_BASE_URL=http://localhost:6152`
- `DATABASE_URL=file:./prisma/schema.sqlite.db`
- `AUTH_DEV_CODE` for quick local auth if needed
- `JWT_SECRET` can use the default local value

### 2. Vercel Production

**File**: `.env.production.vercel`

**How to create it**:

```bash
cp .env.example .env.production.vercel
# Then edit the file and fill in the Vercel production values
```

**Key settings**:

- `API_BASE_URL`: the Vercel deployment domain
- `NEXT_PUBLIC_URL`: the frontend URL
- `DATABASE_URL`: use an absolute path or PostgreSQL
- `JWT_SECRET`: **must be replaced with a production-grade secret**
- `AUTH_DEV_CODE`: **remove it or leave it empty**
- Set real third-party service keys such as Stripe, Alipay, and OAuth

**Deployment options**:

1. Configure variables manually in the Vercel dashboard
2. Import them with the `vercel env` CLI

### 3. Volcengine Production

**File**: `.env.production.volcengine`

**How to create it**:

```bash
cp .env.example .env.production.volcengine
# Then edit the file and fill in the Volcengine production values
```

**Key settings**:

- `API_BASE_URL=https://conductor-ai.top/`
- `DATABASE_URL=file:/opt/conductor/prisma/schema.sqlite.db` with an absolute path
- `JWT_SECRET`: **must be replaced with a production-grade secret**
- `AUTH_DEV_CODE`: **remove it or leave it empty**
- Set real third-party service keys

**Deployment**:

```bash
# On the server, copy the matching config file
cp .env.production.volcengine .env.production.local

# Or handle this automatically in CI/CD
```

## Next.js Environment Variable Loading Order

Next.js loads environment variables in this priority order, from highest to lowest:

1. `.env.$(NODE_ENV).local` such as `.env.production.local`
2. `.env.local` (not loaded in test mode)
3. `.env.$(NODE_ENV)` such as `.env.production`
4. `.env`

## Security Best Practices

### Do

1. Commit `.env.example` to Git
2. Do not commit any `.env.*` file that contains real secrets
3. In production:
   - use a strong random secret
   - remove `AUTH_DEV_CODE`
   - use an environment variable management service such as Vercel Env Variables or a secret manager
4. Rotate `JWT_SECRET`, API keys, and other sensitive values regularly

### Do Not

1. Do not put real secrets in `.env.example`
2. Do not commit `.env.local` to Git
3. Do not use the local default secret in production
4. Do not print environment variables in logs

## Initialize the Database

```bash
cd web

# 1. Install dependencies
pnpm install

# 2. Generate the Prisma client
pnpm db:generate

# 3. Initialize the database
pnpm db:push

# 4. Start the development server
pnpm dev
```

## FAQ

### Q: How do I test production config locally?

A: Create `.env.production.local`, then run:

```bash
NODE_ENV=production pnpm dev
```

### Q: How do I switch quickly between environment configs?

A: You can use a symlink or a small `Makefile`:

```makefile
.PHONY: env-dev env-vercel env-volcengine

env-dev:
	cp .env.local .env.production.local

env-vercel:
	cp .env.production.vercel .env.production.local

env-volcengine:
	cp .env.production.volcengine .env.production.local
```

### Q: What path should I use for the database file?

A:

- Local development: use the relative path `file:./prisma/schema.sqlite.db`
- Production: use the absolute path `file:/opt/conductor/prisma/schema.sqlite.db`
- PostgreSQL is recommended for production deployments

## References

- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)
- [Prisma Connection URLs](https://www.prisma.io/docs/reference/database-reference/connection-urls)
