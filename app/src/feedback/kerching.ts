/** The "kerching" heard when a card is added to the collection automatically. */
import { AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { crumb } from '../debug/breadcrumbs';

let player: AudioPlayer | null = null;
let ready = false;

function makePlayer(): AudioPlayer {
  const next = createAudioPlayer(require('../../assets/kerching.wav'));
  next.volume = 1;
  next.muted = false;
  // The scan log shows what the player reports, so a silent device can be diagnosed.
  next.addListener('playbackStatusUpdate', (status) => {
    if (status.isLoaded && !ready) {
      ready = true;
      crumb(`sound: loaded (${status.duration.toFixed(2)}s)`);
    }
    if (status.error) crumb(`sound: error ${status.error}`);
  });
  return next;
}

/**
 * Create and load the player ahead of time, so the first kerching isn't lost to
 * loading. Safe to call more than once; never throws.
 */
export function warmUpKerching(): void {
  try {
    if (player) return;
    void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch((error) =>
      crumb(`sound: audio mode failed ${String(error)}`),
    );
    player = makePlayer();
  } catch (error) {
    crumb(`sound: setup failed ${String(error)}`);
  }
}

/**
 * Play the sound from the start. Never throws and never blocks: a device with no
 * audio output, or a player that fails to start, simply stays silent — the popup
 * still shows, and the reason lands in the scan log.
 */
export function playKerching(): void {
  void (async () => {
    try {
      warmUpKerching();
      if (!player) return;
      crumb(`sound: play (loaded=${ready}, volume=${player.volume})`);
      await player.seekTo(0);
      player.play();
    } catch (error) {
      crumb(`sound: play failed ${String(error)}`);
      // A player in a bad state is thrown away so the next call starts fresh.
      try {
        player?.remove();
      } catch {
        // Nothing more to do.
      }
      player = null;
      ready = false;
    }
  })();
}
