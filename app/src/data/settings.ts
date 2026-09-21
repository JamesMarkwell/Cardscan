/** Small JSON-file settings store — no extra native dependency needed. */
import { File, Paths } from 'expo-file-system';
import { GameId } from './types';

export interface Settings {
  /** Base URL of the CardScan Worker that serves the manifest and packs. */
  apiBaseUrl: string;
  gameId: GameId;
  currency: 'GBP' | 'USD' | 'EUR';
  /** Keep corrections locally so the model can be tuned later. */
  shareCorrections: boolean;
  autoAddHighConfidence: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: '',
  gameId: 'onepiece',
  currency: 'GBP',
  shareCorrections: false,
  autoAddHighConfidence: true,
};

function settingsFile(): File {
  return new File(Paths.document, 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const file = settingsFile();
    if (!file.exists) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(file.textSync()) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  const file = settingsFile();
  if (!file.exists) file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(settings, null, 2));
}
