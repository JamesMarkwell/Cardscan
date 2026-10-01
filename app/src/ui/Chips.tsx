/** A row of tappable options that scrolls sideways; one (or none) is selected. */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { theme } from './theme';

export const CHIP_HEIGHT = 36;

export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: T | null; label: string }>;
  value: T | null;
  onChange: (key: T | null) => void;
}) {
  return (
    // A horizontal ScrollView grows to fill a column's spare height by default,
    // which stretched the chips into tall pills. Pin it to the chips' own height.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key ?? 'all'}
            onPress={() => onChange(option.key)}
            style={[styles.chip, selected && styles.chipSelected]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.text, selected && styles.textSelected]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 0, height: CHIP_HEIGHT + 8 },
  row: { alignItems: 'center', gap: theme.spacing(1), paddingVertical: 4, paddingRight: theme.spacing(2) },
  chip: {
    height: CHIP_HEIGHT,
    paddingHorizontal: theme.spacing(1.75),
    borderRadius: CHIP_HEIGHT / 2,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
  text: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  textSelected: { color: theme.onAccent, fontWeight: '700' },
});
