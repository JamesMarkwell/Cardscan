/**
 * Camera screen: live preview with a manual shutter.
 *
 * Uses react-native-vision-camera. The preview renders natively and streams
 * continuously (cheap, off the JS thread). Scanning is manual: the user frames a
 * card and taps Scan, which captures one still and runs the identify pipeline on
 * it. Continuous live scanning streamed every camera frame to the JS thread and
 * froze the UI (the tab bar and chips live on that thread); a single capture on
 * demand does the heavy work once, so the rest of the UI stays responsive.
 */
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput, usePreviewOutput } from 'react-native-vision-camera';
import { GAMES, GameId } from '../data/types';
import { decodeJpegToRgba } from '../scan/capture';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Still-capture resolution. The pipeline downscales to its working width anyway,
// so a modest photo keeps the capture and decode fast.
const PHOTO_RESOLUTION = { width: 1280, height: 720 };

// What each pipeline rejection reason means for the person holding the phone.
const STATUS_TEXT: Record<string, string> = {
  'no-card': 'No card detected — line it up and tap Scan',
  'bad-quad': 'Show all four corners, then tap Scan',
  'too-small': 'Move closer, then tap Scan',
  blurry: 'Hold steady — that shot was blurry',
  moving: 'Hold steady and tap Scan',
  steadying: 'Hold steady and tap Scan',
};

const IDLE_STATUS = 'Point at a card and tap Scan';

interface Props {
  service: ScanService;
  gameId: GameId;
  onGameChange: (gameId: GameId) => void;
  onResult: (result: ScanResult) => void;
  indexReady: boolean;
  syncing?: boolean;
  /** Hide the shutter while something else is on top (e.g. the result sheet). */
  paused?: boolean;
}

export function ScanScreen({ service, gameId, onGameChange, onResult, indexReady, syncing, paused }: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // The live preview only renders when a preview output is connected, and the
  // photo output is what lets us capture a still to scan.
  const previewOutput = usePreviewOutput();
  const photoOutput = usePhotoOutput({
    targetResolution: PHOTO_RESOLUTION,
    // jpeg so we can decode the bytes ourselves with jpeg-js.
    containerFormat: 'jpeg',
    qualityPrioritization: 'balanced',
    quality: 0.7,
  });
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);
  const [scanning, setScanning] = useState(false);

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
          setStatus(IDLE_STATUS);
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
  const ready = modelsReady && hasPermission && !paused && !syncing;
  // The Camera streams the preview whenever we have permission and no result
  // sheet is up. The preview does not need the models or the catalogue, so it
  // stays live during "Updating catalogue…" instead of showing black.
  const cameraActive = hasPermission && !paused;

  // Capture one still and identify it — the manual shutter.
  const captureAndScan = async () => {
    if (!ready || scanning) return;
    setScanning(true);
    setStatus('Capturing…');
    try {
      const photo = await photoOutput.capturePhoto({ enableShutterSound: false }, {});
      let outcome: { result: ScanResult | null; status: string };
      try {
        if (!mounted.current) return;
        setStatus('Reading photo…');
        const bytes = new Uint8Array(await photo.getFileDataAsync());
        const frame = decodeJpegToRgba(bytes);
        outcome = await service.scanImageOnce(frame, (stage) => {
          if (mounted.current) setStatus(stage);
        });
      } finally {
        photo.dispose();
      }
      if (!mounted.current) return;
      const { result, status: next } = outcome;

      if (result && result.printing) {
        void Haptics.notificationAsync(
          result.confidence.tier === 'high'
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
        onResult(result);
        setStatus(IDLE_STATUS);
      } else if (result) {
        // The pipeline ran but matched nothing confidently.
        setStatus('No match — try again, filling the frame');
      } else {
        setStatus(STATUS_TEXT[next] ?? next);
      }
    } catch (error) {
      if (mounted.current) setStatus(`Scan error: ${(error as Error).message}`);
    } finally {
      if (mounted.current) setScanning(false);
    }
  };

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

      <View style={styles.controls}>
        <View style={styles.statusBar}>
          {!modelsReady ? <ActivityIndicator color={theme.accent} /> : null}
          <Text style={styles.statusText}>{status}</Text>
          {syncing ? (
            <Text style={styles.warning}>Updating catalogue…</Text>
          ) : !indexReady ? (
            <Text style={styles.warning}>No card index yet — it downloads on first sync.</Text>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan card"
          disabled={!ready || scanning}
          onPress={() => void captureAndScan()}
          style={[styles.shutter, (!ready || scanning) && styles.shutterDisabled]}
        >
          {scanning ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.shutterText}>Scan</Text>
          )}
        </Pressable>
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
    bottom: '30%',
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
  controls: {
    position: 'absolute',
    bottom: theme.spacing(4),
    left: theme.spacing(2),
    right: theme.spacing(2),
    alignItems: 'center',
    gap: theme.spacing(1.5),
  },
  statusBar: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    backgroundColor: 'rgba(11,14,20,0.8)',
    borderRadius: theme.radius,
    padding: theme.spacing(1.5),
  },
  statusText: { color: theme.text, fontSize: 15, textAlign: 'center' },
  warning: { color: theme.check, fontSize: 12, textAlign: 'center' },
  shutter: {
    minWidth: 200,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
    paddingHorizontal: theme.spacing(4),
    paddingVertical: theme.spacing(2),
    borderRadius: 999,
  },
  shutterDisabled: { opacity: 0.5 },
  shutterText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
