// Turning normalised screencast input into page coordinates.
//
// The client sends fractions of the frame, not pixels, because neither side knows the other's
// geometry: the screencast is captured at up to 1280px wide (Chromium picks the scale), and the
// browser then fits that image into whatever the pane happens to be. Pixels sent from the client
// would be in a third coordinate space belonging to neither.
//
// Pure, so every rounding and clamping case below is testable without a browser.

/** Viewport size reported by the most recent screencast frame, in CSS pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Converts a normalised point to page CSS pixels, or null when the conversion cannot be trusted.
 *
 * Null rather than a clamped guess when the frame size is unknown or degenerate: dispatching a
 * click at (0, 0) because no frame has arrived yet would hit whatever is in the top-left corner,
 * which is exactly the kind of silent wrong action this codebase avoids.
 */
export function toPageCoords(
  norm: { x: number; y: number },
  frame: FrameSize | undefined,
): { x: number; y: number } | null {
  if (!frame) return null;
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return null;
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (!Number.isFinite(norm.x) || !Number.isFinite(norm.y)) return null;

  const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
  // Clamped to the last addressable pixel: x = 1.0 would otherwise land one pixel outside the
  // viewport, which Chromium ignores rather than treating as an edge click.
  return {
    x: Math.min(Math.round(clamp01(norm.x) * frame.width), frame.width - 1),
    y: Math.min(Math.round(clamp01(norm.y) * frame.height), frame.height - 1),
  };
}

/**
 * Keys that must not be forwarded to the page, whatever the client sends.
 *
 * These either close or navigate away from the page the human was asked to unblock — losing the
 * session they took over to rescue — or they open browser-level UI the screencast cannot show,
 * leaving the view frozen on a page that is no longer in front. The human still has every normal
 * key, including Tab, Enter and Escape.
 */
const BLOCKED_KEYS = new Set(['F5', 'F11', 'F12', 'BrowserRefresh', 'BrowserBack', 'BrowserForward']);

/** Whether a key event is safe to dispatch into a taken-over page. */
export function isForwardableKey(key: string): boolean {
  return key.length > 0 && !BLOCKED_KEYS.has(key);
}

/**
 * Wheel deltas, bounded. An unbounded delta from a malformed client would scroll a page by
 * millions of pixels in one event; clamping keeps a bad frame from being disorienting.
 */
export function clampWheel(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  const MAX = 1000;
  return Math.max(-MAX, Math.min(MAX, Math.round(delta)));
}
