import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

function readWorkflow(filePath) {
  return readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n');
}

function getJobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const jobHeader = `  ${jobName}:`;
  const start = lines.findIndex((line) => line === jobHeader);

  if (start === -1) {
    return '';
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^[ ]{2}[a-zA-Z0-9_-]+:\s*$/.test(line)
  );

  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

describe('workflow reliability policy', () => {
  it('cancels superseded non-main runs without cancelling main runs', () => {
    const workflowPaths = [
      '.github/workflows/example-app.yml',
      '.github/workflows/release.yml',
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = readWorkflow(workflowPath);

      expect(workflow).toContain(
        'group: ${{ github.workflow }}-${{ github.ref }}'
      );
      expect(workflow).toContain(
        "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}"
      );
      expect(workflow).not.toContain(
        "cancel-in-progress: ${{ github.ref == 'refs/heads/main' }}"
      );
    }
  });

  it('uploads preview regeneration artifacts when screenshot rendering fails', () => {
    const exampleAppWorkflow = readWorkflow(
      '.github/workflows/example-app.yml'
    );
    const previewRegenJob = getJobBlock(exampleAppWorkflow, 'preview-regen');

    expect(previewRegenJob).toContain(
      'name: Upload screenshot failure artifacts'
    );
    expect(previewRegenJob).toContain('if: failure()');
    expect(previewRegenJob).toContain('uses: actions/upload-artifact@v7');
    expect(previewRegenJob).toContain(
      'name: preview-regen-failure-${{ github.run_id }}'
    );
    expect(previewRegenJob).toContain('docs/screenshots/');
    expect(previewRegenJob).toContain('web/test-results/');
    expect(previewRegenJob).toContain('web/playwright-report/');
    expect(previewRegenJob).toContain('retention-days: 7');
    expect(previewRegenJob).toContain('if-no-files-found: ignore');
  });

  it('uses the official Playwright image for preview regeneration instead of downloading Chromium', () => {
    const exampleAppWorkflow = readWorkflow(
      '.github/workflows/example-app.yml'
    );
    const previewRegenJob = getJobBlock(exampleAppWorkflow, 'preview-regen');
    const imageVersion = previewRegenJob.match(
      /image:\s*mcr\.microsoft\.com\/playwright:v([0-9.]+)-noble/
    )?.[1];
    const packageVersion = previewRegenJob.match(/playwright@([0-9.]+)/)?.[1];

    expect(previewRegenJob).toContain('container:');
    expect(imageVersion).toBe('1.59.1');
    expect(packageVersion).toBe(imageVersion);
    expect(previewRegenJob).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'");
    expect(previewRegenJob).not.toContain('npx playwright install');
    expect(previewRegenJob).not.toContain('~/.cache/ms-playwright');
  });

  it('verifies desktop package output before uploading artifacts', () => {
    const exampleAppWorkflow = readWorkflow(
      '.github/workflows/example-app.yml'
    );
    const desktopPackageJob = getJobBlock(
      exampleAppWorkflow,
      'desktop-package'
    );
    const packageStepIndex = desktopPackageJob.indexOf(
      'name: Package Electron app'
    );
    const uploadStepIndex = desktopPackageJob.indexOf(
      'name: Upload desktop package'
    );

    expect(packageStepIndex).toBeGreaterThanOrEqual(0);
    expect(uploadStepIndex).toBeGreaterThan(packageStepIndex);
    expect(desktopPackageJob).toContain("node-version: '20.x'");
    expect(desktopPackageJob).not.toContain("node-version: '24.x'");
    expect(desktopPackageJob).toContain('shell: bash');
    expect(desktopPackageJob).toContain('npm run example:desktop:package');
    expect(desktopPackageJob).toContain('find examples/universal-app/out');
    expect(desktopPackageJob).toContain(
      'Desktop package output was not created at examples/universal-app/out'
    );
    expect(desktopPackageJob).toContain('if-no-files-found: error');
  });
});
