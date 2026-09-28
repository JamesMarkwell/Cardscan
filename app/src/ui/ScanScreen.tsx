/**
 * Camera screen: live auto-scan, no shutter button.
 *
 * Uses react-native-vision-camera: the preview renders natively and frames are
 * delivered on the Camera's own worklet thread. Marshalling a frame to JS and
 * identifying it both land on the JS thread — the same thread React Native uses
 * to dispatch touches — so two throttles keep that thread free enough for the
 * tab bar and game chips: the worklet forwards only ~1 frame in FORWARD_EVERY to
 * JS (the sensor's raw rate would flood it), and each identify pass is gated
 * behind an idle window plus InteractionManager. The live preview streams
 * whenever we have permission — it does not wait on the models or the catalogue.
 */
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, usePreviewOutput } from 'react-native-vision-camera';
import { createSynchronizable, runOnJS } from 'react-native-worklets';
import { GAMES, GameId } from '../data/types';
import { RgbaImage } from '../scan/image';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Forward only every Nth camera frame from the worklet thread to JS. The camera
// delivers frames at the sensor rate — an { fps } constraint is only a hint the
// sensor rounds to its nearest supported range (often 15–30fps), NOT a hard cap —
// and every forwarded frame marshals a whole RGBA buffer onto the JS thread, the
// same thread React Native dispatches touches on. Left unthrottled that marshal
// alone floods the JS thread and freezes the tab bar and chips, before any
// identification even runs. Dropping frames in the worklet (off the JS thread) is
// free, so we forward ~1 in 8 — roughly 2–4fps, plenty for the capture gate.
const FORWARD_EVERY = 8;
// Working frame. The detector squashes to 384 and the dewarped crop is 448, so
// this still oversamples both — while keeping the buffer marshalled to JS each
// forwarded frame small (640x360x4 ≈ 0.9MB vs 2MB at 960x540), pure JS-thread cost.
const TARGET_RESOLUTION = { width: 640, height: 360 };
// Minimum idle window between pipeline passes. Each pass blocks the JS thread in
// bursts (tensor packing, the blur check, the index search); without a gap the
// next frame starts the moment one finishes and touches never get the thread.
// After the gap we also wait for InteractionManager, so a tab-bar tap always
// wins the thread first and the next frame runs only once the UI is idle again.
const FRAME_GAP_MS = 150;

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
  // The live preview only renders when a preview output is connected — the
  // migration was missing this, so the Camera showed nothing on its own.
  const previewOutput = usePreviewOutput();
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);

  // A frame counter shared with the worklet thread, so the worklet can forward
  // only every Nth frame to JS and dispose the rest without ever touching JS.
  const frameCounter = useMemo(() => createSynchronizable(0), []);

  // The newest frame the worklet has handed us, waiting to be processed. Frames
  // arrive faster than the pipeline runs, so we only ever keep the latest one
  // and drop the rest — a stale frame is worthless for a live scan anyway.
  const pendingFrame = useRef<RgbaImage | null>(null);
  const processing = useRef(false);
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

  // Scanning needs the models loaded and a settled catalogue. The scheduler
  // below only identifies frames while this is true.
  const active = modelsReady && hasPermission && !paused && !syncing;
  // The Camera streams (preview + frames) whenever we have permission and no
  // result sheet is up. The preview does NOT need the models or the catalogue,
  // so it stays live during "Updating catalogue…" instead of showing black; the
  // heavy identification still waits for `active`.
  const cameraActive = hasPermission && !paused;

  // Runs on the JS thread for every delivered frame, but does almost nothing:
  // it just stashes the latest frame. The heavy identification is driven
  // separately (below) so it can be throttled and yielded around touches.
  const handleFrame = useCallback((data: Uint8Array, width: number, height: number) => {
    if (mounted.current) pendingFrame.current = { data, width, height };
  }, []);

  // Identify the latest stashed frame, then reschedule — but only after a short
  // idle gap and once InteractionManager reports the UI is idle, so taps on the
  // tab bar and game chips are always serviced before the next pipeline pass.
  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let interaction: ReturnType<typeof InteractionManager.runAfterInteractions> | undefined;

    const schedule = () => {
      timer = setTimeout(() => {
        interaction = InteractionManager.runAfterInteractions(async () => {
          if (cancelled) return;
          const frame = pendingFrame.current;
          pendingFrame.current = null;

          if (frame && !processing.current) {
            processing.current = true;
            try {
              const { result, status: next } = await service.offerImage(frame);
              if (!cancelled && mounted.current) {
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
              }
            } catch (error) {
              if (!cancelled && mounted.current) setStatus((error as Error).message);
            } finally {
              processing.current = false;
            }
          }

          if (!cancelled) schedule();
        });
      }, FRAME_GAP_MS);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      interaction?.cancel();
    };
  }, [active, onResult, service]);

  const frameOutput = useFrameOutput({
    pixelFormat: 'rgb',
    targetResolution: TARGET_RESOLUTION,
    // Hand us a display-upright buffer so the card is the right way up for the
    // detector, regardless of sensor orientation.
    enablePhysicalBufferRotation: true,
    onFrame: (frame) => {
      'worklet';
      // Throttle on the worklet thread: forward ~1 frame in FORWARD_EVERY to JS
      // and dispose the rest here, so the JS thread is never flooded with buffer
      // marshalling at the sensor's frame rate. Dropping frames here is free.
      const n = frameCounter.getDirty() + 1;
      frameCounter.setBlocking(n);
      if (n % FORWARD_EVERY !== 0) {
        frame.dispose();
        return;
      }
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
        isActive={cameraActive}
        outputs={frameOutput ? [previewOutput, frameOutput] : [previewOutput]}
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
