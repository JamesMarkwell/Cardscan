/** The collection: what you own, what it is worth — searchable, sortable, filterable and editable. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  CollectionFilters,
  NO_FILTERS,
  SORTS,
  SortKey,
  applyFilters,
  formatMoney,
  gamesPresent,
  rowValue,
  sortRows,
  summarise,
} from '../collection/organise';
import {
  CollectionRow,
  collectionRows,
  defaultPortfolio,
  removeFromCollection,
  updateCollectionEntry,
} from '../data/db';
import { Condition, GAMES, GameId, Variant } from '../data/types';
import { AddCardModal } from './AddCardModal';
import { CardDetailModal } from './CardDetailModal';
import { CardImage } from './CardImage';
import { Chips } from './Chips';
import { theme } from './theme';

const CONDITION_FILTERS: Array<{ key: Condition | null; label: string }> = [
  { key: null, label: 'Any condition' },
  ...(['NM', 'LP', 'MP', 'HP', 'DMG'] as Condition[]).map((key) => ({ key, label: key })),
];

export function CollectionScreen({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

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

  const summary = useMemo(() => summarise(rows), [rows]);
  const games = useMemo(
    () => gamesPresent(rows, GAMES.map((game) => game.id)),
    [rows],
  );
  const visible = useMemo(() => sortRows(applyFilters(rows, filters), sort), [rows, filters, sort]);
  const shown = useMemo(() => summarise(visible), [visible]);
  const filtered = filters.query !== '' || filters.gameId !== null || filters.condition !== null;
  const open = rows.find((row) => row.id === openId) ?? null;

  const change = async (changes: { quantity?: number; condition?: Condition; variant?: Variant }) => {
    if (openId === null) return;
    await updateCollectionEntry(openId, changes);
    await load();
  };

  const remove = async () => {
    if (openId === null) return;
    await removeFromCollection(openId);
    setOpenId(null);
    await load();
  };

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <View>
          <Text style={styles.summaryValue}>{formatMoney(summary.value, summary.currency)}</Text>
          <Text style={styles.summaryLabel}>estimated value</Text>
        </View>
        <View style={styles.summaryRight}>
          <Text style={styles.summaryValue}>{summary.cards}</Text>
          <Text style={styles.summaryLabel}>
            {summary.cards === 1 ? 'card' : 'cards'} · {summary.unique} unique
          </Text>
        </View>
      </View>

      <View style={styles.controls}>
        <View style={styles.searchRow}>
          <TextInput
            value={filters.query}
            onChangeText={(query) => setFilters((current) => ({ ...current, query }))}
            placeholder="Search your collection"
            placeholderTextColor={theme.textMuted}
            style={styles.search}
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
          <Pressable style={styles.sortButton} onPress={() => setSortOpen(true)} accessibilityRole="button">
            <Text style={styles.sortText}>Sort ▾</Text>
          </Pressable>
        </View>
        {games.length > 1 ? (
          <Chips
            options={[{ key: null, label: 'All games' }, ...GAMES.filter((g) => games.includes(g.id)).map((g) => ({ key: g.id as GameId | null, label: g.name }))]}
            value={filters.gameId}
            onChange={(gameId) => setFilters((current) => ({ ...current, gameId }))}
          />
        ) : null}
        <Chips
          options={CONDITION_FILTERS}
          value={filters.condition}
          onChange={(condition) => setFilters((current) => ({ ...current, condition }))}
        />
        {filtered ? (
          <View style={styles.filterNote}>
            <Text style={styles.filterText}>
              Showing {shown.unique} of {summary.unique} · {formatMoney(shown.value, shown.currency)}
            </Text>
            <Pressable onPress={() => setFilters(NO_FILTERS)}>
              <Text style={styles.clear}>Clear</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(row) => String(row.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={theme.accent} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {rows.length === 0
              ? 'Nothing here yet. Scan a card, or tap + to add one by hand.'
              : 'No cards match. Try clearing the filters.'}
          </Text>
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => setOpenId(item.id)}>
            <CardImage uri={item.printing.imageUrl} width={46} label={item.printing.name} />
            <View style={styles.rowMain}>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.printing.name}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.printing.setName} · {item.printing.number}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.variant === 'normal' ? '' : `${item.variant.replace('_', ' ')} · `}
                {item.condition}
                {item.printing.rarity ? ` · ${item.printing.rarity}` : ''}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowPrice}>{item.market === null ? '—' : formatMoney(rowValue(item), item.currency)}</Text>
              <Text style={styles.rowQuantity}>×{item.quantity}</Text>
            </View>
          </Pressable>
        )}
      />

      <Pressable style={styles.fab} onPress={() => setAdding(true)} accessibilityLabel="Add a card" accessibilityRole="button">
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <Modal visible={sortOpen} transparent animationType="fade" onRequestClose={() => setSortOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSortOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Sort by</Text>
            {SORTS.map((option) => (
              <Pressable
                key={option.key}
                style={styles.sheetRow}
                onPress={() => {
                  setSort(option.key);
                  setSortOpen(false);
                }}
              >
                <Text style={[styles.sheetText, option.key === sort && styles.sheetSelected]}>
                  {option.key === sort ? '✓ ' : ''}
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <CardDetailModal
        row={open}
        onClose={() => setOpenId(null)}
        onChange={(changes) => void change(changes)}
        onRemove={() => void remove()}
      />

      <AddCardModal
        visible={adding}
        onClose={() => setAdding(false)}
        onAdded={() => void load()}
        initialGameId={filters.gameId}
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
    paddingBottom: theme.spacing(1.5),
  },
  summaryRight: { alignItems: 'flex-end' },
  summaryValue: { color: theme.text, fontSize: 28, fontWeight: '700' },
  summaryLabel: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase' },
  controls: { paddingHorizontal: theme.spacing(2), gap: theme.spacing(0.5) },
  searchRow: { flexDirection: 'row', gap: theme.spacing(1), alignItems: 'center' },
  search: {
    flex: 1,
    backgroundColor: theme.surface,
    color: theme.text,
    borderRadius: theme.radius,
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1.25),
    fontSize: 15,
  },
  sortButton: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    paddingHorizontal: theme.spacing(1.75),
    paddingVertical: theme.spacing(1.5),
  },
  sortText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  filterNote: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.spacing(0.5) },
  filterText: { color: theme.textMuted, fontSize: 12 },
  clear: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  list: { padding: theme.spacing(2), gap: theme.spacing(1), paddingBottom: theme.spacing(12) },
  empty: { color: theme.textMuted, textAlign: 'center', marginTop: theme.spacing(6) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(1.25),
  },
  rowMain: { flex: 1 },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: theme.textMuted, fontSize: 12 },
  rowRight: { alignItems: 'flex-end' },
  rowQuantity: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  rowPrice: { color: theme.text, fontSize: 15, fontWeight: '700' },
  fab: {
    position: 'absolute',
    right: theme.spacing(2.5),
    bottom: theme.spacing(2.5),
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  fabText: { color: '#fff', fontSize: 30, lineHeight: 34, fontWeight: '500' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: theme.spacing(2),
    paddingBottom: theme.spacing(4),
  },
  sheetTitle: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase', marginBottom: theme.spacing(1) },
  sheetRow: { paddingVertical: theme.spacing(1.5) },
  sheetText: { color: theme.text, fontSize: 16 },
  sheetSelected: { color: theme.accent, fontWeight: '700' },
});
