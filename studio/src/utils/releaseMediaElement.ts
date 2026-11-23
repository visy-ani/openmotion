/**
 * Stops playback and detaches the media pipeline on unmount or slide change so
 * Chromium releases hardware video decoders and buffered frame memory immediately.
 */
export function releaseMediaElement(element: HTMLMediaElement | null | undefined): void {
  if (!element) return;
  try {
    element.pause();
    element.removeAttribute('src');
    element.load();
  } catch {
    /* ignore detached or simulated DOM media errors */
  }
}
