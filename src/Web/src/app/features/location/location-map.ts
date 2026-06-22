import {
  AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, input, output, signal, viewChild,
} from '@angular/core';
import type * as L from 'leaflet';

import { loadLeaflet, OSM_ATTRIBUTION, OSM_TILE_URL } from '../../shared/leaflet-loader';

/**
 * One pin on the map. `kind` drives the marker colour (user = accent, machine = a distinct amber so the
 * fleet's IP-geo pins read apart from people). `id` is echoed back on click so the parent can select.
 */
export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  /** A short popup title (e.g. a name) — kept free of email per the privacy rule. */
  title: string;
  /** A second popup line (e.g. "City · 3m ago"). Optional. */
  subtitle?: string;
  kind?: 'user' | 'machine';
  /** True to render this pin emphasised (e.g. the selected user's latest). */
  emphasis?: boolean;
}

/** An ordered polyline (a user's history trail), drawn faintly under the pins. */
export interface MapTrail {
  points: [number, number][];
}

/**
 * A thin Leaflet wrapper. Leaflet is DYNAMIC-imported (see leaflet-loader) so it never bloats the main
 * bundle. The component owns the map instance + layers and reconciles them whenever the `pins`/`trails`
 * inputs change; it emits `pinClick` with the pin id. OpenStreetMap tiles (free, no API key) — Google
 * Maps is a planned future swap that would touch only the loader + this file.
 */
@Component({
  selector: 'app-location-map',
  standalone: true,
  template: `<div #host class="leaflet-host" [class.is-empty]="!pins().length"></div>
    @if (!ready()) {
      <div class="leaflet-loading">Loading map…</div>
    }`,
  styles: [`
    :host { position: relative; display: block; width: 100%; height: 100%; min-height: 320px; }
    .leaflet-host { width: 100%; height: 100%; min-height: 320px; border-radius: var(--tech-r-control, 10px); }
    .leaflet-loading {
      position: absolute; inset: 0; display: grid; place-items: center;
      font-family: var(--tech-font-mono); font-size: var(--tech-fs-label, 11px);
      color: var(--tech-text-tertiary, #5e6c82); pointer-events: none;
    }
  `],
})
export class LocationMap implements AfterViewInit, OnDestroy {
  /** Pins to render. */
  readonly pins = input<MapPin[]>([]);
  /** Optional history trails (polylines). */
  readonly trails = input<MapTrail[]>([]);
  /** Fired with a pin's id when the user clicks its marker. */
  readonly pinClick = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly ready = signal(false);
  private leaflet: typeof L | null = null;
  private map: L.Map | null = null;
  private markerLayer: L.LayerGroup | null = null;
  private trailLayer: L.LayerGroup | null = null;

  /** A stable key for the current pin set so we only refit the view when the markers actually change. */
  private readonly pinKey = computed(() =>
    this.pins().map(p => `${p.id}:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|'));
  private lastFitKey = '';

  constructor() {
    // Reconcile layers whenever inputs change AND the map is ready.
    effect(() => {
      this.pins(); this.trails(); this.ready();
      if (this.map) this.render();
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.leaflet = await loadLeaflet();
    const Lm = this.leaflet;

    this.map = Lm.map(this.host().nativeElement, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: true,
    });
    Lm.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(this.map);
    this.markerLayer = Lm.layerGroup().addTo(this.map);
    this.trailLayer = Lm.layerGroup().addTo(this.map);
    this.ready.set(true);
    this.render();
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }

  private render(): void {
    const Lm = this.leaflet;
    if (!Lm || !this.map || !this.markerLayer || !this.trailLayer) return;

    this.trailLayer.clearLayers();
    for (const t of this.trails()) {
      if (t.points.length > 1) {
        Lm.polyline(t.points, { color: '#5b8def', weight: 2, opacity: 0.45 }).addTo(this.trailLayer);
      }
    }

    this.markerLayer.clearLayers();
    const pins = this.pins();
    for (const p of pins) {
      const marker = p.kind === 'machine'
        ? Lm.circleMarker([p.lat, p.lng], {
            radius: p.emphasis ? 9 : 7, color: '#b9770e', fillColor: '#f0a020',
            fillOpacity: 0.85, weight: 2,
          })
        : Lm.marker([p.lat, p.lng], { riseOnHover: true });
      const safeTitle = this.escape(p.title);
      const safeSub = p.subtitle ? `<br><span class="lp-sub">${this.escape(p.subtitle)}</span>` : '';
      marker.bindPopup(`<strong>${safeTitle}</strong>${safeSub}`);
      marker.on('click', () => this.pinClick.emit(p.id));
      marker.addTo(this.markerLayer);
    }

    // Fit the view to the markers the first time we see this pin set (so re-selection within the same set
    // doesn't yank the viewport). One pin → a gentle zoom; many → fit bounds with padding.
    const key = this.pinKey();
    if (pins.length && key !== this.lastFitKey) {
      this.lastFitKey = key;
      if (pins.length === 1) {
        this.map.setView([pins[0].lat, pins[0].lng], 12);
      } else {
        const bounds = Lm.latLngBounds(pins.map(p => [p.lat, p.lng] as [number, number]));
        this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      }
    }
  }

  /** Minimal HTML-escape for popup text (titles/cities are server data, but belt-and-suspenders). */
  private escape(s: string): string {
    return s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
  }
}
