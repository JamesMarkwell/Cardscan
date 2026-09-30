/** One collection row in full: the picture, what it is worth, and edit / remove. */
import React from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../collection/organise';
import { CollectionRow } from '../data/db';
import { Condition, Variant } from '../data/types';
import { CardImage } from './CardImage';
import { Chips } from './Chips';
import { topInset } from './layout';
import { theme } from './theme';

const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const VARIANTS: Array<{ key: Variant; label: string }> = [
  { key: 'normal', label: 'Normal' },
  { key: 'foil', label: 'Foil' },
  { key: 'reverse', label: 'Reverse holo' },
  { key: 'first_edition', label: '1st edition' },
];

export function CardDetailModal({
  row,
  onClose,
  onChange,
  onRemove,
}: {
  row: CollectionRow | null;
  onClose: () => void;
  onChange: (changes: { quantity?: number; condition?: Condition; variant?: Variant }) => void;
  onRemove: () => void;
}) {
  if (!row) return null;
  const { printing } = row;

  const confirmRemove = () =>
    Alert.alert('Remove from collection?', `${printing.name} ×${row.quantity} will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: onRemove },
    ]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
            <Text style={styles.closeText}>‹ Back</Text>
          </Pressable>

          <View style={styles.hero}>
            <CardImage uri={printing.imageUrl} width={200} label={printing.name} />
          </View>

          <Text style={styles.name}>{printing.name}</Text>
          <Text style={styles.meta}>
            {printing.setName} · {printing.setCode} {printing.number}
            {printing.rarity ? ` · ${printing.rarity}` : ''}
          </Text>

          <View style={styles.priceRow}>
            <View>
              <Text style={styles.priceValue}>{formatMoney(row.market, row.currency)}</Text>
              <Text style={styles.label}>each</Text>
            </View>
            <View style={styles.right}>
              <Text style={styles.priceValue}>
                {row.market === null ? '—' : formatMoney(row.market * row.quantity, row.currency)}
              </Text>
              <Text style={styles.label}>total for {row.quantity}</Text>
            </View>
          </View>

          <Text style={styles.section}>Quantity</Text>
          <View style={styles.stepper}>
            <Pressable
              style={[styles.stepButton, row.quantity <= 1 && styles.stepDisabled]}
              disabled={row.quantity <= 1}
              onPress={() => onChange({ quantity: row.quantity - 1 })}
              accessibilityLabel="One fewer"
            >
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={styles.quantity}>{row.quantity}</Text>
            <Pressable
              style={styles.stepButton}
              onPress={() => onChange({ quantity: row.quantity + 1 })}
              accessibilityLabel="One more"
            >
              <Text style={styles.stepText}>+</Text>
            </Pressable>
          </View>

          <Text style={styles.section}>Condition</Text>
          <Chips
            options={CONDITIONS.map((key) => ({ key, label: key }))}
            value={row.condition}
            onChange={(condition) => condition && onChange({ condition })}
          />

          <Text style={styles.section}>Version</Text>
          <Chips
            options={VARIANTS}
            value={row.variant}
            onChange={(variant) => variant && onChange({ variant })}
          />

          <Pressable style={styles.remove} onPress={confirmRemove} accessibilityRole="button">
            <Text style={styles.removeText}>Remove from collection</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: theme.spacing(2.5), paddingTop: topInset + theme.spacing(1), gap: theme.spacing(1) },
  close: { alignSelf: 'flex-start', paddingVertical: theme.spacing(1) },
  closeText: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  hero: { alignItems: 'center', marginVertical: theme.spacing(1.5) },
  name: { color: theme.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  meta: { color: theme.textMuted, fontSize: 13, textAlign: 'center' },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(2),
    marginTop: theme.spacing(1.5),
  },
  right: { alignItems: 'flex-end' },
  priceValue: { color: theme.text, fontSize: 22, fontWeight: '700' },
  label: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase' },
  section: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase', marginTop: theme.spacing(2) },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDisabled: { opacity: 0.35 },
  stepText: { color: theme.text, fontSize: 24, fontWeight: '600' },
  quantity: { color: theme.text, fontSize: 24, fontWeight: '700', minWidth: 32, textAlign: 'center' },
  remove: {
    marginTop: theme.spacing(4),
    borderWidth: 1,
    borderColor: theme.low,
    borderRadius: theme.radius,
    padding: theme.spacing(1.75),
    alignItems: 'center',
  },
  removeText: { color: theme.low, fontSize: 15, fontWeight: '700' },
});
