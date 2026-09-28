/**
 * Camera screen: live auto-scan, no shutter button.
 *
 * Uses react-native-vision-camera. The preview renders natively and streams
 * continuously (that is cheap and never touches the JS thread). Scanning is done
 * by capturing one still photo per cycle and running the existing pipeline on it,
 * rather than streaming every camera frame to the JS thread — a continuous frame
 * stream floods the JS thread (each frame marshals a whole buffer across the
 * thread boundary) and freezes the tab bar and game chips, which sit on that same
 * thread. One capture every ~second leaves the thread free between scans, and each
 * capture+identify pass is gated behind an idle window so taps always win first.
 */
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput, usePreviewOutput } from 'react-native-vision-camera';
import { GAMES, GameId } from '../data/types';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Idle gap between scan captures. A capture + identify pass briefly uses the JS
// thread (the JPEG decode and the pipeline); the gap, plus InteractionManager,
// guarantees the tab bar and chips get the thread between passes. The capture
// gate needs 3 steady frames to lock, so this barely changes time-to-scan.
const CAPTURE_GAP_MS = 700;
// Still-capture resolution. The pipeline downscales to its working width anyway,
// so a modest photo keeps the capture and decode fast.
const PHOTO_RESOLUTION = { width: 1280, height: 720 };

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
  /** Stop scanning while something else is on top (e.g. the result sheet). */
  paused?: boolean;
}

export function ScanScreen({ service, gameId, onGameChange, onResult, indexReady, syncing, paused }: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // The live preview only renders when a preview output is connected, and the
  // photo output is what lets us capture stills to scan.
  const previewOutput = usePreviewOutput();
  const photoOutput = usePhotoOutput({
    targetResolution: PHOTO_RESOLUTION,
    qualityPrioritization: 'balanced',
    quality: 0.7,
  });
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

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

  // Scanning needs the models loaded and a settled catalogue.
  const active = modelsReady && hasPermission && !paused && !syncing;
  // The Camera streams the preview whenever we have permission and no result
  // sheet is up. The preview does not need the models or the catalogue, so it
  // stays live during "Updating catalogue…" instead of showing black.
  const cameraActive = hasPermission && !paused;

  // Capture one still, identify it, then reschedule — but only after an idle gap
  // and once InteractionManager reports the UI is idle, so taps on the tab bar
  // and game chips are always serviced before the next capture.
  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let interaction: ReturnType<typeof InteractionManager.runAfterInteractions> | undefined;

    const scan = async () => {
      try {
        const file = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
        if (cancelled || !mounted.current) return;

        const { result, status: next } = await service.offerPhoto(`file://${file.filePath}`);
        if (cancelled || !mounted.current) return;

        if (result) {
          void Haptics.notificationAsync(
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
        if (!cancelled && mounted.current) setStatus((error as Error).message);
      } finally {
        if (!cancelled) schedule();
      }
    };

    const schedule = () => {
      timer = setTimeout(() => {
        interaction = InteractionManager.runAfterInteractions(() => {
          if (!cancelled) void scan();
        });
      }, CAPTURE_GAP_MS);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      interaction?.cancel();
    };
  }, [active, photoOutput, onResult, service]);

  if (!hasPermission) {
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

  if (device == null) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.body}>No camera found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={cameraActive}
        outputs={[previewOutput, photoOutput]}
      />

      <View pointerEvents="none" style={styles.frameGuide} />

      <View style={styles.gameRow}>
        {GAMES.map((game) => (
          <Pressable
            key={game.id}
            onPress={() => onGameChange(game.id)}
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
