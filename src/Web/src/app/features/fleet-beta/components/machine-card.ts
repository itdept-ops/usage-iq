import {
  ChangeDetectionStrategy, Component, computed, input, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FleetMachine } from '../../../core/models';
import { CompactPipe, timeAgo } from '../../../shared/format';
import { BetaStatTile } from '../../beta-ui';
import {
  agentIcon, agentLabel, compactUsd, isLocalName, isOnline, locationLabel,
} from '../fleet-beta.model';

/**
 * BETA FLEET · MachineCard — a single reporting machine as a DEPTH card (sediment surface, lift, a
 * gradient-edge hairline). Header: an online "pulse" dot, the host name + agent/OS line, and the
 * last-seen relative time; a per-machine spend + tokens pair rendered as kit {@link BetaStatTile}s,
 * plus a relative-spend mini bar (this machine's cost vs the fleet's top). Tapping anywhere opens the
 * detail sheet (the whole card is a button). Reads the page accent off the host cascade.
 *
 * Pure presentation over the EXISTING `FleetMachine` DTO — no fetch, no writes.
 */
@Component({
  selector: 'app-fleet-machine-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CompactPipe, BetaStatTile],
  template: `
    <button type="button" class="mc" (click)="open.emit()"
            [attr.aria-label]="ariaLabel()">
      <div class="mc__edge" aria-hidden="true"></div>

      <header class="mc__head">
        <span class="mc__ico" aria-hidden="true">
          <mat-icon>{{ icon() }}</mat-icon>
          @if (online()) { <span class="mc__pulse" aria-hidden="true"></span> }
        </span>
        <span class="mc__id">
          <span class="mc__name" [title]="machine().name">{{ displayName() }}</span>
          <span class="mc__meta">
            @if (online()) { <span class="mc__live">Online</span> }
            @else { <span class="mc__seen">{{ seen() }}</span> }
            @if (subLine()) { <span class="mc__dot" aria-hidden="true">·</span><span class="mc__sub">{{ subLine() }}</span> }
          </span>
        </span>
        <mat-icon class="mc__chev" aria-hidden="true">chevron_right</mat-icon>
      </header>

      <div class="mc__tiles">
        <app-bs-stat-tile [value]="spendLabel()" label="Spend" />
        <app-bs-stat-tile [value]="(machine().tokens | compact)" unit="tok" label="Tokens" />
      </div>

      <div class="mc__share">
        <div class="mc__share-row">
          <span class="mc__share-l">Share of fleet spend</span>
          <span class="mc__share-pct">{{ sharePct() }}%</span>
        </div>
        <div class="mc__bar" [attr.aria-label]="sharePct() + '% of fleet spend'"
             role="img">
          <i [style.width.%]="costPct()"></i>
        </div>
      </div>
    </button>
  `,
  styleUrl: './machine-card.scss',
})
export class FleetMachineCard {
  /** The machine to render. */
  readonly machine = input.required<FleetMachine>();
  /** The fleet's top machine cost — drives the relative-spend bar width. */
  readonly maxCost = input<number>(1);
  /** The fleet's TOTAL spend — drives the labeled share-% (this machine's slice of the whole). */
  readonly totalCost = input<number>(0);
  /** Fired when the card is tapped (the page opens the detail sheet). */
  readonly open = output<void>();

  protected readonly online = computed(() => isOnline(this.machine().lastSeenUtc));
  protected readonly icon = computed(() => agentIcon(this.machine().agent));
  protected readonly displayName = computed(() =>
    isLocalName(this.machine().name) ? 'local (file sync)' : this.machine().name);
  protected readonly seen = computed(() => timeAgo(this.machine().lastSeenUtc));
  protected readonly spendLabel = computed(() => compactUsd(this.machine().costUsd));

  /** Agent + OS line under the name ("Desktop · Windows 11"); drops blanks. */
  protected readonly subLine = computed(() => {
    const m = this.machine();
    return [agentLabel(m.agent), m.os, locationLabel(m)].filter((p) => !!p && p!.length).slice(0, 2).join(' · ');
  });

  protected readonly costPct = computed(() => {
    const max = this.maxCost() || 1;
    return Math.max(3, Math.round((this.machine().costUsd / max) * 100));
  });

  /** This machine's share of the FLEET's total spend, as a display % ("12" / "0.4" for tiny slices). */
  protected readonly sharePct = computed(() => {
    const total = this.totalCost();
    if (total <= 0) return '0';
    const pct = (this.machine().costUsd / total) * 100;
    return pct >= 10 ? Math.round(pct).toString() : pct.toFixed(1);
  });

  protected readonly ariaLabel = computed(() => {
    const m = this.machine();
    const state = this.online() ? 'online' : this.seen();
    return `${this.displayName()}, ${state}, ${this.spendLabel()} spend. Tap for details.`;
  });
}
