import type { ImageRequest } from '../../core/models';

/**
 * Shared helpers for the tracker's AI photo features (photo-meal, read-label). Two concerns:
 *
 *  1. {@link captureImage} — open the OS camera / photo picker, downscale the chosen image to a small
 *     JPEG, and hand back the raw base64 + mime type the API's {@link ImageRequest} expects (NO `data:`
 *     prefix). Keeping uploads small (<=1024px long edge, JPEG ~0.8) keeps them cheap + fast on the wire
 *     and well under the API's ~5 MB cap.
 *
 *  2. {@link confirmPhotoNotice} — show a ONE-TIME privacy notice before the first photo use, gated by a
 *     localStorage flag, so users know the image goes to Google Gemini and is not stored by Usage IQ.
 *
 * Both are framework-free (no Angular DI), so any dialog/component can call them directly.
 */

/** Max length of the long edge after downscale — keeps the JPEG small + cheap for the multimodal call. */
const MAX_EDGE = 1024;

/** JPEG quality for the re-encode (good detail/size trade-off for food + label photos). */
const JPEG_QUALITY = 0.8;

/** The output mime type after re-encoding (always JPEG — smallest for photographic content). */
const OUTPUT_MIME = 'image/jpeg';

/** localStorage key gating the one-time "your photo goes to Gemini" notice. */
const PHOTO_NOTICE_KEY = 'usage_iq_ai_photo_notice';

/** The one-time notice copy shown before the FIRST photo use. */
const PHOTO_NOTICE_TEXT =
  'Your photo is sent to Google Gemini to analyze the food — it is not stored by Usage IQ.';

/**
 * Capture (camera) or pick an image, downscale it to <= {@link MAX_EDGE}px on the long edge, re-encode as
 * JPEG (~{@link JPEG_QUALITY}), and return the raw base64 (no `data:` prefix) + mime type ready to POST as
 * an {@link ImageRequest}. Resolves to `null` when the user cancels the picker (no file chosen).
 *
 * Uses a throwaway `<input type=file accept=image/* capture=environment>` so on mobile it offers the rear
 * camera, and on desktop it falls back to a normal file picker. Rejects on a non-image file or a decode
 * failure so the caller can surface a friendly error.
 */
export function captureImage(): Promise<ImageRequest | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // Hint mobile browsers to offer the rear camera; harmless (ignored) on desktop.
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';

    // If the picker is dismissed, most browsers fire no event at all; we resolve(null) on a focus-back
    // sweep so the promise never hangs. `change` (a real selection) wins the race and clears it.
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('focus', onFocus, true);
      input.remove();
    };
    const onFocus = () => {
      // Defer: the `change` event fires shortly AFTER focus returns when a file WAS chosen.
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          settled = true;
          cleanup();
          resolve(null);
        }
      }, 400);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
        return;
      }
      settled = true;
      window.removeEventListener('focus', onFocus, true);
      input.remove();

      if (!file.type.startsWith('image/')) {
        reject(new Error('Please choose an image file.'));
        return;
      }
      downscaleToJpeg(file).then(resolve, reject);
    });

    window.addEventListener('focus', onFocus, true);
    input.click();
  });
}

/**
 * PICK an image from the device gallery / files (the sibling of {@link captureImage}), downscale it to
 * <= {@link MAX_EDGE}px on the long edge, re-encode as JPEG (~{@link JPEG_QUALITY}), and return the raw
 * base64 (no `data:` prefix) + mime type ready to POST as an {@link ImageRequest}. Resolves to `null`
 * when the user cancels the picker (no file chosen).
 *
 * Identical to {@link captureImage} EXCEPT it omits the `capture` attribute, so on mobile the OS offers
 * the photo library / file browser (not just the rear camera) — letting the user attach an existing photo.
 * Rejects on a non-image file or a decode failure so the caller can surface a friendly error.
 */
export function pickImage(): Promise<ImageRequest | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // NOTE: deliberately NO `capture` attribute — mobile then offers the gallery/files, not just the camera.
    input.style.display = 'none';

    // If the picker is dismissed, most browsers fire no event at all; we resolve(null) on a focus-back
    // sweep so the promise never hangs. `change` (a real selection) wins the race and clears it.
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('focus', onFocus, true);
      input.remove();
    };
    const onFocus = () => {
      // Defer: the `change` event fires shortly AFTER focus returns when a file WAS chosen.
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          settled = true;
          cleanup();
          resolve(null);
        }
      }, 400);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
        return;
      }
      settled = true;
      window.removeEventListener('focus', onFocus, true);
      input.remove();

      if (!file.type.startsWith('image/')) {
        reject(new Error('Please choose an image file.'));
        return;
      }
      downscaleToJpeg(file).then(resolve, reject);
    });

    window.addEventListener('focus', onFocus, true);
    input.click();
  });
}

/**
 * Decode a File/Blob, downscale so the long edge is <= {@link MAX_EDGE}px (never UP-scaling), re-encode as
 * a JPEG, and return its raw base64 + mime type. Shared by {@link captureImage} / {@link pickImage};
 * exported for callers that already hold a Blob (e.g. a drag-drop or paste).
 */
export async function downscaleToJpeg(file: Blob): Promise<ImageRequest> {
  const { source, cleanup } = await loadBitmap(file);
  try {
    const { width, height } = source;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process the image.');
    ctx.drawImage(source, 0, 0, outW, outH);

    const dataUrl = canvas.toDataURL(OUTPUT_MIME, JPEG_QUALITY);
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    if (!base64) throw new Error('Could not process the image.');
    return { imageBase64: base64, mimeType: OUTPUT_MIME };
  } finally {
    // Free the bitmap / revoke the object URL AFTER drawing (revoking earlier can break drawImage).
    cleanup();
  }
}

/**
 * Read a Blob/File as raw base64 (NO `data:` prefix) — used for files we forward to the model WITHOUT a
 * canvas re-encode, e.g. a PDF schedule upload (where there's nothing to downscale). Rejects on a read
 * failure so the caller can surface a friendly error.
 */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      if (!base64) reject(new Error('Could not read that file.'));
      else resolve(base64);
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Decode a Blob into something drawable. Prefers `createImageBitmap` (off-thread, no DOM), falling back to
 * an `<img>` + object URL on older browsers. Returns either an ImageBitmap or an HTMLImageElement — both
 * are valid `drawImage` sources.
 */
async function loadBitmap(file: Blob): Promise<{ source: ImageBitmap | HTMLImageElement; cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, cleanup: () => bmp.close() };
    } catch {
      // Fall through to the <img> path (e.g. some webp/HEIC cases).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read the image.'));
      i.src = url;
    });
    // Revoke only via cleanup() AFTER the caller draws it — revoking now can break drawImage.
    return { source: img, cleanup: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Has the one-time photo-privacy notice already been acknowledged? Lets a caller pre-check (e.g. to skip
 * an extra await) without showing the prompt.
 */
export function photoNoticeAcknowledged(): boolean {
  try {
    return localStorage.getItem(PHOTO_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Gate the FIRST photo use behind a one-time privacy notice. If the notice has already been acknowledged
 * (localStorage flag {@link PHOTO_NOTICE_KEY}), resolves `true` immediately with no prompt. Otherwise shows
 * the {@link PHOTO_NOTICE_TEXT} confirm: on accept it sets the flag and resolves `true` (proceed); on
 * cancel it resolves `false` (abort) WITHOUT setting the flag, so the notice shows again next time.
 *
 * Returns a Promise so callers can `await` it uniformly regardless of whether a prompt was shown.
 */
export function confirmPhotoNotice(): Promise<boolean> {
  if (photoNoticeAcknowledged()) return Promise.resolve(true);
  const proceed = typeof window !== 'undefined' && window.confirm(PHOTO_NOTICE_TEXT);
  if (proceed) {
    try {
      localStorage.setItem(PHOTO_NOTICE_KEY, '1');
    } catch {
      // Non-fatal: a blocked localStorage just means we re-show the notice next time.
    }
  }
  return Promise.resolve(proceed);
}
