# Releasing

Published by hand; there is no release workflow. Run from a clean `main` that CI passed on.

```sh
bun run pre:release         # frozen install, sqlite build, bytes, typecheck, db + bus tests,
                            # routes:check, pack:check (packs, installs, runs `bql` and `bql bus`)

npm publish --dry-run       # packing errors surface before anything uploads
bun run release             # bumpp: pick the version, commit, tag v<version>, push both
npm publish                 # prepack builds the bus dashboard
```

`bun run release` bumps `version` in `package.json` only — the workspace packages are private and
never published. If `npm publish` then fails, the tag is already pushed; fix and publish the same
version rather than bumping again.

No provenance: npm only attests publishes from CI with OIDC.
