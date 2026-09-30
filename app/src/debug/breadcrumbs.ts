/**
 * Breadcrumbs that survive a crash.
 *
 * A release build has no console and no red error screen, and when the app is
 * killed mid-scan nothing on screen says why. This appends short timestamped
 * lines to a file, synchronously, as each step starts — so after a restart the
 * last line written is the last thing that ran. It also records any fatal
 * JavaScript error, which in a release build closes the app silently and is
 * otherwise indistinguishable from a native crash.
 *
 * Every function here swallows its own failures: diagnostics must never be the
 * reason the app breaks.
 */
import { File, Paths } from 'expo-file-system';

const LOG_NAME = 'scan-log.txt';
// Start a fresh file once it grows past this, so it can't grow without bound.
const MAX_BYTES = 60_000;

let file: File | null = null;

function logFile(): File {
  if (!file) file = new File(Paths.document, LOG_NAME);
  return file;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Append one line, synchronously, so it lands even if the app dies next. */
export function crumb(message: string): void {
  try {
    const target = logFile();
    if (!target.exists) target.create();
    target.write(`${stamp()} ${message}\n`, { append: true });
  } catch {
    // Diagnostics only.
  }
}

/** The last `maxLines` lines written, oldest first. */
export async function readCrumbs(maxLines = 40): Promise<string[]> {
  try {
    const target = logFile();
    if (!target.exists) return [];
    const text = await target.text();
    return text.split('\n').filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler(): ErrorHandler;
  setGlobalHandler(handler: ErrorHandler): void;
}

/**
 * Call once at start-up. Marks a new session in the log and records every
 * uncaught JavaScript error (fatal ones are what close a release build) before
 * handing it on to React Native's own handler.
 */
export function installCrashLogger(): void {
  try {
    const target = logFile();
    if (target.exists && (target.size ?? 0) > MAX_BYTES) target.write('');
  } catch {
    // Diagnostics only.
  }
  crumb('--- session start ---');

  try {
    const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (!errorUtils) return;
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      const err = error as { message?: string; stack?: string } | null;
      const detail = `${err?.message ?? String(error)} | ${(err?.stack ?? '').split('\n').slice(0, 4).join(' / ')}`;
      crumb(`${isFatal ? 'FATAL' : 'ERROR'}: ${detail.slice(0, 600)}`);
      previous(error, isFatal);
    });
  } catch {
    // Diagnostics only.
  }
}
