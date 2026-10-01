/**
 * The small popup under the scan button when a card was added on its own:
 * what was scanned, what it is worth, and Undo in case it was wrong.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { bestPrice, formatMoney } from '../collection/organise';
import { convertAmount } from '../data/currency';
import { Printing } from '../data/types';
import { pricesFor } from '../data/db';
import { CardImage } from './CardImage';
import { useCurrency } from './CurrencyContext';
import { theme } from './theme';

export const TOAST_MS = 4500;

export interface AddedCard {
  printing: Printing;
  /** How many of it are now in the collection (this one included). */
  owned: number;
}

export function AddedToast({
  added,
  onUndo,
  onDismiss,
}: {
  added: AddedCard;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { currency, rates } = useCurrency();
  const [price, setPrice] = useState<{ value: number; currency: string } | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    let cancelled = false;
    setPrice(null);
    void pricesFor(added.printing.id).then((prices) => {
      if (!cancelled) setPrice(bestPrice(prices));
    });
    return () => {
      cancelled = true;
    };
  }, [added]);

  // Go away by itself; a new card restarts the timer (the `added` object is new each time).
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [added]);

  const { printing } = added;
  return (
    <View style={styles.toast} accessibilityLiveRegion="polite">
      <CardImage uri={printing.imageUrl} width={38} label={printing.name} />
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          ✓ Added · {printing.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {printing.setCode} {printing.number}
          {added.owned > 1 ? ` · you now own ${added.owned}` : ''}
        </Text>
      </View>
      <Text style={styles.price}>
        {price ? formatMoney(convertAmount(price.value, price.currency, currency, rates), currency) : ''}
      </Text>
      <Pressable onPress={onUndo} hitSlop={10} accessibilityRole="button" accessibilityLabel="Undo add">
        <Text style={styles.undo}>Undo</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.25),
    alignSelf: 'stretch',
    backgroundColor: 'rgba(20,26,35,0.96)',
    borderColor: theme.high,
    borderWidth: 1,
    borderRadius: theme.radius,
    paddingHorizontal: theme.spacing(1.25),
    paddingVertical: theme.spacing(0.75),
  },
  main: { flex: 1 },
  title: { color: theme.text, fontSize: 14, fontWeight: '700' },
  meta: { color: theme.textMuted, fontSize: 12 },
  price: { color: theme.high, fontSize: 16, fontWeight: '800' },
  undo: { color: theme.accent, fontSize: 14, fontWeight: '700' },
});
