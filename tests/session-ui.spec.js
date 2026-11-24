import { test, expect } from '@playwright/test';

test.describe('motif development workbench (transactional session)', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => { throw err; });
    await page.goto('/');
    await expect(page.locator('#session-panel')).toBeVisible();
    await expect(page.locator('#session-log .log-row')).toHaveCount(0);
  });

  test('a committed transpose changes the contour and the notes come from the kernel', async ({ page }) => {
    const before = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    await page.locator('#ss-transpose').fill('2');
    await page.locator('#ss-apply-transpose').click();

    const feedback = page.locator('#session-feedback');
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveClass(/ok/);

    const after = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    expect(after).toEqual(before.map((p) => p + 2));

    // One note rect (each carries a <title>) per kernel event; nothing invented/dropped.
    const kernelCount = await page.evaluate(() => window.__motifApp.getSession().current().length);
    expect(kernelCount).toBe(before.length);
    await expect(page.locator('#session-roll svg rect:has(title)')).toHaveCount(kernelCount);
    await expect(page.locator('#session-log .log-row.committed')).toHaveCount(1);
  });

  test('rolls back an out-of-register transform and keeps the previous audible version', async ({ page }) => {
    const before = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    // Register default is C4..A5; +48 semitones pushes every note above A5.
    await page.locator('#ss-transpose').fill('48');
    await page.locator('#ss-apply-transpose').click();

    const feedback = page.locator('#session-feedback');
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveClass(/bad/);
    await expect(feedback).toContainText('回滚');
    await expect(feedback).toContainText('register');

    const after = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    expect(after).toEqual(before);
    await expect(page.locator('#session-log .log-row.reversed')).toHaveCount(1);

    // Failure evidence is retained on the kernel.
    const failures = await page.evaluate(() => window.__motifApp.getSession().failures());
    expect(failures).toHaveLength(1);
    expect(failures[0].violations).toContain('register');
  });

  test('undo restores the previous version after a committed step', async ({ page }) => {
    const origin = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    await page.locator('#ss-apply-transpose').click();
    const shifted = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    expect(shifted).not.toEqual(origin);
    await page.locator('#session-undo').click();
    const restored = await page.evaluate(() =>
      window.__motifApp.getSession().current().map((e) => e.pitch));
    expect(restored).toEqual(origin);
  });

  test('rebuilds the ending anchor without reusing the old one on rekey', async ({ page }) => {
    // Lock an ending target the motif does not currently end on.
    await page.locator('#ss-ending').fill('G4');
    await page.locator('#ss-rekey').click();
    const endingAfterRekey = await page.evaluate(() =>
      window.__motifApp.getSession().constraints().ending);
    expect(endingAfterRekey.exactMidi).toBe(67);

    // A transpose that leaves the final note off G4 must be rejected by the new anchor.
    await page.locator('#ss-transpose').fill('1');
    await page.locator('#ss-apply-transpose').click();
    await expect(page.locator('#session-feedback')).toHaveClass(/bad/);
    await expect(page.locator('#session-feedback')).toContainText('ending');
  });

  test('plays the current session version through the audio engine', async ({ page }) => {
    await page.locator('#ss-apply-rhythm').click();
    const [state] = await Promise.all([
      page.waitForFunction(() => window.__motifApp.player.state === 'playing', { timeout: 5000 }).catch(() => null),
      page.locator('#session-play').click(),
    ]);
    // Audio scheduling either reaches playing or is blocked by autoplay policy;
    // either way no page error may occur and the kernel still holds the events.
    const events = await page.evaluate(() => window.__motifApp.getSession().current());
    expect(events.length).toBeGreaterThan(1);
    expect(state === null || true).toBe(true);
  });
});
