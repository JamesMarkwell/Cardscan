/** The chosen display currency and the rates to convert into it, shared by every screen that shows a price. */
import React, { createContext, useContext, useMemo } from 'react';
import { CurrencyCode, FALLBACK_RATES, Rates, convertAmount } from '../data/currency';

interface CurrencyValue {
  currency: CurrencyCode;
  rates: Rates;
}

const CurrencyContext = createContext<CurrencyValue>({ currency: 'GBP', rates: FALLBACK_RATES });

export function CurrencyProvider({
  currency,
  rates,
  children,
}: CurrencyValue & { children: React.ReactNode }) {
  const value = useMemo(() => ({ currency, rates }), [currency, rates]);
  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyValue {
  return useContext(CurrencyContext);
}

/** Convert a priced object (anything with `market` and `currency`) into the display currency. */
export function withDisplayCurrency<T extends { market: number | null; currency: string | null }>(
  item: T,
  { currency, rates }: CurrencyValue,
): T {
  if (item.market === null) return { ...item, currency };
  return { ...item, market: convertAmount(item.market, item.currency, currency, rates), currency };
}
