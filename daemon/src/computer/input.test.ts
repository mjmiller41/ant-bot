import { describe, it, expect } from 'vitest';
import { toPageCoords, isForwardableKey, clampWheel } from './input.js';

const frame = { width: 1280, height: 720 };

describe('toPageCoords', () => {
  it('scales a normalised point to page pixels', () => {
    expect(toPageCoords({ x: 0.5, y: 0.5 }, frame)).toEqual({ x: 640, y: 360 });
    expect(toPageCoords({ x: 0, y: 0 }, frame)).toEqual({ x: 0, y: 0 });
  });

  // x = 1.0 maps to 1280, which is one pixel outside a 1280-wide viewport — Chromium ignores it
  // rather than treating it as an edge click, so the bottom-right corner would be unclickable.
  it('keeps the far edge inside the viewport', () => {
    expect(toPageCoords({ x: 1, y: 1 }, frame)).toEqual({ x: 1279, y: 719 });
  });

  it('clamps a point outside the frame rather than dispatching off-page', () => {
    expect(toPageCoords({ x: -0.5, y: 2 }, frame)).toEqual({ x: 0, y: 719 });
  });

  it('rounds to whole pixels', () => {
    expect(toPageCoords({ x: 0.3334, y: 0.6667 }, frame)).toEqual({ x: 427, y: 480 });
  });

  it('scales against the actual frame, not a fixed size', () => {
    expect(toPageCoords({ x: 0.5, y: 0.5 }, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
  });

  // The dangerous case: no frame yet means no geometry, and a guessed (0,0) is a real click on
  // whatever sits in the top-left corner.
  it('refuses when no frame has arrived', () => {
    expect(toPageCoords({ x: 0.5, y: 0.5 }, undefined)).toBeNull();
  });

  it('refuses a degenerate or non-finite frame', () => {
    expect(toPageCoords({ x: 0.5, y: 0.5 }, { width: 0, height: 720 })).toBeNull();
    expect(toPageCoords({ x: 0.5, y: 0.5 }, { width: -10, height: 720 })).toBeNull();
    expect(toPageCoords({ x: 0.5, y: 0.5 }, { width: NaN, height: 720 })).toBeNull();
  });

  it('refuses a non-finite point', () => {
    expect(toPageCoords({ x: NaN, y: 0.5 }, frame)).toBeNull();
    expect(toPageCoords({ x: 0.5, y: Infinity }, frame)).toBeNull();
  });
});

describe('isForwardableKey', () => {
  it('allows ordinary keys, including the ones a blocked step needs', () => {
    for (const k of ['a', 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'Shift', 'Control']) {
      expect(isForwardableKey(k)).toBe(true);
    }
  });

  // These close or navigate away from the page the human took over to rescue, or open browser
  // chrome the screencast cannot show.
  it('blocks keys that would lose or hide the page', () => {
    for (const k of ['F5', 'F11', 'F12', 'BrowserRefresh', 'BrowserBack', 'BrowserForward']) {
      expect(isForwardableKey(k)).toBe(false);
    }
  });

  it('rejects an empty key', () => {
    expect(isForwardableKey('')).toBe(false);
  });
});

describe('clampWheel', () => {
  it('passes ordinary deltas through, rounded', () => {
    expect(clampWheel(120)).toBe(120);
    expect(clampWheel(-53.7)).toBe(-54);
  });

  it('bounds an absurd delta instead of scrolling into the void', () => {
    expect(clampWheel(1e9)).toBe(1000);
    expect(clampWheel(-1e9)).toBe(-1000);
  });

  it('treats a non-finite delta as no scroll', () => {
    expect(clampWheel(NaN)).toBe(0);
    expect(clampWheel(Infinity)).toBe(0);
  });
});
