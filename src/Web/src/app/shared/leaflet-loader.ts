/**
 * Lazy Leaflet loader. Leaflet is heavy (~150KB) and only two pages use it (My locations + admin
 * Locations), so we DYNAMIC-import the library AND its CSS on first use rather than shipping them in the
 * main bundle. The promise is memoised so repeated map mounts share one load.
 *
 * MAPS = Leaflet + OpenStreetMap tiles — free, NO API key required. Google Maps is a deliberate future
 * swap (its JS API needs a key + billing); when that day comes, only this helper + the two map components
 * change. Attribution to OpenStreetMap is mandatory under the ODbL tile-usage policy and is wired into the
 * tile layer below (plus a visible "Powered by OpenStreetMap" note in each page).
 *
 * The default-marker-icon paths are also patched here: Leaflet resolves its marker PNGs relative to the
 * CSS by default, which breaks under a hashed esbuild bundle — so we point them at the unpkg CDN copies
 * (same files Leaflet ships) so pins render without bundling binary assets.
 */
import type * as L from 'leaflet';

let leafletPromise: Promise<typeof L> | null = null;

/** The OpenStreetMap raster tile endpoint + the attribution string OSM's usage policy requires. */
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Default OSM marker assets (Leaflet's own PNGs, served from the CDN so we don't bundle binaries). */
const ICON_BASE = 'https://unpkg.com/leaflet@1.9.4/dist/images/';

/**
 * Leaflet's stylesheet, served from the CDN. We load it via a runtime <link> rather than a JS-side
 * `import('leaflet/dist/leaflet.css')` because that CSS references its own PNGs via relative `url(...)`,
 * which esbuild cannot resolve at build time (no PNG loader) and would fail the bundle. The CDN copy
 * resolves those image URLs against the CDN origin, and keeps the stylesheet out of the main bundle —
 * preserving the lazy, no-binaries-bundled design.
 */
const CSS_HREF = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

/** Inject the Leaflet stylesheet once, resolving when it has loaded (or already present). */
function loadLeafletCss(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[data-leaflet-css]`)) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-leaflet-css', '');
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('Failed to load Leaflet stylesheet'));
    document.head.appendChild(link);
  });
}

/**
 * Resolve the Leaflet module (dynamically importing the lib + its stylesheet the first time, then
 * patching the default icon URLs). Safe to call from many components — the underlying import runs once.
 */
export async function loadLeaflet(): Promise<typeof L> {
  if (!leafletPromise) {
    leafletPromise = (async () => {
      // Lazy stylesheet load via runtime <link> (kept out of the bundle; see loadLeafletCss notes).
      await loadLeafletCss();
      const mod = await import('leaflet');
      const leaflet = ((mod as unknown as { default?: typeof L }).default ?? mod) as typeof L;

      // Patch the default marker icon so pins render under a hashed bundle (the usual Leaflet gotcha).
      const proto = leaflet.Icon.Default.prototype as unknown as { _getIconUrl?: unknown };
      if (proto._getIconUrl) delete proto._getIconUrl;
      leaflet.Icon.Default.mergeOptions({
        iconRetinaUrl: ICON_BASE + 'marker-icon-2x.png',
        iconUrl: ICON_BASE + 'marker-icon.png',
        shadowUrl: ICON_BASE + 'marker-shadow.png',
      });
      return leaflet;
    })();
  }
  return leafletPromise;
}
