/** Catalog sync, currency, scanning options, and the open-source notices the AGPL requires. */
import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Settings, saveSettings } from '../data/settings';
import { GAMES } from '../data/types';
import { SyncProgress, fetchManifest, syncGame } from '../data/sync';
import { playKerching } from '../feedback/kerching';
import { BrandHeader } from './BrandHeader';
import { topInset } from './layout';
import { Row, Section } from './Section';
import { theme } from './theme';

const SOURCE_URL = 'https://github.com/JamesMarkwell/cardscan';
const CURRENCIES = ['GBP', 'USD', 'EUR'] as const;

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onSynced: () => void;
}

/** One option of a set, laid out to share the row evenly. */
function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.segment, active && styles.segmentActive]} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <BrandHeader subtitle="Settings" />

      <Section title="Prices">
        <Text style={styles.fieldLabel}>Show prices in</Text>
        <View style={styles.segments}>
          {CURRENCIES.map((currency) => (
            <Segment key={currency} label={currency} active={settings.currency === currency} onPress={() => update({ currency })} />
          ))}
        </View>
        <Text style={styles.note}>
          TCGplayer market prices (US dollars), converted at the latest exchange rate. A market price is an
          observed average, not a guaranteed sale price.
        </Text>
      </Section>

      <Section title="Scanning">
        <Row label="Add matches automatically" hint="High-confidence scans go straight into your collection, with an Undo.">
          <Switch
            value={settings.autoAddHighConfidence}
            onValueChange={(value) => update({ autoAddHighConfidence: value })}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor={theme.text}
          />
        </Row>
        <Row label="Kerching sound" hint="Played when a card is added.">
          <Pressable style={styles.smallButton} onPress={playKerching} accessibilityRole="button" accessibilityLabel="Play the sound">
            <Text style={styles.smallButtonText}>Test</Text>
          </Pressable>
          <Switch
            value={settings.soundEffects}
            onValueChange={(value) => update({ soundEffects: value })}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor={theme.text}
          />
        </Row>
        <Row label="Keep my corrections" hint="Saved on this phone to improve matching." last>
          <Switch
            value={settings.shareCorrections}
            onValueChange={(value) => update({ shareCorrections: value })}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor={theme.text}
          />
        </Row>
      </Section>

      <Section title="Catalogue">
        <Text style={styles.fieldLabel}>Game to sync</Text>
        <View style={styles.chipWrap}>
          {GAMES.map((game) => (
            <Pressable
              key={game.id}
              onPress={() => update({ gameId: game.id })}
              style={[styles.chip, settings.gameId === game.id && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: settings.gameId === game.id }}
            >
              <Text style={[styles.chipText, settings.gameId === game.id && styles.chipTextActive]} numberOfLines={1}>
                {game.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.fieldLabel}>Catalogue URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://cardscan-worker.example.workers.dev"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable style={[styles.button, syncing && styles.disabled]} disabled={syncing} onPress={() => void sync()} accessibilityRole="button">
          <Text style={styles.buttonText}>{syncing ? 'Syncing…' : 'Sync catalogue now'}</Text>
        </Pressable>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </Section>

      <Section title="Open source">
        <Text style={styles.note}>
          Card recognition uses CollectorVision (AGPL-3.0) — its Cornelius corner detector and Milo embedder
          are bundled unchanged. CardScan is licensed AGPL-3.0; the complete source is available.
        </Text>
        <Pressable onPress={() => void Linking.openURL(SOURCE_URL)} accessibilityRole="link">
          <Text style={styles.link} numberOfLines={1}>
            {SOURCE_URL}
          </Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: theme.spacing(2), paddingTop: topInset + theme.spacing(1.5), paddingBottom: theme.spacing(6), gap: theme.spacing(3) },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  segments: { flexDirection: 'row', backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 4, gap: 4 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: theme.spacing(1.25), borderRadius: 9 },
  segmentActive: { backgroundColor: theme.accent },
  segmentText: { color: theme.textMuted, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: theme.onAccent },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(1) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: theme.onAccent, fontWeight: '700' },
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 12,
    color: theme.text,
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1.25),
    fontSize: 14,
  },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: theme.spacing(1.5), alignItems: 'center' },
  buttonText: { color: theme.onAccent, fontWeight: '800', fontSize: 15 },
  smallButton: { backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(0.75) },
  smallButtonText: { color: theme.accent, fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  status: { color: theme.textMuted, fontSize: 12 },
  note: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  link: { color: theme.accent, fontSize: 13 },
});
