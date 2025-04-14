import { FontEngine } from '../font.js';
import { segment } from '../utils.js';

export function genMeasurer(
  engine: FontEngine,
  isImage: (grapheme: string) => boolean
): {
  measureGrapheme: (grapheme: string, fontSize: number, letterSpacing: number) => number;
  measureGraphemeArray: (graphemes: string[], fontSize: number, letterSpacing: number) => number;
  measureText: (text: string, fontSize: number, letterSpacing: number) => number;
} {
  const cache = new Map<string, number>();

  function measureGrapheme(grapheme: string, fontSize: number, letterSpacing: number): number {
    const cacheKey = `${grapheme}-${fontSize}-${letterSpacing}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const width = engine.measure(grapheme, { fontSize, letterSpacing });
    cache.set(cacheKey, width);

    return width;
  }

  function measureGraphemeArray(graphemes: string[], fontSize: number, letterSpacing: number): number {
    let width = 0;

    for (const grapheme of graphemes) {
      if (isImage(grapheme)) {
        width += fontSize;
      } else {
        width += measureGrapheme(grapheme, fontSize, letterSpacing);
      }
    }

    return width;
  }

  function measureText(text: string, fontSize: number, letterSpacing: number): number {
    return measureGraphemeArray(segment(text, 'grapheme'), fontSize, letterSpacing);
  }

  return {
    measureGrapheme,
    measureGraphemeArray,
    measureText,
  };
}