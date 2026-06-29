import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { BillDto, BillItemDto, ChatContactDto, PERM, ReceiptBreakdownDto } from '../../core/models';
import { pickImage, confirmPhotoNotice } from '../tracker/ai-image';

import {
  BetaFab, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile,
  BetaToaster, ToastController, Segment,
} from '../beta-ui';
import { BillCard } from './cards/bill-card';
import { AssignChange } from './rows/bill-item-row';
import {
  BillDetailSheet, TitleChange, AddItem, BumpChange,
} from './ui/bill-detail-sheet';
import { NewBillSheet, NewBillResult } from './ui/new-bill-sheet';
import { ReceiptReviewSheet, ReceiptReviewResult } from './ui/receipt-review-sheet';

/**
 * Bills "Tally" — the mobile-first split-the-check experience, REBUILT on the shared beta-ui "Strata"
 * foundation (`@use '../beta-ui/beta-kit'`) with a CREAM / warm-paper SIGNATURE accent (a light cream
 * accent on the dark kit — the Tally receipt-paper identity). It reframes the old single-bill editor into a
 * proper money-splitter: an immersive scrolling header (title + a "you're owed" summary pill + two glance
 * stat tiles + an open/settled filter), the bills LIST as rich DEPTH cards ({@link BillCard} — who owes
 * what, status, the amount in big Clash Display numerals, member avatars, a who-owes-what split bar) with a
 * spring-stagger entrance, swipe actions per card (settle / delete), pull-to-refresh, a warm tasteful empty
 * state (keeping the "split the check" invitation), a primary "New bill" {@link BetaFab}, and three bottom
 * sheets: the polished NEW-BILL / split flow ({@link NewBillSheet} — amount keypad, even/custom split,
 * per-person shares with avatars), the full per-bill editor ({@link BillDetailSheet} — items, claim strip,
 * tax/tip, per-person totals, share-claim-link, receipt snap), and the AI receipt review
 * ({@link ReceiptReviewSheet}). HOME-style toasts via {@link ToastController}/{@link BetaToaster}.
 *
 * ISOLATION: reuses the existing bills `Api` methods + DTOs and the shared beta-ui kit, but touches NO live
 * page/component, NO global `--tech-*` tokens, and does NOT modify the flagship tracker-beta or the kit
 * (consume only). The page owns its own optimistic row/bill patch + reconcile (no shared store). Gated by
 * BOTH `platform.mobile` and `bills.use`. No new npm deps.
 */
@Component({
  selector: 'app-bills-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bills-beta.page.scss',
  providers: [ToastController],
  imports: [
    CurrencyPipe, MatIconModule,
    BetaFab, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile, BetaToaster,
    BillCard, BillDetailSheet, NewBillSheet, ReceiptReviewSheet,
  ],
  template: `
    <!-- The scroll column IS the kit pull-to-refresh (it owns overflow + the live accent spinner). -->
    <app-bs-pull-refresh class="bb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="scroll">

        <!-- Immersive header: title + tally subtitle + a cream bloom + a "you're owed" pill. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><mat-icon aria-hidden="true">receipt_long</mat-icon> Tally</span>
              <h1 class="hh__title">Split the check</h1>
              <p class="hh__sub">{{ subtitle() }}</p>
            </div>
            @if (openCount() > 0) {
              <div class="hh__owed" aria-label="Total still open across your bills">
                <span class="hh__owed-v">{{ openTotal() | currency: 'USD' : 'symbol' : '1.0-0' }}</span>
                <span class="hh__owed-l">open</span>
              </div>
            }
          </div>

          <!-- Running totals across ALL your bills (grand total + still-unclaimed money). -->
          @if (bills().length) {
            <div class="hh__running" aria-label="Totals across all your bills">
              <span class="hh__run">
                <span class="hh__run-v">{{ grandTotal() | currency: 'USD' : 'symbol' : '1.0-0' }}</span>
                <span class="hh__run-l">total billed</span>
              </span>
              <span class="hh__run-sep" aria-hidden="true"></span>
              <span class="hh__run" [class.hh__run--warn]="unclaimedTotalAll() > 0">
                <span class="hh__run-v">{{ unclaimedTotalAll() | currency: 'USD' : 'symbol' : '1.0-0' }}</span>
                <span class="hh__run-l">unclaimed</span>
              </span>
            </div>
          }

          @if (bills().length) {
            <div class="hh__stats">
              <app-bs-stat-tile [value]="openCount()" label="Open bills"
                                [ringValue]="settledFrac()" />
              <app-bs-stat-tile [value]="unclaimedCount()" label="Need claiming"
                                accentA="color-mix(in srgb, var(--warn) 78%, #fff)" accentB="var(--warn)" />
            </div>

            <div class="bb-filter">
              <app-bs-segmented [segments]="FILTERS" [(value)]="filter" label="Filter bills" />
            </div>
          }
        </header>

        <!-- LOADING -->
        @if (loading() && !bills().length) {
          <div class="bb-skel">
            <app-bs-skeleton height="148px" radius="var(--r-card)" />
            <app-bs-skeleton height="148px" radius="var(--r-card)" />
            <app-bs-skeleton height="148px" radius="var(--r-card)" />
          </div>

        <!-- EMPTY (no bills at all) -->
        } @else if (!bills().length) {
          <div class="bb-empty">
            <span class="bb-empty__art" aria-hidden="true"><mat-icon>splitscreen</mat-icon></span>
            <h2 class="bb-empty__h">Got the check?</h2>
            <p class="bb-empty__p">Start a bill, snap the receipt, and let everyone claim what's theirs. Splitting dinner has never been this easy.</p>
            <button type="button" class="bb-empty__btn" (click)="openNewBill()">
              <mat-icon aria-hidden="true">add</mat-icon> Split the check
            </button>
          </div>

        <!-- FILTERED-EMPTY (have bills, but none in this tab) -->
        } @else if (!visibleBills().length) {
          <div class="bb-empty">
            <span class="bb-empty__art" aria-hidden="true"><mat-icon>{{ filter() === 'settled' ? 'task_alt' : 'inbox' }}</mat-icon></span>
            <h2 class="bb-empty__h">{{ filter() === 'settled' ? 'Nothing settled yet' : 'All caught up' }}</h2>
            <p class="bb-empty__p">{{ filter() === 'settled' ? 'Settled bills will collect here once everyone has squared up.' : 'No open bills right now — start a new one when the next check lands.' }}</p>
          </div>

        <!-- LIST -->
        } @else {
          <div class="bb-list">
            @for (b of visibleBills(); track b.id) {
              <div class="rise" [id]="'bill-' + b.id" [style.--i]="$index">
                <app-bill-card [bill]="b"
                               (open)="openDetail(b)"
                               (settle)="settleBill(b)"
                               (delete)="deleteBill(b)" />
              </div>
            }
          </div>
        }

        <div class="scroll__foot" aria-hidden="true"></div>
      </div>
    </app-bs-pull-refresh>

    <!-- Fixed bottom action bar: the primary "New bill" FAB pill. -->
    <nav class="actions" aria-label="Bill actions">
      <app-bs-fab class="actions__new" icon="add" label="New bill" [extended]="true" (action)="openNewBill()" />
    </nav>

    <!-- NEW-BILL / split sheet -->
    <app-new-bill-sheet [(open)]="newBillOpen" [contacts]="contacts()"
                        (confirmed)="onNewBill($event)" />

    <!-- BILL-DETAIL sheet -->
    <app-bill-detail-sheet
      [(open)]="detailOpen" [bill]="selected()" [contacts]="contacts()"
      [canUseVision]="canUseVision()" [busy]="busy()"
      [importing]="importing()" [importDone]="importDone()" [importTotal]="importTotal()"
      (titleChange)="onTitle($event)"
      (addItem)="onAddItem($event)"
      (settleItem)="onSettleItem($event)"
      (deleteItem)="onDeleteItem($event)"
      (assignItem)="onAssignItem($event)"
      (bumpTax)="onBumpTax($event)"
      (bumpTip)="onBumpTip($event)"
      (toggleSettled)="settleBill($event)"
      (snap)="uploadReceipt($event)"
      (enableShare)="enableShare($event)"
      (disableShare)="disableShare($event)"
      (shareLink)="shareLink($event)"
      (copyShare)="copyShare($event)" />

    <!-- RECEIPT review sheet -->
    <app-receipt-review-sheet [(open)]="reviewOpen" [breakdown]="reviewBreakdown()"
                              (confirmed)="onReviewConfirmed($event)" />

    <!-- One toaster host for the page's optimistic toasts. -->
    <app-bs-toaster />
  `,
})
export class BillsBetaPage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toasts = inject(ToastController);
  private route = inject(ActivatedRoute);

  readonly bills = signal<BillDto[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly refreshing = signal(false);
  readonly contacts = signal<ChatContactDto[]>([]);

  /** AI receipt is only offered when the caller holds ai.vision (matching the live page's extra gate). */
  readonly canUseVision = computed(() => this.auth.hasPermission(PERM.aiVision));

  // ---- list filter ----
  protected readonly FILTERS: Segment[] = [
    { key: 'open', label: 'Open' },
    { key: 'settled', label: 'Settled' },
    { key: 'all', label: 'All' },
  ];
  readonly filter = signal<string>('open');

  // ---- sheet state ----
  readonly newBillOpen = signal(false);
  readonly detailOpen = signal(false);

  // Receipt-import progress (drives the determinate bar in the detail sheet).
  readonly importing = signal(false);
  readonly importDone = signal(0);
  readonly importTotal = signal(0);

  // Receipt-review sheet state.
  readonly reviewOpen = signal(false);
  readonly reviewBreakdown = signal<ReceiptBreakdownDto | null>(null);
  private reviewBillId: number | null = null;

  readonly selected = computed<BillDto | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.bills().find(b => b.id === id) ?? null;
  });

  /** Bills shown in the current filter tab. */
  readonly visibleBills = computed<BillDto[]>(() => {
    const f = this.filter();
    const list = this.bills();
    if (f === 'all') return list;
    if (f === 'settled') return list.filter(b => b.status === 'settled');
    return list.filter(b => b.status !== 'settled');
  });

  // ---- header summary ----
  readonly openCount = computed(() => this.bills().filter(b => b.status !== 'settled').length);
  readonly settledCount = computed(() => this.bills().filter(b => b.status === 'settled').length);
  readonly settledFrac = computed(() => {
    const total = this.bills().length;
    return total ? this.settledCount() / total : 0;
  });
  /** Sum of every OPEN bill's list price (items + tax + tip). */
  readonly openTotal = computed(() =>
    this.bills().filter(b => b.status !== 'settled')
      .reduce((s, b) => s + this.billTotal(b), 0));
  /** How many bills still have unclaimed money on them. */
  readonly unclaimedCount = computed(() =>
    this.bills().filter(b => b.status !== 'settled' && b.unclaimedTotal > 0).length);
  /** Running grand total across EVERY one of your bills (open + settled), items + tax + tip. */
  readonly grandTotal = computed(() =>
    this.bills().reduce((s, b) => s + this.billTotal(b), 0));
  /** Running unclaimed money still on the table across all your bills. */
  readonly unclaimedTotalAll = computed(() =>
    this.bills().reduce((s, b) => s + Math.max(0, b.unclaimedTotal), 0));

  readonly subtitle = computed(() => {
    const n = this.bills().length;
    if (!n) return 'Start your first bill below.';
    const open = this.openCount();
    if (!open) return 'Everything is settled — nice work.';
    return `${open} open ${open === 1 ? 'bill' : 'bills'} to square up.`;
  });

  constructor() {
    this.reload();
    this.loadContacts();
  }

  private billTotal(b: BillDto): number {
    return b.items.reduce((s, i) => s + i.amount, 0) + (b.taxAmount ?? 0) + (b.tipAmount ?? 0);
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.api.bills());
      this.bills.set(list);
      this.focusFromQuery(list);
      // Keep the open detail bill consistent if the list changed underneath it.
      if (this.selectedId() != null && !list.some(b => b.id === this.selectedId())) {
        this.selectedId.set(null);
        this.detailOpen.set(false);
      }
    } catch {
      this.toasts.show('Could not load your bills.', { tone: 'warn' });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Deep-link from Search: ?focus={id} selects + opens + scrolls to that bill (parity with the desktop
   * /bills consumer, which selects + scrolls). We switch the filter to "All" first so the focused bill is
   * guaranteed to render even if it's settled (the default tab is "Open"), open its detail sheet, then
   * scroll its #bill-{id} anchor into view once it's painted. No-op when the param is absent/invalid, so a
   * normal visit behaves exactly as before. Only acts once (consumes the snapshot param).
   */
  private focused = false;
  private focusFromQuery(list: BillDto[]): void {
    if (this.focused) return;
    const raw = this.route.snapshot.queryParamMap.get('focus');
    const id = raw ? Number(raw) : NaN;
    if (!Number.isInteger(id) || !list.some(b => b.id === id)) return;
    this.focused = true;
    this.filter.set('all'); // ensure the target renders regardless of its open/settled status
    this.selectedId.set(id);
    this.detailOpen.set(true);
    setTimeout(() => {
      document.getElementById('bill-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /** Pull-to-refresh: re-pull the bills (and contacts), with a beat so the spinner reads as real work. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      await Promise.all([this.reload(), this.loadContacts()]);
      await new Promise(r => setTimeout(r, 350));
    } finally {
      this.refreshing.set(false);
    }
  }

  /** Best-effort contacts for the inline claim strip + split flow — chat.read gated; silently empty if denied. */
  private async loadContacts(): Promise<void> {
    try {
      this.contacts.set((await firstValueFrom(this.api.myContacts())) ?? []);
    } catch {
      this.contacts.set([]);
    }
  }

  /** Replace one bill in the list (after a write returns the fresh DTO) without a full reload. */
  private patchBill(b: BillDto): void {
    this.bills.set(this.bills().map(x => (x.id === b.id ? b : x)));
  }

  /** Patch a single item's fields in a bill — used for optimistic assign/settle. */
  private patchItem(billId: number, itemId: number, change: Partial<BillItemDto>): void {
    this.bills.set(this.bills().map(b =>
      b.id !== billId ? b : { ...b, items: b.items.map(i => (i.id === itemId ? { ...i, ...change } : i)) }));
  }

  private async refreshBill(id: number): Promise<void> {
    try {
      this.patchBill(await firstValueFrom(this.api.bill(id)));
    } catch {
      this.reload();
    }
  }

  // ---- list-level actions ----

  openNewBill(): void {
    this.newBillOpen.set(true);
  }

  openDetail(b: BillDto): void {
    this.selectedId.set(b.id);
    this.detailOpen.set(true);
  }

  /** Toggle a bill open/settled (swipe-right on the card, or the detail button). Optimistic + reconcile. */
  async settleBill(b: BillDto): Promise<void> {
    const next = b.status === 'settled' ? 'open' : 'settled';
    const prevStatus = b.status;
    this.patchBill({ ...b, status: next });
    try {
      const updated = await firstValueFrom(this.api.updateBill(b.id, {
        taxAmount: b.taxAmount ?? null, tipAmount: b.tipAmount ?? null, status: next,
      }));
      this.patchBill(updated);
      this.toasts.show(next === 'settled' ? `“${b.title}” settled` : `“${b.title}” reopened`, {
        tone: 'success',
        actionLabel: 'Undo',
        onAction: () => void this.settleBill({ ...b, status: next }),
      });
    } catch {
      this.patchBill({ ...b, status: prevStatus });
      this.toasts.show('Could not update the bill.', { tone: 'warn' });
    }
  }

  /** Delete a bill (swipe-left). Optimistic remove, undo restores via re-create-free reload on failure. */
  async deleteBill(b: BillDto): Promise<void> {
    const prev = this.bills();
    this.bills.set(prev.filter(x => x.id !== b.id));
    if (this.selectedId() === b.id) { this.detailOpen.set(false); this.selectedId.set(null); }
    try {
      await firstValueFrom(this.api.deleteBill(b.id));
      this.toasts.show(`“${b.title}” deleted`, { tone: 'neutral' });
    } catch {
      this.bills.set(prev);
      this.toasts.show('Could not delete the bill.', { tone: 'warn' });
    }
  }

  // ---- new-bill / split flow ----

  /** Create the bill, then write one split line per participant (assigning to their contact when present). */
  async onNewBill(result: NewBillResult): Promise<void> {
    this.busy.set(true);
    try {
      const created = await firstValueFrom(this.api.createBill({ title: result.title }));
      this.bills.set([created, ...this.bills()]);

      for (const share of result.shares) {
        const added = await firstValueFrom(this.api.addBillItem(created.id, {
          name: `${share.name}'s share`, amount: share.amount,
        }));
        // Assign the line to the contact so the per-person totals attribute it correctly.
        if (share.userId != null) {
          try { await firstValueFrom(this.api.assignBillItem(created.id, added.id, share.userId)); }
          catch { /* assignment is best-effort — the line still exists unassigned */ }
        }
      }

      await this.refreshBill(created.id);
      this.toasts.show(`“${result.title}” is ready to split.`, { tone: 'success' });
      // Drop the user straight into the new bill's detail.
      this.openDetail(this.bills().find(b => b.id === created.id) ?? created);
    } catch {
      this.toasts.show('Could not create the bill.', { tone: 'warn' });
      this.reload();
    } finally {
      this.busy.set(false);
    }
  }

  // ---- detail-sheet mutations (the page owns the optimistic patch + reconcile) ----

  async onTitle(c: TitleChange): Promise<void> {
    await this.update(c.bill, { title: c.title });
  }

  async onBumpTax(c: BumpChange): Promise<void> {
    const next = Math.max(0, Math.round(((c.bill.taxAmount ?? 0) + c.dir) * 100) / 100);
    await this.update(c.bill, { taxAmount: next || null });
  }

  async onBumpTip(c: BumpChange): Promise<void> {
    const next = Math.max(0, Math.round(((c.bill.tipAmount ?? 0) + c.dir) * 100) / 100);
    await this.update(c.bill, { tipAmount: next || null });
  }

  /** Mirrors the live page: always resend tax/tip so a null clear stays explicit, merged with `body`. */
  private async update(b: BillDto, body: Parameters<Api['updateBill']>[1]): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.updateBill(b.id, {
        taxAmount: b.taxAmount ?? null,
        tipAmount: b.tipAmount ?? null,
        ...body,
      }));
      this.patchBill(updated);
    } catch {
      this.toasts.show('Could not save.', { tone: 'warn' });
      this.reload();
    }
  }

  async onAddItem(c: AddItem): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.addBillItem(c.bill.id, { name: c.name, amount: c.amount }));
      await this.refreshBill(c.bill.id);
    } catch {
      this.toasts.show('Could not add the item.', { tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }

  async onDeleteItem(c: { bill: BillDto; item: BillItemDto }): Promise<void> {
    const { bill, item } = c;
    const prev = bill.items;
    this.bills.set(this.bills().map(x =>
      x.id !== bill.id ? x : { ...x, items: x.items.filter(i => i.id !== item.id) }));
    try {
      await firstValueFrom(this.api.deleteBillItem(bill.id, item.id));
      await this.refreshBill(bill.id);
    } catch {
      this.bills.set(this.bills().map(x => (x.id === bill.id ? { ...x, items: prev } : x)));
      this.toasts.show('Could not remove the item.', { tone: 'warn' });
    }
  }

  async onSettleItem(c: { bill: BillDto; item: BillItemDto }): Promise<void> {
    const { bill, item } = c;
    const next = !item.settled;
    this.patchItem(bill.id, item.id, { settled: next });
    try {
      await firstValueFrom(this.api.settleBillItem(bill.id, item.id, next));
      await this.refreshBill(bill.id);
    } catch {
      this.patchItem(bill.id, item.id, { settled: !next });
      this.toasts.show('Could not update the item.', { tone: 'warn' });
    }
  }

  async onAssignItem(c: { bill: BillDto; change: AssignChange }): Promise<void> {
    const { bill } = c;
    const { item, userId } = c.change;
    const prev = {
      assignedToUserId: item.assignedToUserId ?? null,
      assignedToName: item.assignedToName ?? null,
      open: item.open,
    };
    const name = userId == null ? null : (this.contacts().find(x => x.userId === userId)?.name ?? null);
    this.patchItem(bill.id, item.id, { assignedToUserId: userId, assignedToName: name, open: userId == null });
    try {
      await firstValueFrom(this.api.assignBillItem(bill.id, item.id, userId));
      await this.refreshBill(bill.id);
    } catch (e: unknown) {
      this.patchItem(bill.id, item.id, prev);
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Could not assign the item.';
      this.toasts.show(msg, { tone: 'warn' });
    }
  }

  // ---- Receipt AI (gated ai.vision; image digested in-memory, never stored; 503-graceful) ----

  async uploadReceipt(b: BillDto): Promise<void> {
    if (!this.canUseVision()) return;
    if (!(await confirmPhotoNotice())) return;

    let img;
    try {
      // No `capture` attribute → the OS offers BOTH "Take Photo" and "Photo Library", so the user can snap
      // a receipt OR attach an existing photo (previously this forced the camera first).
      img = await pickImage();
    } catch (e: unknown) {
      this.toasts.show((e as Error)?.message ?? 'Could not read that image.', { tone: 'warn' });
      return;
    }
    if (!img) return;

    this.busy.set(true);
    let breakdown: ReceiptBreakdownDto;
    try {
      breakdown = await firstValueFrom(this.api.billReceipt(b.id, img));
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      this.toasts.show(
        status === 503
          ? 'Receipt AI is unavailable right now — add the items manually.'
          : 'Could not read that receipt. Add the items manually.',
        { tone: 'warn' });
      return;
    } finally {
      this.busy.set(false);
    }

    this.reviewBillId = b.id;
    this.reviewBreakdown.set(breakdown);
    this.reviewOpen.set(true);
  }

  /** Batch-write the reviewed lines, then the detected tax/tip, behind a determinate bar. */
  async onReviewConfirmed(result: ReceiptReviewResult): Promise<void> {
    const id = this.reviewBillId;
    const b = id == null ? null : this.bills().find(x => x.id === id);
    if (!b) return;

    this.importing.set(true);
    this.importTotal.set(result.items.length);
    this.importDone.set(0);
    try {
      for (const it of result.items) {
        await firstValueFrom(this.api.addBillItem(b.id, { name: it.name, amount: it.amount }));
        this.importDone.update(n => n + 1);
      }
      if (result.tax != null || result.tip != null) {
        await firstValueFrom(this.api.updateBill(b.id, {
          taxAmount: result.tax ?? b.taxAmount ?? null,
          tipAmount: result.tip ?? b.tipAmount ?? null,
        }));
      }
      await this.refreshBill(b.id);
      this.toasts.show(`Added ${result.items.length} item${result.items.length === 1 ? '' : 's'} from the receipt.`,
        { tone: 'success' });
    } catch {
      this.toasts.show('Saved some lines but hit an error — check the bill.', { tone: 'warn' });
      this.refreshBill(b.id);
    } finally {
      this.importing.set(false);
      this.reviewBillId = null;
    }
  }

  // ---- Public claim link ----

  /** Absolute claim URL for copy/share (the API returns a path like /bill/{token}). */
  private shareUrl(b: BillDto): string {
    return b.sharePath ? `${location.origin}${b.sharePath}` : '';
  }

  private async setShare(b: BillDto, enabled: boolean): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.toggleBillShare(b.id, enabled));
      this.patchBill({ ...b, shareEnabled: res.shareEnabled, sharePath: res.sharePath ?? null });
    } catch {
      this.toasts.show('Could not update the share link.', { tone: 'warn' });
    }
  }

  /** Turn the link on, then immediately offer to share it. */
  async enableShare(b: BillDto): Promise<void> {
    await this.setShare(b, true);
    const fresh = this.bills().find(x => x.id === b.id);
    if (fresh?.shareEnabled) await this.shareLink(fresh);
  }

  async disableShare(b: BillDto): Promise<void> {
    await this.setShare(b, false);
  }

  /** Native Web Share when available, else copy to clipboard. */
  async shareLink(b: BillDto): Promise<void> {
    const url = this.shareUrl(b);
    if (!url) return;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: b.title, text: `Claim your items on "${b.title}"`, url });
        return;
      } catch {
        // user cancelled the share sheet — fall through to copy as a convenience
      }
    }
    await this.copyShare(b);
  }

  async copyShare(b: BillDto): Promise<void> {
    const url = this.shareUrl(b);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.toasts.show('Claim link copied.', { tone: 'success' });
    } catch {
      this.toasts.show('Copy failed — select and copy the link manually.', { tone: 'warn' });
    }
  }
}
