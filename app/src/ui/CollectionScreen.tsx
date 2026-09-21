/** The collection: what you own, what it is worth. */
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { CollectionRow, collectionRows, defaultPortfolio } from '../data/db';
import { theme } from './theme';

function symbolFor(currency: string | null): string {
  if (currency === 'GBP') return '£';
  if (currency === 'EUR') return '€';
  return '$';
}

export function CollectionScreen({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const portfolio = await defaultPortfolio();
      setRows(await collectionRows(portfolio.id));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const cards = rows.reduce((total, row) => total + row.quantity, 0);
  const value = rows.reduce((total, row) => total + (row.market ?? 0) * row.quantity, 0);
  const currency = rows.find((row) => row.currency)?.currency ?? 'GBP';

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <View>
          <Text style={styles.summaryValue}>{cards}</Text>
          <Text style={styles.summaryLabel}>cards</Text>
        </View>
        <View>
          <Text style={styles.summaryValue}>
            {symbolFor(currency)}
            {value.toFixed(2)}
          </Text>
          <Text style={styles.summaryLabel}>estimated value</Text>
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => String(row.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={theme.accent} />}
        ListEmptyComponent={
          <Text style={styles.empty}>Nothing here yet. Scan a card and it will show up.</Text>
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.printing.name}</Text>
              <Text style={styles.rowMeta}>
                {item.printing.setCode} {item.printing.number} · {item.variant} · {item.condition}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowQuantity}>×{item.quantity}</Text>
              <Text style={styles.rowPrice}>
                {item.market !== null
                  ? `${symbolFor(item.currency)}${(item.market * item.quantity).toFixed(2)}`
                  : '—'}
              </Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: theme.spacing(2.5),
    paddingTop: theme.spacing(7),
  },
  summaryValue: { color: theme.text, fontSize: 28, fontWeight: '700' },
  summaryLabel: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase' },
  list: { padding: theme.spacing(2), gap: theme.spacing(1) },
  empty: { color: theme.textMuted, textAlign: 'center', marginTop: theme.spacing(6) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(1.5),
  },
  rowMain: { flex: 1 },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: theme.textMuted, fontSize: 12 },
  rowRight: { alignItems: 'flex-end' },
  rowQuantity: { color: theme.textMuted, fontSize: 12 },
  rowPrice: { color: theme.text, fontSize: 15, fontWeight: '600' },
});
