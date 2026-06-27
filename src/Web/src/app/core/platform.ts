import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ViewportService } from './viewport';

/** How the active platform is chosen: follow the device, or force one. Persisted under {@link PLATFORM_KEY}. */
export type PlatformMode = 'auto' | 'desktop' | 'mobile';

/** The resolved platform a page should render as. */
export type Platform = 'desktop' | 'mobile';

/** localStorage key for the user's manual desktop/mobile override. */
const PLATFORM_KEY = 'uiq.platform';

/**
 * The single source of truth for "which platform am I on right now?" — desktop or mobile — and the seam the
 * whole desktop/mobile split hangs off. It composes the live device signal ({@link ViewportService.isMobile},
 * ≤640px) with a PERSISTED manual override, so:
 *   - `auto` (default) → follow the viewport,
 *   - `desktop` / `mobile` → force that platform regardless of device (the "Switch to desktop/mobile" toggle).
 *
 * The router's per-page `canMatch` guards, the app-shell chrome, and the nav all read {@link isMobile}/
 * {@link platform} from here. Modeled on {@link ThemeService}'s persisted-signal pattern; SSR/no-storage safe
 * (a blocked localStorage just means the override won't survive a reload).
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  private readonly viewport = inject(ViewportService);
  private readonly router = inject(Router);

  /** The user's chosen mode (auto / desktop / mobile), seeded from localStorage. */
  private readonly _override = signal<PlatformMode>(this.read());
  readonly override: Signal<PlatformMode> = this._override.asReadonly();

  /** The resolved platform: an explicit override wins; otherwise the live viewport breakpoint decides. */
  readonly platform = computed<Platform>(() => {
    const o = this._override();
    if (o === 'desktop' || o === 'mobile') return o;
    return this.viewport.isMobile() ? 'mobile' : 'desktop';
  });

  /** True when the resolved platform is mobile (device OR forced). The canMatch + shell read this. */
  readonly isMobile = computed(() => this.platform() === 'mobile');

  /**
   * Switch the override and persist it, then RE-RENDER the current URL in the new platform. `canMatch` only
   * runs on navigation, so we re-navigate to the same URL (router config sets `onSameUrlNavigation: 'reload'`)
   * — the router then re-evaluates the platform `canMatch` and swaps in the other variant's component. We pass
   * the already-serialized `router.url` so query + fragment are preserved.
   */
  setOverride(mode: PlatformMode): void {
    this._override.set(mode);
    try {
      localStorage.setItem(PLATFORM_KEY, mode);
    } catch {
      /* private mode / storage disabled — runtime still updates, just not persisted */
    }
    void this.router.navigateByUrl(this.router.url, { onSameUrlNavigation: 'reload' });
  }

  /** Convenience for the "Switch to desktop/mobile site" control: force the OTHER platform. */
  toggle(): void {
    this.setOverride(this.isMobile() ? 'desktop' : 'mobile');
  }

  /** Drop the override and follow the device again. */
  useAuto(): void {
    this.setOverride('auto');
  }

  private read(): PlatformMode {
    try {
      const v = localStorage.getItem(PLATFORM_KEY);
      if (v === 'auto' || v === 'desktop' || v === 'mobile') return v;
    } catch {
      /* ignore */
    }
    return 'auto';
  }
}
