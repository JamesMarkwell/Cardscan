/** Small JSON-file settings store — no extra native dependency needed. */
import { File, Paths } from 'expo-file-system';
import { GameId } from './types';

/**
 * Baked-in catalog URL, so the app syncs on first launch without anyone opening
 * Settings. Set this to the deployed Worker's URL, e.g.
 * "https://cardscan-worker.<your-subdomain>.workers.dev". Left blank until the
 * Worker is deployed; the Settings field still overrides it.
 */
export const DEFAULT_CATALOG_URL = '';

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
