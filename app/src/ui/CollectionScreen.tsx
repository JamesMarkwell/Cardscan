/** The portfolio: what you own and what it is worth — searchable, sortable, filterable, with a grid or list and multi-select delete. */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
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
import { CollectionRow, removeFromCollection, removeManyFromCollection, updateCollectionEntry } from '../data/db';
import { Condition, GAMES, GameId, Variant } from '../data/types';
import { AddCardModal } from './AddCardModal';
import { CardDetailModal } from './CardDetailModal';
import { CardImage } from './CardImage';
import { Chips } from './Chips';
import { Icon, IconName } from './Icon';
import { topInset } from './layout';
import { theme } from './theme';
import { useCollection } from './useCollection';

type ViewMode = 'grid' | 'list';

const GAP = theme.spacing(1.5);
const PAD = theme.spacing(2);
const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

/** "Near Mint • Foil" style line. */
function conditionLine(row: CollectionRow): string {
  const parts: string[] = [row.condition];
  if (row.variant !== 'normal') parts.push(row.variant.replace('_', ' '));
  return parts.join(' • ');
}

/** A round icon button with a label underneath: the portfolio's action row. */
function Action({ icon, label, onPress, active }: { icon: IconName; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable style={styles.action} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <View style={[styles.actionCircle, active && styles.actionCircleOn]}>
        <Icon name={icon} size={22} color={active ? theme.onAccent : theme.accent} />
      </View>
      <Text style={styles.actionLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function CollectionScreen({
  reloadKey,
  onScan,
  sortRequest,
}: {
  reloadKey: number;
  onScan: () => void;
  /** Asks for a particular sort (e.g. "View all" on Home); a new nonce applies it again. */
  sortRequest?: { sort: SortKey; nonce: number };
}) {
  const { rows, refreshing, reload } = useCollection(reloadKey);
  const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('recent');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [view, setView] = useState<ViewMode>('grid');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  // Selection mode: null when off, otherwise the ids picked so far.
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (sortRequest) {
      setSort(sortRequest.sort);
      setFilters(NO_FILTERS);
    }
  }, [sortRequest]);

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
    await reload();
  };

  const remove = async () => {
    if (openId === null) return;
    await removeFromCollection(openId);
    setOpenId(null);
    await reload();
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
              await reload();
            })();
          },
        },
      ],
    );
  };

  const cardWidth = Math.floor((width - PAD * 2 - GAP) / 2);

  const mark = (row: CollectionRow, style: object) =>
    selecting ? (
      <View style={[styles.mark, style, selected.has(row.id) && styles.markOn]}>
        {selected.has(row.id) ? <Text style={styles.markText}>✓</Text> : null}
      </View>
    ) : null;

  const renderGridCard = (item: CollectionRow) => (
    <Pressable
      style={[styles.card, { width: cardWidth }, selecting && selected.has(item.id) && styles.cardSelected]}
      onPress={() => press(item)}
      onLongPress={() => longPress(item)}
    >
      <View style={styles.cardImage}>
        <CardImage uri={item.printing.imageUrl} width={cardWidth - 26} label={item.printing.name} />
        {mark(item, styles.markOverlay)}
      </View>
      <Text style={styles.cardName} numberOfLines={2}>
        {item.printing.name}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {item.printing.setName}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {item.printing.rarity ? `${item.printing.rarity} • ` : ''}
        {item.printing.number}
      </Text>
      <Text style={styles.cardCondition} numberOfLines={1}>
        {conditionLine(item)}
      </Text>
      <View style={styles.cardFoot}>
        <Text style={styles.cardQty}>Qty: {item.quantity}</Text>
        <View style={styles.cardPriceBox}>
          <Text style={styles.cardPrice} numberOfLines={1}>
            {formatMoney(item.market, item.currency)}
          </Text>
          {item.quantity > 1 && item.market !== null ? (
            <Text style={styles.cardTotal} numberOfLines={1}>
              {formatMoney(rowValue(item), item.currency)} total
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );

  const renderListRow = (item: CollectionRow) => (
    <Pressable
      style={[styles.row, selecting && selected.has(item.id) && styles.cardSelected]}
      onPress={() => press(item)}
      onLongPress={() => longPress(item)}
    >
      {mark(item, styles.markInline)}
      <CardImage uri={item.printing.imageUrl} width={56} label={item.printing.name} />
      <View style={styles.rowMain}>
        <Text style={styles.cardName} numberOfLines={2}>
          {item.printing.name}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {item.printing.setName} • {item.printing.number}
        </Text>
        <Text style={styles.cardCondition} numberOfLines={1}>
          {conditionLine(item)}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.cardPrice}>{formatMoney(item.market, item.currency)}</Text>
        <Text style={styles.cardQty}>×{item.quantity}</Text>
      </View>
    </Pressable>
  );

  const header = (
    <View style={styles.header}>
      <Text style={styles.headerLabel}>Portfolio</Text>
      <Text style={styles.headerValue} numberOfLines={1} adjustsFontSizeToFit>
        {formatMoney(summary.value, summary.currency)}
      </Text>
      <Text style={styles.headerSub}>
        {summary.cards} {summary.cards === 1 ? 'card' : 'cards'} · {summary.unique} unique
      </Text>

      <View style={styles.actions}>
        <Action icon="plus" label="Add cards" onPress={() => setAdding(true)} />
        <Action icon="sort" label="Sort" onPress={() => setSheetOpen(true)} />
        <Action icon="select" label="Select" active={selecting} onPress={() => setSelected(selecting ? null : new Set())} />
        <Action
          icon={view === 'grid' ? 'list' : 'grid'}
          label={view === 'grid' ? 'List' : 'Grid'}
          onPress={() => setView((current) => (current === 'grid' ? 'list' : 'grid'))}
        />
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
  );

  return (
    <View style={styles.container}>
      {selecting ? (
        <View style={styles.selectBar}>
          <Pressable onPress={() => setSelected(null)} accessibilityRole="button" hitSlop={10}>
            <Text style={styles.selectAction}>Cancel</Text>
          </Pressable>
          <Text style={styles.selectCount}>{selected.size} selected</Text>
          <Pressable
            onPress={() => setSelected(allShownSelected ? new Set() : new Set(visible.map((row) => row.id)))}
            accessibilityRole="button"
            hitSlop={10}
          >
            <Text style={styles.selectAction}>{allShownSelected ? 'None' : 'All'}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.searchRow}>
          <View style={styles.searchField}>
            <Icon name="search" size={20} color={theme.textMuted} />
            <TextInput
              value={filters.query}
              onChangeText={(query) => setFilters((current) => ({ ...current, query }))}
              placeholder="Search your collection"
              placeholderTextColor={theme.textMuted}
              style={styles.searchInput}
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          <Pressable style={[styles.roundButton, (filters.condition || sort !== 'recent') && styles.roundButtonOn]} onPress={() => setSheetOpen(true)} accessibilityRole="button" accessibilityLabel="Sort and filter">
            <Icon name="filter" size={20} color={filters.condition || sort !== 'recent' ? theme.onAccent : theme.text} />
          </Pressable>
        </View>
      )}

      <FlatList
        // A different column count needs a fresh list.
        key={view}
        data={visible}
        numColumns={view === 'grid' ? 2 : 1}
        columnWrapperStyle={view === 'grid' ? styles.gridRow : undefined}
        keyExtractor={(row) => String(row.id)}
        extraData={selected}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload()} tintColor={theme.accent} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{rows.length === 0 ? 'Nothing here yet' : 'No cards match'}</Text>
            <Text style={styles.emptyText}>
              {rows.length === 0 ? 'Scan a card, or add one by hand.' : 'Try clearing the search or filters.'}
            </Text>
            {rows.length === 0 ? (
              <Pressable style={styles.emptyButton} onPress={onScan} accessibilityRole="button">
                <Text style={styles.emptyButtonText}>Scan a card</Text>
              </Pressable>
            ) : null}
          </View>
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (view === 'grid' ? renderGridCard(item) : renderListRow(item))}
      />

      {selecting ? (
        <View style={styles.deleteBar}>
          <Pressable
            style={[styles.deleteButton, selected.size === 0 && styles.deleteDisabled]}
            disabled={selected.size === 0}
            onPress={deleteSelected}
            accessibilityRole="button"
          >
            <Icon name="trash" size={20} color="#fff" />
            <Text style={styles.deleteText}>{selected.size === 0 ? 'Select cards to delete' : `Delete ${selected.size}`}</Text>
          </Pressable>
        </View>
      ) : null}

      <Modal visible={sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSheetOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.sheetTitle}>Sort by</Text>
              {SORTS.map((option) => (
                <Pressable key={option.key} style={styles.sheetRow} onPress={() => setSort(option.key)}>
                  <Text style={[styles.sheetText, option.key === sort && styles.sheetSelected]}>{option.label}</Text>
                  {option.key === sort ? <Text style={styles.sheetTick}>✓</Text> : null}
                </Pressable>
              ))}

              <Text style={[styles.sheetTitle, styles.sheetGap]}>Condition</Text>
              <Chips
                options={[{ key: null, label: 'Any' }, ...CONDITIONS.map((key) => ({ key, label: key }))]}
                value={filters.condition}
                onChange={(condition) => setFilters((current) => ({ ...current, condition }))}
              />
            </ScrollView>
            <Pressable style={styles.sheetDone} onPress={() => setSheetOpen(false)} accessibilityRole="button">
              <Text style={styles.sheetDoneText}>Show {visible.length} {visible.length === 1 ? 'card' : 'cards'} · {sortLabel(sort)}</Text>
            </Pressable>
          </Pressable>
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
        onAdded={() => void reload()}
        initialGameId={filters.gameId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1), paddingHorizontal: PAD, paddingTop: topInset + theme.spacing(1), paddingBottom: theme.spacing(1) },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.25),
    height: 48,
    paddingHorizontal: theme.spacing(2),
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: 15, paddingVertical: 0, height: 48, textAlignVertical: 'center' },
  roundButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  roundButtonOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  selectBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', height: 48 + topInset + theme.spacing(2), paddingHorizontal: PAD, paddingTop: topInset },
  selectCount: { color: theme.text, fontSize: 18, fontWeight: '800' },
  selectAction: { color: theme.accent, fontSize: 16, fontWeight: '700' },
  header: { alignItems: 'center', gap: theme.spacing(0.5), paddingBottom: theme.spacing(1.5) },
  headerLabel: { color: theme.textMuted, fontSize: 15, fontWeight: '600', marginTop: theme.spacing(1) },
  headerValue: { color: theme.text, fontSize: 44, fontWeight: '800', letterSpacing: -1, maxWidth: '100%' },
  headerSub: { color: theme.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'stretch', paddingVertical: theme.spacing(2) },
  action: { alignItems: 'center', gap: 6, width: 76 },
  actionCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: theme.border, backgroundColor: theme.surface },
  actionCircleOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  actionLabel: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  filterNote: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch', paddingTop: theme.spacing(1) },
  filterText: { color: theme.textMuted, fontSize: 12 },
  clear: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  list: { paddingHorizontal: PAD, paddingBottom: theme.spacing(12) },
  gridRow: { gap: GAP, marginBottom: GAP },
  card: { borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.background, padding: 12, gap: 3 },
  cardSelected: { borderColor: theme.accent, borderWidth: 2 },
  cardImage: { alignItems: 'center', marginBottom: theme.spacing(0.75) },
  cardName: { color: theme.text, fontSize: 16, fontWeight: '700', lineHeight: 21, minHeight: 42 },
  cardMeta: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
  cardCondition: { color: theme.accent, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  cardFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: theme.spacing(1) },
  cardQty: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  cardPriceBox: { alignItems: 'flex-end', flexShrink: 1 },
  cardPrice: { color: theme.text, fontSize: 18, fontWeight: '800' },
  cardTotal: { color: theme.textMuted, fontSize: 11 },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5), borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: theme.spacing(1) },
  rowMain: { flex: 1, gap: 2 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  mark: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.textMuted, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  markInline: {},
  markOverlay: { position: 'absolute', top: 6, left: 6 },
  markOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  markText: { color: theme.onAccent, fontSize: 14, fontWeight: '800', lineHeight: 16 },
  empty: { alignItems: 'center', gap: theme.spacing(1), paddingTop: theme.spacing(4) },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '800' },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: 'center' },
  emptyButton: { marginTop: theme.spacing(1), height: 48, paddingHorizontal: theme.spacing(3), borderRadius: theme.radius, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' },
  emptyButtonText: { color: theme.onAccent, fontSize: 15, fontWeight: '800' },
  deleteBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: PAD, backgroundColor: theme.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  deleteButton: { height: 52, borderRadius: theme.radius, backgroundColor: theme.low, flexDirection: 'row', gap: theme.spacing(1), alignItems: 'center', justifyContent: 'center' },
  deleteDisabled: { opacity: 0.4 },
  deleteText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.surfaceAlt, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: PAD, paddingBottom: theme.spacing(3), maxHeight: '80%' },
  sheetTitle: { color: theme.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: theme.spacing(0.5) },
  sheetGap: { marginTop: theme.spacing(2) },
  sheetRow: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetText: { color: theme.text, fontSize: 16 },
  sheetSelected: { color: theme.accent, fontWeight: '700' },
  sheetTick: { color: theme.accent, fontSize: 18, fontWeight: '700' },
  sheetDone: { height: 52, borderRadius: theme.radius, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', marginTop: theme.spacing(2) },
  sheetDoneText: { color: theme.onAccent, fontSize: 15, fontWeight: '800' },
});
