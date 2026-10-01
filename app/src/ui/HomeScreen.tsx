/** The overview: what the collection is worth, where it is, the best cards and the newest. */
import React, { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatMoney, mostValuable, recentlyAdded, rowValue, summarise, valueByGame } from '../collection/organise';
import { CollectionRow } from '../data/db';
import { GAMES } from '../data/types';
import { CardImage } from './CardImage';
import { Icon } from './Icon';
import { topInset } from './layout';
import { Section } from './Section';
import { BrandHeader } from './BrandHeader';
import { gameColour, theme } from './theme';
import { useCollection } from './useCollection';

const GAME_NAME = Object.fromEntries(GAMES.map((game) => [game.id, game.name])) as Record<string, string>;

function describe(row: CollectionRow): string {
  const parts: string[] = [row.condition];
  if (row.variant !== 'normal') parts.push(row.variant.replace('_', ' '));
  return parts.join(' • ');
}

export function HomeScreen({
  reloadKey,
  onViewAll,
  onScan,
}: {
  reloadKey: number;
  onViewAll: () => void;
  onScan: () => void;
}) {
  const { rows, refreshing, reload } = useCollection(reloadKey);
  const summary = useMemo(() => summarise(rows), [rows]);
  const games = useMemo(() => valueByGame(rows), [rows]);
  const best = useMemo(() => mostValuable(rows, 5), [rows]);
  const recent = useMemo(() => recentlyAdded(rows, 8), [rows]);
  const totalForBar = games.reduce((total, game) => total + game.value, 0);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload()} tintColor={theme.accent} />}
    >
      <BrandHeader />

      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Portfolio value</Text>
        <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>
          {formatMoney(summary.value, summary.currency)}
        </Text>
        <Text style={styles.heroSub}>
          {summary.cards} {summary.cards === 1 ? 'card' : 'cards'} · {summary.unique} unique
          {summary.unpriced > 0 ? ` · ${summary.unpriced} without a price` : ''}
        </Text>
      </View>

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="scan" size={40} color={theme.accent} />
          <Text style={styles.emptyTitle}>Your collection is empty</Text>
          <Text style={styles.emptyText}>Scan a card and it will be added, with its price, straight away.</Text>
          <Pressable style={styles.primary} onPress={onScan} accessibilityRole="button">
            <Text style={styles.primaryText}>Scan your first card</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Section title="Value by game">
            {totalForBar > 0 ? (
              <View style={styles.bar}>
                {games.map((game) => (
                  <View key={game.gameId} style={{ flex: Math.max(game.value, 0.0001), backgroundColor: gameColour[game.gameId] ?? theme.accent }} />
                ))}
              </View>
            ) : null}
            {games.map((game) => (
              <View key={game.gameId} style={styles.gameRow}>
                <View style={[styles.dot, { backgroundColor: gameColour[game.gameId] ?? theme.accent }]} />
                <View style={styles.gameText}>
                  <Text style={styles.gameName} numberOfLines={1}>
                    {GAME_NAME[game.gameId] ?? game.gameId}
                  </Text>
                  <Text style={styles.muted}>
                    {game.cards} {game.cards === 1 ? 'card' : 'cards'}
                  </Text>
                </View>
                <Text style={styles.gameValue}>{formatMoney(game.value, summary.currency)}</Text>
              </View>
            ))}
          </Section>

          <Section title="Most valuable">
            {best.length === 0 ? (
              <Text style={styles.muted}>No prices yet — they appear after the catalogue syncs.</Text>
            ) : (
              best.map((row) => (
                <View key={row.id} style={styles.valueRow}>
                  <CardImage uri={row.printing.imageUrl} width={40} label={row.printing.name} />
                  <View style={styles.valueText}>
                    <Text style={styles.valueName} numberOfLines={1}>
                      {row.printing.name}
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      {describe(row)}
                      {row.quantity > 1 ? ` • ×${row.quantity}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.valuePrice}>{formatMoney(rowValue(row), row.currency)}</Text>
                </View>
              ))
            )}
            <Pressable onPress={onViewAll} style={styles.viewAll} accessibilityRole="button">
              <Text style={styles.viewAllText}>View all</Text>
            </Pressable>
          </Section>

          <View style={styles.recentHeader}>
            <Text style={styles.recentTitle}>Recently added</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recentScroll} contentContainerStyle={styles.recentRow}>
            {recent.map((row) => (
              <View key={row.id} style={styles.recentCard}>
                <CardImage uri={row.printing.imageUrl} width={112} label={row.printing.name} />
                <Text style={styles.recentName} numberOfLines={2}>
                  {row.printing.name}
                </Text>
                <Text style={styles.recentPrice}>{formatMoney(row.market, row.currency)}</Text>
              </View>
            ))}
          </ScrollView>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: theme.spacing(2), paddingTop: topInset + theme.spacing(1.5), paddingBottom: theme.spacing(4), gap: theme.spacing(3) },
  hero: { alignItems: 'center', gap: 2, paddingVertical: theme.spacing(1) },
  heroLabel: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
  heroValue: { color: theme.text, fontSize: 48, fontWeight: '800', letterSpacing: -1, maxWidth: '100%' },
  heroSub: { color: theme.textMuted, fontSize: 13 },
  bar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 },
  gameRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) },
  dot: { width: 10, height: 10, borderRadius: 5 },
  gameText: { flex: 1 },
  gameName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  gameValue: { color: theme.text, fontSize: 15, fontWeight: '700' },
  muted: { color: theme.textMuted, fontSize: 12 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) },
  valueText: { flex: 1, gap: 2 },
  valueName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  valuePrice: { color: theme.text, fontSize: 15, fontWeight: '700' },
  viewAll: { alignItems: 'center', paddingTop: theme.spacing(0.5) },
  viewAllText: { color: theme.accent, fontSize: 15, fontWeight: '700' },
  recentHeader: { marginBottom: -theme.spacing(1.5) },
  recentTitle: { color: theme.text, fontSize: 18, fontWeight: '800' },
  recentScroll: { flexGrow: 0, marginHorizontal: -theme.spacing(2) },
  recentRow: { paddingHorizontal: theme.spacing(2), gap: theme.spacing(1.5) },
  recentCard: { width: 112, gap: 4 },
  recentName: { color: theme.text, fontSize: 13, fontWeight: '600', minHeight: 34 },
  recentPrice: { color: theme.accent, fontSize: 14, fontWeight: '800' },
  empty: { alignItems: 'center', gap: theme.spacing(1.5), backgroundColor: theme.surface, borderRadius: theme.radius, padding: theme.spacing(3) },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '800' },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  primary: { alignSelf: 'stretch', height: 52, borderRadius: theme.radius, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', marginTop: theme.spacing(1) },
  primaryText: { color: theme.onAccent, fontSize: 16, fontWeight: '800' },
});
