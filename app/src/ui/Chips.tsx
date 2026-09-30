/** A row of tappable options; one (or none) is selected. */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { theme } from './theme';

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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
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
            <Text style={[styles.text, selected && styles.textSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: theme.spacing(1), paddingVertical: theme.spacing(0.5) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
  text: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  textSelected: { color: '#fff' },
});
