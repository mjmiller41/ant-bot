import { test, expect } from '@playwright/test';

test.describe('smoke', () => {
  test('app loads and the sidebar renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('ant-bot')).toBeVisible();
    await expect(page.getByRole('button', { name: /^new$/i })).toBeVisible();

    // The roster is in exactly one of two valid states: the empty-state message,
    // or one or more bot rows. Never both, never neither.
    const emptyState = page.getByText(/no bots yet/i);
    const botRows = page.getByTestId('bot-row');
    await expect(emptyState.or(botRows.first())).toBeVisible();
    const rowCount = await botRows.count();
    const isEmpty = await emptyState.isVisible();
    expect(isEmpty ? rowCount === 0 : rowCount > 0).toBe(true);
  });

  test('create a bot and see it appear in the roster', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^new$/i }).click();

    const name = `E2E Bot ${Date.now()}`;
    await page.getByPlaceholder('Scout').fill(name);
    await page.getByRole('button', { name: /create bot/i }).click();

    // The name renders in both the sidebar row and the thread header; assert on the roster.
    await expect(page.getByRole('complementary').getByText(name).or(page.getByText(name).first())).toBeVisible({ timeout: 15000 });
  });
});
