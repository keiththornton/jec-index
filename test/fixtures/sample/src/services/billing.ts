import { Money, formatMoney } from '@/utils/money';
import { logger } from '../lib/logger.js';
import { InsufficientFundsError } from '../lib/errors';

export class BillingService {
  private balance = Money.zero('USD');

  async charge(amount: Money): Promise<string> {
    if (amount.amount > this.balance.amount) {
      logger.error('insufficient');
      throw new InsufficientFundsError('nope');
    }
    this.balance = this.balance.add(amount);
    return formatMoney(this.balance);
  }
}

export default BillingService;
