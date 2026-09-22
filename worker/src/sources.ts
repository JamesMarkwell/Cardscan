/**
 * Source adapters.
 *
 * TCGCSV is a community mirror of the TCGplayer catalog (their own API is
 * closed to new developers). Cardmarket publishes official daily price files
 * and is our UK/EU price source. Both are fetched politely: one request at a
 * time, a descriptive user agent, and a cache hint.
 */
import { GameId } from './types';

export interface FetchOptions {
  userAgent: string;
  /** Minimum gap between requests to the same host, in ms. */
  minIntervalMs?: number;
}

const lastRequestAt = new Map<string, number>();

/** Fetch with a descriptive user agent and a per-host rate limit. */
export async function politeFetch(url: string, options: FetchOptions): Promise<Response> {
  const host = new URL(url).host;
  const gap = options.minIntervalMs ?? 1000;
  const previous = lastRequestAt.get(host) ?? 0;
  const wait = previous + gap - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(host, Date.now());

  const response = await fetch(url, {
    headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response;
}

export const TCGCSV_BASE = 'https://tcgcsv.com/tcgplayer';

export interface TcgGroup {
  groupId: number;
  name: string;
  abbreviation: string | null;
  publishedOn: string | null;
}

export interface TcgProduct {
  productId: number;
  name: string;
  cleanName: string;
  imageUrl: string;
  groupId: number;
  extendedData?: Array<{ name: string; displayName: string; value: string }>;
}

export interface TcgPrice {
  productId: number;
  subTypeName: string;
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  directLowPrice: number | null;
}

interface TcgEnvelope<T> {
  success: boolean;
  errors: string[];
  results: T[];
}

export async function fetchGroups(categoryId: number, options: FetchOptions): Promise<TcgGroup[]> {
  const response = await politeFetch(`${TCGCSV_BASE}/${categoryId}/groups`, options);
  return ((await response.json()) as TcgEnvelope<TcgGroup>).results;
}

export async function fetchProducts(categoryId: number, groupId: number, options: FetchOptions): Promise<TcgProduct[]> {
  const response = await politeFetch(`${TCGCSV_BASE}/${categoryId}/${groupId}/products`, options);
  return ((await response.json()) as TcgEnvelope<TcgProduct>).results;
}

export async function fetchPrices(categoryId: number, groupId: number, options: FetchOptions): Promise<TcgPrice[]> {
  const response = await politeFetch(`${TCGCSV_BASE}/${categoryId}/${groupId}/prices`, options);
  return ((await response.json()) as TcgEnvelope<TcgPrice>).results;
}

/** Pull a named field out of TCGplayer's extendedData bag. */
export function extended(product: TcgProduct, field: string): string | null {
  const entry = product.extendedData?.find((item) => item.name === field || item.displayName === field);
  return entry?.value ?? null;
}

export const TCGCSV_CATEGORY: Record<GameId, number> = {
  mtg: 1,
  yugioh: 2,
  pokemon: 3,
  onepiece: 68,
  lorcana: 71,
};

/**
 * Cardmarket's price guide is a gzipped JSON file behind a per-account URL. The
 * URL is configured rather than hard-coded so it can be rotated without a
 * deploy.
 */
export interface CardmarketPrice {
  idProduct: number;
  avg: number | null;
  low: number | null;
  trend: number | null;
  avg7: number | null;
  avg30: number | null;
}

export async function fetchCardmarketPriceGuide(url: string, options: FetchOptions): Promise<CardmarketPrice[]> {
  const response = await politeFetch(url, options);
  const payload = (await response.json()) as { version?: number; priceGuides?: CardmarketPrice[] };
  return payload.priceGuides ?? [];
}
