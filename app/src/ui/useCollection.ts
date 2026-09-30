/** Loads the collection and shows its prices in the currency chosen in Settings. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CollectionRow, collectionRows, defaultPortfolio } from '../data/db';
import { useCurrency, withDisplayCurrency } from './CurrencyContext';

export function useCollection(reloadKey: number) {
  const [loaded, setLoaded] = useState<CollectionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const currency = useCurrency();

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const portfolio = await defaultPortfolio();
      setLoaded(await collectionRows(portfolio.id));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const rows = useMemo(() => loaded.map((row) => withDisplayCurrency(row, currency)), [loaded, currency]);
  return { rows, refreshing, reload };
}
