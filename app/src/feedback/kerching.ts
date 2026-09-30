/** The "kerching" heard when a card is added to the collection automatically. */
import { AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';

let player: AudioPlayer | null = null;
let modeSet = false;

/**
 * Play the sound. Never throws and never blocks: a device with no audio output, or
 * a player that fails to start, simply stays silent — the popup still shows.
 */
export function playKerching(): void {
  try {
    if (!modeSet) {
      modeSet = true;
      // Mix with other audio (music the user has on) rather than stopping it.
      void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' }).catch(() => {});
    }
    if (!player) player = createAudioPlayer(require('../../assets/kerching.wav'));
    // Rewind first so a second card in quick succession sounds again.
    void player.seekTo(0).catch(() => {});
    player.play();
  } catch {
    // Silent is fine.
  }
}
