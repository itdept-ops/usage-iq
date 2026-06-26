import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { Api } from '../../core/api';
import { AutomationRule, AutomationRuleInput } from '../../core/models';
import {
  BetaFab, BetaPullRefresh, BetaSkeleton, BetaSwipeRow, BetaToaster, ToastController,
} from '../beta-ui';

import { RelayRuleCard } from './components/rule-card';
import { RelayCreateSheet } from './components/rule-create-sheet';

/**
 * Automations "Relay" — the mobile-first if-this-then-that surface, built on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`). One signature accent — a bold ORANGE (amber → red) — re-skins the
 * whole screen via the per-page contract. An immersive header (active-rule count + a glance), then each
 * rule as a readable WHEN → THEN flow card with a native enable switch, in a BetaSwipeRow (swipe LEFT to
 * delete, swipe RIGHT to flip enabled). A BetaFab opens a create BottomSheet (pick trigger + action).
 * Pull-to-refresh, spring stagger, optimistic toggle/delete with toasts, a tasteful empty state.
 *
 * DATA PARITY: every rule + write goes through the SAME endpoints the live `/automations` page uses —
 * `Api.automations` (the caller's own rules), `Api.updateAutomation` (toggle: one-field upsert, webhook
 * left untouched), `Api.deleteAutomation` (remove), and `Api.createAutomation` (the sheet). The server
 * owns all self-scoping + validation; this page never re-derives or relaxes anything.
 *
 * ISOLATION: gated by `beta.access` + `automations.use`; reuses the kit + the SAME read/write Api as the
 * live page. No live page is imported or modified; the kit is consumed, never changed. State lives in this
 * page's signals; the only route-level provider is its own ToastController.
 */
@Component({
  selector: 'app-automations-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, BetaPullRefresh, BetaFab, BetaToaster, BetaSkeleton, BetaSwipeRow,
    RelayRuleCard, RelayCreateSheet,
  ],
  template: `
    <app-bs-pull-refresh class="ab-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="ab-scroll">

        <!-- Immersive header: title + accent bloom + active-rule glance. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Automations</span>
              <h1 class="hh__title">Relay</h1>
              <p class="hh__tag">When this happens, do that — only on your own activity.</p>
            </div>
            <span class="hh__glyph" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
          </div>

          <!-- Glance: active / total / actions (Clash Display numerals). -->
          <div class="hh__glance" role="group" aria-label="Automations summary">
            <div class="hh__stat">
              <span class="hh__stat-n">{{ activeCount() }}</span>
              <span class="hh__stat-l">{{ activeCount() === 1 ? 'rule active' : 'rules active' }}</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              @if (total() > 0) {
                <span class="hh__stat-n">{{ total() }}</span>
                <span class="hh__stat-l">{{ total() === 1 ? 'total' : 'total rules' }}</span>
              } @else {
                <span class="hh__stat-n hh__stat-n--mute">0</span>
                <span class="hh__stat-l">none yet</span>
              }
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              <span class="hh__stat-n">{{ pausedCount() }}</span>
              <span class="hh__stat-l">{{ pausedCount() === 1 ? 'paused' : 'paused' }}</span>
            </div>
          </div>
        </header>

        <!-- Rules. -->
        <section class="ab-list" aria-label="Your automations">
          @if (loading()) {
            <div class="ab-skel">
              @for (s of [0,1,2]; track s) { <app-bs-skeleton height="132px" radius="var(--r-card)" /> }
            </div>
          } @else if (error()) {
            <div class="ab-state">
              <span class="ab-state-ic" aria-hidden="true"><mat-icon>cloud_off</mat-icon></span>
              <p class="ab-state-msg">We couldn't load your automations just now.</p>
              <button type="button" class="ab-state-btn" (click)="reload(true)">
                <mat-icon aria-hidden="true">refresh</mat-icon> Try again
              </button>
            </div>
          } @else if (rules().length === 0) {
            <div class="ab-state ab-empty">
              <span class="ab-state-ic ab-empty-ic" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
              <h2 class="ab-empty-h">No automations yet</h2>
              <p class="ab-state-msg">Create a rule to get a nudge the moment you log a workout, finish a 75-Hard day, or hit your water goal. Tap <strong>New automation</strong> below to start.</p>
            </div>
          } @else {
            <div class="ab-rules">
              @for (r of rules(); track r.id; let i = $index) {
                <div class="ab-row-in" [style.--i]="i">
                  <app-bs-swipe-row
                    leftLabel="Delete"
                    [rightLabel]="r.enabled ? 'Disable' : 'Enable'"
                    [leftDestructive]="true"
                    [label]="r.name || 'Automation'"
                    (swipe)="onSwipe(r, $event)">
                    <app-relay-rule-card
                      [rule]="r"
                      (toggle)="setEnabled(r, $event)"
                      (open)="openCreate()" />
                  </app-bs-swipe-row>
                </div>
              }
            </div>

            <p class="ab-hint">
              <mat-icon aria-hidden="true">swipe</mat-icon>
              Swipe a rule to enable, disable, or delete.
            </p>
          }
        </section>
      </div>
    </app-bs-pull-refresh>

    <!-- Primary action: add a rule. -->
    <app-bs-fab icon="add" label="New automation" [extended]="true" [fixed]="true" (action)="openCreate()" />

    <!-- Create sheet. -->
    <app-relay-create-sheet #createSheet (created)="onCreated($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './automations-beta.page.scss',
})
export class AutomationsBetaPage {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  private readonly createSheet = viewChild.required(RelayCreateSheet);

  // ---- data state ----
  readonly rules = signal<AutomationRule[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly refreshing = signal(false);

  // ---- derived glance ----
  readonly total = computed(() => this.rules().length);
  readonly activeCount = computed(() => this.rules().filter(r => r.enabled).length);
  readonly pausedCount = computed(() => this.rules().filter(r => !r.enabled).length);

  constructor() {
    this.reload(true);
  }

  // ---- load ----
  reload(initial = false): void {
    if (initial) { this.loading.set(true); this.error.set(false); }
    this.api.automations()
      .pipe(
        catchError(() => { if (initial) this.error.set(true); return of<AutomationRule[] | null>(null); }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(rs => {
        if (rs) { this.rules.set(rs); this.error.set(false); }
        this.loading.set(false);
      });
  }

  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      const rs = await firstValueFrom(this.api.automations().pipe(catchError(() => of<AutomationRule[] | null>(null))));
      if (rs) {
        this.rules.set(rs);
        this.error.set(false);
        this.toast.show('Automations refreshed', { tone: 'success', durationMs: 1600 });
      } else {
        this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
      }
    } finally {
      this.refreshing.set(false);
    }
  }

  // ---- swipe: left = delete, right = toggle enabled ----
  onSwipe(rule: AutomationRule, side: 'left' | 'right'): void {
    if (side === 'left') this.remove(rule);
    else this.setEnabled(rule, !rule.enabled);
  }

  // ---- toggle enabled (optimistic, one-field upsert; webhook left untouched) ----
  async setEnabled(rule: AutomationRule, next: boolean): Promise<void> {
    if (rule.enabled === next) return;
    const prev = this.rules();
    // Optimistic flip.
    this.rules.set(prev.map(r => (r.id === rule.id ? { ...r, enabled: next } : r)));

    const body: AutomationRuleInput = {
      name: rule.name,
      triggerKind: rule.triggerKind,
      conditionOp: rule.conditionOp,
      conditionValue: rule.conditionValue,
      action: rule.action,
      messageTemplate: rule.messageTemplate,
      // webhookUrl omitted => null = leave as-is: a one-field toggle must never touch the stored webhook.
      enabled: next,
    };
    try {
      const saved = await firstValueFrom(this.api.updateAutomation(rule.id, body));
      // Reconcile with the server's canonical row (e.g. updatedUtc).
      this.rules.set(this.rules().map(r => (r.id === saved.id ? saved : r)));
      this.toast.show(next ? `“${this.label(rule)}” is on` : `“${this.label(rule)}” paused`, {
        tone: next ? 'success' : 'neutral', durationMs: 2000,
      });
    } catch {
      this.rules.set(prev); // revert
      this.toast.show('Couldn’t update that automation', { tone: 'warn' });
    }
  }

  // ---- delete (optimistic; no undo — a delete can't be re-created with the same id) ----
  async remove(rule: AutomationRule): Promise<void> {
    const prev = this.rules();
    this.rules.set(prev.filter(r => r.id !== rule.id));
    try {
      await firstValueFrom(this.api.deleteAutomation(rule.id));
      this.toast.show(`Deleted “${this.label(rule)}”`, { tone: 'neutral', durationMs: 2600 });
    } catch {
      this.rules.set(prev); // revert
      this.toast.show('Couldn’t delete that automation', { tone: 'warn' });
    }
  }

  // ---- create sheet ----
  openCreate(): void {
    const sheet = this.createSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  onCreated(rule: AutomationRule): void {
    // Optimistically prepend the new rule (the server returns the canonical row).
    this.rules.set([rule, ...this.rules().filter(r => r.id !== rule.id)]);
    this.toast.show(`Created “${this.label(rule)}”`, { tone: 'success', durationMs: 2600 });
  }

  /** A short display name for a rule in toasts (name, else a default from its trigger). */
  private label(rule: AutomationRule): string {
    return rule.name?.trim() || 'Automation';
  }
}
