/** App shell: three tabs, one shared scan service. */
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { StoredRates, fetchRates, loadRates, ratesAreStale } from './src/data/currency';
import { openDatabase } from './src/data/db';
import { crumb } from './src/debug/breadcrumbs';
import { warmUpKerching } from './src/feedback/kerching';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { loadIndexPack } from './src/data/indexPack';
import { Settings, loadSettings, saveSettings } from './src/data/settings';
import { fetchManifest, localVersion, syncGame } from './src/data/sync';
import { ScanResult, ScanService } from './src/scan/scanService';
import { readSerial } from './src/scan/serialOcr';
import { CollectionScreen } from './src/ui/CollectionScreen';
import { CurrencyProvider } from './src/ui/CurrencyContext';
import { ResultSheet } from './src/ui/ResultSheet';
import { ScanScreen } from './src/ui/ScanScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { theme } from './src/ui/theme';

type Tab = 'scan' | 'collection' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: number }> = [
  { id: 'scan', label: 'Scan', icon: require('./assets/tabs/scan.png') },
  { id: 'collection', label: 'Collection', icon: require('./assets/tabs/collection.png') },
  { id: 'settings', label: 'Settings', icon: require('./assets/tabs/settings.png') },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [result, setResult] = useState<ScanResult | null>(null);
  const [collectionKey, setCollectionKey] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Exchange rates for showing prices in the chosen currency; refreshed in the
  // background when the saved ones are old, and never blocking anything.
  const [rates, setRates] = useState<StoredRates>(() => loadRates());

  const service = useMemo(
    () =>
      new ScanService({
        gameId: settings.gameId,
        framesPerScan: 3,
        // The printed serial (One Piece's OP17-070) is read on-device and checked
        // first; each step is logged so a failed read shows up in the scan log.
        serialReader: (game, frame, corners) => readSerial(game, frame, corners, (message) => crumb(message)),
      }),
    [],
  );

  useEffect(() => {
    void openDatabase();
    warmUpKerching();
  }, []);

  useEffect(() => {
    if (!ratesAreStale(rates)) return;
    void fetchRates().then((fresh) => {
      if (fresh) setRates(fresh);
    });
    // Only on launch: a failed fetch must not retry in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <CurrencyProvider currency={settings.currency} rates={rates.rates}>
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
              autoScan={settings.autoScan}
              autoAdd={settings.autoAddHighConfidence}
              sound={settings.soundEffects}
              onAdded={() => setCollectionKey((key) => key + 1)}
              onAutoScanChange={(autoScan) => {
                const next = { ...settings, autoScan };
                setSettings(next);
                saveSettings(next);
              }}
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
          {TABS.map((entry) => {
            const active = tab === entry.id;
            return (
              <Pressable
                key={entry.id}
                style={styles.tab}
                onPress={() => setTab(entry.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Image source={entry.icon} style={[styles.tabIcon, { tintColor: active ? theme.accent : theme.textMuted }]} />
                <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                  {entry.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <ResultSheet
          result={result}
          onClose={() => setResult(null)}
          onAdded={() => setCollectionKey((key) => key + 1)}
        />
      </View>
      </CurrencyProvider>
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
    paddingTop: theme.spacing(1),
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabIcon: { width: 24, height: 24 },
  tabText: { color: theme.textMuted, fontSize: 11, fontWeight: '700' },
  tabTextActive: { color: theme.accent },
});
