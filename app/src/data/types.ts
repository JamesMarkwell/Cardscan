/** Shared catalog types — mirrors the D1 schema in /worker/migrations. */

export type GameId = 'pokemon' | 'onepiece' | 'mtg' | 'yugioh' | 'lorcana';

export const GAMES: Array<{ id: GameId; name: string }> = [
  { id: 'onepiece', name: 'One Piece' },
  { id: 'pokemon', name: 'Pokémon' },
  { id: 'mtg', name: 'Magic: The Gathering' },
  { id: 'yugioh', name: 'Yu-Gi-Oh!' },
  { id: 'lorcana', name: 'Lorcana' },
];

export type Variant = 'normal' | 'foil' | 'reverse' | 'first_edition';

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export interface Card {
  id: string;
  gameId: GameId;
  name: string;
  /** Groups reprints that share the same artwork — this is what a scan matches. */
  artId: string;
}

export interface Printing {
  id: string;
  cardId: string;
  gameId: GameId;
  name: string;
  setId: string;
  setCode: string;
  setName: string;
  number: string;
  setTotal: string | null;
  rarity: string | null;
  variant: Variant;
  language: string;
  imageKey: string | null;
  tcgplayerProductId: number | null;
  cardmarketProductId: number | null;
}

export type PriceSource = 'tcgplayer' | 'cardmarket';

export interface Price {
  printingId: string;
  source: PriceSource;
  currency: string;
  market: number | null;
  low: number | null;
  trend: number | null;
  avg7: number | null;
  avg30: number | null;
  asOf: string;
}

export interface CollectionEntry {
  id: number;
  portfolioId: number;
  printingId: string;
  variant: Variant;
  condition: Condition;
  quantity: number;
  /** What was paid, in the portfolio's currency. */
  costBasis: number | null;
  addedAt: string;
}

export interface Portfolio {
  id: number;
  name: string;
  currency: string;
  createdAt: string;
}
