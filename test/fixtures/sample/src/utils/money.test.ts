import { describe, it, expect } from 'vitest';
import { Money, formatMoney } from './money';

describe('money', () => {
  it('formats', () => {
    expect(formatMoney(new Money(1, 'USD'))).toBe('USD 1.00');
  });
});
