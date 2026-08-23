import { test, expect } from '@playwright/test';

// This spec exercises the Permission Gateway end-to-end: a bot attempts a tool call that
// requires approval, an ApprovalCard appears in the thread, and clicking Deny resolves it
// and shows the denial in-thread. It requires a live daemon with a working Agent Session
// (M1/M2), so it is expected to fail until those are wired up.
test('an approval card appears for a risky tool call and Deny works', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^new$/i }).click();

  const name = `Approval E2E ${Date.now()}`;
  await page.getByPlaceholder('Scout').fill(name);
  await page.getByRole('button', { name: /create bot/i }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 });
  await page.getByText(name).first().click();

  const textarea = page.getByRole('textbox');
  await textarea.fill('Run exactly this with your Bash tool: npm install left-pad');
  await textarea.press('Enter');

  const approvalCard = page.getByText(/approval needed/i).first();
  await expect(approvalCard).toBeVisible({ timeout: 180000 });

  await page.getByRole('button', { name: /^deny$/i }).click();

  await expect(page.getByText(/denied/i).first()).toBeVisible({ timeout: 15000 });
});
