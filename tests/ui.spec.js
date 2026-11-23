import { test, expect } from '@playwright/test';

test.describe('motif developer UI', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => { throw err; });
    await page.goto('/');
    await expect(page.locator('.candidate').first()).toBeVisible();
    await page.locator('.candidate').first().click();
  });

  test('renders the theme, candidates and a structural comparison', async ({ page }) => {
    expect(await page.locator('.candidate').count()).toBeGreaterThan(0);
    await expect(page.locator('#detail-panel')).toBeVisible();
    // One row per slot in the segment/lineage table.
    expect(await page.locator('.segment-table tbody tr').count()).toBeGreaterThanOrEqual(3);
    // Hard-constraint checks are listed separately from the style components.
    expect(await page.locator('.check-item').count()).toBeGreaterThan(0);
    expect(await page.locator('.comp').count()).toBeGreaterThan(0);
    // Reproducibility block exposes the seed + hashes.
    await expect(page.locator('.repro')).toContainText('candidate hash');
    // No error banner for the default configuration.
    await expect(page.locator('#error-banner')).toBeHidden();
  });

  test('shows lineage that replays to the actual notes', async ({ page }) => {
    const rows = await page.locator('.segment-table .verification').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    for (const text of rows) expect(text).toMatch(/replay matches motif ops/);
  });

  test('plays audio and exports MIDI + JSON', async ({ page }) => {
    await page.locator('#play-chosen').click();
    await expect(page.locator('#stop')).toContainText('播放中');
    await page.locator('#stop').click();
    await expect(page.locator('#stop')).toContainText('停止');

    const [midi] = await Promise.all([page.waitForEvent('download'), page.locator('#export-midi').click()]);
    expect(midi.suggestedFilename()).toMatch(/\.mid$/);
    const [json] = await Promise.all([page.waitForEvent('download'), page.locator('#export-json').click()]);
    expect(json.suggestedFilename()).toMatch(/\.json$/);
  });

  test('reports an ending conflict when harmony cannot support the target', async ({ page }) => {
    // Closing on C major (C E G); D# is neither a chord tone there nor legal as
    // a phrase-final passing note, so the ending target and the harmony conflict.
    await page.locator('#harmony').fill('C, Am, F, C');
    await page.locator('#ending-pc').selectOption('D#');
    await page.locator('#generate').click();
    await expect(page.locator('#error-banner')).toBeVisible();
    await expect(page.locator('#error-banner')).toContainText(/ending conflict/i);
  });
});
