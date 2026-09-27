/**
 * Camera screen: live auto-scan, no shutter button.
 *
 * Uses react-native-vision-camera: the preview renders natively and frames are
 * delivered on the Camera's own worklet thread — never the JS/UI thread — so the
 * bottom tab bar and game chips stay responsive while scanning. Each delivered
 * frame is already RGB at a small target resolution (no JPEG decode), copied to
 * a compact RGBA buffer in the worklet and handed to JS via runOnJS, where the
 * existing pipeline identifies the card.
 */
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import { GAMES, GameId } from '../data/types';
import { RgbaImage } from '../scan/image';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Frame delivery rate. Frames arrive on the Camera worklet thread, but each one
// still schedules a little work on JS (the pipeline), so we cap the camera at a
// modest rate rather than the full preview rate. Tunable.
const TARGET_FPS = 8;
// Small working frame: the detector wants 384 and the dewarped crop 448, so this
// oversamples both while keeping the per-frame copy cheap.
const TARGET_RESOLUTION = { width: 960, height: 540 };

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
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);

  const busy = useRef(false);
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

  const active = modelsReady && hasPermission && !paused && !syncing;

  // Runs on the JS thread, one frame at a time. `busy` drops any frame that
  // arrives while the previous one is still being identified.
  const handleFrame = useCallback(
    (data: Uint8Array, width: number, height: number) => {
      if (!mounted.current || busy.current || !active) return;
      busy.current = true;
      const image: RgbaImage = { data, width, height };
      service
        .offerImage(image)
        .then(({ result, status: next }) => {
          if (!mounted.current) return;
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
        })
        .catch((error: Error) => mounted.current && setStatus(error.message))
        .finally(() => {
          busy.current = false;
        });
    },
    [active, onResult, service],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'rgb',
    targetResolution: TARGET_RESOLUTION,
    // Hand us a display-upright buffer so the card is the right way up for the
    // detector, regardless of sensor orientation.
    enablePhysicalBufferRotation: true,
    onFrame: (frame) => {
      'worklet';
      const plane = frame.getPlanes()[0];
      if (plane == null) {
        frame.dispose();
        return;
      }
      const width = plane.width;
      const height = plane.height;
      const bytesPerRow = plane.bytesPerRow;
      const src = new Uint8Array(plane.getPixelBuffer());
      // 'rgb' is 3 bytes/pixel, but some pipelines negotiate a 4-byte layout;
      // derive it from the row stride and copy into compact RGBA.
      const channels = Math.max(3, Math.round(bytesPerRow / width));
      const out = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x += 1) {
          const s = row + x * channels;
          const d = (y * width + x) * 4;
          out[d] = src[s];
          out[d + 1] = src[s + 1];
          out[d + 2] = src[s + 2];
          out[d + 3] = 255;
        }
      }
      frame.dispose();
      runOnJS(handleFrame)(out, width, height);
    },
  });

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
        isActive={active}
        outputs={frameOutput ? [frameOutput] : []}
        constraints={[{ fps: TARGET_FPS }]}
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
