import { Address } from '@ton/core';

export function isValidTonAddress(address: string): boolean {
  try {
    Address.parse(address);
    return true;
  } catch {
    return false;
  }
}

export function formatAddressShort(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function isValidAmount(amount: string): boolean {
  const regex = /^\d+(\.\d+)?$/;
  if (!regex.test(amount)) return false;
  const num = parseFloat(amount);
  return num > 0 && isFinite(num);
}

export function isValidTelegramId(id: string): boolean {
  const num = parseInt(id, 10);
  return !isNaN(num) && num > 0;
}
