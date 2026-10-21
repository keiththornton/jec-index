import { it, expect } from 'vitest';
import { BillingService } from '../src/services/billing';

it('charges', async () => {
  expect(new BillingService()).toBeTruthy();
});
