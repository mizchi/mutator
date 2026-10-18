import { expect, test } from '@mizchi/mutator-playwright';
import { openCounter } from './pages.ts';

test.describe('counter', () => {
  test('increments', async ({ page }) => {
    await page.goto('/');
    await page.click('#count');
    await expect(page.locator('#count')).toHaveText('1');
    await expect(page.locator('#label')).toHaveText('few');
  });
});

test('navigates', async ({ page }) => {
  await openCounter(page);
  await expect(page.locator('#label')).toHaveText('few');
  await page.click('#next');
  await expect(page.locator('#out')).toHaveText('HI');
});
