import { expect, test } from '@playwright/test';

test('saves a brief and confirms constraints', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('origin-city').locator('input').fill('Warszawa');
  await page.getByTestId('start-date').locator('input').fill('2026-10-10');
  await page.getByTestId('end-date').locator('input').fill('2026-10-13');
  await page.getByTestId('adults').fill('2');
  await page.getByTestId('total-budget').fill('3500');
  await page.getByTestId('currency').locator('input').fill('PLN');
  await page.getByTestId('pace').selectOption('BALANCED');

  await page.getByTestId('save-brief').click();

  await expect(page.getByTestId('brief-summary')).toContainText('Warszawa');
  await expect(page.getByTestId('status')).toHaveText('DRAFT');

  await page.getByTestId('confirm-constraints').click();

  await expect(page.getByTestId('status')).toHaveText('CONSTRAINTS_CONFIRMED');
  await expect(page.getByTestId('next-stage-message')).toContainText(
    'Wyszukiwanie wariantów zostanie dodane w kolejnym etapie',
  );
});
