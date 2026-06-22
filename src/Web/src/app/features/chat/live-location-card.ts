import {
  Component, OnDestroy, computed, effect, input, output, signal,
} from '@angular/core';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ChatLocationShareDto } from '../../core/models';
import { LocationMap, MapPin } from '../location/location-map';

/**
 * One LIVE-LOCATION CARD rendered inline in a chat conversation. It reuses the shared {@link LocationMap}
 * (Leaflet/OSM) to show the sharer's single pin, runs a LOCAL countdown to `expiresUtc` (so the card ends
 * on its own even if the final "stopped"/"expired" broadcast is missed), and — for the SHARER — offers
 * Extend (+15m / +1h) and Stop controls. It owns no data: the parent feeds the latest {@link ChatLocationShareDto}
 * (updated live by the SignalR handlers) and handles the extend/stop actions. Email is never present — the
 * sharer is shown by display name only.
 */
@Component({
  selector: 'app-live-location-card',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatMenuModule, MatTooltipModule, LocationMap],
  templateUrl: './live-location-card.html',
  styleUrl: './live-location-card.scss',
})
export class LiveLocationCard implements OnDestroy {
  /** The share to render (kept current by the parent from the realtime cache). */
  readonly share = input.required<ChatLocationShareDto>();
  /** True when the signed-in user is the sharer (shows the Extend/Stop controls). */
  readonly isMine = input(false);

  /** The sharer asked to extend the share by N minutes (e.g. 15 / 60). */
  readonly extend = output<number>();
  /** The sharer asked to stop the share. */
  readonly stop = output<void>();

  /** A 1s heartbeat driving the countdown + the active/ended state without leaning on input churn. */
  readonly now = signal(Date.now());
  private readonly ticker = setInterval(() => this.now.set(Date.now()), 1000);

  /** Active right now: not stopped AND before expiry (the client mirrors the server rule + a live clock). */
  readonly active = computed(() => {
    const s = this.share();
    return !s.stopped && this.now() < new Date(s.expiresUtc).getTime();
  });

  /** Whole seconds remaining until expiry (0 once ended). */
  readonly remainingSec = computed(() => {
    const ms = new Date(this.share().expiresUtc).getTime() - this.now();
    return Math.max(0, Math.floor(ms / 1000));
  });

  /** A short "12:34" / "1:02:03" countdown label. */
  readonly countdown = computed(() => {
    const total = this.remainingSec();
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  });

  /** Why the card ended (for the ended state's sub-line). */
  readonly endedReason = computed(() => (this.share().stopped ? 'Sharing stopped' : 'Sharing ended'));

  /** The single map pin for the sharer's current position (emphasised). */
  readonly pins = computed<MapPin[]>(() => {
    const s = this.share();
    return [{
      id: String(s.id),
      lat: s.lat,
      lng: s.lng,
      title: s.sharerName,
      subtitle: this.active() ? `Live · ${this.accuracyLabel(s)}` : this.endedReason(),
      kind: 'user',
      emphasis: true,
    }];
  });

  constructor() {
    // Fire the heartbeat reactively too, so the countdown stays correct after a tab-visibility resume.
    effect(() => { this.share(); this.now.set(Date.now()); });
  }

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }

  onExtend(minutes: number): void {
    if (this.active()) this.extend.emit(minutes);
  }

  onStop(): void {
    if (this.active()) this.stop.emit();
  }

  private accuracyLabel(s: ChatLocationShareDto): string {
    return s.accuracyM != null && Number.isFinite(s.accuracyM)
      ? `±${Math.round(s.accuracyM)} m`
      : 'live location';
  }
}
