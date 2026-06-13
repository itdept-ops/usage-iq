import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { Pricing as PricingRow, PERM } from '../../core/models';
import { AuthService } from '../../core/auth';

@Component({
  selector: 'app-pricing',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, MatSnackBarModule,
  ],
  templateUrl: './pricing.html',
  styleUrl: './pricing.scss',
})
export class Pricing {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  readonly rows = signal<PricingRow[]>([]);
  readonly loading = signal(true);
  readonly savingId = signal<number | null>(null);
  readonly recomputing = signal(false);

  constructor() { this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.pricing().subscribe({
      next: r => { this.rows.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load pricing', 'Dismiss', { duration: 4000 }); },
    });
  }

  save(row: PricingRow): void {
    this.savingId.set(row.id);
    this.api.updatePricing(row.id, row).subscribe({
      next: () => { this.savingId.set(null); this.snack.open(`Saved ${row.modelPattern}`, 'OK', { duration: 2500 }); },
      error: () => { this.savingId.set(null); this.snack.open('Save failed', 'Dismiss', { duration: 4000 }); },
    });
  }

  recompute(): void {
    this.recomputing.set(true);
    this.api.recompute().subscribe({
      next: r => { this.recomputing.set(false); this.snack.open(`Recomputed cost on ${r.rowsUpdated.toLocaleString()} rows (${r.modelsUpdated} models)`, 'OK', { duration: 5000 }); },
      error: () => { this.recomputing.set(false); this.snack.open('Recompute failed', 'Dismiss', { duration: 4000 }); },
    });
  }
}
