import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { PlatformService } from '../../core/platform';
import { SnapRouteService } from '../../core/snap-route';
// ai-image (camera/picker/downscale + the one-time Gemini notice) is DYNAMIC-imported on first capture, not
// statically — this orchestrator is mounted in the app shell (eager initial chunk), but the photo helpers
// are only ever needed once the user triggers a Snap. Keeping them out of the initial bundle (loaded via
// {@link aiImage}) trims the main chunk; the module is memoized so repeat captures don't re-fetch.
import type * as AiImage from '../tracker/ai-image';
import { BetaBottomSheet } from '../beta-ui';
import type {
  ImageRequest, PhotoKind, ParsedFoodItemDto, ReadLabelResponse, ScheduleAiEvent, ReceiptItemDto,
} from '../../core/models';

/** The orchestrator's current screen within the one bottom sheet. */
type Stage = 'closed' | 'pick' | 'classifying' | 'route-picker' | 'review';

/** An editable food row in the meal/label review list (description + macros). */
interface FoodRow {
  description: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** An editable receipt line in the bill review list. */
interface BillLine {
  name: string;
  amount: number;
}

/** A route option shown in the manual picker / override list. */
interface RouteOption {
  kind: Exclude<PhotoKind, 'unknown'>;
  icon: string;
  label: string;
  blurb: string;
}

const ALL_ROUTES: readonly RouteOption[] = [
  { kind: 'receipt', icon: 'receipt_long', label: 'Receipt → split a bill', blurb: 'Line items into a new bill' },
  { kind: 'label', icon: 'nutrition', label: 'Nutrition label → log food', blurb: 'One food from the label' },
  { kind: 'meal', icon: 'restaurant', label: 'Meal → log food', blurb: 'Editable food items' },
  { kind: 'pantry', icon: 'kitchen', label: 'Pantry → meal planner', blurb: 'On-hand ingredients' },
  { kind: 'schedule', icon: 'event', label: 'Schedule → calendar', blurb: 'Proposed events to confirm' },
  { kind: 'note', icon: 'sticky_note_2', label: 'Note → family notes', blurb: 'Transcribe a whiteboard / note' },
];

/**
 * SNAP & ROUTE orchestrator — the thin client for the "+ Snap" photo-anything capture surface.
 *
 * Mounted ONCE in the shell. A trigger (the mobile bottom-tab camera FAB, the desktop top-bar / ⌘K palette
 * entry) calls {@link SnapRouteService.request}; this component reacts, runs ONE capture → downscale →
 * classify flow, then drives a route-review sheet for the detected {@link PhotoKind}, REUSING the existing
 * per-destination readers + write endpoints (it never rebuilds a reader). Each review sheet's CONFIRM posts
 * to the existing write endpoint, which re-gates on its own write permission — so the classifier is a HINT
 * ONLY and a misclassification can never bypass a gate.
 *
 * INVARIANTS honoured here:
 *  - AI floors to a MANUAL picker (classify never 503s; `unknown`/AI-off shows {@link RouteOption}s).
 *  - The user can always OVERRIDE the detected route ("Not right? Pick a route").
 *  - PER-PERMISSION visibility: routes the caller can't WRITE are hidden (via {@link SnapRouteService.canWrite}).
 *  - PDF is accepted ONLY on the schedule route (image/* elsewhere).
 *  - The receipt draft bill is created ON COMMIT and DELETED on cancel/abandon (no stray empty drafts).
 *  - The captured image is downscaled + sent inline; it is never stored (server contract) and we drop it
 *    from memory as soon as the route's reader has run.
 */
@Component({
  selector: 'app-snap-route',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, BetaBottomSheet],
  styleUrl: './snap-route-orchestrator.scss',
  template: `
    <app-bs-sheet [(open)]="sheetOpen" detent="full" label="Snap & route" (closed)="onSheetClosed()">
      <div class="snap" [class.snap--desktop]="!platform.isMobile()">

        <!-- DESKTOP capture: a drop/upload zone (the FAB path on mobile opens the OS camera directly). -->
        @if (stage() === 'pick') {
          <header class="snap__head">
            <h2 class="snap__title">Snap &amp; route</h2>
            <p class="snap__hint">Drop a photo and we'll send it to the right place.</p>
          </header>
          <div class="drop" [class.drop--over]="dragOver()"
               (dragover)="onDragOver($event)" (dragleave)="dragOver.set(false)" (drop)="onDrop($event)"
               role="button" tabindex="0" (click)="pickFromDevice()" (keydown.enter)="pickFromDevice()">
            <mat-icon class="drop__icon" aria-hidden="true">photo_camera</mat-icon>
            <p class="drop__label">Drag a photo here, or click to choose</p>
            <p class="drop__sub">Receipts, nutrition labels, meals, pantry, schedules, notes</p>
          </div>
          <button type="button" class="snap__manual" (click)="goManualPicker()">
            Or pick a destination yourself
          </button>
        }

        <!-- CLASSIFY spinner. -->
        @if (stage() === 'classifying') {
          <div class="busy" role="status" aria-live="polite">
            <mat-icon class="busy__spin" aria-hidden="true">progress_activity</mat-icon>
            <p class="busy__label">Reading your photo…</p>
          </div>
        }

        <!-- MANUAL / OVERRIDE route picker (also the floor for unknown / AI-off). -->
        @if (stage() === 'route-picker') {
          <header class="snap__head">
            <h2 class="snap__title">What is this?</h2>
            <p class="snap__hint">{{ pickerHint() }}</p>
          </header>
          <div class="routes">
            @for (r of routes(); track r.kind) {
              <button type="button" class="route" (click)="chooseRoute(r.kind)">
                <span class="route__icon"><mat-icon aria-hidden="true">{{ r.icon }}</mat-icon></span>
                <span class="route__body">
                  <span class="route__label">{{ r.label }}</span>
                  <span class="route__blurb">{{ r.blurb }}</span>
                </span>
                <mat-icon class="route__chev" aria-hidden="true">chevron_right</mat-icon>
              </button>
            }
            @if (routes().length === 0) {
              <p class="routes__empty">You don't have access to any capture destinations.</p>
            }
          </div>
        }

        <!-- REVIEW: per-kind editable confirm step (reusing each destination's review shape). -->
        @if (stage() === 'review') {
          <header class="snap__head">
            <h2 class="snap__title">{{ reviewTitle() }}</h2>
            @if (hint(); as h) { <p class="snap__hint">{{ h }}</p> }
          </header>

          <!-- meal / label → editable food items (parse-meal / read-label → /api/tracker/food) -->
          @if (active() === 'meal' || active() === 'label') {
            <div class="rows">
              @for (f of foods(); track $index) {
                <div class="frow">
                  <input class="frow__desc" [(ngModel)]="f.description" placeholder="Food" aria-label="Food description" />
                  <div class="frow__macros">
                    <label>kcal <input type="number" [(ngModel)]="f.calories" aria-label="Calories" /></label>
                    <label>P <input type="number" [(ngModel)]="f.proteinG" aria-label="Protein grams" /></label>
                    <label>C <input type="number" [(ngModel)]="f.carbsG" aria-label="Carb grams" /></label>
                    <label>F <input type="number" [(ngModel)]="f.fatG" aria-label="Fat grams" /></label>
                  </div>
                  <button type="button" class="frow__del" (click)="removeFood($index)" aria-label="Remove food">
                    <mat-icon aria-hidden="true">close</mat-icon>
                  </button>
                </div>
              }
              @if (foods().length === 0) {
                <p class="rows__empty">Nothing was read — add a row or pick another route.</p>
              }
              <button type="button" class="rows__add" (click)="addFood()">
                <mat-icon aria-hidden="true">add</mat-icon> Add food
              </button>
            </div>
          }

          <!-- receipt → editable bill line items (POST /api/bills then /receipt) -->
          @if (active() === 'receipt') {
            <label class="field">
              <span class="field__label">Bill name</span>
              <input class="field__input" [(ngModel)]="billTitle" placeholder="e.g. Grocery run" />
            </label>
            <div class="rows">
              @for (l of lines(); track $index) {
                <div class="lrow">
                  <input class="lrow__name" [(ngModel)]="l.name" placeholder="Item" aria-label="Line item" />
                  <input class="lrow__amt" type="number" [(ngModel)]="l.amount" aria-label="Amount" />
                  <button type="button" class="lrow__del" (click)="removeLine($index)" aria-label="Remove line">
                    <mat-icon aria-hidden="true">close</mat-icon>
                  </button>
                </div>
              }
              @if (lines().length === 0) {
                <p class="rows__empty">No line items — add one or pick another route.</p>
              }
              <button type="button" class="rows__add" (click)="addLine()">
                <mat-icon aria-hidden="true">add</mat-icon> Add line
              </button>
            </div>
          }

          <!-- pantry → on-hand ingredient chips (scan-pantry → meal planner bias) -->
          @if (active() === 'pantry') {
            <div class="chips">
              @for (ing of pantry(); track $index) {
                <span class="chip">
                  {{ ing }}
                  <button type="button" class="chip__x" (click)="removePantry($index)" aria-label="Remove ingredient">
                    <mat-icon aria-hidden="true">close</mat-icon>
                  </button>
                </span>
              }
              @if (pantry().length === 0) {
                <p class="rows__empty">Nothing was read off the shelf.</p>
              }
            </div>
          }

          <!-- schedule → proposed events to confirm (from-image → /events) -->
          @if (active() === 'schedule') {
            <div class="rows">
              @for (e of events(); track $index) {
                <label class="erow">
                  <input type="checkbox" [(ngModel)]="e.keep" aria-label="Include this event" />
                  <span class="erow__body">
                    <input class="erow__title" [(ngModel)]="e.title" placeholder="Event" aria-label="Event title" />
                    <span class="erow__when">{{ formatWhen(e) }}</span>
                  </span>
                </label>
              }
              @if (events().length === 0) {
                <p class="rows__empty">No events were found in that schedule.</p>
              }
            </div>
          }

          <!-- note → title/body editor (photo-to-note → /api/family/notes) -->
          @if (active() === 'note') {
            <label class="field">
              <span class="field__label">Title</span>
              <input class="field__input" [(ngModel)]="noteTitle" placeholder="Note title" />
            </label>
            <label class="field">
              <span class="field__label">Body</span>
              <textarea class="field__area" rows="8" [(ngModel)]="noteBody" placeholder="Transcribed note…"></textarea>
            </label>
          }

          <div class="actions">
            <button type="button" class="btn btn--ghost" (click)="goManualPicker()">Not right? Pick a route</button>
            <button type="button" class="btn btn--primary" [disabled]="busy() || !canConfirm()" (click)="confirm()">
              @if (busy()) { Saving… } @else { {{ confirmLabel() }} }
            </button>
          </div>
        }
      </div>
    </app-bs-sheet>

    <!-- Hidden picker input for the desktop "choose file" path; schedule route also allows application/pdf. -->
    <input #file type="file" class="snap-file" [accept]="pickAccept()" (change)="onFileInput($event)" hidden />
  `,
})
export class SnapRouteOrchestrator {
  private readonly api = inject(Api);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  readonly platform = inject(PlatformService);
  readonly snapRoute = inject(SnapRouteService);

  protected readonly stage = signal<Stage>('closed');
  protected readonly sheetOpen = signal(false);
  protected readonly dragOver = signal(false);
  protected readonly busy = signal(false);

  /** The captured, downscaled image (raw base64 + mime). Held only until its route's reader has run, then dropped. */
  private image: ImageRequest | null = null;

  /** The detected/chosen route currently under review. */
  protected readonly active = signal<PhotoKind>('unknown');
  /** The classifier's short hint (or a manual-picker context line). */
  protected readonly hint = signal<string | null>(null);

  // ---- review buffers (one per destination shape) ----
  protected readonly foods = signal<FoodRow[]>([]);
  protected readonly lines = signal<BillLine[]>([]);
  protected readonly pantry = signal<string[]>([]);
  protected readonly events = signal<(ScheduleAiEvent & { keep: boolean })[]>([]);
  protected billTitle = '';
  protected noteTitle = '';
  protected noteBody = '';

  /** The draft bill id created when the user COMMITS to the receipt route (deleted on cancel/abandon). */
  private draftBillId: number | null = null;

  /** Memoized dynamic import of the ai-image helpers (loaded lazily on the first capture; see import note). */
  private aiImageMod: Promise<typeof AiImage> | null = null;
  private aiImage(): Promise<typeof AiImage> {
    return (this.aiImageMod ??= import('../tracker/ai-image'));
  }

  /** The routes the caller can WRITE, in display order (per-permission visibility). */
  protected readonly routes = computed<RouteOption[]>(() => {
    const writable = new Set(this.snapRoute.writableRoutes());
    return ALL_ROUTES.filter((r) => writable.has(r.kind));
  });

  constructor() {
    // React to a trigger (FAB / palette / top bar). A bump of `requested` opens the capture flow: on a phone
    // we go straight to the OS rear camera; on desktop we open the drop/upload sheet.
    let seen = this.snapRoute.requested();
    effect(() => {
      const n = this.snapRoute.requested();
      if (n === seen) return;
      seen = n;
      void this.begin();
    });
  }

  /** The accept-list for the file picker — PDF only on the schedule route (image/* otherwise). */
  protected pickAccept(): string {
    return this.active() === 'schedule' ? 'image/*,application/pdf' : 'image/*';
  }

  protected pickerHint(): string {
    return this.hint() ?? 'Choose where this photo should go.';
  }

  protected reviewTitle(): string {
    return ALL_ROUTES.find((r) => r.kind === this.active())?.label ?? 'Review';
  }

  protected confirmLabel(): string {
    switch (this.active()) {
      case 'receipt': return 'Create bill';
      case 'schedule': return 'Add events';
      case 'note': return 'Save note';
      case 'pantry': return 'Use on-hand';
      default: return 'Log food';
    }
  }

  protected canConfirm(): boolean {
    switch (this.active()) {
      case 'meal':
      case 'label': return this.foods().length > 0;
      case 'receipt': return this.lines().length > 0;
      case 'pantry': return this.pantry().length > 0;
      case 'schedule': return this.events().some((e) => e.keep);
      case 'note': return this.noteTitle.trim().length > 0 || this.noteBody.trim().length > 0;
      default: return false;
    }
  }

  // ---- capture ----

  /** Start a capture: privacy notice (one-time) → OS camera (mobile) or drop sheet (desktop). */
  private async begin(): Promise<void> {
    if (!this.snapRoute.canCapture()) return; // defensive: trigger shouldn't show, but never dead-end
    const ai = await this.aiImage();
    if (!(await ai.confirmPhotoNotice())) return; // user declined the one-time Gemini notice

    this.resetState();
    if (this.platform.isMobile()) {
      // Mobile: open the OS rear camera directly, then classify.
      let img: ImageRequest | null = null;
      try {
        img = await ai.captureImage();
      } catch {
        this.snack.open('Could not read that photo.', 'OK', { duration: 4000 });
        return;
      }
      if (!img) return; // cancelled
      this.image = img;
      this.openAt('classifying');
      await this.classify();
    } else {
      // Desktop: open the drop/upload sheet.
      this.openAt('pick');
    }
  }

  /** Desktop: open the OS file picker (image/* — the drop zone is the schedule-agnostic generic entry). */
  protected pickFromDevice(): void {
    void (async () => {
      let img: ImageRequest | null = null;
      try {
        const ai = await this.aiImage();
        img = await ai.pickImage();
      } catch {
        this.snack.open('Could not read that photo.', 'OK', { duration: 4000 });
        return;
      }
      if (!img) return;
      this.image = img;
      this.stage.set('classifying');
      await this.classify();
    })();
  }

  protected onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(true);
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.ingestFile(file);
  }

  protected onFileInput(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = ''; // allow re-picking the same file
    if (file) void this.ingestFile(file);
  }

  /** Downscale a chosen/dropped image then classify (images only at this generic entry; PDFs come via schedule). */
  private async ingestFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      this.snack.open('Please choose an image.', 'OK', { duration: 4000 });
      return;
    }
    try {
      const ai = await this.aiImage();
      this.image = await ai.downscaleToJpeg(file);
    } catch {
      this.snack.open('Could not read that photo.', 'OK', { duration: 4000 });
      return;
    }
    this.stage.set('classifying');
    await this.classify();
  }

  // ---- classify ----

  /** Classify the captured image → drive the detected route, falling back to the manual picker. */
  private async classify(): Promise<void> {
    const img = this.image;
    if (!img) { this.goManualPicker(); return; }
    let kind: PhotoKind = 'unknown';
    let detectedHint: string | null = null;
    try {
      const res = await firstValueFrom(this.api.classifyPhoto(img));
      kind = res.kind;
      detectedHint = res.hint ?? null;
    } catch {
      // 400 (bad/oversized) or a transport error → fall to the manual picker (never a hard error screen).
      this.snack.open('Could not classify that photo — pick a route.', 'OK', { duration: 4000 });
      kind = 'unknown';
    }

    // Honour per-permission visibility + the HINT-only rule: if the detected route isn't writable by this
    // caller, drop to the manual picker rather than opening a sheet whose confirm would 403.
    if (kind === 'unknown' || !this.snapRoute.canWrite(kind)) {
      this.hint.set(detectedHint);
      this.goManualPicker();
      return;
    }
    this.hint.set(detectedHint);
    await this.enterRoute(kind);
  }

  /** Show the manual route picker (the floor for unknown / AI-off / an un-writable detection, or an override). */
  protected goManualPicker(): void {
    this.openAt('route-picker');
  }

  /** The user picked (or overrode to) a route — run that route's reader then open its review. */
  protected chooseRoute(kind: Exclude<PhotoKind, 'unknown'>): void {
    void this.enterRoute(kind);
  }

  // ---- per-route readers (REUSE the existing endpoints) ----

  private async enterRoute(kind: Exclude<PhotoKind, 'unknown'>): Promise<void> {
    // Switching routes invalidates any in-flight draft bill from a prior receipt attempt.
    await this.cleanupDraftBill();
    this.active.set(kind);
    const img = this.image;
    if (!img) { this.goManualPicker(); return; }

    this.stage.set('classifying'); // reuse the spinner while the per-route reader runs
    try {
      switch (kind) {
        case 'meal': await this.readMeal(img); break;
        case 'label': await this.readLabel(img); break;
        case 'pantry': await this.readPantry(img); break;
        case 'schedule': await this.readSchedule(img); break;
        case 'receipt': await this.readReceipt(img); break;
        case 'note': await this.readNote(img); break;
      }
    } catch {
      this.snack.open('That reader is unavailable right now — you can still edit manually.', 'OK', { duration: 5000 });
    }
    this.stage.set('review');
  }

  private async readMeal(img: ImageRequest): Promise<void> {
    const res = await firstValueFrom(
      this.api.parseMeal({ imageBase64: img.imageBase64, mimeType: img.mimeType }),
    );
    this.foods.set(
      (res.items ?? []).map((i: ParsedFoodItemDto) => ({
        description: i.description, calories: i.calories, proteinG: i.proteinG, carbsG: i.carbG, fatG: i.fatG,
      })),
    );
    if (!res.aiUsed && this.foods().length === 0) this.foods.set([this.blankFood()]);
  }

  private async readLabel(img: ImageRequest): Promise<void> {
    const r: ReadLabelResponse = await firstValueFrom(this.api.readLabel(img));
    const desc = r.description?.trim() || 'Food from label';
    this.foods.set([{ description: desc, calories: r.calories, proteinG: r.proteinG, carbsG: r.carbsG, fatG: r.fatG }]);
  }

  private async readPantry(img: ImageRequest): Promise<void> {
    const r = await firstValueFrom(this.api.scanPantry(img));
    this.pantry.set([...(r.ingredients ?? [])]);
  }

  private async readSchedule(img: ImageRequest): Promise<void> {
    const r = await firstValueFrom(
      this.api.scheduleFromImage([{ imageBase64: img.imageBase64, mime: img.mimeType }]),
    );
    this.events.set((r.events ?? []).map((e) => ({ ...e, keep: true })));
    if (r.notes) this.hint.set(r.notes);
  }

  private async readReceipt(img: ImageRequest): Promise<void> {
    // RECEIPT is the only multi-step route: the receipt reader needs a bill id, so we create the draft bill
    // ON COMMIT to this route (and delete it on cancel/abandon — see cleanupDraftBill). One draft per attempt.
    const bill = await firstValueFrom(this.api.createBill({ title: 'Snap receipt' }));
    this.draftBillId = bill.id;
    this.billTitle = bill.title || 'Snap receipt';
    const r = await firstValueFrom(this.api.billReceipt(bill.id, img));
    this.lines.set((r.items ?? []).map((i: ReceiptItemDto) => ({ name: i.name, amount: i.amount })));
  }

  private async readNote(img: ImageRequest): Promise<void> {
    const r = await firstValueFrom(this.api.photoToNote(img));
    this.noteTitle = r.title ?? '';
    this.noteBody = r.body ?? '';
  }

  // ---- confirm (each writes via the EXISTING endpoint, which re-gates on its own write permission) ----

  protected confirm(): void {
    void (async () => {
      this.busy.set(true);
      try {
        switch (this.active()) {
          case 'meal':
          case 'label': await this.commitFoods(); break;
          case 'receipt': await this.commitReceipt(); break;
          case 'pantry': this.commitPantry(); break;
          case 'schedule': await this.commitSchedule(); break;
          case 'note': await this.commitNote(); break;
        }
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        this.snack.open(
          status === 403 ? "You don't have permission to write there." : 'Could not save — please try again.',
          'OK', { duration: 5000 },
        );
        this.busy.set(false);
        return;
      }
      this.busy.set(false);
      this.close();
    })();
  }

  private async commitFoods(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    for (const f of this.foods()) {
      await firstValueFrom(this.api.addFood({
        date: today, meal: 'snack', description: f.description || 'Food', quantity: 1,
        calories: f.calories, proteinG: f.proteinG, carbG: f.carbsG, fatG: f.fatG,
      }));
    }
    this.snack.open(`Logged ${this.foods().length} item${this.foods().length === 1 ? '' : 's'}.`, 'OK', { duration: 3000 });
  }

  private async commitReceipt(): Promise<void> {
    const id = this.draftBillId;
    if (id == null) throw new Error('no draft bill');
    if (this.billTitle.trim()) await firstValueFrom(this.api.updateBill(id, { title: this.billTitle.trim() }));
    for (const l of this.lines()) {
      await firstValueFrom(this.api.addBillItem(id, { name: l.name || 'Item', amount: Number(l.amount) || 0 }));
    }
    this.draftBillId = null; // committed — do NOT delete it on close
    this.snack.open('Bill created from your receipt.', 'OK', { duration: 3000 });
  }

  private commitPantry(): void {
    // Pantry "on hand" biases the meal planner — it is NOT a persistent write (nothing is created server-side).
    // We stash the confirmed chips (a forward-compatible handoff the planner's AI plan can read as
    // ingredientsOnHand) and route the user to the planner so they land where the bias applies.
    try { sessionStorage.setItem('usage_iq_pantry_on_hand', JSON.stringify(this.pantry())); } catch { /* non-fatal */ }
    this.snack.open('On-hand ingredients ready — opening the meal planner.', 'OK', { duration: 3000 });
    void this.router.navigateByUrl('/meal-planner');
  }

  private async commitSchedule(): Promise<void> {
    const keep = this.events().filter((e) => e.keep);
    for (const e of keep) {
      await firstValueFrom(this.api.createEvent({
        title: e.title || 'Event', startUtc: e.startUtc, endUtc: e.endUtc, allDay: e.allDay,
        location: e.location, description: e.description, recurrence: e.recurrence,
      }));
    }
    this.snack.open(`Added ${keep.length} event${keep.length === 1 ? '' : 's'} to your calendar.`, 'OK', { duration: 3000 });
  }

  private async commitNote(): Promise<void> {
    await firstValueFrom(this.api.createFamilyNote({
      title: this.noteTitle.trim() || 'Note', body: this.noteBody, pinned: false,
    }));
    this.snack.open('Note saved.', 'OK', { duration: 3000 });
  }

  // ---- review-list editing ----

  private blankFood(): FoodRow { return { description: '', calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }; }
  protected addFood(): void { this.foods.update((l) => [...l, this.blankFood()]); }
  protected removeFood(i: number): void { this.foods.update((l) => l.filter((_, idx) => idx !== i)); }
  protected addLine(): void { this.lines.update((l) => [...l, { name: '', amount: 0 }]); }
  protected removeLine(i: number): void { this.lines.update((l) => l.filter((_, idx) => idx !== i)); }
  protected removePantry(i: number): void { this.pantry.update((l) => l.filter((_, idx) => idx !== i)); }

  protected formatWhen(e: ScheduleAiEvent): string {
    if (e.allDay) return 'All day';
    try {
      const s = new Date(e.startUtc);
      return s.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  // ---- lifecycle ----

  private resetState(): void {
    this.image = null;
    this.active.set('unknown');
    this.hint.set(null);
    this.foods.set([]);
    this.lines.set([]);
    this.pantry.set([]);
    this.events.set([]);
    this.billTitle = '';
    this.noteTitle = '';
    this.noteBody = '';
    this.busy.set(false);
    this.draftBillId = null;
  }

  private openAt(stage: Stage): void {
    this.stage.set(stage);
    this.sheetOpen.set(true);
  }

  protected close(): void {
    this.sheetOpen.set(false); // triggers onSheetClosed for cleanup
  }

  /** Sheet dismissed (swipe / scrim / Escape / programmatic): clean up any stray draft bill + drop the image. */
  protected onSheetClosed(): void {
    void this.cleanupDraftBill();
    this.image = null; // never retain the photo past the sheet
    this.stage.set('closed');
  }

  /** Delete the receipt draft bill if it was created but not committed (no stray empty drafts). */
  private async cleanupDraftBill(): Promise<void> {
    const id = this.draftBillId;
    if (id == null) return;
    this.draftBillId = null;
    try { await firstValueFrom(this.api.deleteBill(id)); } catch { /* best-effort cleanup */ }
  }
}
