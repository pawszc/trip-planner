import { expect, test, type Page } from '@playwright/test';

async function setPreference(page: Page, key: string, value: number): Promise<void> {
  const range = page.getByTestId(`preference-${key}`);
  await range.focus();
  await range.press('Home');
  for (let current = 1; current < value; current += 1) {
    await range.press('ArrowRight');
  }
}

test('completes planning and presents exactly three grounded options', async ({ page }) => {
  const frontendErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') frontendErrors.push(message.text());
  });
  page.on('pageerror', (error) => frontendErrors.push(error.message));

  await page.goto('/');

  await page.getByLabel('Miasto rozpoczęcia').fill('Wrocław');
  await page.getByLabel('Data rozpoczęcia').fill('2026-10-10');
  await page.getByLabel('Data zakończenia').fill('2026-10-13');
  await page.getByLabel('Liczba dorosłych').fill('2');
  await page.getByLabel('Całkowity budżet').fill('4500');
  await page.getByLabel('Waluta').fill('PLN');
  await page.getByLabel('Tempo podróży').selectOption('RELAXED');

  await page.getByLabel('Najwcześniejszy wyjazd').fill('07:00');
  await page.getByLabel('Najpóźniejszy powrót').fill('22:00');
  await page.getByLabel('Maks. liczba przesiadek').fill('1');
  await page.getByLabel('Maks. czas jednego odcinka (min)').fill('480');
  await page.getByLabel('Budżet jest twardym limitem').check();
  await page.getByLabel('Samolot').uncheck();
  await page.getByLabel('Pociąg').check();
  await page.getByLabel('Autobus').check();

  await setPreference(page, 'food', 5);
  await setPreference(page, 'nature', 5);
  await setPreference(page, 'history', 3);
  await setPreference(page, 'museums', 2);
  await setPreference(page, 'nightlife', 1);
  await setPreference(page, 'centralAccommodation', 4);
  await setPreference(page, 'travelComfort', 4);
  await setPreference(page, 'priceSensitivity', 4);

  await page.getByTestId('save-brief').click();
  await expect(page.getByTestId('brief-summary')).toContainText('Wrocław');
  await expect(page.getByTestId('hard-constraints-summary')).toContainText('maks. 480 min');
  await expect(page.getByTestId('soft-preferences-summary')).toContainText('Jedzenie');
  await expect(page.getByTestId('status')).toHaveText('DRAFT');

  await page.getByTestId('confirm-constraints').click();
  await expect(page.getByTestId('status')).toHaveText('CONSTRAINTS_CONFIRMED');

  await page.getByTestId('start-planning').click();
  await expect(page.getByTestId('options-grid')).toBeVisible();
  await expect(page.getByTestId('option-card')).toHaveCount(3);
  await expect(page.getByTestId('workflow-status')).toHaveText('Workflow: OPTIONS_READY');

  const roles = await page.getByTestId('option-role').allTextContents();
  expect(roles.map((role) => role.split(' · ')[0])).toEqual([
    'BEST_OVERALL',
    'MOST_CONVENIENT',
    'BEST_VALUE',
  ]);
  await expect(page.getByTestId('option-cost')).toHaveCount(3);
  await expect(page.getByTestId('option-cost').first()).toContainText('3168,00');
  await expect(page.getByTestId('option-cost').first()).toContainText('zł');
  await expect(page.getByTestId('option-transport')).toHaveCount(3);
  await expect(page.getByTestId('option-transport').first()).toContainText('Pociąg');

  const firstOption = page.getByTestId('option-card').first();
  const sources = firstOption.getByTestId('option-sources');
  await sources.locator('summary').click();
  await expect(sources.getByTestId('fixture-label').first()).toContainText(
    'Dane demonstracyjne · INTERNAL_FIXTURE',
  );
  const budget = firstOption.getByTestId('option-budget');
  await budget.locator('summary').click();
  await expect(budget).toContainText('Transport lokalny');

  const diagnostics = page.getByTestId('rejection-diagnostics');
  await expect(diagnostics.locator('summary').first()).toContainText('22 kandydatów');
  await diagnostics.locator('summary').first().click();
  await expect(diagnostics.getByTestId('rejection-group')).toHaveCount(13);
  const firstGroup = diagnostics.getByTestId('rejection-group').first();
  await firstGroup.locator('summary').click();
  await expect(firstGroup.locator('li').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('option-card')).toHaveCount(3);
  const horizontalLayout = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const overflowingElements = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).replaceAll(' ', '.')}` : ''}`,
          testId: element.dataset.testid ?? null,
          text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100) ?? '',
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width),
        };
      })
      .filter(
        ({ left, right, width }) =>
          width > 0 && (left < -1 || right > documentElement.clientWidth + 1),
      )
      .slice(0, 10);

    return {
      clientWidth: documentElement.clientWidth,
      scrollWidth: documentElement.scrollWidth,
      overflowingElements,
    };
  });
  expect(
    horizontalLayout.scrollWidth,
    `Elementy poza mobilnym viewportem: ${JSON.stringify(horizontalLayout.overflowingElements)}`,
  ).toBeLessThanOrEqual(horizontalLayout.clientWidth);
  expect(frontendErrors).toEqual([]);
});
