import { expect, test } from '@mizchi/mutator-playwright';

test('calculates the total', async ({ page }) => {
  await page.goto('/cart');
  await page.getByLabel('Quantity').fill('2');
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByTestId('total')).toHaveText('$20');
});
