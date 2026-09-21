/** Catalog sync, currency, and the open-source notices the AGPL requires. */
import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Settings, saveSettings } from '../data/settings';
import { GAMES } from '../data/types';
import { SyncProgress, fetchManifest, syncGame } from '../data/sync';
import { theme } from './theme';

const SOURCE_URL = 'https://github.com/JamesMarkwell/cardscan';

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onSynced: () => void;
}

export function SettingsScreen({ settings, onChange, onSynced }: Props) {
  const [baseUrl, setBaseUrl] = useState(settings.apiBaseUrl);
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    onChange(next);
  };

  const sync = async () => {
    if (!baseUrl.trim()) {
      setStatus('Set the catalog URL first.');
      return;
    }
    setSyncing(true);
    setStatus('Fetching manifest…');
    try {
      update({ apiBaseUrl: baseUrl.trim() });
      const manifest = await fetchManifest(baseUrl.trim());
      const game = manifest.games.find((entry) => entry.game === settings.gameId);
      if (!game) {
        setStatus(`No catalog published for ${settings.gameId} yet.`);
        return;
      }
      const report = (progress: SyncProgress) =>
        setStatus(`${progress.stage}${progress.ratio ? ` ${Math.round(progress.ratio * 100)}%` : ''}…`);
      const changed = await syncGame(baseUrl.trim(), game, report);
      setStatus(changed ? `Updated to ${game.version}.` : 'Already up to date.');
      onSynced();
    } catch (error) {
      setStatus(`Sync failed: ${(error as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Catalog</Text>
      <Text style={styles.label}>Catalog URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://cardscan-worker.example.workers.dev"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Game</Text>
      <View style={styles.chipRow}>
        {GAMES.map((game) => (
          <Pressable
            key={game.id}
            onPress={() => update({ gameId: game.id })}
            style={[styles.chip, settings.gameId === game.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, settings.gameId === game.id && styles.chipTextActive]}>
              {game.name}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.button, syncing && styles.disabled]} disabled={syncing} onPress={() => void sync()}>
        <Text style={styles.buttonText}>{syncing ? 'Syncing…' : 'Sync catalog now'}</Text>
      </Pressable>
      {status ? <Text style={styles.status}>{status}</Text> : null}

      <Text style={styles.heading}>Prices</Text>
      <View style={styles.chipRow}>
        {(['GBP', 'USD', 'EUR'] as const).map((currency) => (
          <Pressable
            key={currency}
            onPress={() => update({ currency })}
            style={[styles.chip, settings.currency === currency && styles.chipActive]}
          >
            <Text style={[styles.chipText, settings.currency === currency && styles.chipTextActive]}>
              {currency}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.note}>
        Prices come from Cardmarket and TCGplayer and are labelled with their source and date. A market
        price is an observed average, not a guaranteed sale price.
      </Text>

      <Text style={styles.heading}>Scanning</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Add high-confidence matches automatically</Text>
        <Switch
          value={settings.autoAddHighConfidence}
          onValueChange={(value) => update({ autoAddHighConfidence: value })}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Keep my corrections to improve matching</Text>
        <Switch value={settings.shareCorrections} onValueChange={(value) => update({ shareCorrections: value })} />
      </View>

      <Text style={styles.heading}>Open source</Text>
      <Text style={styles.note}>
        Card recognition uses CollectorVision (AGPL-3.0) — its Cornelius corner detector and Milo embedder
        are bundled unchanged. CardScan is licensed AGPL-3.0; the complete source is available.
      </Text>
      <Pressable onPress={() => void Linking.openURL(SOURCE_URL)}>
        <Text style={styles.link}>{SOURCE_URL}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: theme.spacing(2.5), paddingTop: theme.spacing(7), gap: theme.spacing(1) },
  heading: { color: theme.text, fontSize: 18, fontWeight: '700', marginTop: theme.spacing(2) },
  label: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase' },
  input: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    padding: theme.spacing(1.5),
  },
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
  button: {
    backgroundColor: theme.accent,
    borderRadius: theme.radius,
    paddingVertical: theme.spacing(1.5),
    alignItems: 'center',
    marginTop: theme.spacing(1),
  },
  buttonText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.5 },
  status: { color: theme.textMuted, fontSize: 12 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 18 },
  link: { color: theme.accent, fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing(2) },
  switchLabel: { color: theme.text, flex: 1, fontSize: 14 },
});
