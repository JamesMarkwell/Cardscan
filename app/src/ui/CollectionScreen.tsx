/** The collection: what you own, what it is worth — as a list or a grid, searchable, sortable, editable, with multi-select delete. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  CollectionFilters,
  NO_FILTERS,
  SORTS,
  SortKey,
  applyFilters,
  formatMoney,
  gamesPresent,
  rowValue,
  sortLabel,
  sortRows,
  summarise,
} from '../collection/organise';
import {
  CollectionRow,
  collectionRows,
  defaultPortfolio,
  removeFromCollection,
  removeManyFromCollection,
  updateCollectionEntry,
} from '../data/db';
import { Condition, GAMES, GameId, Variant } from '../data/types';
import { AddCardModal } from './AddCardModal';
import { CardDetailModal } from './CardDetailModal';
import { CardImage } from './CardImage';
import { Chips } from './Chips';
import { useCurrency, withDisplayCurrency } from './CurrencyContext';
import { theme } from './theme';

type ViewMode = 'list' | 'grid';

const GRID_COLUMNS = 3;
const GRID_GAP = theme.spacing(1);
const LIST_PADDING = theme.spacing(2);

const CONDITION_FILTERS: Array<{ key: Condition | null; label: string }> = [
  { key: null, label: 'Any condition' },
  ...(['NM', 'LP', 'MP', 'HP', 'DMG'] as Condition[]).map((key) => ({ key, label: key })),
];

/** "Holo · LP" style detail line; empty for a plain near-mint card. */
function detailLine(row: CollectionRow): string {
  const parts: string[] = [];
  if (row.variant !== 'normal') parts.push(row.variant.replace('_', ' '));
  if (row.condition !== 'NM') parts.push(row.condition);
  return parts.join(' · ');
}

export function CollectionScreen({ reloadKey }: { reloadKey: number }) {
  const [loaded, setRows] = useState<CollectionRow[]>([]);
  // Prices are stored in their source's currency; show them in the one chosen in Settings.
  const currency = useCurrency();
  const rows = useMemo(() => loaded.map((row) => withDisplayCurrency(row, currency)), [loaded, currency]);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('name');
  const [sortOpen, setSortOpen] = useState(false);
  const [view, setView] = useState<ViewMode>('list');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  // Selection mode: null when off, otherwise the ids picked so far.
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const { width } = useWindowDimensions();

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
  const games = useMemo(() => gamesPresent(rows, GAMES.map((game) => game.id)), [rows]);
  const visible = useMemo(() => sortRows(applyFilters(rows, filters), sort), [rows, filters, sort]);
  const shown = useMemo(() => summarise(visible), [visible]);
  const filtered = filters.query !== '' || filters.gameId !== null || filters.condition !== null;
  const open = rows.find((row) => row.id === openId) ?? null;
  const selecting = selected !== null;

  // Drop selections for rows that no longer exist (deleted, or a sync changed the list).
  useEffect(() => {
    setSelected((current) => {
      if (!current) return current;
      const ids = new Set(rows.map((row) => row.id));
      const kept = new Set([...current].filter((id) => ids.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [rows]);

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

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const press = (row: CollectionRow) => (selecting ? toggle(row.id) : setOpenId(row.id));
  const longPress = (row: CollectionRow) => {
    if (!selecting) setSelected(new Set([row.id]));
  };

  const allShownSelected = selecting && visible.length > 0 && visible.every((row) => selected.has(row.id));

  const deleteSelected = () => {
    if (!selected || selected.size === 0) return;
    const chosen = rows.filter((row) => selected.has(row.id));
    const copies = chosen.reduce((total, row) => total + row.quantity, 0);
    Alert.alert(
      `Delete ${chosen.length} ${chosen.length === 1 ? 'card' : 'cards'}?`,
      `${copies} ${copies === 1 ? 'copy' : 'copies'} will be removed from your collection.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await removeManyFromCollection(chosen.map((row) => row.id));
              setSelected(null);
              await load();
            })();
          },
        },
      ],
    );
  };

  const gridWidth = Math.floor((width - LIST_PADDING * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);

  const renderSelectMark = (row: CollectionRow, style: object) =>
    selecting ? (
      <View style={[styles.mark, style, selected.has(row.id) && styles.markOn]}>
        {selected.has(row.id) ? <Text style={styles.markText}>✓</Text> : null}
      </View>
    ) : null;

  const renderListRow = (item: CollectionRow) => {
    const detail = detailLine(item);
    return (
      <Pressable
        style={[styles.row, selecting && selected.has(item.id) && styles.rowSelected]}
        onPress={() => press(item)}
        onLongPress={() => longPress(item)}
      >
        {renderSelectMark(item, styles.markInline)}
        <CardImage uri={item.printing.imageUrl} width={64} label={item.printing.name} />
        <View style={styles.rowMain}>
          <Text style={styles.rowName} numberOfLines={2}>
            {item.printing.name}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {item.printing.setName} · {item.printing.number}
          </Text>
          {detail ? <Text style={styles.rowMeta}>{detail}</Text> : null}
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowPrice}>{formatMoney(item.market, item.currency)}</Text>
          {item.quantity > 1 ? (
            <Text style={styles.rowQuantity}>
              ×{item.quantity} · {formatMoney(rowValue(item), item.currency)}
            </Text>
          ) : (
            <Text style={styles.rowQuantity}>×1</Text>
          )}
        </View>
      </Pressable>
    );
  };

  const renderGridTile = (item: CollectionRow) => (
    <Pressable
      style={[styles.tile, { width: gridWidth }, selecting && selected.has(item.id) && styles.rowSelected]}
      onPress={() => press(item)}
      onLongPress={() => longPress(item)}
    >
      <View>
        <CardImage uri={item.printing.imageUrl} width={gridWidth - 8} label={item.printing.name} />
        {item.quantity > 1 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>×{item.quantity}</Text>
          </View>
        ) : null}
        {renderSelectMark(item, styles.markOverlay)}
      </View>
      <Text style={styles.tileName} numberOfLines={2}>
        {item.printing.name}
      </Text>
      <Text style={styles.tilePrice}>{formatMoney(item.market, item.currency)}</Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      {selecting ? (
        <View style={styles.selectBar}>
          <Pressable onPress={() => setSelected(null)} accessibilityRole="button">
            <Text style={styles.selectAction}>Cancel</Text>
          </Pressable>
          <Text style={styles.selectCount}>{selected.size} selected</Text>
          <Pressable
            onPress={() => setSelected(allShownSelected ? new Set() : new Set(visible.map((row) => row.id)))}
            accessibilityRole="button"
          >
            <Text style={styles.selectAction}>{allShownSelected ? 'None' : 'All'}</Text>
          </Pressable>
        </View>
      ) : (
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
      )}

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
          <Pressable
            style={styles.iconButton}
            onPress={() => setView((current) => (current === 'list' ? 'grid' : 'list'))}
            accessibilityRole="button"
            accessibilityLabel={view === 'list' ? 'Switch to grid' : 'Switch to list'}
          >
            <Text style={styles.iconText}>{view === 'list' ? '▦' : '☰'}</Text>
          </Pressable>
        </View>
        <View style={styles.toolRow}>
          <Pressable style={styles.sortButton} onPress={() => setSortOpen(true)} accessibilityRole="button">
            <Text style={styles.sortText}>⇅ {sortLabel(sort)}</Text>
          </Pressable>
          <Pressable
            style={[styles.sortButton, selecting && styles.toolOn]}
            onPress={() => setSelected(selecting ? null : new Set())}
            accessibilityRole="button"
          >
            <Text style={[styles.sortText, selecting && styles.toolOnText]}>Select</Text>
          </Pressable>
        </View>
        {games.length > 1 ? (
          <Chips
            options={[
              { key: null, label: 'All games' },
              ...GAMES.filter((g) => games.includes(g.id)).map((g) => ({ key: g.id as GameId | null, label: g.name })),
            ]}
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
        // A different column count needs a fresh list.
        key={view}
        data={visible}
        numColumns={view === 'grid' ? GRID_COLUMNS : 1}
        columnWrapperStyle={view === 'grid' ? styles.gridRow : undefined}
        keyExtractor={(row) => String(row.id)}
        extraData={selected}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={theme.accent} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {rows.length === 0
              ? 'Nothing here yet. Scan a card, or tap + to add one by hand.'
              : 'No cards match. Try clearing the filters.'}
          </Text>
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (view === 'grid' ? renderGridTile(item) : renderListRow(item))}
      />

      {selecting ? (
        <View style={styles.deleteBar}>
          <Pressable
            style={[styles.deleteButton, selected.size === 0 && styles.deleteDisabled]}
            disabled={selected.size === 0}
            onPress={deleteSelected}
            accessibilityRole="button"
          >
            <Text style={styles.deleteText}>
              {selected.size === 0 ? 'Select cards to delete' : `Delete ${selected.size}`}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.fab} onPress={() => setAdding(true)} accessibilityLabel="Add a card" accessibilityRole="button">
          <Text style={styles.fabText}>+</Text>
        </Pressable>
      )}

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
  selectBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing(2.5),
    paddingTop: theme.spacing(7),
    paddingBottom: theme.spacing(2),
  },
  selectCount: { color: theme.text, fontSize: 18, fontWeight: '700' },
  selectAction: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  controls: { paddingHorizontal: LIST_PADDING, gap: theme.spacing(0.5) },
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
  iconButton: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: theme.text, fontSize: 20 },
  toolRow: { flexDirection: 'row', gap: theme.spacing(1) },
  sortButton: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    paddingHorizontal: theme.spacing(1.75),
    paddingVertical: theme.spacing(1.25),
  },
  sortText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  toolOn: { backgroundColor: theme.accent },
  toolOnText: { color: '#fff' },
  filterNote: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.spacing(0.5) },
  filterText: { color: theme.textMuted, fontSize: 12 },
  clear: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  list: { padding: LIST_PADDING, gap: theme.spacing(1), paddingBottom: theme.spacing(14) },
  gridRow: { gap: GRID_GAP },
  empty: { color: theme.textMuted, textAlign: 'center', marginTop: theme.spacing(6) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(1.25),
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowSelected: { borderColor: theme.accent },
  rowMain: { flex: 1, gap: 2 },
  rowName: { color: theme.text, fontSize: 16, fontWeight: '700' },
  rowMeta: { color: theme.textMuted, fontSize: 12 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  rowQuantity: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  rowPrice: { color: theme.high, fontSize: 18, fontWeight: '800' },
  tile: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 4,
    alignItems: 'center',
    gap: 2,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  tileName: { color: theme.text, fontSize: 12, fontWeight: '600', textAlign: 'center', minHeight: 30 },
  tilePrice: { color: theme.high, fontSize: 14, fontWeight: '800', paddingBottom: 4 },
  badge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  mark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.textMuted,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markInline: {},
  markOverlay: { position: 'absolute', top: 6, left: 6 },
  markOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  markText: { color: '#fff', fontSize: 14, fontWeight: '800', lineHeight: 16 },
  deleteBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: theme.spacing(2),
    backgroundColor: theme.surfaceAlt,
  },
  deleteButton: { backgroundColor: theme.low, borderRadius: theme.radius, padding: theme.spacing(1.75), alignItems: 'center' },
  deleteDisabled: { opacity: 0.4 },
  deleteText: { color: '#fff', fontSize: 16, fontWeight: '700' },
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
