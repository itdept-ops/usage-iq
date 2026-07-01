import {
  ChangeDetectionStrategy, Component, computed, input, model, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  GroupBy, IngestionSource, MachineStat, ModelStat, ProjectDto, SavedView, UsageFilter,
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
  imports: [BetaBottomSheet, BetaSegmentedControl, FormsModule],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="Filter usage" (closed)="onClosed()">
      <div class="fs">
        <header class="fs__head">
          <h2 class="fs__title">Filters</h2>
          <button type="button" class="fs__reset" (click)="reset()">Reset</button>
        </header>

        <!-- Saved views: apply / rename / delete a named filter set. Save-current lives in the apply bar. -->
        @if (savedViews().length) {
          <section class="fs__group">
            <h3 class="fs__label" id="fs-lbl-views">Saved views</h3>
            <ul class="fs__views" role="group" aria-labelledby="fs-lbl-views">
              @for (v of savedViews(); track v.id) {
                <li class="view">
                  @if (renamingId() === v.id) {
                    <input class="view__rename" type="text" [ngModel]="renameDraft()"
                           (ngModelChange)="renameDraft.set($event)"
                           (keydown.enter)="commitRename(v)" (keydown.escape)="cancelRename()"
                           aria-label="View name" />
                    <button type="button" class="view__act view__act--ok" (click)="commitRename(v)"
                            aria-label="Save name">Save</button>
                    <button type="button" class="view__act" (click)="cancelRename()"
                            aria-label="Cancel rename">Cancel</button>
                  } @else {
                    <button type="button" class="view__apply" (click)="applyView.emit(v)">{{ v.name }}</button>
                    <button type="button" class="view__act" (click)="startRename(v)"
                            aria-label="Rename view">Rename</button>
                    <button type="button" class="view__act view__act--del" (click)="deleteView.emit(v)"
                            aria-label="Delete view">Delete</button>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <!-- Custom range: from/to date inputs. Setting either clears the preset chip on apply. -->
        <section class="fs__group">
          <h3 class="fs__label">Custom range</h3>
          <div class="fs__dates">
            <label class="date">
              <span class="date__cap">From</span>
              <input class="date__in" type="date" [ngModel]="draft().from ?? ''"
                     (ngModelChange)="setFrom($event)" aria-label="From date" />
            </label>
            <label class="date">
              <span class="date__cap">To</span>
              <input class="date__in" type="date" [ngModel]="draft().to ?? ''"
                     (ngModelChange)="setTo($event)" aria-label="To date" />
            </label>
          </div>
          @if (draft().from || draft().to) {
            <button type="button" class="fs__reset fs__reset--inline" (click)="clearRange()">Clear range</button>
          }
        </section>

        @if (projects().length) {
          <section class="fs__group">
            <h3 class="fs__label" id="fs-lbl-projects">Projects</h3>
            <div class="fs__chips" role="group" aria-labelledby="fs-lbl-projects">
              @for (p of projects(); track p.id) {
                <button type="button" class="chip" [class.chip--on]="hasProject(p.id)"
                        [attr.aria-pressed]="hasProject(p.id)"
                        (click)="toggleProject(p.id)">{{ p.name }}</button>
              }
            </div>
          </section>
        }

        @if (models().length) {
          <section class="fs__group">
            <h3 class="fs__label" id="fs-lbl-models">Models</h3>
            <div class="fs__chips" role="group" aria-labelledby="fs-lbl-models">
              @for (m of models(); track m.model) {
                <button type="button" class="chip" [class.chip--on]="hasModel(m.model)"
                        [attr.aria-pressed]="hasModel(m.model)"
                        (click)="toggleModel(m.model)">{{ m.model }}</button>
              }
            </div>
          </section>
        }

        @if (sources().length) {
          <section class="fs__group">
            <h3 class="fs__label" id="fs-lbl-sources">Sources</h3>
            <div class="fs__chips" role="group" aria-labelledby="fs-lbl-sources">
              @for (s of sources(); track s.name) {
                <button type="button" class="chip" [class.chip--on]="hasSource(s.name)"
                        [attr.aria-pressed]="hasSource(s.name)"
                        (click)="toggleSource(s.name)">{{ s.name }}</button>
              }
            </div>
          </section>
        }

        @if (machines().length) {
          <section class="fs__group">
            <h3 class="fs__label" id="fs-lbl-machines">Machines</h3>
            <div class="fs__chips" role="group" aria-labelledby="fs-lbl-machines">
              @for (mc of machines(); track mc.name) {
                <button type="button" class="chip" [class.chip--on]="hasMachine(mc.name)"
                        [attr.aria-pressed]="hasMachine(mc.name)"
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
        <button type="button" class="fs__save" (click)="saveCurrent.emit(draft())"
                aria-label="Save current filters as a view">Save view</button>
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
    .switch--on { background: var(--accent-a); }
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
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--ink-on-accent); border: 0;
      box-shadow: 0 8px 22px -8px color-mix(in srgb, var(--accent-a) 70%, transparent);
    }
    .fs__save { flex: 0 0 auto; padding: 0 14px; background: var(--bg-rise); color: var(--ink); }

    .fs__reset--inline { align-self: flex-start; padding: 0; min-height: 36px; }

    /* Saved views list */
    .fs__views { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .view { display: flex; align-items: center; gap: 8px; }
    .view__apply {
      flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 14px; border-radius: var(--r-tile);
      background: var(--bg-rise); border: 1px solid var(--hairline); color: var(--ink);
      font: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .view__apply:active { background: color-mix(in srgb, var(--accent-a) 12%, var(--bg-rise)); }
    .view__rename {
      flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: var(--r-tile);
      background: var(--bg-base); border: 1px solid color-mix(in srgb, var(--accent-a) 45%, var(--hairline));
      color: var(--ink); font: inherit; font-size: 14px;
    }
    .view__act {
      flex: 0 0 auto; min-height: 44px; padding: 0 12px; border-radius: var(--r-pill);
      background: none; border: 1px solid var(--hairline); color: var(--ink-dim);
      font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .view__act--del:active { color: var(--tech-danger, #f5556d); }
    .view__act--ok {
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--ink-on-accent); border: 0;
    }

    /* Custom range date inputs */
    .fs__dates { display: flex; gap: 10px; }
    .date { flex: 1 1 0; display: flex; flex-direction: column; gap: 6px; }
    .date__cap {
      font-size: 12px; font-weight: 700; letter-spacing: .03em; color: var(--ink-dim);
    }
    .date__in {
      min-height: 44px; padding: 0 12px; border-radius: var(--r-tile);
      background: var(--bg-rise); border: 1px solid var(--hairline); color: var(--ink);
      font: inherit; font-size: 14px; width: 100%;
    }
    .date__in:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
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

  /** Per-user saved views (owned + fetched by the page; the sheet only renders + emits intents). */
  readonly savedViews = input<SavedView[]>([]);

  /** Emitted on Apply with the committed draft (page re-fetches). */
  readonly applied = output<{ filter: UsageFilter; groupBy: GroupBy }>();

  /** Saved-view intents — the page owns the Api calls (saveView/updateView/deleteView). */
  readonly applyView = output<SavedView>();
  readonly deleteView = output<SavedView>();
  /** Save the CURRENT draft filter as a named view; the page prompts for a name + upserts. */
  readonly saveCurrent = output<UsageFilter>();
  /** Rename an existing view: {view, name}. The page PUTs the same payload with only the name changed. */
  readonly renameView = output<{ view: SavedView; name: string }>();

  /** Inline rename state for the views list. */
  readonly renamingId = signal<number | null>(null);
  readonly renameDraft = signal('');

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

  // ---- custom date range (empty string ⇒ null) ----
  setFrom(v: string): void { this.draftFilter.update(f => ({ ...f, from: v || null })); }
  setTo(v: string): void { this.draftFilter.update(f => ({ ...f, to: v || null })); }
  clearRange(): void { this.draftFilter.update(f => ({ ...f, from: null, to: null })); }

  // ---- inline rename of a saved view ----
  startRename(v: SavedView): void { this.renamingId.set(v.id); this.renameDraft.set(v.name); }
  cancelRename(): void { this.renamingId.set(null); }
  commitRename(v: SavedView): void {
    const name = this.renameDraft().trim();
    this.renamingId.set(null);
    if (name && name !== v.name) this.renameView.emit({ view: v, name });
  }

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
