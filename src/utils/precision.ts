import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export class Precision {
  static toBaseUnits(amount: string, decimals: number): bigint {
    const d = new Decimal(amount);
    const factor = new Decimal(10).pow(decimals);
    return BigInt(d.times(factor).toFixed(0));
  }

  static fromBaseUnits(amount: bigint, decimals: number): string {
    const d = new Decimal(amount.toString());
    const factor = new Decimal(10).pow(decimals);
    return d.dividedBy(factor).toFixed(decimals);
  }

  static formatDisplay(amount: string, decimals: number = 4): string {
    const d = new Decimal(amount);
    return d.toFixed(decimals);
  }

  static calculateFee(amount: bigint, feePercent: number): bigint {
    const d = new Decimal(amount.toString());
    const fee = d.times(feePercent).dividedBy(100);
    return BigInt(fee.toFixed(0));
  }

  static subtract(a: bigint, b: bigint): bigint {
    return a - b;
  }

  static add(a: bigint, b: bigint): bigint {
    return a + b;
  }

  static multiply(a: bigint, b: bigint): bigint {
    return a * b;
  }

  static divide(a: bigint, b: bigint): bigint {
    return a / b;
  }

  static isLessThan(a: bigint, b: bigint): boolean {
    return a < b;
  }

  static isGreaterThanOrEqual(a: bigint, b: bigint): boolean {
    return a >= b;
  }

  static zero(): bigint {
    return BigInt(0);
  }

  static fromNumber(n: number, decimals: number): bigint {
    return Precision.toBaseUnits(n.toString(), decimals);
  }
}
