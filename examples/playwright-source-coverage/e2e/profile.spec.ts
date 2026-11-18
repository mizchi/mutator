import { expect, test } from '@mizchi/mutator-playwright';

test('formats the display name', async ({ page }) => {
  await page.goto('/profile');
  await page.getByLabel('Name').fill('mizchi');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('display-name')).toHaveText('MIZCHI');
});
