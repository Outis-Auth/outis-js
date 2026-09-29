# Releasing

Releases are cut by pushing a tag. The workflow in `.github/workflows/release.yml` checks the tag, runs the test suite, publishes to npm and creates a GitHub release.

## Cut a release

1. On a branch, bump the version. This updates `package.json` and `package-lock.json` together:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

   Update `VERSION` in `src/version.ts` to the same value. The release workflow fails if the two disagree.

2. Open a pull request, let CI pass, and merge it into `main`.

3. Tag the merge commit on `main` and push the tag:

   ```sh
   git checkout main
   git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The tag has to be exactly `v` followed by the version in `package.json`. Anything else stops the workflow with a message saying which version it expected.

## What the workflow does

- Checks that the tag matches `package.json` and `src/version.ts`.
- Runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build`.
- Packs the tarball with `npm pack` and publishes that same tarball with `npm publish --provenance --access public`. If the version is already on npm, it skips this step instead of failing.
- Creates a GitHub release for the tag with generated notes, with the tarball attached.

Publishing uses npm trusted publishing. The workflow exchanges its GitHub OIDC token for a short-lived npm credential, so there's no npm token in the repository secrets, and every published version carries a provenance attestation linking it to the commit and the workflow run.

## One-time setup on npmjs.com

Do this before pushing the first tag.

1. Sign in to npmjs.com and make sure the `@outis-auth` scope is yours. A scope belongs to the user or organization with that name, so create an organization named `outis-auth` (Add Organization, free public plan) if it doesn't exist yet.

2. A trusted publisher can only be attached to a package that already exists, so the first version goes out by hand. From a clean checkout of `main` at the release commit, signed in to npm with an account that can publish to the scope:

   ```sh
   npm ci
   npm publish --access public
   ```

   `prepublishOnly` builds `dist/` first. Then push the `vX.Y.Z` tag as usual. The workflow sees the version is already on npm, skips publishing, and still creates the GitHub release.

3. On the package page (`https://www.npmjs.com/package/@outis-auth/sdk`), open Settings, find Trusted Publisher, and choose GitHub Actions. Fill in:

   - Organization or user: `Outis-Auth`
   - Repository: `outis-js`
   - Workflow filename: `release.yml`
   - Environment name: leave blank

4. In the same settings, set publishing access to "Require two-factor authentication and disallow tokens" so trusted publishing is the only automated path in.

Every version after the first is published by the workflow.

## Installing

Users install the SDK with:

```sh
npm install @outis-auth/sdk
```

The package also ships the `outis` command. Run it without installing:

```sh
npx @outis-auth/sdk init worker -runtime next
```

Or, once the package is a dependency, call `outis` from an npm script or `npx outis`.
