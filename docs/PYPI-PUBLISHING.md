# Python trusted publishing

The top-level `.github/workflows/python.yml` publishes with
`pypa/gh-action-pypi-publish` using GitHub OIDC. No `PYPI_TOKEN` secret is needed.
Only `publishToPyPI` receives `id-token: write`. Publishing and the GitHub release
require successful checks and the `main` branch, for both push and manual runs.

## Publisher configuration

The PyPI publisher must match these values:

| Field | Value |
| --- | --- |
| PyPI project | `linksql` |
| GitHub owner | `link-foundation` |
| GitHub repository | `linksql` |
| Workflow filename | `python.yml` |
| Environment | empty (this workflow does not use an environment) |

For an existing project, attach this publisher in
[the project's Publishing settings](https://pypi.org/manage/project/linksql/settings/publishing/).
For a project that does not exist yet, register a pending publisher in
[account Publishing settings](https://pypi.org/manage/account/publishing/).
PyPI converts a matching pending publisher into a normal publisher on its first
successful OIDC upload. A GitHub workflow change alone cannot attach a publisher
to a PyPI account.

## Start or retry a release

After this workflow is on `main`:

```sh
gh workflow run python.yml --repo link-foundation/linksql --ref main
```

Manual runs always run lint and the test matrix, even without changed Python
files. They publish the version committed in `python/pyproject.toml`; no automatic
bump is performed, so retrying the first release does not change its version.
For a subsequent release, commit a version bump first. The publishing action
skips files that already exist, so retries are safe. Other upload and OIDC errors
fail the job. A manual run on another branch runs checks but cannot publish.

## Verify an OIDC release

Check that `publishToPyPI` succeeds in the Actions run, that the uploaded version
appears on [PyPI](https://pypi.org/project/linksql/), and that the publisher appears
in the project's Publishing settings. For a newly uploaded wheel, inspect its
provenance (replace the version and filename as appropriate):

```sh
curl --fail https://pypi.org/integrity/linksql/0.1.0/linksql-0.1.0-py3-none-any.whl/provenance
```

The publisher identity must reference `link-foundation/linksql` and `python.yml`.
A skipped, already published version does not prove a new OIDC upload; use a new
version to verify the next release. Existing files cannot be overwritten to add
attestations.

See PyPI's [publishing instructions](https://docs.pypi.org/trusted-publishers/using-a-publisher/)
and [pending publisher documentation](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).
