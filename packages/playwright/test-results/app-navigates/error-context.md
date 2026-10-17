# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> navigates
- Location: tests/app.spec.ts:12:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('#out')
Expected: "HI"
Received: ""
Timeout:  2000ms

Call log:
  - Expect "toHaveText" locator('#out') with timeout 2000ms
  - waiting for locator('#out')
    21 × locator resolved to <span id="out"></span>
       - unexpected value ""

```

# Test source

```ts
  1  | import { expect, test } from '@mizchi/mutator-playwright';
  2  | 
  3  | test.describe('counter', () => {
  4  |   test('increments', async ({ page }) => {
  5  |     await page.goto('/');
  6  |     await page.click('#count');
  7  |     await expect(page.locator('#count')).toHaveText('1');
  8  |     await expect(page.locator('#label')).toHaveText('few');
  9  |   });
  10 | });
  11 | 
  12 | test('navigates', async ({ page }) => {
  13 |   await page.goto('/');
  14 |   await expect(page.locator('#label')).toHaveText('few');
  15 |   await page.click('#next');
> 16 |   await expect(page.locator('#out')).toHaveText('HI');
     |                                      ^ Error: expect(locator).toHaveText(expected) failed
  17 | });
  18 | 
```