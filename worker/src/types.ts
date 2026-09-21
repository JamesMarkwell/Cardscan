export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  USER_AGENT: string;
  /** Minimum gap between requests to a source host. Defaults to 1000ms. */
  SOURCE_MIN_INTERVAL_MS?: string;
  PUBLIC_BASE_URL: string;
  WORKER_ADMIN_TOKEN?: string;
}

export type GameId = 'pokemon' | 'onepiece' | 'mtg' | 'yugioh' | 'lorcana';

export interface SetRow {
  id: string;
  gameId: GameId;
  code: string;
  name: string;
  releaseDate: string | null;
  cardCount: number | null;
}

export interface CardRow {
  id: string;
  gameId: GameId;
  name: string;
  artId: string;
}

export interface PrintingRow {
  id: string;
  cardId: string;
  gameId: GameId;
  setId: string;
  number: string;
  setTotal: string | null;
  rarity: string | null;
  variant: string;
  language: string;
  tcgplayerProductId: number | null;
  cardmarketProductId: number | null;
  imageKey: string | null;
  imageUrl: string | null;
  updatedAt: string;
}

export interface PriceRow {
  printingId: string;
  source: 'tcgplayer' | 'cardmarket';
  currency: string;
  market: number | null;
  low: number | null;
  trend: number | null;
  avg7: number | null;
  avg30: number | null;
  asOf: string;
}

export interface CatalogDelta {
  from: string;
  to: string;
  sets: SetRow[];
  cards: CardRow[];
  printings: PrintingRow[];
  prices: PriceRow[];
  removedPrintings: string[];
}

export interface GameManifest {
  game: GameId;
  version: string;
  printingsCount: number;
  catalogUrl: string;
  indexUrl: string;
  indexIdsUrl: string;
  deltas: Array<{ from: string; to: string; url: string }>;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  games: GameManifest[];
}
