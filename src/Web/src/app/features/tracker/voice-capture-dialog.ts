import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { PERM, VoiceIntentDto } from '../../core/models';
import {
  AudioClipResult, TranscriptResult, VoiceRecording, confirmVoiceNotice,
  mediaRecorderSupported, recordAudioClip, recordTranscript, speechSupported,
} from './voice-capture';

/** Opens with the active date (echoed to the parser as "today"; NOT trusted server-side). */
export interface VoiceCaptureData {
  date: string;
}

/** What the dialog resolves with so the page can refresh the day after a confirmed log. `undefined` = nothing logged. */
export type VoiceCaptureResult = { logged: number } | undefined;

/** The dialog lifecycle phases. */
type Phase = 'idle' | 'recording' | 'parsing' | 'confirm' | 'logging' | 'none' | 'unavailable' | 'denied' | 'done';

/** A per-intent row: the parsed intent, an editable label, and whether it's selected to log. */
interface IntentRow {
  intent: VoiceIntentDto;
  /** The single human-editable field (description/name/label) extracted from the payload. */
  label: string;
  /** The payload key the {@link label} maps back onto (so an edit re-clamps NOTHING but the display field). */
  labelKey: string;
  selected: boolean;
}

/** A friendly per-domain icon for the confirm list. */
const DOMAIN_ICON: Record<string, string> = {
  food: 'restaurant',
  exercise: 'fitness_center',
  hydration: 'local_drink',
  coffee: 'local_cafe',
  weight: 'monitor_weight',
  supplement: 'medication',
  sleep: 'bedtime',
  family: 'home',
};

/**
 * Voice capture dialog — speak a note, confirm what to log. PARSE-ONLY: the spoken note is transcribed
 * on-device (preferred — audio never leaves the device) or, when on-device STT is unavailable AND the user
 * has ai.vision, recorded as a short clip; either is sent to POST /api/ai/voice-parse which WRITES NOTHING.
 * The parsed intents are shown for the user to review + edit + confirm; on confirm we post each selected
 * intent's server-issued payload to its EXISTING owner-scoped write endpoint (so voice rides the existing
 * permission gates + clamps and can never bypass a gate or write cross-user). Nothing logs without confirm.
 *
 * State machine: idle → recording → parsing → (confirm → logging → done) | none | unavailable | denied.
 * Handles mic-permission-denied, AI-off/unavailable (offers typing), and no-intent-detected gracefully.
 */
@Component({
  selector: 'app-voice-capture-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
    MatProgressSpinnerModule, MatCheckboxModule,
  ],
  template: `
    <h2 mat-dialog-title class="vc-title">
      <mat-icon aria-hidden="true">mic</mat-icon> Voice log
    </h2>

    <!-- sr-only live region: announces the recording/parsing state for screen readers. -->
    <p class="vc-sr" aria-live="assertive">{{ announce() }}</p>

    <mat-dialog-content class="vc-body">
      @switch (phase()) {

        @case ('idle') {
          <p class="vc-lead">Tell me what to log — “a coffee and 20 minutes of cycling”, “240 ml of water”,
            “I weighed 178 today”. You’ll review everything before anything is logged.</p>
          @if (canSpeak()) {
            <button mat-flat-button color="primary" type="button" class="vc-mic" (click)="start()"
                    aria-label="Start recording your voice note">
              <mat-icon aria-hidden="true">mic</mat-icon> Start talking
            </button>
          } @else {
            <p class="vc-note">Your browser can’t capture voice here — type your note instead.</p>
          }
          <button mat-stroked-button type="button" class="vc-type-toggle" (click)="useTyping()">
            <mat-icon aria-hidden="true">keyboard</mat-icon> Type instead
          </button>
        }

        @case ('recording') {
          <div class="vc-rec" role="status">
            <span class="vc-rec-dot" aria-hidden="true"></span>
            <span class="vc-rec-label">Listening… speak now</span>
          </div>
          @if (interim()) { <p class="vc-interim">“{{ interim() }}”</p> }
          <div class="vc-rec-actions">
            <button mat-flat-button color="primary" type="button" (click)="stop()"
                    aria-label="Stop recording and process your note">
              <mat-icon aria-hidden="true">stop</mat-icon> Done
            </button>
            <button mat-stroked-button type="button" (click)="cancelRecording()" aria-label="Cancel recording">
              Cancel
            </button>
          </div>
        }

        @case ('parsing') {
          <div class="vc-loading" role="status">
            <mat-progress-spinner mode="indeterminate" diameter="36" aria-hidden="true" />
            <span>Understanding your note…</span>
          </div>
        }

        @case ('confirm') {
          @if (transcript()) {
            <p class="vc-transcript" aria-label="What we heard">“{{ transcript() }}”</p>
          }
          <p class="vc-lead">Review and confirm — uncheck anything you don’t want, then log.</p>
          <ul class="vc-list">
            @for (row of rows(); track $index) {
              <li class="vc-item" [class.vc-item--off]="!row.selected">
                <mat-checkbox class="vc-check" [ngModel]="row.selected"
                              (ngModelChange)="toggle($index, $event)"
                              [attr.aria-label]="'Log: ' + row.intent.summary">
                  <span class="vc-item-main">
                    <mat-icon class="vc-item-icon" aria-hidden="true">{{ icon(row.intent.domain) }}</mat-icon>
                    <span class="vc-item-summary">{{ row.intent.summary }}</span>
                  </span>
                </mat-checkbox>
                @if (row.labelKey) {
                  <mat-form-field appearance="outline" class="vc-item-field">
                    <mat-label>{{ fieldLabel(row.intent.domain) }}</mat-label>
                    <input matInput type="text" maxlength="200" [ngModel]="row.label"
                           (ngModelChange)="setLabel($index, $event)" [disabled]="!row.selected" />
                  </mat-form-field>
                }
              </li>
            }
          </ul>
          <button mat-stroked-button type="button" class="vc-redo" (click)="reset()">
            <mat-icon aria-hidden="true">replay</mat-icon> Start over
          </button>
        }

        @case ('none') {
          <div class="vc-empty" role="status">
            <mat-icon aria-hidden="true">hearing</mat-icon>
            <p>I didn’t catch anything I could log.</p>
            @if (transcript()) { <p class="vc-transcript">“{{ transcript() }}”</p> }
            <p class="vc-note">Try again with something like “a banana and a coffee”.</p>
          </div>
          <button mat-flat-button color="primary" type="button" (click)="reset()">
            <mat-icon aria-hidden="true">replay</mat-icon> Try again
          </button>
        }

        @case ('unavailable') {
          <div class="vc-empty" role="status">
            <mat-icon aria-hidden="true">mic_off</mat-icon>
            <p>{{ unavailableMsg() }}</p>
            <p class="vc-note">You can log it manually with the section buttons instead.</p>
          </div>
        }

        @case ('denied') {
          <div class="vc-empty" role="status">
            <mat-icon aria-hidden="true">mic_off</mat-icon>
            <p>{{ deniedMsg() }}</p>
          </div>
          @if (canSpeak()) {
            <button mat-stroked-button type="button" (click)="reset()">
              <mat-icon aria-hidden="true">replay</mat-icon> Try again
            </button>
          }
        }

        @case ('logging') {
          <div class="vc-loading" role="status">
            <mat-progress-spinner mode="indeterminate" diameter="36" aria-hidden="true" />
            <span>Logging…</span>
          </div>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions class="vc-actions" align="end">
      @if (phase() === 'confirm') {
        <button mat-stroked-button type="button" (click)="close()">Cancel</button>
        <button mat-flat-button color="primary" type="button" [disabled]="selectedCount() === 0" (click)="logSelected()">
          Log {{ selectedCount() }} {{ selectedCount() === 1 ? 'item' : 'items' }}
        </button>
      } @else if (phase() === 'done' || phase() === 'none' || phase() === 'unavailable' || phase() === 'denied') {
        <button mat-flat-button color="primary" type="button" (click)="close()">Close</button>
      } @else {
        <button mat-stroked-button type="button" (click)="close()">Close</button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .vc-title { display: flex; align-items: center; gap: 8px; font-family: var(--tech-font-ui);
      font-weight: 700; color: var(--tech-text);
      mat-icon { color: var(--tech-accent, var(--tech-text)); } }
    .vc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .vc-body { min-width: min(420px, 86vw); display: flex; flex-direction: column;
      gap: var(--tech-space-3); padding-top: 4px !important; }
    .vc-lead { margin: 0; color: var(--tech-text); font-size: 0.95rem; }
    .vc-note { margin: 0; color: var(--tech-text-dim, var(--tech-text)); font-size: 0.85rem; }
    .vc-mic, .vc-type-toggle, .vc-redo { min-height: 44px; border-radius: var(--tech-r-control); font-weight: 600; }
    .vc-mic { align-self: stretch; }
    .vc-type-toggle { align-self: flex-start; }

    .vc-rec { display: flex; align-items: center; gap: 10px; }
    .vc-rec-dot { width: 14px; height: 14px; border-radius: 50%; background: var(--tech-danger, #e5484d);
      box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.5); animation: vc-pulse 1.4s ease-out infinite; }
    @keyframes vc-pulse {
      0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.5); }
      70% { box-shadow: 0 0 0 12px rgba(229, 72, 77, 0); }
      100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
    }
    @media (prefers-reduced-motion: reduce) { .vc-rec-dot { animation: none; } }
    .vc-rec-label { font-weight: 600; color: var(--tech-text); }
    .vc-interim { margin: 0; font-style: italic; color: var(--tech-text-dim, var(--tech-text)); }
    .vc-rec-actions { display: flex; gap: 8px; button { min-height: 44px; border-radius: var(--tech-r-control); font-weight: 600; } }

    .vc-loading { display: flex; align-items: center; gap: 12px; padding: var(--tech-space-2) 0; color: var(--tech-text); }

    .vc-transcript { margin: 0; padding: var(--tech-space-2) var(--tech-space-3);
      background: var(--tech-surface-2, rgba(127,127,127,0.08)); border-radius: var(--tech-r-control);
      color: var(--tech-text); font-size: 0.9rem; }

    .vc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--tech-space-2); }
    .vc-item { display: flex; flex-direction: column; gap: 6px; padding: var(--tech-space-2);
      border: 1px solid var(--tech-border, rgba(127,127,127,0.2)); border-radius: var(--tech-r-control); }
    .vc-item--off { opacity: 0.55; }
    .vc-item-main { display: inline-flex; align-items: center; gap: 8px; }
    .vc-item-icon { color: var(--tech-accent, var(--tech-text)); }
    .vc-item-summary { font-weight: 600; color: var(--tech-text); }
    .vc-item-field { width: 100%; }
    .vc-check { min-height: 44px; display: flex; align-items: center; }

    .vc-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
      padding: var(--tech-space-2) 0; color: var(--tech-text);
      mat-icon { font-size: 36px; width: 36px; height: 36px; color: var(--tech-text-dim, var(--tech-text)); }
      p { margin: 0; } }

    .vc-actions { padding: var(--tech-space-3) var(--tech-space-4); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; } }
  `,
})
export class VoiceCaptureDialog implements OnDestroy {
  private ref = inject(MatDialogRef<VoiceCaptureDialog, VoiceCaptureResult>);
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  readonly data = inject<VoiceCaptureData>(MAT_DIALOG_DATA);

  /** The inline-audio fallback is sent to the server, so it's the SEPARATE ai.vision capability. */
  private readonly canUseVision = this.auth.hasPermission(PERM.aiVision);

  readonly phase = signal<Phase>('idle');
  readonly announce = signal('');
  readonly interim = signal('');
  readonly transcript = signal('');
  readonly rows = signal<IntentRow[]>([]);
  readonly unavailableMsg = signal('Voice is unavailable right now — type instead.');
  readonly deniedMsg = signal('Microphone access was blocked. Allow the mic in your browser, or type instead.');

  /** Active recording handle, so Done/Cancel can drive it. */
  private active: VoiceRecording | null = null;
  private loggedSoFar = 0;

  /** Whether this browser can capture voice at all (on-device STT, or the audio fallback when vision-gated). */
  readonly canSpeak = computed(() => speechSupported() || (this.canUseVision && mediaRecorderSupported()));

  readonly selectedCount = computed(() => this.rows().filter(r => r.selected).length);

  // ─────────────────────────────────────────── capture ─────────────────────────────────────────

  /** Begin a capture: one-time privacy notice, then on-device STT (preferred) or the audio fallback. */
  async start(): Promise<void> {
    if (this.phase() !== 'idle' && this.phase() !== 'denied' && this.phase() !== 'none') return;
    const ok = await confirmVoiceNotice();
    if (!ok) return;

    this.interim.set('');
    this.transcript.set('');

    if (speechSupported()) {
      this.startTranscript();
    } else if (this.canUseVision && mediaRecorderSupported()) {
      this.startAudio();
    } else {
      this.toUnavailable('Your browser can’t capture voice here — type your note instead.');
    }
  }

  /** On-device STT path — the transcript is parsed as TEXT; audio never leaves the device. */
  private startTranscript(): void {
    try {
      const { recording, done } = recordTranscript((t) => this.interim.set(t));
      this.active = recording;
      this.toRecording();
      done.then(
        (res) => this.onTranscript(res),
        (err) => this.onCaptureError(err),
      );
    } catch (e) {
      this.onCaptureError(e);
    }
  }

  /** Inline-audio fallback (ai.vision) — record a short clip + send it for server-side transcription. */
  private startAudio(): void {
    try {
      const { recording, done } = recordAudioClip();
      this.active = recording;
      this.toRecording();
      done.then(
        (clip) => this.onAudio(clip),
        (err) => this.onCaptureError(err),
      );
    } catch (e) {
      this.onCaptureError(e);
    }
  }

  /** Stop the mic and let the capture promise settle into parsing. */
  stop(): void {
    this.active?.stop();
    this.active = null;
  }

  /** Abort recording without parsing — back to the idle prompt. */
  cancelRecording(): void {
    this.active?.abort();
    this.active = null;
    this.phase.set('idle');
    this.announce.set('Recording cancelled.');
  }

  private onTranscript(res: TranscriptResult | null): void {
    if (res === null) { this.phase.set('idle'); return; } // user-aborted
    const text = (res.text ?? '').trim();
    if (!text) { this.toNone(); return; }
    this.transcript.set(text);
    void this.parse({ transcript: text });
  }

  private onAudio(clip: AudioClipResult | null): void {
    if (clip === null) { this.phase.set('idle'); return; } // user-aborted
    void this.parse({ audioBase64: clip.audioBase64, mimeType: clip.mimeType });
  }

  private onCaptureError(err: unknown): void {
    const msg = err instanceof Error ? err.message : 'Could not capture audio.';
    if (/block|allow|denied|permission/i.test(msg)) {
      this.deniedMsg.set(msg);
      this.phase.set('denied');
      this.announce.set(msg);
    } else {
      this.toUnavailable(msg);
    }
    this.active = null;
  }

  // ─────────────────────────────────────────── parse ───────────────────────────────────────────

  /** Send the transcript/clip to the PARSE-ONLY endpoint (always 200) and route on the result. */
  private async parse(payload: { transcript?: string } | { audioBase64: string; mimeType: string }): Promise<void> {
    this.phase.set('parsing');
    this.announce.set('Understanding your note.');
    try {
      const res = await firstValueFrom(this.api.voiceParse({ ...payload, date: this.data.date }));
      // Floor: AI off/unconfigured/error → friendly "type instead" (never an error toast).
      if (!res.aiUsed) { this.toUnavailable(res.message || 'Voice is unavailable right now — type instead.'); return; }
      if (res.transcript) this.transcript.set(res.transcript);
      const intents = res.intents ?? [];
      if (intents.length === 0) { this.toNone(); return; }
      this.rows.set(intents.map(intent => this.toRow(intent)));
      this.phase.set('confirm');
      this.announce.set(`Heard ${intents.length} ${intents.length === 1 ? 'thing' : 'things'} to log. Review and confirm.`);
    } catch {
      // The endpoint floors to 200, so a real throw here is a transport error — treat as unavailable.
      this.toUnavailable('Voice is unavailable right now — type instead.');
    }
  }

  /** Build an editable row from a parsed intent, surfacing its main human field (description/name/label). */
  private toRow(intent: VoiceIntentDto): IntentRow {
    const p = intent.payload ?? {};
    let labelKey = '';
    for (const k of ['description', 'name', 'label', 'text']) {
      if (typeof p[k] === 'string') { labelKey = k; break; }
    }
    const label = labelKey ? String(p[labelKey] ?? '') : '';
    return { intent, label, labelKey, selected: true };
  }

  toggle(index: number, selected: boolean): void {
    this.rows.update(rows => rows.map((r, i) => (i === index ? { ...r, selected } : r)));
  }

  /** Edit the row's display field, writing it back into the (still server-clamped) payload. */
  setLabel(index: number, value: string): void {
    this.rows.update(rows => rows.map((r, i) => {
      if (i !== index || !r.labelKey) return r;
      return { ...r, label: value, intent: { ...r.intent, payload: { ...r.intent.payload, [r.labelKey]: value } } };
    }));
  }

  // ─────────────────────────────────────────── log ─────────────────────────────────────────────

  /**
   * CONFIRM: post each selected intent's payload to its EXISTING owner-scoped endpoint (validated against
   * the route allow-list in {@link Api.postVoiceIntent}). Each write rides that endpoint's own permission
   * gate + clamps server-side. Reports how many logged; a per-item failure is surfaced but never half-hides
   * the rest. Resolves the dialog so the page reloads the day.
   */
  async logSelected(): Promise<void> {
    if (this.phase() === 'logging') return;
    const selected = this.rows().filter(r => r.selected);
    if (selected.length === 0) return;

    this.phase.set('logging');
    this.announce.set('Logging your items.');
    let ok = 0;
    let failed = 0;
    for (const row of selected) {
      // Drop an emptied display field (e.g. the user cleared the description) — skip rather than write blank.
      if (row.labelKey && !row.label.trim()) { failed++; continue; }
      try {
        await firstValueFrom(this.api.postVoiceIntent(row.intent.endpoint, row.intent.payload));
        ok++;
      } catch {
        failed++;
      }
    }
    this.loggedSoFar = ok;

    if (ok > 0) {
      const msg = failed > 0
        ? `Logged ${ok} ${ok === 1 ? 'item' : 'items'} — ${failed} couldn’t be logged`
        : `Logged ${ok} ${ok === 1 ? 'item' : 'items'}`;
      this.snack.open(msg, 'OK', { duration: 4000 });
      this.phase.set('done');
      this.ref.close({ logged: ok });
    } else {
      this.snack.open('Nothing could be logged — try again or log manually', 'OK', { duration: 5000 });
      this.phase.set('confirm');
    }
  }

  /** Discard the parsed intents and go back to the start (re-record). */
  reset(): void {
    this.rows.set([]);
    this.transcript.set('');
    this.interim.set('');
    this.phase.set('idle');
    this.announce.set('Ready to record again.');
  }

  /** Close to typing: the user logs manually with the section buttons. */
  useTyping(): void {
    this.close();
  }

  close(): void {
    this.active?.abort();
    this.active = null;
    this.ref.close(this.loggedSoFar > 0 ? { logged: this.loggedSoFar } : undefined);
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  icon(domain: string): string {
    return DOMAIN_ICON[domain] ?? 'check_circle';
  }

  fieldLabel(domain: string): string {
    switch (domain) {
      case 'food': return 'What you ate';
      case 'exercise': return 'Exercise';
      case 'supplement': return 'Supplement';
      case 'family': return 'Note';
      default: return 'Label';
    }
  }

  private toRecording(): void {
    this.phase.set('recording');
    this.announce.set('Recording started. Speak now, then press Done.');
  }

  private toNone(): void {
    this.phase.set('none');
    this.announce.set('I didn’t catch anything I could log.');
  }

  private toUnavailable(msg: string): void {
    this.unavailableMsg.set(msg);
    this.phase.set('unavailable');
    this.announce.set(msg);
  }

  ngOnDestroy(): void {
    this.active?.abort();
    this.active = null;
  }
}
