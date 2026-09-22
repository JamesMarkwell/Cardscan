/**
 * The catalog/collection database opens a single shared connection even when
 * several callers race to open it — the mount effect, the launch auto-sync and
 * the Settings "Sync now" button all call openDatabase() at once. Two opens
 * would orphan one native handle and later fail a query with a
 * NullPointerException, so this guards against a regression of that crash.
 */
import * as SQLite from 'expo-sqlite';
import { closeDatabase, openDatabase } from '../data/db';

jest.mock('expo-sqlite', () => {
  const db = {
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: 1 }),
    runAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
  return { openDatabaseAsync: jest.fn().mockResolvedValue(db) };
});

const openDatabaseAsync = SQLite.openDatabaseAsync as jest.Mock;

afterEach(async () => {
  await closeDatabase();
  openDatabaseAsync.mockClear();
  openDatabaseAsync.mockResolvedValue({
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: 1 }),
    runAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  });
});

it('opens a single connection when callers race', async () => {
  const handles = await Promise.all([openDatabase(), openDatabase(), openDatabase(), openDatabase()]);

  expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
  for (const handle of handles) expect(handle).toBe(handles[0]);
});

it('reuses the cached connection on later calls', async () => {
  const first = await openDatabase();
  const second = await openDatabase();

  expect(first).toBe(second);
  expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
});

it('does not cache a failed open, so a later call retries', async () => {
  openDatabaseAsync.mockRejectedValueOnce(new Error('database is locked'));

  await expect(openDatabase()).rejects.toThrow('database is locked');

  const handle = await openDatabase();
  expect(handle).toBeDefined();
  expect(openDatabaseAsync).toHaveBeenCalledTimes(2);
});
