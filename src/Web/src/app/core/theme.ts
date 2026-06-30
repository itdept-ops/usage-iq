import { Injectable, signal, computed, effect } from '@angular/core';

/** The three user-selectable theme modes. 'system' follows the OS `prefers-color-scheme`. */
export type ThemeMode = 'system' | 'light' | 'dark';

/** The actually-applied palette after resolving 'system'. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * The FiMobile color-scheme axis — orthogonal to light/dark. 'default' is the template's blue;
 * the other nine recolor the accent family (links, buttons, active states, charts, hero gradient).
 * Applied as `<html data-scheme="…">` (omitted for 'default'); the CSS lives in styles.scss.
 */
export type ColorScheme =
  | 'default'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'cyan';

/** Ordered list for pickers, each with the representative swatch hex (the light-mode accent). */
export const COLOR_SCHEMES: ReadonlyArray<{ value: ColorScheme; label: string; swatch: string }> = [
  { value: 'default', label: 'Blue', swatch: '#2a4fd6' },
  { value: 'indigo', label: 'Indigo', swatch: '#6610f2' },
  { value: 'purple', label: 'Purple', swatch: '#6f42c1' },
  { value: 'pink', label: 'Pink', swatch: '#d63384' },
  { value: 'red', label: 'Red', swatch: '#f73563' },
  { value: 'orange', label: 'Orange', swatch: '#fd7e14' },
  { value: 'yellow', label: 'Yellow', swatch: '#ffbd17' },
  { value: 'green', label: 'Green', swatch: '#1fa97e' },
  { value: 'teal', label: 'Teal', swatch: '#0a96a1' },
  { value: 'cyan', label: 'Cyan', swatch: '#0bb6d8' },
];

const VALID_SCHEMES = new Set<ColorScheme>(COLOR_SCHEMES.map((s) => s.value));

/** localStorage keys — MUST match the no-flash bootstrap in index.html. */
const THEME_KEY = 'uiq.theme';
const SCHEME_KEY = 'uiq.scheme';

/**
 * Owns the app's light/dark theme at runtime.
 *
 * The COLD-START application of the saved theme lives in an inline script in index.html (so the very
 * first paint already carries the right `data-theme` — no flash). This service then takes over:
 *   - exposes the user's chosen {@link ThemeMode} (persisted to localStorage) as a signal,
 *   - re-applies `data-theme` on <html> whenever the mode (or, for 'system', the OS preference) changes,
 *   - listens to `matchMedia('(prefers-color-scheme: …)')` so 'system' tracks the OS live.
 *
 * `data-theme` drives the `[data-theme="light"]` palette override in styles.scss; absence/`"dark"` is the
 * default dark console. The inline bootstrap and this service use the SAME key + resolution logic.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** The user's chosen mode (System / Light / Dark), seeded from localStorage. */
  private readonly _mode = signal<ThemeMode>(this.readMode());
  readonly mode = this._mode.asReadonly();

  /** The user's chosen color scheme (FiMobile accent axis), seeded from localStorage. */
  private readonly _scheme = signal<ColorScheme>(this.readScheme());
  readonly scheme = this._scheme.asReadonly();

  /** The OS preference (only consulted when mode === 'system'), kept live by the matchMedia listener. */
  private readonly _systemDark = signal<boolean>(this.systemPrefersDark());

  /** The palette actually in effect, after resolving 'system' against the OS preference. */
  readonly resolved = computed<ResolvedTheme>(() => {
    const m = this._mode();
    if (m === 'light') return 'light';
    if (m === 'dark') return 'dark';
    return this._systemDark() ? 'dark' : 'light';
  });

  constructor() {
    // Keep <html data-theme> + the persisted choice in sync with the signals. Runs once on boot too,
    // which harmlessly re-affirms what the index.html bootstrap already set (idempotent).
    effect(() => {
      const resolved = this.resolved();
      if (typeof document !== 'undefined') {
        document.documentElement.dataset['theme'] = resolved;
      }
    });

    // Apply the color scheme as <html data-scheme>; 'default' (blue) carries no attribute so the
    // base palette in styles.scss applies. Mirrors the no-flash bootstrap in index.html (idempotent).
    effect(() => {
      const scheme = this._scheme();
      if (typeof document === 'undefined') return;
      if (scheme === 'default') {
        delete document.documentElement.dataset['scheme'];
      } else {
        document.documentElement.dataset['scheme'] = scheme;
      }
    });

    // Live OS-preference tracking for 'system' mode.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e: MediaQueryListEvent) => this._systemDark.set(e.matches);
      // addEventListener is the modern API; the deprecated addListener is the Safari <14 fallback.
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange);
      } else if (typeof mq.addListener === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        mq.addListener(onChange);
      }
    }
  }

  /** Switch the active mode and persist it; the effect re-applies `data-theme`. */
  setMode(mode: ThemeMode): void {
    this._mode.set(mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* private mode / storage disabled — runtime still updates, just not persisted */
    }
  }

  /** Switch the active color scheme and persist it; the effect re-applies `data-scheme`. */
  setScheme(scheme: ColorScheme): void {
    this._scheme.set(scheme);
    try {
      localStorage.setItem(SCHEME_KEY, scheme);
    } catch {
      /* private mode / storage disabled — runtime still updates, just not persisted */
    }
  }

  private readMode(): ThemeMode {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
      /* ignore */
    }
    return 'system';
  }

  private readScheme(): ColorScheme {
    try {
      const v = localStorage.getItem(SCHEME_KEY) as ColorScheme | null;
      if (v && VALID_SCHEMES.has(v)) return v;
    } catch {
      /* ignore */
    }
    return 'default';
  }

  private systemPrefersDark(): boolean {
    try {
      return !(
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: light)').matches
      );
    } catch {
      return true;
    }
  }
}
