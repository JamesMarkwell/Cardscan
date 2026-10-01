/** CardScan's look: dark grey surfaces with an orange accent. */
export const theme = {
  background: '#121316',
  surface: '#1C1E23',
  surfaceAlt: '#262930',
  border: '#33363E',
  text: '#F5F3EF',
  textMuted: '#9A9EA8',
  /** The brand orange. */
  accent: '#FF7A1A',
  /** A faint orange wash for selected/active backgrounds. */
  accentSoft: 'rgba(255,122,26,0.16)',
  /** Text and icons that sit on the orange (dark, for contrast). */
  onAccent: '#14110D',
  high: '#3DD68C',
  check: '#F5B942',
  low: '#F2686B',
  radius: 14,
  spacing: (n: number) => n * 8,
} as const;

export const tierColour = { high: theme.high, check: theme.check, low: theme.low } as const;

export const tierLabel = {
  high: 'High confidence',
  check: 'Worth a check',
  low: 'Not sure — pick one',
} as const;

/** A colour per game, for charts and tags. */
export const gameColour: Record<string, string> = {
  onepiece: '#FF7A1A',
  pokemon: '#F5B942',
  mtg: '#3DD68C',
  yugioh: '#4C8DFF',
  lorcana: '#B07CFF',
};
