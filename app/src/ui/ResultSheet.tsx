/**
 * What the scan found.
 *
 * A high-confidence match is one tap to add. Anything less shows its
 * alternatives, because a wrong card added silently costs more than a tap.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { addToCollection, defaultPortfolio, pricesFor, recordCorrection } from '../data/db';
import { Condition, Price, Printing, Variant } from '../data/types';
import { ScanResult } from '../scan/scanService';
import { theme, tierColour, tierLabel } from './theme';

const VARIANTS: Variant[] = ['normal', 'foil', 'reverse', 'first_edition'];
const VARIANT_LABEL: Record<Variant, string> = {
  normal: 'Normal',
  foil: 'Foil',
  reverse: 'Reverse',
  first_edition: '1st ed.',
};
const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

interface Props {
  result: ScanResult | null;
  onClose: () => void;
  onAdded: () => void;
}

function formatPrice(price: Price): string {
  const value = price.market ?? price.trend ?? price.low;
  if (value === null || value === undefined) return '—';
  const symbol = price.currency === 'GBP' ? '£' : price.currency === 'EUR' ? '€' : '$';
  return `${symbol}${value.toFixed(2)}`;
}

export function ResultSheet({ result, onClose, onAdded }: Props) {
  const [selected, setSelected] = useState<Printing | null>(null);
  const [variant, setVariant] = useState<Variant>('normal');
  const [condition, setCondition] = useState<Condition>('NM');
  const [prices, setPrices] = useState<Price[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(result?.printing ?? null);
    setVariant(result?.printing?.variant ?? 'normal');
    setCondition('NM');
  }, [result]);

  useEffect(() => {
    if (!selected) {
      setPrices([]);
      return;
    }
    void pricesFor(selected.id).then(setPrices);
  }, [selected]);

  if (!result) return null;

  const tier = result.confidence.tier;
  const alternatives = result.candidates.flatMap((candidate) => candidate.printings);

  const add = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const portfolio = await defaultPortfolio();
      await addToCollection({
        portfolioId: portfolio.id,
        printingId: selected.id,
        variant,
        condition,
        quantity: 1,
      });

      // A correction is the most valuable training signal there is, so keep it.
      if (result.printing && selected.id !== result.printing.id) {
        await recordCorrection(result.candidates[0]?.artId ?? null, selected.id, result.embedding);
      }
      onAdded();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={[styles.tierPill, { backgroundColor: tierColour[tier] }]}>
            <Text style={styles.tierText}>{tierLabel[tier]}</Text>
          </View>

          {selected ? (
            <>
              <Text style={styles.name}>{selected.name}</Text>
              <Text style={styles.meta}>
                {selected.setName} · {selected.setCode} {selected.number}
                {selected.setTotal ? `/${selected.setTotal}` : ''} · {selected.rarity ?? 'Unknown rarity'}
              </Text>
            </>
          ) : (
            <Text style={styles.name}>No match found</Text>
          )}

          <Text style={styles.reasons}>
            {Math.round(result.confidence.score * 100)}% · top score{' '}
            {result.confidence.topScore.toFixed(3)}
            {result.confidence.reasons.length ? ` · ${result.confidence.reasons.join(', ')}` : ''}
          </Text>

          {prices.length > 0 ? (
            <View style={styles.priceRow}>
              {prices.map((price) => (
                <View key={price.source} style={styles.priceCard}>
                  <Text style={styles.priceValue}>{formatPrice(price)}</Text>
                  <Text style={styles.priceSource}>
                    {price.source === 'cardmarket' ? 'Cardmarket' : 'TCGplayer'} · {price.asOf.slice(0, 10)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.reasons}>No price on file yet.</Text>
          )}

          <Text style={styles.sectionLabel}>Variant</Text>
          <View style={styles.chipRow}>
            {VARIANTS.map((value) => (
              <Pressable
                key={value}
                onPress={() => setVariant(value)}
                style={[styles.chip, variant === value && styles.chipActive]}
              >
                <Text style={[styles.chipText, variant === value && styles.chipTextActive]}>
                  {VARIANT_LABEL[value]}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Condition</Text>
          <View style={styles.chipRow}>
            {CONDITIONS.map((value) => (
              <Pressable
                key={value}
                onPress={() => setCondition(value)}
                style={[styles.chip, condition === value && styles.chipActive]}
              >
                <Text style={[styles.chipText, condition === value && styles.chipTextActive]}>{value}</Text>
              </Pressable>
            ))}
          </View>

          {(tier !== 'high' || alternatives.length > 1) && alternatives.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>Other candidates</Text>
              <ScrollView style={styles.alternatives} contentContainerStyle={styles.alternativesContent}>
                {alternatives.slice(0, 10).map((printing) => (
                  <Pressable
                    key={printing.id}
                    onPress={() => setSelected(printing)}
                    style={[styles.alternative, selected?.id === printing.id && styles.alternativeActive]}
                  >
                    <Text style={styles.alternativeName}>{printing.name}</Text>
                    <Text style={styles.alternativeMeta}>
                      {printing.setCode} {printing.number} · {printing.setName}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : null}

          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.secondary]} onPress={onClose}>
              <Text style={styles.secondaryText}>Discard</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.primary, (!selected || saving) && styles.disabled]}
              disabled={!selected || saving}
              onPress={() => void add()}
            >
              <Text style={styles.primaryText}>{saving ? 'Adding…' : 'Add to collection'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: theme.spacing(2.5),
    gap: theme.spacing(1),
    maxHeight: '90%',
  },
  tierPill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  tierText: { color: '#08121C', fontWeight: '700', fontSize: 12 },
  name: { color: theme.text, fontSize: 22, fontWeight: '700' },
  meta: { color: theme.textMuted, fontSize: 14 },
  reasons: { color: theme.textMuted, fontSize: 12 },
  sectionLabel: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase', marginTop: theme.spacing(1) },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(1) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textMuted, fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  priceRow: { flexDirection: 'row', gap: theme.spacing(1) },
  priceCard: { flex: 1, backgroundColor: theme.surface, borderRadius: theme.radius, padding: theme.spacing(1.5) },
  priceValue: { color: theme.text, fontSize: 18, fontWeight: '700' },
  priceSource: { color: theme.textMuted, fontSize: 11 },
  alternatives: { maxHeight: 180 },
  alternativesContent: { gap: theme.spacing(0.75) },
  alternative: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(1.25),
    borderWidth: 1,
    borderColor: 'transparent',
  },
  alternativeActive: { borderColor: theme.accent },
  alternativeName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  alternativeMeta: { color: theme.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  button: { flex: 1, paddingVertical: theme.spacing(1.5), borderRadius: theme.radius, alignItems: 'center' },
  primary: { backgroundColor: theme.accent },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: { backgroundColor: theme.surfaceAlt },
  secondaryText: { color: theme.textMuted, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
