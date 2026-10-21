export interface MoneyLike { amount: number; currency: string }

export function formatMoney(m: MoneyLike): string {
  return `${m.currency} ${m.amount.toFixed(2)}`;
}

export class Money implements MoneyLike {
  constructor(public amount: number, public currency: string) {}
  add(other: Money): Money {
    return new Money(this.amount + other.amount, this.currency);
  }
  static zero(currency: string): Money {
    return new Money(0, currency);
  }
}

export const DEFAULT_CURRENCY = 'USD';
const internalHelper = () => 1;
export type Cents = number;
