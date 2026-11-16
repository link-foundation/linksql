"""Regression coverage for manual releases and token-free PyPI publishing."""

import os
import subprocess
from pathlib import Path

import pytest
import yaml

WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github/workflows/python.yml"


@pytest.fixture
def workflow():
    # BaseLoader keeps GitHub's `on` key a string (rather than YAML 1.1 True).
    return yaml.load(WORKFLOW_PATH.read_text(), Loader=yaml.BaseLoader)


def test_manual_trigger(workflow):
    assert "workflow_dispatch" in workflow["on"]


@pytest.mark.skipif(
    os.name == "nt", reason="Change detection runs on Ubuntu and uses POSIX Bash."
)
def test_manual_run_without_changed_files(workflow, tmp_path):
    steps = workflow["jobs"]["findChangedPythonFiles"]["steps"]
    changed_files = next(step for step in steps if step.get("id") == "changed-files")
    assert changed_files["if"] == "github.event_name != 'workflow_dispatch'"
    script = steps[-1]["run"].replace(
        "${{ steps.changed-files.outputs.all_changed_files }}", ""
    )
    output = tmp_path / "outputs"
    subprocess.run(
        ["bash", "-e", "-c", script],
        env={
            **os.environ,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_OUTPUT": output.name,
        },
        cwd=tmp_path,
        check=True,
        timeout=10,
    )
    assert "isPythonFilesChanged=true" in output.read_text()


@pytest.mark.parametrize("job", ["publishToPyPI", "publishRelease"])
def test_release_gates(workflow, job):
    condition = workflow["jobs"][job]["if"]
    # Keep both entry points restricted to main, after the test matrix succeeds.
    assert (
        "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')"
        in condition
    )
    assert "&& github.ref == 'refs/heads/main'" in condition
    assert (
        "needs.findChangedPythonFiles.outputs.isPythonFilesChanged == 'true'"
        in condition
    )
    if job == "publishToPyPI":
        assert "test" in workflow["jobs"][job]["needs"]
    else:
        assert "needs.publishToPyPI.result == 'success'" in condition
        assert workflow["jobs"][job]["permissions"]["contents"] == "write"


def test_publish_uses_oidc_and_correct_distribution_directory(workflow):
    publish = workflow["jobs"]["publishToPyPI"]
    assert publish["permissions"]["id-token"] == "write"
    assert publish["permissions"]["contents"] == "read"
    action = next(
        step
        for step in publish["steps"]
        if step.get("uses", "").startswith("pypa/gh-action-pypi-publish@")
    )
    assert action["with"]["packages-dir"] == "python/dist/"
    assert action["with"]["skip-existing"] == "true"
    assert "password" not in action["with"]
    assert "PYPI_TOKEN" not in WORKFLOW_PATH.read_text()
    assert all(
        "id-token" not in job.get("permissions", {})
        for name, job in workflow["jobs"].items()
        if name != "publishToPyPI"
    )
