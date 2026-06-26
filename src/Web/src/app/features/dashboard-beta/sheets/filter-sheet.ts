import {
  ChangeDetectionStrategy, Component, computed, input, model, output, signal,
} from '@angular/core';

import {
  GroupBy, IngestionSource, MachineStat, ModelStat, ProjectDto, UsageFilter,
} from '../../../core/models';
import { BetaBottomSheet, BetaSegmentedControl, type Segment } from '../../beta-ui';

/**
 * The full filter surface, exiled into the kit {@link BetaBottomSheet} (the live page's 4× mat-select
 * is unusable at 390px). Rebuilt on the shared beta-ui kit: chip grids + a {@link BetaSegmentedControl}
 * for the time grouping, all reading the page accent + ink/glass tokens. Edits a LOCAL draft so Cancel
 * discards and Apply commits — the page only re-fetches on Apply. Chips are 44px+ touch targets.
 *
 * Parity note: this only edits a {@link UsageFilter} (+ {@link GroupBy}); the page hands the exact same
 * filter to `Api.summary`, so the numbers match the live dashboard. No client aggregation here.
 */
@Component({
  selector: 'app-pulse-filter-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BetaBottomSheet, BetaSegmentedControl],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="Filter usage" (closed)="onClosed()">
      <div class="fs">
        <header class="fs__head">
          <h2 class="fs__title">Filters</h2>
          <button type="button" class="fs__reset" (click)="reset()">Reset</button>
        </header>

        @if (projects().length) {
          <section class="fs__group">
            <h3 class="fs__label">Projects</h3>
            <div class="fs__chips">
              @for (p of projects(); track p.id) {
                <button type="button" class="chip" [class.chip--on]="hasProject(p.id)"
                        (click)="toggleProject(p.id)">{{ p.name }}</button>
              }
            </div>
          </section>
        }

        @if (models().length) {
          <section class="fs__group">
            <h3 class="fs__label">Models</h3>
            <div class="fs__chips">
              @for (m of models(); track m.model) {
                <button type="button" class="chip" [class.chip--on]="hasModel(m.model)"
                        (click)="toggleModel(m.model)">{{ m.model }}</button>
              }
            </div>
          </section>
        }

        @if (sources().length) {
          <section class="fs__group">
            <h3 class="fs__label">Sources</h3>
            <div class="fs__chips">
              @for (s of sources(); track s.name) {
                <button type="button" class="chip" [class.chip--on]="hasSource(s.name)"
                        (click)="toggleSource(s.name)">{{ s.name }}</button>
              }
            </div>
          </section>
        }

        @if (machines().length) {
          <section class="fs__group">
            <h3 class="fs__label">Machines</h3>
            <div class="fs__chips">
              @for (mc of machines(); track mc.name) {
                <button type="button" class="chip" [class.chip--on]="hasMachine(mc.name)"
                        (click)="toggleMachine(mc.name)">{{ mc.label }}</button>
              }
            </div>
          </section>
        }

        <section class="fs__group">
          <h3 class="fs__label">Group time by</h3>
          <app-bs-segmented [segments]="groupSegs" [value]="draftGroupBy()"
                            label="Group time by" (change)="draftGroupBy.set($any($event))" />
        </section>

        <section class="fs__group">
          <button type="button" class="fs__toggle" (click)="toggleSidechain()"
                  [attr.aria-pressed]="draft().includeSidechain">
            <span class="fs__toggle-text">
              <span class="fs__toggle-title">Include subagents</span>
              <span class="fs__toggle-sub">Side-chain (subagent) calls in the totals</span>
            </span>
            <span class="switch" [class.switch--on]="draft().includeSidechain" aria-hidden="true">
              <span class="switch__dot"></span>
            </span>
          </button>
        </section>
      </div>

      <div class="fs__apply">
        <button type="button" class="fs__cancel" (click)="cancel()">Cancel</button>
        <button type="button" class="fs__commit" (click)="apply()">
          Apply{{ activeCount() ? ' · ' + activeCount() : '' }}
        </button>
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .fs { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 88px; }
    .fs__head { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }
    .fs__title { margin: 0; font-size: 20px; font-weight: 800; color: var(--ink); }
    .fs__reset {
      background: none; border: 0; color: var(--ink-dim); font: inherit; font-size: 14px; font-weight: 600;
      min-height: 44px; padding: 0 8px; cursor: pointer; border-radius: var(--r-pill);
    }
    .fs__reset:active { color: var(--ink); }

    .fs__group { display: flex; flex-direction: column; gap: 10px; }
    .fs__label {
      margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim);
    }
    .fs__chips { display: flex; flex-wrap: wrap; gap: 8px; }

    .chip {
      min-height: 44px; padding: 0 16px; border-radius: var(--r-pill);
      background: var(--bg-rise); color: var(--ink-dim);
      border: 1px solid var(--hairline); font: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      transition: background 160ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .chip--on {
      background: color-mix(in srgb, var(--accent-a) 22%, var(--bg-rise));
      color: var(--ink);
      border-color: color-mix(in srgb, var(--accent-a) 55%, var(--hairline));
    }

    .fs__toggle {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      width: 100%; min-height: 56px; padding: 10px 16px; border-radius: var(--r-card);
      background: var(--bg-rise); border: 1px solid var(--hairline); cursor: pointer; text-align: left;
    }
    .fs__toggle-text { display: flex; flex-direction: column; gap: 2px; }
    .fs__toggle-title { font-size: 15px; color: var(--ink); font-weight: 600; }
    .fs__toggle-sub { font-size: 12px; color: var(--ink-dim); }

    .switch {
      flex: 0 0 auto; width: 46px; height: 28px; border-radius: var(--r-pill);
      background: var(--hairline); position: relative; transition: background 200ms var(--ease-out);
    }
    .switch--on { background: var(--signal); }
    .switch__dot {
      position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%;
      background: #fff; transition: transform 200ms var(--ease-out);
    }
    .switch--on .switch__dot { transform: translateX(18px); }

    /* Sticky thumb-zone commit bar, inside the scrolling sheet body. */
    .fs__apply {
      position: sticky; bottom: 0; display: flex; gap: 10px;
      padding: 12px 0 calc(12px + var(--safe-bottom));
      background: linear-gradient(to top, var(--glass) 72%, transparent);
      backdrop-filter: blur(var(--blur-glass));
      -webkit-backdrop-filter: blur(var(--blur-glass));
    }
    .fs__cancel, .fs__commit {
      flex: 1 1 auto; min-height: 52px; border-radius: var(--r-pill); font: inherit;
      font-size: 16px; font-weight: 700; cursor: pointer; border: 1px solid var(--hairline);
      transition: transform 120ms var(--ease-spring);
    }
    .fs__cancel:active, .fs__commit:active { transform: scale(.98); }
    .fs__cancel { flex: 0 0 38%; background: var(--bg-rise); color: var(--ink-dim); }
    .fs__commit {
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #fff; border: 0;
      box-shadow: 0 8px 22px -8px color-mix(in srgb, var(--accent-a) 70%, transparent);
    }
  `],
})
export class PulseFilterSheet {
  /** Two-way open state, owned by the page (it sets true when the filter button is tapped). */
  readonly open = model<boolean>(false);

  /** Option catalogs (read-only) supplied by the page. */
  readonly projects = input<ProjectDto[]>([]);
  readonly models = input<ModelStat[]>([]);
  readonly sources = input<IngestionSource[]>([]);
  readonly machines = input<MachineStat[]>([]);

  /** The committed filter + groupBy the page currently holds (used to seed the draft on open). */
  readonly filter = input.required<UsageFilter>();
  readonly groupBy = input.required<GroupBy>();

  /** Emitted on Apply with the committed draft (page re-fetches). */
  readonly applied = output<{ filter: UsageFilter; groupBy: GroupBy }>();

  protected readonly groupSegs: Segment[] = [
    { key: 'day', label: 'Day' },
    { key: 'month', label: 'Month' },
  ];

  /** Local editable draft — Cancel discards, Apply commits. */
  private readonly draftFilter = signal<UsageFilter>(this.blankFilter());
  readonly draftGroupBy = signal<GroupBy>('day');
  readonly draft = this.draftFilter.asReadonly();

  /** Called by the page right before opening, to copy the live filter into the draft. */
  seed(): void {
    this.draftFilter.set({ ...this.filter(), projectIds: [...this.filter().projectIds], models: [...this.filter().models], sources: [...this.filter().sources], machine: [...this.filter().machine] });
    this.draftGroupBy.set(this.groupBy());
  }

  private blankFilter(): UsageFilter {
    return { from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true };
  }

  readonly activeCount = computed(() => {
    const f = this.draftFilter();
    return f.projectIds.length + f.models.length + f.sources.length + f.machine.length + (f.includeSidechain ? 0 : 1);
  });

  hasProject(id: number): boolean { return this.draftFilter().projectIds.includes(id); }
  hasModel(m: string): boolean { return this.draftFilter().models.includes(m); }
  hasSource(s: string): boolean { return this.draftFilter().sources.includes(s); }
  hasMachine(mc: string): boolean { return this.draftFilter().machine.includes(mc); }

  toggleProject(id: number): void { this.draftFilter.update(f => ({ ...f, projectIds: toggle(f.projectIds, id) })); }
  toggleModel(m: string): void { this.draftFilter.update(f => ({ ...f, models: toggle(f.models, m) })); }
  toggleSource(s: string): void { this.draftFilter.update(f => ({ ...f, sources: toggle(f.sources, s) })); }
  toggleMachine(mc: string): void { this.draftFilter.update(f => ({ ...f, machine: toggle(f.machine, mc) })); }
  toggleSidechain(): void { this.draftFilter.update(f => ({ ...f, includeSidechain: !f.includeSidechain })); }

  reset(): void { this.draftFilter.set(this.blankFilter()); this.draftGroupBy.set('day'); }

  apply(): void {
    this.applied.emit({ filter: this.draftFilter(), groupBy: this.draftGroupBy() });
    this.open.set(false);
  }

  cancel(): void { this.open.set(false); }

  /** Sheet dismissed via grip/scrim/Esc — treat as cancel (no commit). */
  onClosed(): void { /* draft is reseeded on next open via seed(); nothing to persist */ }
}

/** Immutable toggle of a value in an array (add if absent, remove if present). */
function toggle<T>(arr: readonly T[], v: T): T[] {
  return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
}
