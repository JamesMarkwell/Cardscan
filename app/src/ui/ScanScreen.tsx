/**
 * Camera screen: live preview with a manual shutter.
 *
 * Uses react-native-vision-camera. Scanning is manual: the user frames a card
 * and taps Scan, which grabs a single camera frame and runs the identify
 * pipeline on it.
 *
 * How we get the pixels is the whole story of this file. On this build every
 * still-photo decode path hangs: nitro-image and expo-image-manipulator (async
 * or sync) never return, and decoding the photo's JPEG bytes in pure JS with
 * jpeg-js is too slow even at 720p (it froze on "Decoding 1280×720…"). What does
 * work here is the camera's *frame output* — raw RGB buffers delivered on the
 * frame-processor worklet thread, never encoded, the same mechanism the old live
 * scanner used. Live scanning froze the UI only because it marshalled every
 * frame to the JS thread; here the installed worklet discards every frame for
 * free until the user taps Scan, at which point React state swaps in a worklet
 * that copies exactly one frame's pixels over. So there is no JPEG, no native
 * image library, no per-frame JS work, and no cross-thread flag: the worklet
 * itself is the switch.
 */
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, usePreviewOutput } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import { GAMES, GameId } from '../data/types';
import { crumb, readCrumbs } from '../debug/breadcrumbs';
import { RgbaImage } from '../scan/image';
import { ScanResult, ScanService } from '../scan/scanService';
import { theme } from './theme';

// Working frame size. The detector wants 384px and the dewarped crop 448px, so
// this oversamples both while keeping the single per-capture pixel copy cheap.
const FRAME_RESOLUTION = { width: 960, height: 540 };
// Frames stream continuously but the worklet discards them for free until a
// capture is requested, so a low rate is plenty and keeps power/heat down.
const CAPTURE_FPS = 10;
// If the camera hasn't delivered a frame this long after a tap, give up rather
// than spin forever (e.g. the stream stalled).
const CAPTURE_TIMEOUT_MS = 6000;

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
  // The live preview only renders when a preview output is connected; the frame
  // output is what lets us grab a still to scan.
  const previewOutput = usePreviewOutput();
  const [status, setStatus] = useState('Starting camera');
  const [modelsReady, setModelsReady] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Which frame worklet is installed on the camera thread. false: discard every
  // frame. true: grab one. It is plain React state — the hook re-sends the
  // worklet to the camera thread whenever it changes — so there is no shared
  // cross-thread flag to get wrong.
  const [grabbing, setGrabbing] = useState(false);
  // Tap the status bar to show the step log (survives a crash — see breadcrumbs).
  // Open by default for now, so after a crash and restart the previous run's last
  // steps are on screen straight away.
  const [showLog, setShowLog] = useState(true);
  const [logLines, setLogLines] = useState<string[]>([]);
  // Seconds since the current scan began, so a slow step can be told apart from
  // a frozen app (the counter keeps ticking only while the JS thread is free).
  const [elapsed, setElapsed] = useState(0);

  const mounted = useRef(true);
  // True from the moment Scan is tapped until we've consumed one frame. Guards
  // against a stray frame being processed and against double-taps.
  const awaitingCapture = useRef(false);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (watchdog.current) clearTimeout(watchdog.current);
    };
  }, []);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  // Point the pipeline's step logging at the crash-surviving log.
  useEffect(() => {
    service.pipeline.trace = crumb;
    return () => {
      service.pipeline.trace = undefined;
    };
  }, [service]);

  // Confirms the render that installs (or removes) the grab worklet committed.
  useEffect(() => {
    crumb(`render: grabbing=${grabbing}`);
  }, [grabbing]);

  // While the log is open, keep it live so the steps of a running scan appear as
  // they are written instead of showing a stale snapshot.
  useEffect(() => {
    if (!showLog) return undefined;
    const refresh = () => {
      void readCrumbs(16).then((lines) => mounted.current && setLogLines(lines));
    };
    refresh();
    const id = setInterval(refresh, 700);
    return () => clearInterval(id);
  }, [showLog]);

  useEffect(() => {
    if (!scanning) {
      setElapsed(0);
      return undefined;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [scanning]);

  const toggleLog = () => setShowLog((open) => !open);

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
  // The Camera streams whenever we have permission and no result sheet is up.
  const cameraActive = hasPermission && !paused;

  // Runs on the JS thread with one grabbed frame's pixels. Guarded so only the
  // frame captured for the current tap is processed.
  const onCapturedFrame = useCallback(
    (data: Uint8Array, width: number, height: number) => {
      if (!awaitingCapture.current || !mounted.current) return;
      awaitingCapture.current = false;
      // Swap back to the discard worklet so no further frames are copied.
      setGrabbing(false);
      if (watchdog.current) {
        clearTimeout(watchdog.current);
        watchdog.current = null;
      }
      crumb(`js: frame received ${width}x${height}, ${data.length} bytes`);
      setStatus(`Got frame ${width}×${height}…`);
      const frame: RgbaImage = { data, width, height };
      void service
        .scanImageOnce(frame, (stage) => {
          if (mounted.current) setStatus(stage);
        })
        .then(({ result, status: next }) => {
          crumb(`js: scan finished status=${next} printing=${result?.printing?.id ?? 'none'}`);
          if (!mounted.current) return;
          if (result && result.printing) {
            void Haptics.notificationAsync(
              result.confidence.tier === 'high'
                ? Haptics.NotificationFeedbackType.Success
                : Haptics.NotificationFeedbackType.Warning,
            );
            onResult(result);
            setStatus(IDLE_STATUS);
          } else if (result) {
            setStatus('No match — try again, filling the frame');
          } else {
            setStatus(STATUS_TEXT[next] ?? next);
          }
        })
        .catch((error: Error) => {
          crumb(`js: scan error ${error.message}`);
          if (mounted.current) setStatus(`Scan error: ${error.message}`);
        })
        .finally(() => {
          if (mounted.current) setScanning(false);
        });
    },
    [onResult, service],
  );

  // The grab worklet threw. Surface the reason on screen and reset the shutter,
  // so a failure in the camera thread is visible rather than a silent stall.
  const onGrabError = useCallback((message: string) => {
    crumb(`js: grab error ${message}`);
    if (!awaitingCapture.current || !mounted.current) return;
    awaitingCapture.current = false;
    setGrabbing(false);
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
    setScanning(false);
    setStatus(`Frame grab failed: ${message}`);
  }, []);

  const frameOutput = useFrameOutput({
    pixelFormat: 'rgb',
    targetResolution: FRAME_RESOLUTION,
    // Hand us a display-upright buffer so the card is the right way up for the
    // detector, regardless of sensor orientation.
    enablePhysicalBufferRotation: true,
    // Idle: throw every frame away for free. This is what keeps the UI
    // responsive while the preview streams. Tapping Scan flips `grabbing`, which
    // installs the grab worklet below in its place.
    onFrame: grabbing
      ? (frame) => {
          'worklet';
          let out: Uint8Array | null = null;
          let width = 0;
          let height = 0;
          let failure: string | null = null;
          runOnJS(crumb)('worklet: grab start');
          try {
            const plane = frame.getPlanes()[0];
            if (plane == null) throw new Error('frame has no pixel plane');
            width = plane.width;
            height = plane.height;
            const bytesPerRow = plane.bytesPerRow;
            const src = new Uint8Array(plane.getPixelBuffer());
            // 'rgb' is 3 bytes/pixel, but some pipelines negotiate a 4-byte
            // layout; derive it from the row stride and copy into compact RGBA.
            const channels = Math.max(3, Math.round(bytesPerRow / width));
            out = new Uint8Array(width * height * 4);
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
          } catch (error) {
            failure = String(error);
          }
          frame.dispose();
          if (failure != null || out == null) {
            runOnJS(onGrabError)(failure ?? 'no pixels');
          } else {
            runOnJS(crumb)('worklet: copied, handing to JS');
            runOnJS(onCapturedFrame)(out, width, height);
          }
        }
      : (frame) => {
          'worklet';
          frame.dispose();
        },
  });

  // The manual shutter: install the grab worklet so the next frame is captured.
  const requestScan = () => {
    if (!ready || awaitingCapture.current) return;
    crumb('tap: scan requested');
    awaitingCapture.current = true;
    setScanning(true);
    setStatus('Capturing…');
    // Start the watchdog before anything that could throw, so the shutter can
    // never be left spinning with nothing scheduled to reset it.
    watchdog.current = setTimeout(() => {
      if (!awaitingCapture.current) return;
      crumb('watchdog: no frame in 6s');
      awaitingCapture.current = false;
      setGrabbing(false);
      if (mounted.current) {
        setScanning(false);
        setStatus('No camera frame arrived in 6s — try again');
      }
    }, CAPTURE_TIMEOUT_MS);
    setGrabbing(true);
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
        outputs={frameOutput ? [previewOutput, frameOutput] : [previewOutput]}
        constraints={[{ fps: CAPTURE_FPS }]}
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
        {showLog ? (
          <View style={styles.logBox}>
            {logLines.length === 0 ? (
              <Text style={styles.logText}>No log yet.</Text>
            ) : (
              logLines.map((line, index) => (
                <Text key={`${index}-${line}`} style={styles.logText}>
                  {line}
                </Text>
              ))
            )}
          </View>
        ) : null}
        <Pressable style={styles.statusBar} onPress={toggleLog}>
          {!modelsReady ? <ActivityIndicator color={theme.accent} /> : null}
          <Text style={styles.statusText}>
            {status}
            {scanning && elapsed > 0 ? ` (${elapsed}s)` : ''}
          </Text>
          {syncing ? (
            <Text style={styles.warning}>Updating catalogue…</Text>
          ) : !indexReady ? (
            <Text style={styles.warning}>No card index yet — it downloads on first sync.</Text>
          ) : null}
          <Text style={styles.logHint}>{showLog ? 'tap to hide log' : 'tap for log'}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan card"
          disabled={!ready || scanning}
          onPress={requestScan}
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
  logHint: { color: theme.textMuted, fontSize: 10, textAlign: 'center' },
  logBox: {
    alignSelf: 'stretch',
    gap: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: theme.radius,
    padding: theme.spacing(1),
  },
  logText: { color: '#9fe870', fontSize: 10, fontFamily: 'monospace' },
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
