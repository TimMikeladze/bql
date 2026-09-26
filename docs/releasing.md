# Releasing

Published by hand; there is no release workflow. Run from a clean `main` that CI passed on.

```sh
# 1. bump "version" in package.json, commit
bun install --frozen-lockfile
bun run db sqlite:build
bun run bytes && bun run typecheck
bun run db test && bun run bus test
bun run db routes:check
bun run pack:check          # tarball carries the dashboard, installs, runs both halves

npm publish --dry-run       # packing errors surface before anything uploads
npm publish                 # prepack builds the bus dashboard

git tag v$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
git push origin --tags
```

No provenance: npm only attests publishes from CI with OIDC.
