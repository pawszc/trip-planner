import { expect, test } from '@playwright/test';

test('saves a brief and confirms constraints', async ({ page }) => {
  // Vite i CAP są uruchamiane automatycznie przez konfigurację Playwright.
  await page.goto('/');

  // Komponenty UI5 używają Shadow DOM, dlatego pola wskazujemy po stabilnych test ID.
  await page.getByTestId('origin-city').locator('input').fill('Warszawa');
  await page.getByTestId('start-date').locator('input').fill('2026-10-10');
  await page.getByTestId('end-date').locator('input').fill('2026-10-13');
  await page.getByTestId('adults').fill('2');
  await page.getByTestId('total-budget').fill('3500');
  await page.getByTestId('currency').locator('input').fill('PLN');
  await page.getByTestId('pace').selectOption('BALANCED');

  await page.getByTestId('save-brief').click();

  // Najpierw sprawdzamy zapis szkicu, a potem zmianę statusu przez akcję CAP.
  await expect(page.getByTestId('brief-summary')).toContainText('Warszawa');
  await expect(page.getByTestId('status')).toHaveText('DRAFT');

  await page.getByTestId('confirm-constraints').click();

  await expect(page.getByTestId('status')).toHaveText('CONSTRAINTS_CONFIRMED');
  await expect(page.getByTestId('next-stage-message')).toContainText(
    'Wyszukiwanie wariantów zostanie dodane w kolejnym etapie',
  );
});
