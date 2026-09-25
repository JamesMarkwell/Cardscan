/**
 * Camera screen: live auto-scan, no shutter button.
 *
 * The camera keeps taking small photos; the pipeline decides which ones are
 * worth embedding. The overlay explains what it is waiting for rather than
 * leaving the user guessing.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { GAMES, GameId } from '../data/types';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Idle gap between scan frames, so the JS thread is free for touches in between.
const FRAME_GAP_MS = 450;

const STATUS_TEXT: Record<string, string> = {
  'no-card': 'Point at a card',
  'bad-quad': 'Show all four corners',
  'too-small': 'Move closer',
  blurry: 'Hold still — focusing',
  moving: 'Hold still',
  steadying: 'Hold still',
};

interface Props {
  service: ScanService;
  gameId: GameId;
  onGameChange: (gameId: GameId) => void;
  onResult: (result: ScanResult) => void;
  indexReady: boolean;
  syncing?: boolean;
  /** Stop the scan loop while something else is on top (e.g. the result sheet). */
  paused?: boolean;
}

export function ScanScreen({ service, gameId, onGameChange, onResult, indexReady, syncing, paused }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const camera = useRef<CameraView | null>(null);
  const looping = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    service
      .load()
      .then(() => {
        if (!cancelled) {
          setModelsReady(true);
          setStatus('Point at a card');
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setStatus(`Could not load models: ${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const tick = useCallback(async () => {
    if (!camera.current || looping.current) return;
    looping.current = true;

    try {
      const photo = await camera.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: true,
        shutterSound: false,
      });
      if (!photo?.uri || !mounted.current) return;

      const { result, status: next } = await service.offerPhoto(photo.uri);
      if (!mounted.current) return;

      if (result) {
        await Haptics.notificationAsync(
          result.confidence.tier === 'high'
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
        onResult(result);
        setStatus('Point at a card');
      } else {
        setStatus(STATUS_TEXT[next] ?? next);
      }
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      looping.current = false;
    }
  }, [onResult, service]);

  useEffect(() => {
    if (!modelsReady || !permission?.granted || busy || paused) return undefined;

    // Each scan frame does heavy synchronous work on the JS thread (JPEG decode,
    // resize, tensor packing, sharpness) — the same thread React Native uses to
    // dispatch touches. A fixed gap alone is not enough: the next frame is still
    // scheduled unconditionally, so a tab-bar tap that lands while a frame runs
    // (or just as the next starts) is starved out, and the tabs feel dead.
    //
    // So after the gap we hand off to InteractionManager, which holds the frame
    // back until RN has finished any pending touches/gestures. A tab tap always
    // wins the thread first; the frame runs only once the UI is idle again.
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let handle: ReturnType<typeof InteractionManager.runAfterInteractions> | undefined;

    const schedule = () => {
      timer = setTimeout(() => {
        handle = InteractionManager.runAfterInteractions(async () => {
          if (!active) return;
          await tick();
          if (active) schedule();
        });
      }, FRAME_GAP_MS);
    };

    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
      handle?.cancel();
    };
  }, [busy, modelsReady, permission?.granted, paused, tick]);

  if (!permission) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centred}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>CardScan identifies cards from the camera. Nothing leaves your phone.</Text>
        <Pressable style={styles.button} onPress={() => void requestPermission()}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" autofocus="on" />

      <View pointerEvents="none" style={styles.frameGuide} />

      <View style={styles.gameRow}>
        {GAMES.map((game) => (
          <Pressable
            key={game.id}
            onPress={() => {
              onGameChange(game.id);
              setBusy(false);
            }}
            style={[styles.gameChip, game.id === gameId && styles.gameChipActive]}
          >
            <Text style={[styles.gameChipText, game.id === gameId && styles.gameChipTextActive]}>
              {game.name}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.statusBar}>
        {!modelsReady ? <ActivityIndicator color={theme.accent} /> : null}
        <Text style={styles.statusText}>{status}</Text>
        {syncing ? (
          <Text style={styles.warning}>Updating catalogue…</Text>
        ) : !indexReady ? (
          <Text style={styles.warning}>No card index yet — it downloads on first sync.</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing(3),
    backgroundColor: theme.background,
    gap: theme.spacing(1.5),
  },
  title: { color: theme.text, fontSize: 20, fontWeight: '600' },
  body: { color: theme.textMuted, textAlign: 'center' },
  button: {
    backgroundColor: theme.accent,
    paddingHorizontal: theme.spacing(3),
    paddingVertical: theme.spacing(1.5),
    borderRadius: theme.radius,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  frameGuide: {
    position: 'absolute',
    left: '10%',
    right: '10%',
    top: '18%',
    bottom: '26%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.45)',
    borderRadius: 16,
  },
  gameRow: {
    position: 'absolute',
    top: theme.spacing(7),
    left: 0,
    right: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.spacing(1),
    paddingHorizontal: theme.spacing(2),
  },
  gameChip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
    borderRadius: 999,
    backgroundColor: 'rgba(11,14,20,0.75)',
    borderWidth: 1,
    borderColor: theme.border,
  },
  gameChipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  gameChipText: { color: theme.textMuted, fontSize: 12 },
  gameChipTextActive: { color: '#fff', fontWeight: '600' },
  statusBar: {
    position: 'absolute',
    bottom: theme.spacing(4),
    left: theme.spacing(2),
    right: theme.spacing(2),
    alignItems: 'center',
    gap: theme.spacing(0.5),
    backgroundColor: 'rgba(11,14,20,0.8)',
    borderRadius: theme.radius,
    padding: theme.spacing(1.5),
  },
  statusText: { color: theme.text, fontSize: 15 },
  warning: { color: theme.check, fontSize: 12, textAlign: 'center' },
});
