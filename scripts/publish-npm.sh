#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
scripts/publish-npm.sh is deprecated.

Use the changesets release flow instead:
1. Run `npm run changeset` at the repository root and commit the generated file.
2. Merge the PR. The `Release Packages` GitHub Actions workflow will open or
   update a version PR.
3. Merge the version PR. CI will publish the affected npm packages through npm
   trusted publishing and, when the CLI is released, trigger the archive job.
EOF

exit 1
