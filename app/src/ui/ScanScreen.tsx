/**
 * Camera screen: live preview, a Scan button, and optional auto-scan.
 *
 * Uses react-native-vision-camera. Either way, a scan is one grabbed camera
 * frame run through the identify pipeline. The Scan button grabs on demand.
 * Auto-scan grabs when the picture has been held still and is a new scene
 * (autoScan.ts decides, from a tiny thumbnail kept on the camera thread), so
 * holding a card steady scans it and moving to the next card scans that too.
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
import type { Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import { addToCollection, defaultPortfolio, ownedQuantity, removeOneFromCollection } from '../data/db';
import { Condition, GAMES, GameId, Printing } from '../data/types';
import { playKerching } from '../feedback/kerching';
import { crumb, readCrumbs } from '../debug/breadcrumbs';
import {
  AutoScanState,
  createAutoScanState,
  isRepeatOfLastScan,
  sampleThumbnail,
  shouldSample,
  stepAutoScan,
} from '../scan/autoScan';
import { RgbaImage } from '../scan/image';
import { ScanResult, ScanService } from '../scan/scanService';
import { AddedCard, AddedToast } from './AddedToast';
import { GamePicker } from './GamePicker';
import { topInset } from './layout';
import { theme } from './theme';

// Frame size. Detection (384px) and the picture match (448px) would be fine on
// far less, but the printed serial is only a couple of millimetres tall: at
// ~1000px it is about 9px high and digits get misread (a "17" came out as "12"),
// so ask for a full-HD frame. The extra cost is one longer pixel copy per scan;
// everything downstream resamples to a fixed size.
const FRAME_RESOLUTION = { width: 1920, height: 1080 };
// Frames stream continuously but the worklet discards them for free until a
// capture is requested, so a low rate is plenty and keeps power/heat down.
const CAPTURE_FPS = 10;
// If the camera hasn't delivered a frame this long after a tap, give up rather
// than spin forever (e.g. the stream stalled).
const CAPTURE_TIMEOUT_MS = 6000;
// Height of the solid control panel at the bottom; the camera view above it is what the card is framed in.
const PANEL_HEIGHT = 204;

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
const AUTO_IDLE_STATUS = 'Hold a card steady to scan it';

/**
 * Copy a frame's pixels into a compact RGBA buffer, in the right channel order.
 * Runs on the camera thread. `meta` describes the frame, for the scan log.
 */
function copyFrameToRgba(frame: Frame): { out: Uint8Array; width: number; height: number; meta: string } {
  'worklet';
  const plane = frame.getPlanes()[0];
  if (plane == null) throw new Error('frame has no pixel plane');
  const width = plane.width;
  const height = plane.height;
  const bytesPerRow = plane.bytesPerRow;
  const src = new Uint8Array(plane.getPixelBuffer());
  // 'rgb' is 3 bytes/pixel, but some pipelines negotiate a 4-byte layout; derive
  // it from the row stride and copy into compact RGBA.
  const channels = Math.max(3, Math.round(bytesPerRow / width));
  // The channel order is not always RGB: the camera often hands over BGRA
  // ('rgb-bgra-8-bit'). Reading it as RGB swaps red and blue, and the embedder
  // scores a red/blue-swapped card ~0.74 against ~0.91.
  const isBgra = frame.pixelFormat === 'rgb-bgra-8-bit';
  const redAt = isBgra ? 2 : 0;
  const blueAt = isBgra ? 0 : 2;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x += 1) {
      const s = row + x * channels;
      const d = (y * width + x) * 4;
      out[d] = src[s + redAt];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + blueAt];
      out[d + 3] = 255;
    }
  }
  const meta = `format=${frame.pixelFormat} orientation=${frame.orientation} mirrored=${frame.isMirrored} ${width}x${height} stride=${bytesPerRow} channels=${channels}`;
  return { out, width, height, meta };
}

/** A tiny brightness thumbnail of a frame, for spotting when the picture is still. */
function thumbnailOfFrame(frame: Frame): number[] {
  'worklet';
  const plane = frame.getPlanes()[0];
  if (plane == null) throw new Error('frame has no pixel plane');
  const bytesPerRow = plane.bytesPerRow;
  const channels = Math.max(3, Math.round(bytesPerRow / plane.width));
  // Green is the second byte of a pixel in RGB, RGBA and BGRA alike.
  return sampleThumbnail(new Uint8Array(plane.getPixelBuffer()), plane.width, plane.height, bytesPerRow, channels, 1);
}

interface Props {
  service: ScanService;
  gameId: GameId;
  onGameChange: (gameId: GameId) => void;
  onResult: (result: ScanResult) => void;
  indexReady: boolean;
  syncing?: boolean;
  /** Hide the shutter while something else is on top (e.g. the result sheet). */
  paused?: boolean;
  /** Scan by itself when a card is held steady, as well as on the Scan button. */
  autoScan: boolean;
  onAutoScanChange: (on: boolean) => void;
  /** Add high-confidence matches to the collection without asking. */
  autoAdd: boolean;
  /** Play the kerching when one is added. */
  sound: boolean;
  /** Something was added to the collection, so lists showing it should reload. */
  onAdded: () => void;
}

export function ScanScreen({
  service,
  gameId,
  onGameChange,
  onResult,
  indexReady,
  syncing,
  paused,
  autoScan,
  onAutoScanChange,
  autoAdd,
  sound,
  onAdded,
}: Props) {
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
  // Read by callbacks that outlive a render (camera frames arrive on their own
  // schedule): whether auto-scan is on, and whether a scan is being processed.
  const autoRef = useRef(autoScan);
  const busyRef = useRef(false);
  // Read from callbacks that outlive a render (see processFrame).
  const autoAddRef = useRef(autoAdd);
  autoAddRef.current = autoAdd;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  // The popup for the card just added, and what to take back if Undo is tapped.
  const [added, setAdded] = useState<AddedCard | null>(null);
  const lastAdd = useRef<{ portfolioId: number; printingId: string; variant: Printing['variant']; condition: Condition } | null>(null);
  // The scene the last auto-scan looked at. The camera thread tracks this too, but
  // its state is lost if the camera restarts, so the JS side refuses a repeat as well.
  // A card that settled while another was being read, waiting for its turn.
  const queuedFrame = useRef<RgbaImage | null>(null);
  const processRef = useRef<(frame: RgbaImage, origin: 'manual' | 'auto') => void>(() => {});
  const lastAutoScene = useRef<{ scene: number[]; at: number } | null>(null);
  useEffect(() => {
    autoRef.current = autoScan;
  }, [autoScan]);

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

  // Keep the idle prompt in step with the Auto setting (only while nothing else
  // is being said: a scan in progress or an outcome on screen is left alone).
  useEffect(() => {
    setStatus((current) => {
      if (current === IDLE_STATUS || current === AUTO_IDLE_STATUS) return autoScan ? AUTO_IDLE_STATUS : IDLE_STATUS;
      return current;
    });
  }, [autoScan]);

  useEffect(() => {
    let cancelled = false;
    service
      .load()
      .then(() => {
        if (!cancelled) {
          setModelsReady(true);
          setStatus(autoRef.current ? AUTO_IDLE_STATUS : IDLE_STATUS);
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

  const idleStatus = useCallback(() => (autoRef.current ? AUTO_IDLE_STATUS : IDLE_STATUS), []);

  /**
   * Add a high-confidence match to the collection without asking: one near-mint
   * copy, a haptic tap, the kerching, and a small popup with Undo. If saving fails
   * the normal result sheet is shown instead, so the scan is never lost.
   */
  const addAutomatically = useCallback(
    async (result: ScanResult, printing: Printing) => {
      try {
        const portfolio = await defaultPortfolio();
        const variant = printing.variant;
        const condition: Condition = 'NM';
        await addToCollection({ portfolioId: portfolio.id, printingId: printing.id, variant, condition, quantity: 1 });
        const owned = await ownedQuantity(portfolio.id, printing.id, variant, condition);
        lastAdd.current = { portfolioId: portfolio.id, printingId: printing.id, variant, condition };
        crumb(`js: auto-added ${printing.id} (now owns ${owned})`);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (soundRef.current) playKerching();
        onAdded();
        if (mounted.current) setAdded({ printing, owned });
      } catch (error) {
        crumb(`js: auto-add failed ${String(error)}`);
        if (mounted.current) onResult(result);
      }
    },
    [onAdded, onResult],
  );

  const undoAdd = useCallback(async () => {
    const last = lastAdd.current;
    setAdded(null);
    if (!last) return;
    lastAdd.current = null;
    await removeOneFromCollection(last.portfolioId, last.printingId, last.variant, last.condition);
    crumb(`js: undid add of ${last.printingId}`);
    onAdded();
  }, [onAdded]);

  /**
   * Identify one grabbed frame and show the outcome. `origin` decides how a miss
   * is worded: after a tap it is guidance, but auto-scan tries whenever a picture
   * settles, so "no card in view" is just the normal state, not a complaint.
   */
  const processFrame = useCallback(
    (frame: RgbaImage, origin: 'manual' | 'auto') => {
      busyRef.current = true;
      setScanning(true);
      crumb(`js: ${origin} frame received ${frame.width}x${frame.height}, ${frame.data.length} bytes`);
      setStatus(origin === 'auto' ? 'Card steady — scanning…' : `Got frame ${frame.width}×${frame.height}…`);
      void service
        .scanImageOnce(frame, (stage) => {
          if (mounted.current) setStatus(stage);
        })
        .then(({ result, status: next }) => {
          crumb(`js: scan finished status=${next} printing=${result?.printing?.id ?? 'none'}`);
          if (!mounted.current) return;
          if (result && result.printing && result.confidence.tier === 'high' && autoAddRef.current) {
            void addAutomatically(result, result.printing);
            setStatus(idleStatus());
          } else if (result && result.printing) {
            void Haptics.notificationAsync(
              result.confidence.tier === 'high'
                ? Haptics.NotificationFeedbackType.Success
                : Haptics.NotificationFeedbackType.Warning,
            );
            onResult(result);
            setStatus(idleStatus());
          } else if (result) {
            setStatus(origin === 'auto' ? 'No match — try another card, or tap Scan' : 'No match — try again, filling the frame');
          } else if (origin === 'auto' && next === 'no-card') {
            setStatus(AUTO_IDLE_STATUS);
          } else {
            setStatus(STATUS_TEXT[next] ?? next);
          }
        })
        .catch((error: Error) => {
          crumb(`js: scan error ${error.message}`);
          if (mounted.current) setStatus(`Scan error: ${error.message}`);
        })
        .finally(() => {
          busyRef.current = false;
          if (mounted.current) setScanning(false);
          const next = queuedFrame.current;
          queuedFrame.current = null;
          if (next && mounted.current && autoRef.current && !awaitingCapture.current) {
            crumb('js: scanning the card that arrived during the last scan');
            processRef.current(next, 'auto');
          }
        });
    },
    [addAutomatically, idleStatus, onResult, service],
  );

  processRef.current = processFrame;

  // A frame grabbed for a tap on Scan. Guarded so only the frame asked for is used.
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
      processFrame({ data, width, height }, 'manual');
    },
    [processFrame],
  );

  // A frame the camera thread grabbed because the picture had been still for a
  // moment (see autoScan.ts). It may arrive while a scan is already under way, or
  // after auto-scan was switched off; either way it is dropped.
  const onAutoFrame = useCallback(
    (data: Uint8Array, width: number, height: number, scene: number[]) => {
      if (!mounted.current || !autoRef.current || awaitingCapture.current) return;
      const now = Date.now();
      if (isRepeatOfLastScan(lastAutoScene.current, scene, now)) {
        crumb('js: auto frame dropped, practically identical to the last auto scan');
        return;
      }
      lastAutoScene.current = { scene, at: now };
      const frame = { data, width, height };
      if (busyRef.current) {
        // The next card arrived while the last is still being read: keep its picture
        // (the newest one wins) and scan it the moment the current scan ends.
        queuedFrame.current = frame;
        crumb('js: auto frame queued behind the scan in progress');
        return;
      }
      processFrame(frame, 'auto');
    },
    [processFrame],
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

  // The auto-scan watcher threw. Log it and carry on; it will try again.
  const onAutoError = useCallback((message: string) => {
    crumb(`js: auto-scan watcher error ${message}`);
  }, []);

  // Auto-scan watches whenever a scan could start and none is running or asked for.
  // It keeps watching while a scan runs, so the next card is already captured when this one ends.
  const watching = autoScan && ready && !grabbing;

  const frameOutput = useFrameOutput({
    pixelFormat: 'rgb',
    targetResolution: FRAME_RESOLUTION,
    // Hand us a display-upright buffer so the card is the right way up for the
    // detector, regardless of sensor orientation.
    enablePhysicalBufferRotation: true,
    // Three modes, chosen by React state (the hook re-sends the worklet to the
    // camera thread when it changes, so no cross-thread flag is needed):
    //  - grabbing: copy exactly one frame over to JS (the Scan button);
    //  - watching: keep a tiny thumbnail of each sampled frame and, once the
    //    picture has held still and is a new scene, copy one frame over
    //    (auto-scan — nothing else ever crosses to JS, which is what froze the
    //    old live scanner);
    //  - otherwise: throw every frame away for free.
    onFrame: grabbing
      ? (frame) => {
          'worklet';
          let picture: { out: Uint8Array; width: number; height: number; meta: string } | null = null;
          let failure: string | null = null;
          runOnJS(crumb)('worklet: grab start');
          try {
            picture = copyFrameToRgba(frame);
            runOnJS(crumb)(`worklet: ${picture.meta}`);
          } catch (error) {
            failure = String(error);
          }
          frame.dispose();
          if (failure != null || picture == null) {
            runOnJS(onGrabError)(failure ?? 'no pixels');
          } else {
            runOnJS(crumb)('worklet: copied, handing to JS');
            runOnJS(onCapturedFrame)(picture.out, picture.width, picture.height);
          }
        }
      : watching
        ? (frame) => {
            'worklet';
            // State that must outlive a frame lives on this thread's global, which
            // persists across frames and across re-installs of this worklet.
            const scope = globalThis as unknown as { __cardscanAuto?: AutoScanState };
            if (scope.__cardscanAuto == null) scope.__cardscanAuto = createAutoScanState();
            const state = scope.__cardscanAuto;
            const now = Date.now();
            if (!shouldSample(state, now)) {
              frame.dispose();
              return;
            }
            // Even a failed sample counts as one, so a fault cannot spin every frame.
            state.lastSampleAt = now;

            let picture: { out: Uint8Array; width: number; height: number; meta: string } | null = null;
            let failure: string | null = null;
            let scene: number[] = [];
            try {
              const step = stepAutoScan(state, thumbnailOfFrame(frame), now);
              scene = step.thumb;
              if (step.trigger) {
                picture = copyFrameToRgba(frame);
                runOnJS(crumb)(`worklet: auto trigger still=${step.still.toFixed(1)} changed=${step.changed.toFixed(1)} ${picture.meta}`);
              }
            } catch (error) {
              failure = String(error);
            }
            frame.dispose();
            if (failure != null) runOnJS(onAutoError)(failure);
            else if (picture != null) runOnJS(onAutoFrame)(picture.out, picture.width, picture.height, scene);
          }
        : (frame) => {
            'worklet';
            frame.dispose();
          },
  });

  // The manual shutter: install the grab worklet so the next frame is captured.
  const requestScan = () => {
    if (!ready || awaitingCapture.current || busyRef.current) return;
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

      {/* The camera view above the control panel: the card goes in the frame, and nothing overlaps it. */}
      <View style={styles.viewfinder} pointerEvents="box-none">
        <View style={styles.gameRow} pointerEvents="box-none">
          <GamePicker gameId={gameId} onChange={onGameChange} />
        </View>

        <View pointerEvents="none" style={styles.frameGuide}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
        </View>

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
      </View>

      {/* Solid panel: status, the two buttons, and the popup for a card just added. */}
      <View style={styles.panel}>
        <Pressable style={styles.statusBar} onPress={toggleLog}>
          <View style={styles.statusLine}>
            {!modelsReady ? <ActivityIndicator color={theme.accent} size="small" /> : null}
            <Text style={styles.statusText} numberOfLines={2}>
              {status}
              {scanning && elapsed > 0 ? ` (${elapsed}s)` : ''}
            </Text>
          </View>
          {syncing ? (
            <Text style={styles.warning} numberOfLines={1}>
              Updating catalogue…
            </Text>
          ) : !indexReady ? (
            <Text style={styles.warning} numberOfLines={1}>
              No card index yet — it downloads on first sync.
            </Text>
          ) : null}
        </Pressable>

        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: autoScan }}
            accessibilityLabel="Auto-scan"
            onPress={() => onAutoScanChange(!autoScan)}
            style={[styles.autoButton, autoScan && styles.autoButtonOn]}
          >
            <Text style={[styles.autoButtonText, autoScan && styles.autoButtonTextOn]} numberOfLines={1}>
              {autoScan ? 'Auto-scan on' : 'Auto-scan off'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan card"
            disabled={!ready || scanning}
            onPress={requestScan}
            style={[styles.shutter, (!ready || scanning) && styles.shutterDisabled]}
          >
            {scanning ? (
              <ActivityIndicator color={theme.onAccent} />
            ) : (
              <Text style={styles.shutterText}>Scan</Text>
            )}
          </Pressable>

          <Pressable style={styles.logButton} onPress={toggleLog} accessibilityLabel={showLog ? 'Hide log' : 'Show log'}>
            <Text style={styles.logButtonText}>{showLog ? 'Hide log' : 'Log'}</Text>
          </Pressable>
        </View>

        <View style={styles.toastSlot}>
          {added ? <AddedToast added={added} onUndo={() => void undoAdd()} onDismiss={() => setAdded(null)} /> : null}
        </View>
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
  buttonText: { color: theme.onAccent, fontWeight: '700' },
  viewfinder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: PANEL_HEIGHT,
  },
  // Where to put the card: clear of the game chips above and the panel below.
  frameGuide: {
    position: 'absolute',
    left: '9%',
    right: '9%',
    top: topInset + 64,
    bottom: theme.spacing(2),
  },
  corner: { position: 'absolute', width: 34, height: 34, borderColor: theme.accent },
  cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 },
  gameRow: {
    position: 'absolute',
    top: topInset + theme.spacing(1),
    left: 0,
    right: 0,
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: PANEL_HEIGHT,
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: theme.spacing(2),
    paddingTop: theme.spacing(1.5),
    gap: theme.spacing(1.25),
  },
  statusBar: { minHeight: 44, justifyContent: 'center', gap: 2 },
  statusLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing(1) },
  statusText: { color: theme.text, fontSize: 14, textAlign: 'center', flexShrink: 1 },
  warning: { color: theme.check, fontSize: 12, textAlign: 'center' },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.25) },
  autoButton: {
    width: 108,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  autoButtonOn: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
  autoButtonText: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  autoButtonTextOn: { color: theme.accent },
  shutter: {
    flex: 1,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
    borderRadius: theme.radius,
  },
  shutterDisabled: { opacity: 0.45 },
  shutterText: { color: theme.onAccent, fontSize: 17, fontWeight: '800' },
  logButton: {
    width: 68,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius,
    backgroundColor: theme.surfaceAlt,
  },
  logButtonText: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  // Reserved so the popup appearing never moves the buttons.
  toastSlot: { height: 52, justifyContent: 'center' },
  logBox: {
    position: 'absolute',
    left: theme.spacing(1.5),
    right: theme.spacing(1.5),
    bottom: theme.spacing(1),
    gap: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: theme.radius,
    padding: theme.spacing(1),
  },
  logText: { color: '#9fe870', fontSize: 10, fontFamily: 'monospace' },
});
