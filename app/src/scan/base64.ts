/**
 * Base64 -> bytes.
 *
 * Written out rather than relying on atob/Buffer: Hermes' atob returns a binary
 * string (one more copy of a megabyte-sized buffer per frame) and Buffer is not
 * part of React Native.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function base64ToBytes(base64: string): Uint8Array {
  const input = base64.replace(/[\r\n\s]/g, '');
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const length = Math.floor((input.length * 3) / 4) - padding;
  const bytes = new Uint8Array(length);

  let out = 0;
  for (let i = 0; i < input.length; i += 4) {
    const c0 = LOOKUP[input.charCodeAt(i)];
    const c1 = LOOKUP[input.charCodeAt(i + 1)];
    const c2 = LOOKUP[input.charCodeAt(i + 2)];
    const c3 = LOOKUP[input.charCodeAt(i + 3)];

    if (out < length) bytes[out++] = (c0 << 2) | (c1 >> 4);
    if (out < length) bytes[out++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (out < length) bytes[out++] = ((c2 & 3) << 6) | c3;
  }

  return bytes;
}
