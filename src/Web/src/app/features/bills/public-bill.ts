import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { PaymentHandlesDto, PublicBillDto } from '../../core/models';
import { Bills } from './bills';

/** One pay-me link rendered from the owner's configured handles. */
interface PayLink { label: string; icon: string; url: string; }

/**
 * The ANONYMOUS public claim view at /bill/{token} (no auth guard, bare shell — mirrors the public
 * dashboard-share view). Shows the bill's items, lets a visitor claim open items under a display name,
 * shows each person's running total (with the proportional tax/tip split), and renders the owner's
 * pay-me links. It exposes ONLY what the API's public DTO carries — no owner email or other private data.
 * A claim refreshes the whole view from the server's response.
 */
@Component({
  selector: 'app-public-bill',
  imports: [CommonModule, FormsModule, MatProgressBarModule, MatButtonModule, MatIconModule],
  templateUrl: './public-bill.html',
  styleUrl: './public-bill.scss',
})
export class PublicBillView {
  private api = inject(Api);
  private route = inject(ActivatedRoute);

  private token = this.route.snapshot.paramMap.get('token') ?? '';

  readonly data = signal<PublicBillDto | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly claiming = signal<number | null>(null);

  /** The visitor's display name, remembered across claims in this session. */
  readonly myName = signal('');

  readonly payLinks = computed<PayLink[]>(() => Bills.toPayLinks(this.data()?.payments as PaymentHandlesDto));

  /** Full list price (items + tax + tip) for the header summary. */
  readonly billTotal = computed(() => {
    const b = this.data();
    if (!b) return 0;
    const items = b.items.reduce((s, i) => s + i.amount, 0);
    return items + (b.taxAmount ?? 0) + (b.tipAmount ?? 0);
  });

  /** The visitor's own running total, matched by the name they typed (case-insensitive). */
  readonly myTotal = computed(() => {
    const name = this.myName().trim().toLowerCase();
    if (!name) return null;
    return this.data()?.personTotals.find(p => p.name.toLowerCase() === name) ?? null;
  });

  readonly settled = computed(() => this.data()?.status === 'settled');

  constructor() {
    this.load();
  }

  private load(): void {
    this.api.publicBill(this.token).subscribe({
      next: d => { this.data.set(d); this.loading.set(false); },
      error: () => { this.error.set(true); this.loading.set(false); },
    });
  }

  /** Claim an open item under the typed display name; the server returns the refreshed bill. */
  claim(itemId: number): void {
    const name = this.myName().trim();
    if (!name || this.claiming() != null) return;
    this.claiming.set(itemId);
    this.api.claimBillItem(this.token, itemId, name).subscribe({
      next: d => { this.data.set(d); this.claiming.set(null); },
      error: () => {
        this.claiming.set(null);
        // A race (someone else just claimed it) or a settled bill — reload to show the truth.
        this.load();
      },
    });
  }
}
