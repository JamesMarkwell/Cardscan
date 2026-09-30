/** The game being scanned: one compact pill that opens a list, so it can never overflow the screen. */
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GAMES, GameId } from '../data/types';
import { theme } from './theme';

export function GamePicker({ gameId, onChange }: { gameId: GameId; onChange: (id: GameId) => void }) {
  const [open, setOpen] = useState(false);
  const current = GAMES.find((game) => game.id === gameId);

  return (
    <>
      <Pressable style={styles.pill} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Choose game">
        <Text style={styles.pillText} numberOfLines={1}>
          {current?.name ?? 'Choose a game'}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Scan cards from</Text>
            {GAMES.map((game) => {
              const selected = game.id === gameId;
              return (
                <Pressable
                  key={game.id}
                  style={styles.option}
                  onPress={() => {
                    onChange(game.id);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.optionText, selected && styles.optionSelected]}>{game.name}</Text>
                  {selected ? <Text style={styles.tick}>✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1),
    height: 40,
    paddingHorizontal: theme.spacing(2),
    borderRadius: 20,
    backgroundColor: 'rgba(18,19,22,0.82)',
    borderWidth: 1,
    borderColor: theme.border,
  },
  pillText: { color: theme.text, fontSize: 14, fontWeight: '700' },
  chevron: { color: theme.accent, fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surfaceAlt,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: theme.spacing(2),
    paddingBottom: theme.spacing(4),
  },
  sheetTitle: { color: theme.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: theme.spacing(0.5) },
  option: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionText: { color: theme.text, fontSize: 16 },
  optionSelected: { color: theme.accent, fontWeight: '700' },
  tick: { color: theme.accent, fontSize: 18, fontWeight: '700' },
});
