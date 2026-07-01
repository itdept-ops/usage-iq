import {
  ChangeDetectionStrategy, Component, computed, input, model, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

import { FleetMachine } from '../../../core/models';
import { CompactPipe, timeAgo } from '../../../shared/format';
import { BetaBottomSheet, BetaStatTile } from '../../beta-ui';
import {
  agentIcon, agentLabel, compactUsd, FleetAction, geoSourceLabel, hasCoords, isLocalName, isOnline,
  locationLabel, mapUrl, ramLabel, systemLabel, uptimeLabel,
} from '../fleet-beta.model';

/** A single label→value detail line for the sheet's spec grid. */
interface DetailRow { icon: string; label: string; value: string; mono?: boolean; }

/**
 * BETA FLEET · MachineSheet — the tap-through detail BottomSheet for one machine, wrapping the kit
 * {@link BetaBottomSheet}. A hero block (icon + online pulse + name + spend/tokens StatTiles), a
 * "Linked users" chip row, then a spec grid of the agent's reported system metadata (IP/OS/CPU/RAM/
 * GPU/uptime/locale/version) and a location row that links out to OpenStreetMap. All from the EXISTING
 * `FleetMachine` DTO — read-only, no fetch.
 */
@Component({
  selector: 'app-fleet-machine-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, RouterLink, CompactPipe, BetaBottomSheet, BetaStatTile],
  template: `
    <app-bs-sheet [(open)]="open" detent="half" [label]="sheetLabel()">
      @if (machine(); as m) {
        <div class="ms">
          <!-- Hero -->
          <header class="ms__hero">
            <span class="ms__ico" aria-hidden="true">
              <mat-icon>{{ icon() }}</mat-icon>
              @if (online()) { <span class="ms__pulse"></span> }
            </span>
            <div class="ms__id">
              <h2 class="ms__name">{{ displayName() }}</h2>
              <p class="ms__state">
                @if (online()) { <span class="ms__live">Online now</span> }
                @else { <span>Last seen {{ seen() }}</span> }
                @if (agentLbl()) { <span class="ms__sep" aria-hidden="true">·</span><span>{{ agentLbl() }}</span> }
              </p>
            </div>
          </header>

          <!-- Copy the machine name (the raw host, not the "local (file sync)" label). -->
          @if (!isLocal()) {
            <button type="button" class="ms__copyname" (click)="copy(m.name, 'Machine name')">
              <mat-icon aria-hidden="true">content_copy</mat-icon>
              <span class="ms__copyname-t">{{ m.name }}</span>
              <span class="ms__copyname-h">Copy</span>
            </button>
          }

          <div class="ms__tiles">
            <app-bs-stat-tile [value]="spendLabel()" label="Spend" />
            <app-bs-stat-tile [value]="(m.tokens | compact)" unit="tok" label="Tokens" />
            <app-bs-stat-tile [value]="sharePct()" unit="%" label="Of fleet" />
          </div>

          <!-- Identity & network: agent + the IPs, each one-tap copyable. -->
          @if (agentLbl() || m.localIp || m.publicIp || m.lanIps) {
            <section class="ms__sec">
              <span class="ms__sec-h">Identity &amp; network</span>
              <div class="ms__net">
                @if (agentLbl()) {
                  <div class="ms__net-row">
                    <dt class="ms__net-l"><mat-icon aria-hidden="true">{{ icon() }}</mat-icon> Reporter</dt>
                    <span class="ms__net-v">{{ agentLbl() }}</span>
                  </div>
                }
                @if (m.localIp) {
                  <button type="button" class="ms__net-row is-copy" (click)="copy(m.localIp!, 'Local IP')">
                    <span class="ms__net-l"><mat-icon aria-hidden="true">lan</mat-icon> Local IP</span>
                    <span class="ms__net-v mono">{{ m.localIp }}</span>
                    <mat-icon class="ms__net-c" aria-hidden="true">content_copy</mat-icon>
                  </button>
                }
                @if (m.publicIp) {
                  <button type="button" class="ms__net-row is-copy" (click)="copy(m.publicIp!, 'Public IP')">
                    <span class="ms__net-l"><mat-icon aria-hidden="true">public</mat-icon> Public IP</span>
                    <span class="ms__net-v mono">{{ m.publicIp }}</span>
                    <mat-icon class="ms__net-c" aria-hidden="true">content_copy</mat-icon>
                  </button>
                }
                @if (m.lanIps) {
                  <button type="button" class="ms__net-row is-copy" (click)="copy(m.lanIps!, 'LAN IPs')">
                    <span class="ms__net-l"><mat-icon aria-hidden="true">router</mat-icon> LAN IPs</span>
                    <span class="ms__net-v mono">{{ m.lanIps }}</span>
                    <mat-icon class="ms__net-c" aria-hidden="true">content_copy</mat-icon>
                  </button>
                }
              </div>
            </section>
          }

          <!-- Linked users -->
          <section class="ms__sec">
            <span class="ms__sec-h">Users on this machine</span>
            @if (m.users.length) {
              <div class="ms__chips">
                @for (u of m.users; track u) {
                  <span class="ms__chip"><mat-icon aria-hidden="true">person</mat-icon>{{ u }}</span>
                }
              </div>
            } @else {
              <span class="ms__none">No linked users.</span>
            }
          </section>

          <!-- Spec grid -->
          @if (specs().length) {
            <section class="ms__sec">
              <span class="ms__sec-h">Machine details</span>
              <dl class="ms__grid">
                @for (s of specs(); track s.label) {
                  <div class="ms__cell">
                    <dt><mat-icon aria-hidden="true">{{ s.icon }}</mat-icon> {{ s.label }}</dt>
                    <dd [class.mono]="s.mono">{{ s.value }}</dd>
                  </div>
                }
              </dl>
            </section>
          }

          <!-- Location -->
          @if (locLabel() || coords()) {
            <section class="ms__sec">
              <span class="ms__sec-h">
                Location
                @if (geoLbl()) { <span class="ms__geo" [class.is-gps]="geoLbl() === 'GPS'">{{ geoLbl() }}</span> }
              </span>
              <div class="ms__loc">
                @if (locLabel()) { <span class="ms__place">{{ locLabel() }}</span> }
                @if (coords()) {
                  <a class="ms__map" [href]="mapHref()" target="_blank" rel="noopener noreferrer">
                    Open map <mat-icon aria-hidden="true">open_in_new</mat-icon>
                  </a>
                }
              </div>
            </section>
          }

          <!-- Management (reporter.manage) — combine/move + delete this machine. -->
          @if (canManage()) {
            <section class="ms__sec">
              <span class="ms__sec-h">Manage</span>
              <div class="ms__actions">
                <button type="button" class="ms__action" (click)="manage.emit('reassign')">
                  <mat-icon aria-hidden="true">merge_type</mat-icon>
                  <span class="ms__action-t">Combine / move…</span>
                </button>
                <button type="button" class="ms__action is-danger" (click)="manage.emit('delete')">
                  <mat-icon aria-hidden="true">delete_forever</mat-icon>
                  <span class="ms__action-t">Delete…</span>
                </button>
              </div>
            </section>
          }

          <!-- Forward CTA: stand up another reporter. -->
          <a class="ms__cta" routerLink="/reporter" (click)="open.set(false)">
            <span class="ms__cta-ic" aria-hidden="true"><mat-icon>add_link</mat-icon></span>
            <span class="ms__cta-t">
              <span class="ms__cta-h">Set up another reporter</span>
              <span class="ms__cta-s">Connect another machine to your fleet</span>
            </span>
            <mat-icon class="ms__cta-chev" aria-hidden="true">arrow_forward</mat-icon>
          </a>
        </div>
      }
    </app-bs-sheet>
  `,
  styleUrl: './machine-sheet.scss',
})
export class FleetMachineSheet {
  /** Two-way open state — the page flips this when a card is tapped. */
  readonly open = model<boolean>(false);
  /** The machine being detailed (null collapses the sheet body). */
  readonly machine = input<FleetMachine | null>(null);
  /** The fleet's TOTAL spend — drives the "of fleet" share-% tile. */
  readonly totalCost = input<number>(0);
  /** reporter.manage — reveals the combine/move + delete management actions. */
  readonly canManage = input<boolean>(false);
  /** Emitted after a copy attempt so the page can toast (label = what was copied). */
  readonly copied = output<{ label: string; ok: boolean }>();
  /** Fired when a management action is chosen — the page opens the confirm sheet for this machine. */
  readonly manage = output<FleetAction>();

  protected readonly online = computed(() => isOnline(this.machine()?.lastSeenUtc ?? null));
  protected readonly isLocal = computed(() => {
    const m = this.machine();
    return !!m && isLocalName(m.name);
  });
  protected readonly icon = computed(() => agentIcon(this.machine()?.agent ?? null));
  protected readonly displayName = computed(() => {
    const m = this.machine();
    if (!m) return '';
    return isLocalName(m.name) ? 'local (file sync)' : m.name;
  });
  protected readonly agentLbl = computed(() => agentLabel(this.machine()?.agent ?? null));
  protected readonly seen = computed(() => timeAgo(this.machine()?.lastSeenUtc ?? null));
  protected readonly spendLabel = computed(() => compactUsd(this.machine()?.costUsd ?? 0));
  protected readonly sheetLabel = computed(() => `${this.displayName()} details`);

  /** This machine's share of the fleet's total spend, as a display % ("12" / "0.4" for tiny slices). */
  protected readonly sharePct = computed(() => {
    const total = this.totalCost();
    const cost = this.machine()?.costUsd ?? 0;
    if (total <= 0) return '0';
    const pct = (cost / total) * 100;
    return pct >= 10 ? Math.round(pct).toString() : pct.toFixed(1);
  });

  /** Copy a value to the clipboard (best-effort) and notify the page to toast. */
  async copy(value: string, label: string): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = false;
    }
    this.copied.emit({ label, ok });
  }

  protected readonly locLabel = computed(() => { const m = this.machine(); return m ? locationLabel(m) : ''; });
  protected readonly coords = computed(() => { const m = this.machine(); return !!m && hasCoords(m); });
  protected readonly geoLbl = computed(() => geoSourceLabel(this.machine()?.geoSource ?? null));
  protected readonly mapHref = computed(() => { const m = this.machine(); return m && hasCoords(m) ? mapUrl(m) : '#'; });

  /** The reported-metadata rows to show (drops blanks). */
  protected readonly specs = computed<DetailRow[]>(() => {
    const m = this.machine();
    if (!m) return [];
    const rows: DetailRow[] = [];
    const push = (icon: string, label: string, value: string | null | undefined, mono = false) => {
      if (value != null && String(value).trim().length) rows.push({ icon, label, value: String(value), mono });
    };
    // Local/Public IP + agent now live in the copyable "Identity & network" section above.
    push('computer', 'OS', [m.os, m.arch].filter((p) => !!p).join(' · '));
    push('account_circle', 'OS user', m.osUser, true);
    push('workspaces', 'Domain', m.domain ?? null);
    push('developer_board', 'CPU', m.cpuModel ?? null);
    // Physical / logical core counts ("8C / 16T") when reported; else the coarse cpuCount.
    if (m.physicalCores || m.logicalCores) {
      const parts: string[] = [];
      if (m.physicalCores) parts.push(`${m.physicalCores}C`);
      if (m.logicalCores) parts.push(`${m.logicalCores}T`);
      push('memory', 'Cores', parts.join(' / '), true);
    } else if (!m.cpuModel) {
      push('memory', 'CPU cores', m.cpuCount != null ? String(m.cpuCount) : null, true);
    }
    push('sd_card', 'RAM', ramLabel(m.ramTotalMB) || null, true);
    push('videogame_asset', 'GPU', m.gpuModel ?? null);
    push('precision_manufacturing', 'System', systemLabel(m) || null);
    push('timelapse', 'Uptime', uptimeLabel(m.uptimeSec) || null, true);
    push('schedule', 'Time zone', m.timeZoneId ?? null);
    push('translate', 'Locale', m.culture ?? null, true);
    push('verified', 'Reporter', m.reporterVersion ? `v${m.reporterVersion}` : null, true);
    push('code', '.NET', m.frameworkVersion ?? null, true);
    push('history', 'First seen', m.firstSeenUtc ? timeAgo(m.firstSeenUtc) : null);
    return rows;
  });
}
