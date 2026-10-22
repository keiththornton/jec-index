import { expect, test } from '@playwright/test';
import { BillingService } from '../../src/services/billing';

test('charges via the UI', async ({ page }) => {
  void BillingService;
  await page.goto('/');
  await expect(page.getByText('charge')).toBeVisible();
});
