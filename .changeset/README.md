This directory stores release notes for published packages.

Run `npm run changeset` at the repository root, select the package(s) that
changed, and choose the appropriate semver bump. Merge the generated changeset
with the feature branch. The `release-packages` workflow will open or update a
version PR, and merging that PR will publish the affected npm packages.
