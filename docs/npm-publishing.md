# npm trusted publishing

Normal JavaScript releases use GitHub Actions OIDC in `.github/workflows/js.yml`.
Only `publishToNpm` has `id-token: write`. It runs on GitHub-hosted Ubuntu after
tests pass, only on pushes to `main`. Node 24 and pinned npm 11.20.0 satisfy
the [npm trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/).
The workflow neither reads `NPM_TOKEN` nor sets `NODE_AUTH_TOKEN`.

## Attach the publisher

An npm package maintainer must authenticate with an account that has write access
to `@link-foundation/linksql` and 2FA enabled. With npm 11.15.0 or newer:

```sh
npm login
npm trust github @link-foundation/linksql --repo link-foundation/linksql --file js.yml --allow-publish
npm trust list @link-foundation/linksql
```

Alternatively, use the package's **Settings → Trusted publishing** on npmjs.com:

| Field             | Value                                               |
| ----------------- | --------------------------------------------------- |
| Provider          | GitHub Actions                                      |
| Organization      | `link-foundation`                                   |
| Repository        | `linksql`                                           |
| Workflow filename | `js.yml`                                            |
| Environment       | Leave empty (the publishing job has no environment) |
| Allowed actions   | Allow direct `npm publish`                          |

See [npm trust documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
GitHub credentials cannot configure npm account settings. Do not revoke an
existing trust configuration without first inspecting it.

## Verify a release

The package version is bumped in this PR to schedule a release after merge.
The usual version-exists check still skips already published versions.

1. Confirm `npm trust list @link-foundation/linksql` shows the repository and
   `js.yml` publisher above.
2. After merge, inspect the `js` run on the `main` commit. `Publish to NPM with
OIDC` must succeed without any npm token environment or secret reference.
3. Verify `npm view @link-foundation/linksql@0.1.1 version dist.attestations`
   and inspect the provenance link on npmjs.com for the expected workflow/commit.
4. Confirm the `js_0.1.1` GitHub release exists.

PR checks validate configuration and package tests, but intentionally never
publish. An `npm publish --dry-run` does not verify OIDC authentication.
If publishing fails, the job fails with a pointer to this setup; it does not
silently retry with a token or create a GitHub release after failure.

## Emergency token fallback

Use a token only after an explicit maintainer decision that OIDC cannot be used.
Create a fresh, short-lived, package-scoped granular token with the permissions
required by npm, and use it in a separate, manually authorized publishing session
with a temporary npm user config. Remove that config and revoke the token after
the recovery. Never commit credentials, restore workflow-level `NPM_TOKEN`, or
add automatic fallback to normal releases. This PR does not create or retain a
token because no fallback is currently needed.

## Outstanding external verification for issue #4

The implementation session has no authenticated npm account. Both
`npm trust list @link-foundation/linksql` and the exact publisher-creation command
above (with `--yes`) returned HTTP 401 on 2026-11-15; `npm whoami` returned
`ENEEDAUTH`. Publisher attachment and listing remain unverified. A real OIDC
release also remains unverified until the publisher is attached and this workflow
runs on `main`. These acceptance criteria remain unfinished; passing PR CI does
not establish them.
