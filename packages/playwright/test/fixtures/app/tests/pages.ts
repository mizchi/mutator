import type { Page } from '@playwright/test';

/** Opens the counter page (a helper the specs import). */
export async function openCounter(page: Page): Promise<void> {
  await page.goto('/');
}
