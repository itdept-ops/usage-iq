import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { BillDto, BillItemDto, PaymentHandlesDto, PERM } from '../../core/models';
import { captureImage, pickImage, confirmPhotoNotice } from '../tracker/ai-image';
import { ReceiptReviewDialog, ReceiptReviewData, ReceiptReviewResult } from './receipt-review-dialog';
import { AssignContactDialog, AssignContactData, AssignContactResult } from './assign-contact-dialog';

/** One pay-me link rendered from the owner's configured handles. */
interface PayLink {
  label: string;
  icon: string;
  url: string;
}

/**
 * The gated /bills owner page (permissionGuard(bills.use)). A master list of the caller's bills on the
 * left and a detail editor on the right: create a bill, add items manually or via an AI receipt photo
 * (gated ai.vision), assign items to contacts, watch per-person totals roll up (with a proportional
 * tax/tip split), toggle + copy the public claim link, mark items / the whole bill settled, and show the
 * owner's CashApp/PayPal/Venmo pay-me links. Every write is owner-scoped server-side.
 */
@Component({
  selector: 'app-bills',
  imports: [
    CommonModule, FormsModule, MatIconModule, MatButtonModule, MatProgressBarModule,
    MatProgressSpinnerModule, MatTooltipModule, MatMenuModule, MatSlideToggleModule, MatDialogModule,
    MatSnackBarModule,
  ],
  templateUrl: './bills.html',
  styleUrl: './bills.scss',
})
export class Bills {
  private api = inject(Api);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly bills = signal<BillDto[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);

  /** AI receipt breakdown is only offered when the caller holds ai.vision (the receipt route's extra gate). */
  readonly canUseVision = computed(() => this.auth.hasPermission(PERM.aiVision));

  /** Draft for the inline "new item" row in the detail. */
  readonly newName = signal('');
  readonly newAmount = signal<number | null>(null);

  readonly selected = computed<BillDto | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.bills().find(b => b.id === id) ?? null;
  });

  /** The bill's full list price (items + tax + tip) for the header summary. */
  readonly billTotal = computed(() => {
    const b = this.selected();
    if (!b) return 0;
    const items = b.items.reduce((s, i) => s + i.amount, 0);
    return items + (b.taxAmount ?? 0) + (b.tipAmount ?? 0);
  });

  /** The owner's configured pay-me links (CashApp/PayPal/Venmo), omitting blank handles. */
  readonly payLinks = computed<PayLink[]>(() => Bills.toPayLinks(this.selected()?.payments));

  static toPayLinks(p: PaymentHandlesDto | undefined | null): PayLink[] {
    if (!p) return [];
    const out: PayLink[] = [];
    if (p.cashApp) out.push({ label: 'CashApp', icon: 'attach_money', url: p.cashApp });
    if (p.payPal) out.push({ label: 'PayPal', icon: 'account_balance_wallet', url: p.payPal });
    if (p.venmo) out.push({ label: 'Venmo', icon: 'payments', url: p.venmo });
    return out;
  }

  constructor() {
    this.reload(true);
  }

  private async reload(selectFirst = false): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.api.bills());
      this.bills.set(list);
      if (selectFirst && list.length && this.selectedId() == null) this.selectedId.set(list[0].id);
      // Keep the current selection valid (e.g. after a delete).
      if (this.selectedId() != null && !list.some(b => b.id === this.selectedId())) {
        this.selectedId.set(list[0]?.id ?? null);
      }
    } catch {
      this.snack.open('Could not load your bills.', 'OK', { duration: 4000 });
    } finally {
      this.loading.set(false);
    }
  }

  /** Replace one bill in the list (after a write returns the fresh DTO) without a full reload. */
  private patchBill(b: BillDto): void {
    this.bills.set(this.bills().map(x => (x.id === b.id ? b : x)));
  }

  select(id: number): void {
    this.selectedId.set(id);
  }

  async createBill(): Promise<void> {
    this.busy.set(true);
    try {
      const b = await firstValueFrom(this.api.createBill({ title: 'New bill' }));
      this.bills.set([b, ...this.bills()]);
      this.selectedId.set(b.id);
    } catch {
      this.snack.open('Could not create the bill.', 'OK', { duration: 4000 });
    } finally {
      this.busy.set(false);
    }
  }

  /** Persist a title edit on blur (no-op when unchanged or blank). */
  async saveTitle(b: BillDto, title: string): Promise<void> {
    const t = title.trim();
    if (!t || t === b.title) return;
    await this.update(b, { title: t });
  }

  async saveTax(b: BillDto, v: number | null): Promise<void> {
    await this.update(b, { taxAmount: v });
  }

  async saveTip(b: BillDto, v: number | null): Promise<void> {
    await this.update(b, { tipAmount: v });
  }

  async toggleSettled(b: BillDto): Promise<void> {
    await this.update(b, { status: b.status === 'settled' ? 'open' : 'settled' });
  }

  private async update(b: BillDto, body: Parameters<Api['updateBill']>[1]): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.updateBill(b.id, {
        // Always resend tax/tip so a null clear is explicit (the API clamps null→null).
        taxAmount: b.taxAmount ?? null,
        tipAmount: b.tipAmount ?? null,
        ...body,
      }));
      this.patchBill(updated);
    } catch {
      this.snack.open('Could not save.', 'OK', { duration: 4000 });
      this.reload();
    }
  }

  async deleteBill(b: BillDto): Promise<void> {
    if (!confirm(`Delete "${b.title}" and all its items? This can't be undone.`)) return;
    try {
      await firstValueFrom(this.api.deleteBill(b.id));
      this.bills.set(this.bills().filter(x => x.id !== b.id));
      if (this.selectedId() === b.id) this.selectedId.set(this.bills()[0]?.id ?? null);
    } catch {
      this.snack.open('Could not delete the bill.', 'OK', { duration: 4000 });
    }
  }

  // ---- Items ----

  async addItem(b: BillDto): Promise<void> {
    const name = this.newName().trim();
    const amount = this.newAmount() ?? 0;
    if (!name || amount <= 0) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.addBillItem(b.id, { name, amount }));
      this.newName.set('');
      this.newAmount.set(null);
      await this.refreshSelected();
    } catch {
      this.snack.open('Could not add the item.', 'OK', { duration: 4000 });
    } finally {
      this.busy.set(false);
    }
  }

  async saveItem(b: BillDto, item: BillItemDto, name: string, amount: number | null): Promise<void> {
    const n = name.trim();
    const a = amount ?? 0;
    if ((n === item.name && a === item.amount) || !n || a <= 0) return;
    try {
      await firstValueFrom(this.api.updateBillItem(b.id, item.id, { name: n, amount: a }));
      await this.refreshSelected();
    } catch {
      this.snack.open('Could not save the item.', 'OK', { duration: 4000 });
      this.refreshSelected();
    }
  }

  async deleteItem(b: BillDto, item: BillItemDto): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteBillItem(b.id, item.id));
      await this.refreshSelected();
    } catch {
      this.snack.open('Could not remove the item.', 'OK', { duration: 4000 });
    }
  }

  async assign(b: BillDto, item: BillItemDto): Promise<void> {
    const res = await firstValueFrom(
      this.dialog.open<AssignContactDialog, AssignContactData, AssignContactResult>(AssignContactDialog, {
        width: '420px',
        maxWidth: '94vw',
        data: { itemName: item.name, currentUserId: item.assignedToUserId ?? null },
      }).afterClosed(),
    );
    if (!res) return; // cancelled
    try {
      await firstValueFrom(this.api.assignBillItem(b.id, item.id, res.userId));
      await this.refreshSelected();
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Could not assign the item.';
      this.snack.open(msg, 'OK', { duration: 4000 });
    }
  }

  async toggleItemSettled(b: BillDto, item: BillItemDto): Promise<void> {
    try {
      await firstValueFrom(this.api.settleBillItem(b.id, item.id, !item.settled));
      await this.refreshSelected();
    } catch {
      this.snack.open('Could not update the item.', 'OK', { duration: 4000 });
    }
  }

  private async refreshSelected(): Promise<void> {
    const id = this.selectedId();
    if (id == null) return;
    try {
      const b = await firstValueFrom(this.api.bill(id));
      this.patchBill(b);
    } catch {
      this.reload();
    }
  }

  // ---- Receipt AI (gated ai.vision; image digested in-memory, never stored; 503-graceful) ----

  async uploadReceipt(b: BillDto, fromCamera: boolean): Promise<void> {
    if (!this.canUseVision()) return;
    if (!(await confirmPhotoNotice())) return; // one-time "photo goes to Gemini, not stored" notice

    let img;
    try {
      img = fromCamera ? await captureImage() : await pickImage();
    } catch (e: unknown) {
      this.snack.open((e as Error)?.message ?? 'Could not read that image.', 'OK', { duration: 4000 });
      return;
    }
    if (!img) return; // user cancelled the picker

    this.busy.set(true);
    let breakdown;
    try {
      breakdown = await firstValueFrom(this.api.billReceipt(b.id, img));
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      this.snack.open(
        status === 503
          ? 'Receipt AI is unavailable right now — add the items manually.'
          : 'Could not read that receipt. Add the items manually.',
        'OK', { duration: 5000 });
      return;
    } finally {
      this.busy.set(false);
    }

    const result = await firstValueFrom(
      this.dialog.open<ReceiptReviewDialog, ReceiptReviewData, ReceiptReviewResult>(ReceiptReviewDialog, {
        width: '560px',
        maxWidth: '94vw',
        data: { breakdown },
      }).afterClosed(),
    );
    if (!result) return; // owner cancelled the review

    this.busy.set(true);
    try {
      // Persist each reviewed line, then the detected tax/tip, then refresh.
      for (const it of result.items) {
        await firstValueFrom(this.api.addBillItem(b.id, { name: it.name, amount: it.amount }));
      }
      if (result.tax != null || result.tip != null) {
        await firstValueFrom(this.api.updateBill(b.id, {
          taxAmount: result.tax ?? b.taxAmount ?? null,
          tipAmount: result.tip ?? b.tipAmount ?? null,
        }));
      }
      await this.refreshSelected();
      this.snack.open(`Added ${result.items.length} item${result.items.length === 1 ? '' : 's'} from the receipt.`,
        'OK', { duration: 3000 });
    } catch {
      this.snack.open('Saved some lines but hit an error — check the bill.', 'OK', { duration: 4000 });
      this.refreshSelected();
    } finally {
      this.busy.set(false);
    }
  }

  // ---- Public claim link ----

  async toggleShare(b: BillDto): Promise<void> {
    const next = !b.shareEnabled;
    try {
      const res = await firstValueFrom(this.api.toggleBillShare(b.id, next));
      this.patchBill({ ...b, shareEnabled: res.shareEnabled, sharePath: res.sharePath ?? null });
    } catch {
      this.snack.open('Could not update the share link.', 'OK', { duration: 4000 });
    }
  }

  /** Absolute claim URL for copy/open (the API returns a path like /bill/{token}). */
  shareUrl(b: BillDto): string {
    return b.sharePath ? `${location.origin}${b.sharePath}` : '';
  }

  async copyShare(b: BillDto): Promise<void> {
    const url = this.shareUrl(b);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.snack.open('Claim link copied.', 'OK', { duration: 2500 });
    } catch {
      this.snack.open('Copy failed — select and copy the link manually.', 'OK', { duration: 4000 });
    }
  }
}
