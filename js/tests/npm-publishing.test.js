import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

const source = readFileSync(
  new URL('../../.github/workflows/js.yml', import.meta.url),
  'utf8'
);
const workflow = load(source);
const job = workflow.jobs.publishToNpm;

describe('npm trusted publishing workflow', () => {
  it('grants OIDC only to the main-branch publishing job', () => {
    expect(job.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    });
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if.includes("github.event_name == 'push'")).toBe(true);
    expect(job.if.includes("github.ref == 'refs/heads/main'")).toBe(true);
    expect(job.needs.includes('test')).toBe(true);
    for (const [name, otherJob] of Object.entries(workflow.jobs)) {
      if (name !== 'publishToNpm') {
        expect(otherJob.permissions?.['id-token'] === 'write').toBe(false);
      }
    }
  });

  it('installs an OIDC-capable npm before publishing on supported Node', () => {
    const setup = job.steps.find((step) =>
      step.uses?.startsWith('actions/setup-node@')
    );
    expect(Number.parseInt(setup.with['node-version'], 10) >= 24).toBe(true);
    // Avoid setup-node creating an npmrc with a NODE_AUTH_TOKEN placeholder.
    expect(setup.with['registry-url']).toBe(undefined);
    const installIndex = job.steps.findIndex((step) =>
      /npm install --global npm@/.test(step.run || '')
    );
    expect(installIndex >= 0).toBe(true);
    const version = job.steps[installIndex].run.match(
      /npm@(\d+)\.(\d+)\.(\d+)/
    );
    const [major, minor, patch] = version.slice(1).map(Number);
    expect(
      major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))
    ).toBe(true);
    const publishIndex = job.steps.findIndex((step) =>
      /npm publish/.test(step.run || '')
    );
    expect(publishIndex > installIndex).toBe(true);
  });

  it('publishes without a token and preserves version and release guards', () => {
    expect(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/.test(source)).toBe(false);
    const publish = job.steps.find((step) =>
      /npm publish/.test(step.run || '')
    );
    expect(publish.if).toBe(
      "steps.version-check.outputs.should_publish == 'true'"
    );
    expect(publish.run.includes('npm publish --access public')).toBe(true);
    expect(publish.run.includes('::error::')).toBe(true);
    expect(publish.run.includes('exit 1')).toBe(true);
    expect(publish['continue-on-error']).toBe(undefined);
    expect(workflow.jobs.publishRelease.needs.includes('publishToNpm')).toBe(
      true
    );
    expect(
      workflow.jobs.publishRelease.if.includes(
        "needs.publishToNpm.result == 'success'"
      )
    ).toBe(true);
  });
});
