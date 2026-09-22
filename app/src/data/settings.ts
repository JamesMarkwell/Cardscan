/** Small JSON-file settings store — no extra native dependency needed. */
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { GameId } from './types';

/**
 * Baked-in catalog URL, so the app can sync on first launch without anyone
 * opening Settings. It comes from Expo config `extra.catalogUrl`, which
 * app.config.js fills from the CARDSCAN_CATALOG_URL environment variable at
 * build time — so no backend URL lives in committed source. A build that does
 * not set it (a fork, a local build) gets a blank default and the Settings
 * field is used instead.
 */
export const DEFAULT_CATALOG_URL: string =
  (Constants.expoConfig?.extra?.catalogUrl as string | undefined)?.trim() ?? '';

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
  apiBaseUrl: DEFAULT_CATALOG_URL,
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
    const stored = JSON.parse(file.textSync()) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // A blank stored URL should not mask a newly baked-in default.
    if (!merged.apiBaseUrl) merged.apiBaseUrl = DEFAULT_CATALOG_URL;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  const file = settingsFile();
  if (!file.exists) file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(settings, null, 2));
}
