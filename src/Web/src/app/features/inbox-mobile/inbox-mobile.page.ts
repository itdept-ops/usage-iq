import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AgentInbox, AgentInboxItem, AgentInboxPeriod } from '../../core/models';
import {
  BetaPullRefresh, BetaSkeleton, BetaToaster, ToastController, BetaEmptyState, BetaErrorState,
} from '../beta-ui';

/** Per-agent-kind presentation: glyph + a signature hue for the per-card tint. */
interface KindMeta {
  icon: string;
  hue: number;
}

const KIND_META: Readonly<Record<string, KindMeta>> = {
  morningBriefing: { icon: 'wb_sunny', hue: 38 },
  streakRescue: { icon: 'local_fire_department', hue: 14 },
  budgetAlert: { icon: 'savings', hue: 150 },
  lowStaples: { icon: 'shopping_basket', hue: 265 },
  medicationDue: { icon: 'medication', hue: 200 },
  agent: { icon: 'smart_toy', hue: 220 },
};

const PERIOD_META: Readonly<Record<AgentInboxPeriod, { label: string; icon: string }>> = {
  overnight: { label: 'Overnight', icon: 'bedtime' },
  today: { label: 'Today', icon: 'wb_twilight' },
  earlier: { label: 'Earlier', icon: 'history' },
};

const PERIOD_ORDER: readonly AgentInboxPeriod[] = ['overnight', 'today', 'earlier'];

interface InboxRow extends AgentInboxItem {
  meta: KindMeta;
}

interface InboxSection {
  period: AgentInboxPeriod;
  label: string;
  icon: string;
  rows: InboxRow[];
}

/**
 * Agent Inbox — the mobile-first twin of the live /inbox page, rebuilt on the shared beta-ui "Strata" kit.
 * One signature accent — an INDIGO → VIOLET ramp — re-skins the screen via the per-page accent contract. An
 * immersive header (with a pending-count chip + a mark-all control), then period sections (Overnight / Today
 * / Earlier) of glassy cards: the agent's glyph, label, a relative time, an un-handled marker, a one-line
 * summary, and the actions — tap Open to follow the deep-link (navigates + marks handled), or Mark handled.
 *
 * SCOPE + PRIVACY: every item comes from the SAME self-scoped {@link Api.agentInbox} endpoint the live page
 * uses (owner-scoped server-side; gated `agents.use`). "Handled" reuses the existing notification read flag —
 * no migration. No email is ever shown. A holder with no deliveries gets the empty state pointing at /agents.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `agents.use` route guard; consumes only the kit + the SAME
 * Api/DTOs as the live counterpart. No live page is imported or modified.
 */
@Component({
  selector: 'app-inbox-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    BetaPullRefresh, BetaSkeleton, BetaToaster, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <app-bs-pull-refresh class="ib-ptr" [busy]="refreshing()" [disabled]="loading()" (refresh)="reload()">
      <div class="ib-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="ib-hero">
          <p class="ib-hero__kicker"><mat-icon aria-hidden="true">inbox</mat-icon> Your OS</p>
          <h1 class="ib-hero__title">Agent Inbox</h1>
          <p class="ib-hero__sub">Agent activity grouped by when it landed — tap to act or mark handled.</p>

          @if (!loading() && !errored() && items().length) {
            <div class="ib-hero__bar">
              @if (unhandled() > 0) {
                <span class="ib-pill">{{ unhandled() }} to triage</span>
                <button type="button" class="ib-allbtn" [disabled]="busyAll()" (click)="handleAll()">
                  <mat-icon aria-hidden="true">done_all</mat-icon>
                  @if (busyAll()) { Clearing… } @else { Mark all handled }
                </button>
              } @else {
                <span class="ib-pill ib-pill--done"><mat-icon aria-hidden="true">check_circle</mat-icon> All caught up</span>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <div class="ib-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="96px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your inbox"
            body="Something went wrong fetching your agent activity. Give it another go."
            (retry)="reload()" />

        } @else if (isEmpty()) {
          <app-bs-empty
            icon="smart_toy"
            title="Your agents haven't reported in yet"
            body="When your proactive agents run, what they find shows up here. Set one up to get started."
            ctaLabel="Set up agents"
            ctaIcon="smart_toy"
            ctaLink="/agents" />

        } @else {
          @for (sec of sections(); track sec.period) {
            <section class="ib-sec">
              <h2 class="ib-sec__head">
                <mat-icon aria-hidden="true">{{ sec.icon }}</mat-icon>
                {{ sec.label }}
                <span class="ib-sec__count">{{ sec.rows.length }}</span>
              </h2>

              @for (row of sec.rows; track row.id) {
                <article class="ib-card" [class.is-handled]="row.handled" [style.--item-hue]="row.meta.hue">
                  <span class="ib-card__ic" aria-hidden="true"><mat-icon>{{ row.meta.icon }}</mat-icon></span>

                  <div class="ib-card__body">
                    <p class="ib-card__meta">
                      <span class="ib-card__agent">{{ row.agentLabel }}</span>
                      <span class="ib-card__dot" aria-hidden="true">·</span>
                      <time class="ib-card__time">{{ relTime(row.createdUtc) }}</time>
                      @if (!row.handled) { <span class="ib-card__new" aria-label="Not yet handled">New</span> }
                    </p>
                    <p class="ib-card__summary">{{ row.summary }}</p>

                    <div class="ib-card__actions">
                      @if (row.deepLink) {
                        <button type="button" class="ib-btn ib-btn--accent" (click)="act(row)">
                          <mat-icon aria-hidden="true">open_in_new</mat-icon> Open
                        </button>
                      }
                      @if (!row.handled) {
                        <button type="button" class="ib-btn" (click)="markHandled(row)">
                          <mat-icon aria-hidden="true">check</mat-icon> Handled
                        </button>
                      } @else {
                        <span class="ib-card__done"><mat-icon aria-hidden="true">check_circle</mat-icon> Handled</span>
                      }
                    </div>
                  </div>
                </article>
              }
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <app-bs-toaster />
  `,
  styleUrl: './inbox-mobile.page.scss',
})
export class InboxMobilePage {
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(ToastController);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  readonly busyAll = signal(false);

  private readonly itemsSig = signal<InboxRow[]>([]);
  readonly unhandled = signal(0);

  readonly items = computed(() => this.itemsSig());

  readonly sections = computed<InboxSection[]>(() => {
    const byPeriod = new Map<AgentInboxPeriod, InboxRow[]>();
    for (const r of this.itemsSig()) {
      const list = byPeriod.get(r.period) ?? [];
      list.push(r);
      byPeriod.set(r.period, list);
    }
    return PERIOD_ORDER
      .filter((p) => byPeriod.has(p))
      .map((p) => ({ period: p, label: PERIOD_META[p].label, icon: PERIOD_META[p].icon, rows: byPeriod.get(p)! }));
  });

  readonly isEmpty = computed(() => !this.loading() && !this.errored() && this.itemsSig().length === 0);

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const res = await firstValueFrom(this.api.agentInbox());
      this.absorb(res);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) this.refreshing.set(false);
    }
  }

  private absorb(res: AgentInbox): void {
    const rows: InboxRow[] = [];
    for (const g of res.groups) {
      for (const it of g.items) rows.push({ ...it, meta: KIND_META[it.agentKind] ?? KIND_META['agent'] });
    }
    this.itemsSig.set(rows);
    this.unhandled.set(res.unhandledCount);
  }

  act(row: InboxRow): void {
    if (!row.deepLink) return;
    this.markHandled(row);
    void this.router.navigateByUrl(row.deepLink);
  }

  markHandled(row: InboxRow): void {
    if (row.handled) return;
    this.patch(row.id, (r) => ({ ...r, handled: true }));
    this.unhandled.update((n) => Math.max(0, n - 1));
    firstValueFrom(this.api.handleAgentInbox([row.id]))
      .then((res) => this.unhandled.set(res.unhandledCount))
      .catch(() => this.toast.show("Couldn't update — try again", { tone: 'warn' }));
  }

  handleAll(): void {
    if (this.busyAll() || this.unhandled() === 0) return;
    this.busyAll.set(true);
    firstValueFrom(this.api.handleAllAgentInbox())
      .then(() => {
        this.itemsSig.update((rows) => rows.map((r) => ({ ...r, handled: true })));
        this.unhandled.set(0);
        this.toast.show('All caught up', { tone: 'success', durationMs: 1600 });
      })
      .catch(() => this.toast.show("Couldn't clear — try again", { tone: 'warn' }))
      .finally(() => this.busyAll.set(false));
  }

  private patch(id: number, fn: (r: InboxRow) => InboxRow): void {
    this.itemsSig.update((rows) => rows.map((r) => (r.id === id ? fn(r) : r)));
  }

  relTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
