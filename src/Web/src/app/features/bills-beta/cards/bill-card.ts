import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { BillDto } from '../../../core/models';
import { BetaSwipeRow } from '../../beta-ui';

/** One contributor chip the card renders as a stacked avatar + a who-owes-what segment. */
interface Member {
  name: string;
  initials: string;
  total: number;
  /** 0..1 share of the claimed pool (drives the segment bar width). */
  frac: number;
}

/**
 * Tally BILL CARD — one rich depth card in the bills list, rebuilt on the shared beta-ui foundation.
 * It is NOT a flat row: a sediment `--bg-rise` extrusion lifted with `--lift-2`, a gradient hairline edge
 * that picks up the cream page accent, an accent glow on press, the bill's amount in a BIG Clash Display
 * numeral, a status pill (Open / Settled, amber/green — never red), a stack of member avatars, and a
 * "who-owes-what" split bar showing each person's share of the claimed pool (plus an amber Unclaimed
 * sliver). Wrapped in the kit {@link BetaSwipeRow}: swipe RIGHT to settle, swipe LEFT to delete (the page
 * owns the optimistic mutation + undo toast). Tapping the body opens the bill detail sheet.
 *
 * Pure presentation + gesture: every write is emitted to the page. Inherits the cream Tally accent tokens
 * from the page `:host` cascade (no global `--tech-*`, no live imports).
 */
@Component({
  selector: 'app-bill-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, MatIconModule, BetaSwipeRow],
  template: `
    <app-bs-swipe-row
      [label]="bill().title"
      leftLabel="Delete" rightLabel="Settle"
      [leftDestructive]="true"
      (swipe)="onSwipe($event)">

      <article class="bc" [class.bc--settled]="settled()"
               (click)="open.emit(bill())"
               role="button" tabindex="0"
               (keydown.enter)="open.emit(bill())" (keydown.space)="open.emit(bill()); $event.preventDefault()"
               [attr.aria-label]="'Open bill ' + bill().title">
        <span class="bc__edge" aria-hidden="true"></span>

        <!-- HEAD: title + status -->
        <header class="bc__head">
          <div class="bc__titlewrap">
            <h3 class="bc__title">{{ bill().title }}</h3>
            <span class="bc__meta">{{ itemCount() }} {{ itemCount() === 1 ? 'item' : 'items' }}{{ sharingSuffix() }}</span>
          </div>
          <span class="bc__status" [class.bc__status--settled]="settled()">
            <span class="bc__status-dot" aria-hidden="true"></span>{{ settled() ? 'Settled' : 'Open' }}
          </span>
        </header>

        <!-- AMOUNT: the big Clash Display numeral -->
        <div class="bc__amount">
          <span class="bc__amount-v">{{ total() | currency: 'USD' : 'symbol' : '1.2-2' }}</span>
          @if (!settled() && unclaimed() > 0) {
            <span class="bc__owed">
              <mat-icon aria-hidden="true">error_outline</mat-icon>
              {{ unclaimed() | currency: 'USD' }} unclaimed
            </span>
          } @else if (members().length) {
            <span class="bc__split-by">split {{ members().length }} {{ members().length === 1 ? 'way' : 'ways' }}</span>
          }
        </div>

        <!-- WHO-OWES-WHAT: a segmented split bar (each person's share + an amber unclaimed sliver) -->
        @if (hasSplit()) {
          <div class="bc__bar" aria-hidden="true">
            @for (m of members(); track m.name; let i = $index) {
              <span class="bc__seg" [style.flex-grow]="m.frac" [style.--seg]="segColor(i)"></span>
            }
            @if (unclaimedFrac() > 0) {
              <span class="bc__seg bc__seg--unclaimed" [style.flex-grow]="unclaimedFrac()"></span>
            }
          </div>
        }

        <!-- FOOTER: member avatars + chevron -->
        <footer class="bc__foot">
          @if (members().length) {
            <div class="bc__avatars" [attr.aria-label]="members().length + ' people on this bill'">
              @for (m of avatarSlice(); track m.name; let i = $index) {
                <span class="bc__av" [style.--av]="segColor(i)" [style.z-index]="10 - i"
                      [attr.title]="m.name">{{ m.initials }}</span>
              }
              @if (members().length > avatarSlice().length) {
                <span class="bc__av bc__av--more">+{{ members().length - avatarSlice().length }}</span>
              }
            </div>
            <span class="bc__lead">
              @if (topMember(); as t) { {{ t.name }} · {{ t.total | currency: 'USD' }} }
            </span>
          } @else {
            <span class="bc__nobody">
              <mat-icon aria-hidden="true">group_add</mat-icon> Nobody's claimed yet
            </span>
          }
          <mat-icon class="bc__chev" aria-hidden="true">chevron_right</mat-icon>
        </footer>
      </article>
    </app-bs-swipe-row>
  `,
  styles: [`
    .bc {
      position: relative;
      display: flex; flex-direction: column; gap: 12px;
      border-radius: var(--r-card);
      background:
        radial-gradient(130% 90% at 0% 0%, color-mix(in srgb, var(--accent-a) 9%, transparent), transparent 58%),
        var(--bg-rise);
      box-shadow: var(--lift-2);
      padding: 16px;
      overflow: hidden;
      isolation: isolate;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: transform 140ms var(--ease-out), box-shadow 220ms var(--ease-out);
    }
    .bc:active {
      transform: scale(.99);
      box-shadow: var(--lift-1),
        0 0 0 1px color-mix(in srgb, var(--accent-a) 36%, transparent),
        0 10px 32px color-mix(in srgb, var(--accent-a) 22%, transparent);
    }
    .bc--settled { opacity: .82; }

    /* Gradient hairline edge picking up the cream accent (top-lit), masked to a 1px ring. */
    .bc__edge {
      position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none; z-index: 0;
      background: linear-gradient(150deg,
        color-mix(in srgb, var(--accent-a) 50%, transparent),
        var(--hairline) 40%,
        color-mix(in srgb, var(--accent-b) 26%, transparent));
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor; mask-composite: exclude;
    }
    .bc > :not(.bc__edge) { position: relative; z-index: 1; }

    .bc__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .bc__titlewrap { min-width: 0; }
    .bc__title {
      margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 17px; line-height: 1.2;
      color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bc__meta { font-size: 12px; font-weight: 600; color: var(--ink-dim); }

    .bc__status {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: var(--r-pill);
      font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn);
    }
    .bc__status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .bc__status--settled { background: color-mix(in srgb, var(--signal) 18%, transparent); color: var(--signal); }

    .bc__amount { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .bc__amount-v {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 38px; line-height: 1; letter-spacing: -.03em; color: var(--ink);
    }
    .bc--settled .bc__amount-v { color: var(--ink-dim); }
    .bc__owed {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; font-weight: 700; color: var(--warn);
      mat-icon { font-size: 15px; width: 15px; height: 15px; }
    }
    .bc__split-by { font-size: 12px; font-weight: 700; color: var(--ink-dim); }

    /* Split bar — a single rounded track of proportional segments. */
    .bc__bar {
      display: flex; gap: 2px; height: 8px; border-radius: var(--r-pill);
      overflow: hidden; background: var(--bg-sink);
    }
    .bc__seg {
      flex: 0 1 auto; min-width: 6px; height: 100%;
      background: var(--seg, var(--accent-a));
      transition: flex-grow 360ms var(--ease-spring-up);
    }
    .bc__seg--unclaimed {
      background: repeating-linear-gradient(45deg,
        color-mix(in srgb, var(--warn) 60%, transparent) 0 5px,
        color-mix(in srgb, var(--warn) 28%, transparent) 5px 10px);
    }

    .bc__foot { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .bc__avatars { flex: 0 0 auto; display: flex; align-items: center; }
    .bc__av {
      display: grid; place-items: center;
      width: 30px; height: 30px; margin-left: -8px;
      border-radius: 50%; border: 2px solid var(--bg-rise);
      background: var(--av, var(--accent-a));
      color: #1a160a; font: 800 11px/1 var(--font-ui);
      letter-spacing: .02em;
    }
    .bc__av:first-child { margin-left: 0; }
    .bc__av--more { background: var(--bg-sink); color: var(--ink-dim); border-color: var(--bg-rise); font-weight: 700; }
    .bc__lead {
      flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600; color: var(--ink-dim);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bc__nobody {
      flex: 1 1 auto; display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; color: var(--ink-dim);
      mat-icon { font-size: 16px; width: 16px; height: 16px; }
    }
    .bc__chev { flex: 0 0 auto; color: var(--ink-faint); font-size: 22px; width: 22px; height: 22px; }
  `],
})
export class BillCard {
  /** The bill to render. */
  readonly bill = input.required<BillDto>();

  /** Open this bill's detail sheet (tap the body). */
  readonly open = output<BillDto>();
  /** Settle this bill (swipe right). */
  readonly settle = output<BillDto>();
  /** Delete this bill (swipe left). */
  readonly delete = output<BillDto>();

  /** A small rotating palette so each member's avatar/segment reads distinctly over the cream accent. */
  private static readonly PALETTE = ['#e8d9a8', '#9ad7c2', '#f0b27a', '#a8c5e8', '#d9a8d2', '#c2d99a'];

  protected readonly settled = computed(() => this.bill().status === 'settled');

  /** Bill list price = items + tax + tip (mirrors the owner total the live page shows). */
  protected readonly total = computed(() => {
    const b = this.bill();
    return b.items.reduce((s, i) => s + i.amount, 0) + (b.taxAmount ?? 0) + (b.tipAmount ?? 0);
  });

  protected readonly itemCount = computed(() => this.bill().items.length);
  protected readonly unclaimed = computed(() => this.bill().unclaimedTotal);

  /** The contributors, biggest share first, with their fraction of the claimed pool. */
  protected readonly members = computed<Member[]>(() => {
    const people = [...this.bill().personTotals].sort((a, b) => b.total - a.total);
    const pool = people.reduce((s, p) => s + p.total, 0) + Math.max(0, this.unclaimed());
    return people.map(p => ({
      name: p.name,
      initials: this.initials(p.name),
      total: p.total,
      frac: pool > 0 ? p.total / pool : 1 / Math.max(1, people.length),
    }));
  });

  protected readonly topMember = computed(() => this.members()[0] ?? null);

  /** Show at most 4 stacked avatars; the rest collapse into a +N chip. */
  protected readonly avatarSlice = computed(() => this.members().slice(0, 4));

  protected readonly hasSplit = computed(() => this.members().length > 0 || this.unclaimed() > 0);

  protected readonly unclaimedFrac = computed(() => {
    const people = this.bill().personTotals.reduce((s, p) => s + p.total, 0);
    const pool = people + Math.max(0, this.unclaimed());
    return pool > 0 ? Math.max(0, this.unclaimed()) / pool : 0;
  });

  /** " · shared" suffix when the owner enabled the public claim link. */
  protected readonly sharingSuffix = computed(() => (this.bill().shareEnabled ? ' · shared' : ''));

  protected segColor(i: number): string {
    return BillCard.PALETTE[i % BillCard.PALETTE.length];
  }

  protected onSwipe(side: 'left' | 'right'): void {
    if (side === 'left') this.delete.emit(this.bill());
    else this.settle.emit(this.bill());
  }

  private initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
  }
}
