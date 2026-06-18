import {
  Component, ElementRef, OnDestroy, computed, inject, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

/** Minimal structural type for the native BarcodeDetector (not in lib.dom yet). */
interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?(): Promise<string[]>;
}

/** Scanner control surface from the lazily-loaded @zxing fallback (only the stop hook we use). */
interface ScannerControls { stop(): void }

/**
 * Live UPC/EAN barcode scanner. Opens the camera via getUserMedia and decodes codes using the native
 * `BarcodeDetector` when available; otherwise it DYNAMICALLY imports `@zxing/browser` as a fallback
 * (kept out of the eager + tracker chunks until a device actually lacks BarcodeDetector). On a detected
 * code it emits {@link detected} once; the parent then runs the barcode food lookup.
 *
 * Degrades gracefully: requires HTTPS or localhost + camera permission. When the camera or both decode
 * paths are unavailable it surfaces a friendly error and the parent's manual UPC text input still works.
 */
@Component({
  selector: 'app-barcode-scanner',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  templateUrl: './barcode-scanner.html',
  styleUrl: './barcode-scanner.scss',
})
export class BarcodeScanner implements OnDestroy {
  /** Emits the detected (or manually entered) UPC/EAN code. */
  readonly detected = output<string>();

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly scanning = signal(false);
  readonly starting = signal(false);
  readonly error = signal<string | null>(null);
  /** The detection engine in use, for the status caption. */
  readonly engine = signal<'native' | 'zxing' | null>(null);

  /** Manual UPC entry (the always-available fallback when the camera/API is unavailable). */
  readonly manualCode = signal('');
  readonly manualValid = computed(() => /^\d{6,14}$/.test(this.manualCode().trim()));

  private stream: MediaStream | null = null;
  private rafId = 0;
  private zxingControls: ScannerControls | null = null;
  private done = false;

  /** True when the browser can do live camera scanning at all (secure context + getUserMedia). */
  readonly cameraSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    (typeof window === 'undefined' || window.isSecureContext);

  private get detectorCtor(): BarcodeDetectorCtor | undefined {
    return (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  }

  async start(): Promise<void> {
    if (this.scanning() || this.starting()) return;
    this.error.set(null);
    this.done = false;

    if (!this.cameraSupported) {
      this.error.set('Camera scanning needs HTTPS (or localhost) and a supported browser. Enter the UPC below instead.');
      return;
    }

    this.starting.set(true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch {
      this.starting.set(false);
      this.error.set('Could not open the camera. Grant camera permission, or enter the UPC below.');
      return;
    }

    const videoEl = this.video()?.nativeElement;
    if (!videoEl) {
      this.starting.set(false);
      this.stopStream();
      return;
    }

    videoEl.srcObject = this.stream;
    videoEl.setAttribute('playsinline', 'true');
    try {
      await videoEl.play();
    } catch {
      /* autoplay can reject silently; the stream is still live */
    }

    this.scanning.set(true);
    this.starting.set(false);

    if (this.detectorCtor) {
      this.engine.set('native');
      this.runNative(videoEl);
    } else {
      await this.runZxing(videoEl);
    }
  }

  /** Native BarcodeDetector loop: poll frames on requestAnimationFrame. */
  private runNative(videoEl: HTMLVideoElement): void {
    const ctor = this.detectorCtor!;
    const detector = new ctor({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
    });
    const tick = async () => {
      if (this.done || !this.scanning()) return;
      try {
        if (videoEl.readyState >= 2) {
          const codes = await detector.detect(videoEl);
          const raw = codes[0]?.rawValue?.trim();
          if (raw) { this.emit(raw); return; }
        }
      } catch {
        /* transient decode errors are expected between frames */
      }
      this.rafId = requestAnimationFrame(() => void tick());
    };
    this.rafId = requestAnimationFrame(() => void tick());
  }

  /** Fallback path: lazily import @zxing/browser and decode continuously from the live element. */
  private async runZxing(videoEl: HTMLVideoElement): Promise<void> {
    this.engine.set('zxing');
    try {
      const mod = await import('@zxing/browser');
      const reader = new mod.BrowserMultiFormatReader();
      this.zxingControls = await reader.decodeFromVideoElement(videoEl, (result) => {
        if (this.done) return;
        const text = result?.getText?.()?.trim();
        if (text) this.emit(text);
      });
    } catch {
      this.error.set('Live scanning is unavailable on this device. Enter the UPC below instead.');
      this.stop();
    }
  }

  private emit(code: string): void {
    if (this.done) return;
    this.done = true;
    this.stop();
    this.detected.emit(code);
  }

  submitManual(): void {
    if (!this.manualValid()) return;
    this.detected.emit(this.manualCode().trim());
  }

  /** Stop scanning and release the camera. */
  stop(): void {
    this.scanning.set(false);
    this.starting.set(false);
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (this.zxingControls) { try { this.zxingControls.stop(); } catch { /* ignore */ } this.zxingControls = null; }
    this.stopStream();
  }

  private stopStream(): void {
    const videoEl = this.video()?.nativeElement;
    if (videoEl) videoEl.srcObject = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
      this.stream = null;
    }
  }

  ngOnDestroy(): void {
    this.done = true;
    this.stop();
  }
}
