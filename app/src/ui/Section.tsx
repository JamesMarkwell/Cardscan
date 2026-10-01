/** Building blocks for the settings-style screens: a titled card, and rows inside it. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/** A row in a Section: a label (and optional hint) on the left, a control on the right. */
export function Row({
  label,
  hint,
  children,
  last,
}: {
  label: string;
  hint?: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: theme.spacing(1) },
  title: { color: theme.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, paddingLeft: 4 },
  card: { backgroundColor: theme.surface, borderRadius: theme.radius, padding: theme.spacing(2), gap: theme.spacing(1.5) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2), minHeight: 40 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, paddingBottom: theme.spacing(1.5) },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: theme.text, fontSize: 15 },
  rowHint: { color: theme.textMuted, fontSize: 12, lineHeight: 16 },
});
