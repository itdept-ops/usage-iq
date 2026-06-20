import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { CalendarEvent, CalendarEventInput } from '../../core/models';

/** Data passed into the event editor: the event being edited (null = create), and an optional seed date. */
export interface EventEditorData {
  event: CalendarEvent | null;
  /** A "YYYY-MM-DD" local date to pre-seed a NEW event with (e.g. the day a "+" was clicked). */
  seedDate?: string;
}

/** The editor result: either a save payload (local→UTC already applied) or a delete request. */
export type EventEditorResult =
  | { kind: 'save'; input: CalendarEventInput }
  | { kind: 'delete' };

/**
 * Create / edit a calendar event on the caller's own Google Calendar. Times are entered in the user's LOCAL
 * zone (a date + start/end time, or a date range when all-day) and converted to UTC ISO instants on save —
 * mirroring the API, which stores everything in UTC. Editing seeds the form back from the event's UTC times.
 * All-day events use whole local days (the API treats the end date as exclusive; we send start..end inclusive
 * and the server normalises). Location + notes are optional. No other-person identity is involved here.
 */
@Component({
  selector: 'app-event-editor-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSlideToggleModule,
  ],
  templateUrl: './event-editor-dialog.html',
  styleUrls: ['./family.scss', './calendar.scss'],
})
export class EventEditorDialog {
  readonly ref = inject(MatDialogRef<EventEditorDialog, EventEditorResult>);
  readonly data = inject<EventEditorData>(MAT_DIALOG_DATA);

  readonly isEdit = !!this.data.event;

  readonly title = signal(this.data.event?.title ?? '');
  readonly allDay = signal(this.data.event?.allDay ?? false);
  readonly location = signal(this.data.event?.location ?? '');
  readonly notes = signal(this.data.event?.description ?? '');

  /** "YYYY-MM-DD" local — the day the event starts (and, for all-day, the start day). */
  readonly date = signal(this.initialDate());
  /** "YYYY-MM-DD" local — the day the event ends (all-day only; defaults to the start day). */
  readonly endDate = signal(this.initialEndDate());
  /** "HH:mm" local start/end times (timed events only). */
  readonly startTime = signal(this.initialTime('start'));
  readonly endTime = signal(this.initialTime('end'));

  readonly canSave = computed(() => {
    if (this.title().trim().length === 0 || this.date().length === 0) return false;
    if (this.allDay()) return this.endDate().length > 0;
    return this.startTime().length > 0 && this.endTime().length > 0;
  });

  // ---- Seeding from the event (or sensible defaults) ----

  /** Local Date for the event's start, or the seed/today for a new event. */
  private startBasis(): Date {
    if (this.data.event?.startUtc) return new Date(this.data.event.startUtc);
    if (this.data.seedDate) {
      const d = new Date(`${this.data.seedDate}T09:00:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const now = new Date();
    now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
    return now;
  }

  private endBasis(): Date {
    if (this.data.event?.endUtc) return new Date(this.data.event.endUtc);
    // Default a new timed event to one hour; all-day to the same day.
    const start = this.startBasis();
    return new Date(start.getTime() + 60 * 60 * 1000);
  }

  private initialDate(): string {
    return this.toLocalDate(this.startBasis());
  }

  private initialEndDate(): string {
    if (this.data.event?.allDay && this.data.event.endUtc) {
      // The API's all-day end date is EXCLUSIVE; show the last inclusive day in the editor.
      const end = new Date(this.data.event.endUtc);
      end.setDate(end.getDate() - 1);
      const start = this.startBasis();
      return this.toLocalDate(end.getTime() >= start.getTime() ? end : start);
    }
    return this.toLocalDate(this.startBasis());
  }

  private initialTime(which: 'start' | 'end'): string {
    return this.toLocalTime(which === 'start' ? this.startBasis() : this.endBasis());
  }

  // ---- Save ----

  save(): void {
    if (!this.canSave()) return;

    let startUtc: string;
    let endUtc: string;
    if (this.allDay()) {
      // Whole local days. Start at local midnight; end is the day AFTER the last day (exclusive), so the
      // server stores a clean all-day span. new Date(local).toISOString() does the local→UTC conversion.
      const start = new Date(`${this.date()}T00:00:00`);
      const lastDay = new Date(`${this.endDate()}T00:00:00`);
      const exclusiveEnd = new Date(lastDay.getTime() + 24 * 60 * 60 * 1000);
      startUtc = start.toISOString();
      endUtc = exclusiveEnd.toISOString();
    } else {
      startUtc = new Date(`${this.date()}T${this.startTime()}`).toISOString();
      endUtc = new Date(`${this.date()}T${this.endTime()}`).toISOString();
    }

    const input: CalendarEventInput = {
      title: this.title().trim(),
      startUtc,
      endUtc,
      allDay: this.allDay(),
      location: this.location().trim() || null,
      description: this.notes().trim() || null,
    };
    this.ref.close({ kind: 'save', input });
  }

  requestDelete(): void {
    this.ref.close({ kind: 'delete' });
  }

  // ---- Local formatting helpers (browser zone) ----

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private toLocalTime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
