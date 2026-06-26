import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { Api } from '../../../core/api';
import { FamilyToday, FamilyTodayEvent } from '../../../core/models';
import { AtriumWidgetShell, WidgetPhase } from './widget-shell';
import { ReorderableWidget } from './reorderable';

/**
 * Atrium "Next event" widget — the caller's soonest upcoming calendar event today, rendered as an
 * accent-tinted calendar glyph + a bold title + its time. Best-effort: it owns its own cold
 * {@link Api.familyToday} subscription with `catchError(of(null))` + `takeUntilDestroyed`
 * (the family-home.ts:148 pattern), so a calendar/network failure only blanks THIS card.
 *
 * The `nextEvent` reducer is COPIED verbatim from family-home.ts:114 (not imported) to keep this widget
 * fully decoupled from the live page's internals.
 */
@Component({
  selector: 'atr-event-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtriumWidgetShell, MatIconModule],
  template: `
    <atr-widget-shell
      title="Next event" route="/beta/family"
      accentA="#38bdf8" accentB="#7c5cff"
      [phase]="phase()" emptyText="Nothing else on the calendar today." emptyIcon="event_available"
      [reordering]="reordering()"
      (retry)="reload()" (moveUp)="moveUp.emit()" (moveDown)="moveDown.emit()" (hide)="hide.emit()">

      @if (next(); as e) {
        <div body class="ev">
          <span class="ev__ic" aria-hidden="true"><mat-icon>event</mat-icon></span>
          <span class="ev__text">
            <span class="ev__title">{{ e.title }}</span>
            <span class="ev__time">{{ e.allDay ? 'All day' : e.localTime }}</span>
          </span>
        </div>
      }
    </atr-widget-shell>
  `,
  styles: [`
    .ev { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .ev__ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px;
      background: linear-gradient(135deg, color-mix(in srgb, #38bdf8 22%, transparent), color-mix(in srgb, #7c5cff 22%, transparent));
    }
    .ev__ic mat-icon { font-size: 24px; width: 24px; height: 24px; color: #8fd4ff; }
    .ev__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ev__title {
      font-family: var(--font-ui); font-weight: 700; font-size: 17px; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ev__time { font-size: 13px; font-weight: 600; color: #8fd4ff; }
  `],
})
export class EventWidget extends ReorderableWidget {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);

  private readonly today = signal<FamilyToday | null>(null);
  private readonly failed = signal(false);
  private readonly loadingState = signal(true);

  /** Always visible to any signed-in user — no perm gate (presence/today is broadly readable). */
  readonly visible = computed(() => true);

  /** COPIED from family-home.ts:114 — do NOT import FamilyHome. */
  private nextEventOf(evs: FamilyTodayEvent[]): FamilyTodayEvent | null {
    if (!evs.length) return null;
    const now = Date.now();
    const upcoming = evs
      .filter(e => !e.allDay && e.startUtc && Date.parse(e.startUtc) >= now)
      .sort((a, b) => (a.startUtc ?? '').localeCompare(b.startUtc ?? ''));
    if (upcoming.length) return upcoming[0];
    return evs.find(e => e.allDay) ?? null;
  }

  readonly next = computed<FamilyTodayEvent | null>(() => this.nextEventOf(this.today()?.events ?? []));

  readonly phase = computed<WidgetPhase>(() => {
    if (this.loadingState()) return 'loading';
    if (this.failed()) return 'failed';
    return this.next() ? 'ready' : 'empty';
  });

  constructor() {
    super();
    this.reload();
  }

  reload(): void {
    this.loadingState.set(true);
    this.failed.set(false);
    this.api.familyToday()
      .pipe(catchError(() => { this.failed.set(true); return of<FamilyToday | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(t => {
        if (t) this.today.set(t);
        this.loadingState.set(false);
      });
  }
}
