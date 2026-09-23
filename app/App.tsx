/** App shell: three tabs, one shared scan service. */
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { openDatabase } from './src/data/db';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { loadIndexPack } from './src/data/indexPack';
import { Settings, loadSettings } from './src/data/settings';
import { fetchManifest, localVersion, syncGame } from './src/data/sync';
import { ScanResult, ScanService } from './src/scan/scanService';
import { CollectionScreen } from './src/ui/CollectionScreen';
import { ResultSheet } from './src/ui/ResultSheet';
import { ScanScreen } from './src/ui/ScanScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { theme } from './src/ui/theme';

type Tab = 'scan' | 'collection' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'scan', label: 'Scan' },
  { id: 'collection', label: 'Collection' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [result, setResult] = useState<ScanResult | null>(null);
  const [collectionKey, setCollectionKey] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const service = useMemo(() => new ScanService({ gameId: settings.gameId, framesPerScan: 3 }), []);

  useEffect(() => {
    void openDatabase();
  }, []);

  // Auto-sync from the baked-in (or saved) catalog URL, so the catalogue loads
  // without anyone opening Settings. syncGame no-ops when already up to date, so
  // this is cheap on later launches; a failure (offline, not deployed yet) just
  // leaves whatever is already on device.
  useEffect(() => {
    const base = settings.apiBaseUrl?.trim();
    if (!base) return undefined;

    let cancelled = false;
    (async () => {
      setSyncing(true);
      try {
        const manifest = await fetchManifest(base);
        const game = manifest.games.find((entry) => entry.game === settings.gameId);
        if (!game) return;
        const changed = await syncGame(base, game);
        if (changed && !cancelled) setCollectionKey((key) => key + 1);
      } catch {
        // Offline, or the Worker is not deployed yet — keep any existing data.
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settings.apiBaseUrl, settings.gameId]);

  // Load the fingerprint index for whichever game is selected.
  useEffect(() => {
    let cancelled = false;
    service.setGame(settings.gameId);

    (async () => {
      const version = await localVersion(settings.gameId);
      if (!version) {
        if (!cancelled) {
          service.pipeline.setIndex(null);
          setIndexReady(false);
        }
        return;
      }
      const pack = await loadIndexPack(settings.gameId, version);
      if (cancelled) return;
      service.pipeline.setIndex(pack);
      setIndexReady(pack !== null);
    })().catch(() => setIndexReady(false));

    return () => {
      cancelled = true;
    };
  }, [service, settings.gameId, collectionKey]);

  return (
    <ErrorBoundary>
      <View style={styles.container}>
        <StatusBar style="light" />

        <View style={styles.screen}>
          {tab === 'scan' ? (
            <ScanScreen
              service={service}
              gameId={settings.gameId}
              indexReady={indexReady}
              syncing={syncing}
              paused={result !== null}
              onGameChange={(gameId) => setSettings((current) => ({ ...current, gameId }))}
              onResult={setResult}
            />
          ) : null}
          {tab === 'collection' ? <CollectionScreen reloadKey={collectionKey} /> : null}
          {tab === 'settings' ? (
            <SettingsScreen
              settings={settings}
              onChange={setSettings}
              onSynced={() => setCollectionKey((key) => key + 1)}
            />
          ) : null}
        </View>

        <View style={styles.tabBar}>
          {TABS.map((entry) => (
            <Pressable key={entry.id} style={styles.tab} onPress={() => setTab(entry.id)}>
              <Text style={[styles.tabText, tab === entry.id && styles.tabTextActive]}>{entry.label}</Text>
            </Pressable>
          ))}
        </View>

        <ResultSheet
          result={result}
          onClose={() => setResult(null)}
          onAdded={() => setCollectionKey((key) => key + 1)}
        />
      </View>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  screen: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    paddingBottom: theme.spacing(3),
    paddingTop: theme.spacing(1.5),
  },
  tab: { flex: 1, alignItems: 'center' },
  tabText: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: theme.accent },
});
