export const theme = {
  background: '#0B0E14',
  surface: '#141A23',
  surfaceAlt: '#1D2733',
  border: '#27313F',
  text: '#F2F5F9',
  textMuted: '#8A97A8',
  accent: '#4C8DFF',
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
