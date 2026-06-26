import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  ResumeState,
  ResumeDto,
  ResumeApplicationDto,
  ResumeData,
  ResumeExperience,
  ResumeEducation,
  ResumeProject,
  ResumeCertification,
} from '../../core/models';
import { readFileAsBase64 } from '../tracker/ai-image';
import { ResumeAiPanel } from './resume-ai-panel';
import { NewApplicationDialog } from './new-application-dialog';
import {
  emptyResumeData,
  normalizeResumeData,
  cloneResumeData,
  emptyExperience,
  emptyEducation,
  emptyProject,
  emptyCertification,
  emptyLink,
  moveItem,
} from './resume-data.util';

type Onboarding = 'upload' | 'blank' | 'ai';
type ExportKind = 'resume' | 'cover';
type ExportFormat = 'pdf' | 'docx';
type ExportStyle = 'ats' | 'designed';

/**
 * Resume Builder — the gated /resume Tool (permissionGuard(resume.use)). A per-user resume + cover-letter
 * workshop over /api/resume. It has three modes once a master exists:
 *   • a STRUCTURED editor for the master resume (contact / summary / experience / education / skills /
 *     projects / certifications) with add/remove/reorder + a live preview + an explicit Save,
 *   • an AI assistant panel that interviews + refines (per-section "Improve with AI"),
 *   • APPLICATIONS — per-job tailored copies + cover letters you can edit, re-tailor, and export.
 * Before a master exists, an onboarding choice: upload an existing resume (parsed by AI), start blank, or
 * let the assistant interview you. Headshot upload powers the "designed" PDF/DOCX export. Everything is
 * owner-scoped server-side; mobile-first; themed with the --tech-* tokens.
 */
@Component({
  selector: 'app-resume',
  imports: [
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatTabsModule,
    ResumeAiPanel,
  ],
  templateUrl: './resume.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './resume.scss',
})
export class Resume {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal(false);

  /** The persisted master (null until first save). */
  readonly master = signal<ResumeDto | null>(null);
  readonly applications = signal<ResumeApplicationDto[]>([]);

  /** The live, editable copy of the master's data (forked from the server, saved explicitly). */
  readonly draft = signal<ResumeData>(emptyResumeData());
  readonly title = signal('My Resume');
  readonly shareWithContacts = signal(false);

  /** True when the editable draft/title/share differs from the last persisted snapshot. */
  private savedSnapshot = signal('');
  readonly dirty = computed(
    () => this.savedSnapshot() !== this.snapshotOf(this.draft(), this.title(), this.shareWithContacts()),
  );

  readonly saving = signal(false);
  readonly parsing = signal(false);
  readonly creatingApp = signal(false);
  /** Section keys currently running an "Improve with AI" call (so only that control disables). */
  private readonly refiningSet = signal<Set<string>>(new Set());

  /** Headshot object-URL for the live preview (revoked on swap/destroy); null when none. */
  readonly headshotUrl = signal<string | null>(null);
  readonly headshotBusy = signal(false);

  /** The currently-open application's id in the Applications tab (null = list view). */
  readonly openAppId = signal<number | null>(null);
  readonly openApp = computed(() => this.applications().find((a) => a.id === this.openAppId()) ?? null);
  /** Per-application in-flight ids (save / re-tailor / regenerate / delete). */
  private readonly appBusy = signal<Set<number>>(new Set());
  readonly exporting = signal(false);

  /** Whether a master resume exists yet (drives onboarding vs. editor). */
  readonly hasMaster = computed(() => this.master() !== null);

  constructor() {
    void this.load();
    // Revoke any live headshot object URL on teardown.
    this.destroyRef.onDestroy(() => {
      const u = this.headshotUrl();
      if (u) URL.revokeObjectURL(u);
    });
  }

  // ─────────────────────────────────────────── load ────────────────────────────────────────────

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const state: ResumeState = await firstValueFrom(this.api.resumeState());
      this.applyState(state);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private applyState(state: ResumeState): void {
    this.master.set(state.master);
    this.applications.set(state.applications ?? []);
    if (state.master) {
      const data = normalizeResumeData(state.master.data);
      this.draft.set(data);
      this.title.set(state.master.title || 'My Resume');
      this.shareWithContacts.set(state.master.shareWithContacts);
      this.savedSnapshot.set(this.snapshotOf(data, this.title(), this.shareWithContacts()));
      if (state.master.hasHeadshot) void this.refreshHeadshot();
    }
  }

  private snapshotOf(data: ResumeData, title: string, share: boolean): string {
    return JSON.stringify({ data, title, share });
  }

  // ─────────────────────────────────────────── onboarding ──────────────────────────────────────

  /** Start a brand-new blank master (in-memory; user fills it in then Saves). */
  startBlank(): void {
    this.draft.set(emptyResumeData());
    this.title.set('My Resume');
    this.shareWithContacts.set(false);
    // A non-empty snapshot so the first Save is clearly "dirty".
    this.savedSnapshot.set('__new__');
    // Persist immediately so the editor + applications unlock.
    void this.save();
  }

  /** Begin the AI interview path: create a blank master, then nudge the user toward the assistant. */
  startAi(): void {
    this.startBlank();
    this.snack.open('Open the assistant on the right and ask it to interview you.', 'OK', { duration: 4500 });
  }

  /** Upload + parse an existing resume file (PDF/DOCX/image/txt) into the structured editor. */
  async onUploadFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      this.snack.open('That file is too large (max 12 MB).', 'Dismiss', { duration: 4000 });
      return;
    }
    this.parsing.set(true);
    try {
      const isText = file.type.startsWith('text/') || /\.txt$/i.test(file.name);
      let res: { data: ResumeData; aiUsed: boolean };
      if (isText) {
        const text = await file.text();
        res = await firstValueFrom(this.api.parseResume({ text }));
      } else {
        const base64 = await readFileAsBase64(file);
        res = await firstValueFrom(this.api.parseResume({ fileBase64: base64, mime: file.type || 'application/octet-stream' }));
      }
      this.draft.set(normalizeResumeData(res.data));
      if (!this.title()) this.title.set('My Resume');
      this.savedSnapshot.set('__new__');
      await this.save();
      this.snack.open('Imported your resume — review and tweak each section.', 'OK', { duration: 4000 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.snack.open(
        status === 503
          ? 'AI parsing is not configured right now. You can start blank instead.'
          : "Couldn't read that file — try another, or start blank.",
        'Dismiss',
        { duration: 5000 },
      );
    } finally {
      this.parsing.set(false);
    }
  }

  // ─────────────────────────────────────────── master save ─────────────────────────────────────

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const saved = await firstValueFrom(
        this.api.saveResume({
          title: this.title().trim() || 'My Resume',
          data: this.draft(),
          shareWithContacts: this.shareWithContacts(),
        }),
      );
      this.master.set(saved);
      const data = normalizeResumeData(saved.data);
      this.draft.set(data);
      this.savedSnapshot.set(this.snapshotOf(data, saved.title, saved.shareWithContacts));
      this.snack.open('Resume saved', 'OK', { duration: 2200 });
    } catch {
      this.snack.open("Couldn't save — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.saving.set(false);
    }
  }

  async deleteMaster(): Promise<void> {
    if (!this.master()) return;
    if (!confirm('Delete your resume and all tailored applications? This can’t be undone.')) return;
    try {
      await firstValueFrom(this.api.deleteResume());
      const u = this.headshotUrl();
      if (u) URL.revokeObjectURL(u);
      this.headshotUrl.set(null);
      this.master.set(null);
      this.applications.set([]);
      this.openAppId.set(null);
      this.draft.set(emptyResumeData());
      this.title.set('My Resume');
      this.shareWithContacts.set(false);
      this.savedSnapshot.set('');
      this.snack.open('Resume deleted', 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't delete — try again", 'Dismiss', { duration: 4000 });
    }
  }

  // ─────────────────────────────────────────── draft mutators ──────────────────────────────────
  // Each mutates a cloned copy then re-sets the signal (so OnPush + dirty recompute fire).

  private patch(mut: (d: ResumeData) => void): void {
    const next = cloneResumeData(this.draft());
    mut(next);
    this.draft.set(next);
  }

  setSummary(v: string): void { this.patch((d) => (d.summary = v)); }
  setContact<K extends keyof ResumeData['contact']>(key: K, v: ResumeData['contact'][K]): void {
    this.patch((d) => (d.contact[key] = v));
  }

  addLink(): void { this.patch((d) => d.contact.links.push(emptyLink())); }
  removeLink(i: number): void { this.patch((d) => d.contact.links.splice(i, 1)); }
  setLink(i: number, key: 'label' | 'url', v: string): void { this.patch((d) => (d.contact.links[i][key] = v)); }

  // Experience
  addExperience(): void { this.patch((d) => d.experience.unshift(emptyExperience())); }
  removeExperience(i: number): void { this.patch((d) => d.experience.splice(i, 1)); }
  moveExperience(i: number, delta: number): void { this.patch((d) => moveItem(d.experience, i, delta)); }
  setExperience<K extends keyof ResumeExperience>(i: number, key: K, v: ResumeExperience[K]): void {
    this.patch((d) => (d.experience[i][key] = v));
  }
  addExpBullet(i: number): void { this.patch((d) => d.experience[i].bullets.push('')); }
  removeExpBullet(i: number, b: number): void { this.patch((d) => d.experience[i].bullets.splice(b, 1)); }
  setExpBullet(i: number, b: number, v: string): void { this.patch((d) => (d.experience[i].bullets[b] = v)); }

  // Education
  addEducation(): void { this.patch((d) => d.education.unshift(emptyEducation())); }
  removeEducation(i: number): void { this.patch((d) => d.education.splice(i, 1)); }
  moveEducation(i: number, delta: number): void { this.patch((d) => moveItem(d.education, i, delta)); }
  setEducation<K extends keyof ResumeEducation>(i: number, key: K, v: ResumeEducation[K]): void {
    this.patch((d) => (d.education[i][key] = v));
  }

  // Skills (comma/line list edited as a single textarea, but stored as an array)
  setSkillsText(v: string): void {
    const list = v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    this.patch((d) => (d.skills = list));
  }
  get skillsText(): string { return this.draft().skills.join(', '); }

  // Projects
  addProject(): void { this.patch((d) => d.projects.unshift(emptyProject())); }
  removeProject(i: number): void { this.patch((d) => d.projects.splice(i, 1)); }
  moveProject(i: number, delta: number): void { this.patch((d) => moveItem(d.projects, i, delta)); }
  setProject<K extends keyof ResumeProject>(i: number, key: K, v: ResumeProject[K]): void {
    this.patch((d) => (d.projects[i][key] = v));
  }
  addProjBullet(i: number): void { this.patch((d) => d.projects[i].bullets.push('')); }
  removeProjBullet(i: number, b: number): void { this.patch((d) => d.projects[i].bullets.splice(b, 1)); }
  setProjBullet(i: number, b: number, v: string): void { this.patch((d) => (d.projects[i].bullets[b] = v)); }

  // Certifications
  addCertification(): void { this.patch((d) => d.certifications.unshift(emptyCertification())); }
  removeCertification(i: number): void { this.patch((d) => d.certifications.splice(i, 1)); }
  setCertification<K extends keyof ResumeCertification>(i: number, key: K, v: ResumeCertification[K]): void {
    this.patch((d) => (d.certifications[i][key] = v));
  }

  // ─────────────────────────────────────────── per-section AI refine ───────────────────────────

  isRefining(key: string): boolean { return this.refiningSet().has(key); }
  private setRefining(key: string, on: boolean): void {
    this.refiningSet.update((s) => {
      const next = new Set(s);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  /**
   * "Improve with AI" for one section's free text. `section` names it ("summary", "experience-bullet"…);
   * `content` is the current text; on success `apply` writes the refined text back into the draft.
   */
  async refine(
    sectionKey: string,
    section: string,
    content: string,
    instruction: string,
    apply: (refined: string) => void,
  ): Promise<void> {
    if (!content.trim() || this.isRefining(sectionKey)) return;
    this.setRefining(sectionKey, true);
    try {
      const res = await firstValueFrom(
        this.api.refineResumeSection({ section, content, instruction, data: this.draft() }),
      );
      if (res.result?.trim()) {
        apply(res.result.trim());
        this.snack.open('Polished with AI', 'OK', { duration: 2200 });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.snack.open(
        status === 503 ? 'AI is not configured right now.' : "Couldn't refine that — try again",
        'Dismiss',
        { duration: 4000 },
      );
    } finally {
      this.setRefining(sectionKey, false);
    }
  }

  improveSummary(): void {
    void this.refine('summary', 'summary', this.draft().summary,
      'Rewrite this professional summary to be concise, impactful, and achievement-oriented.',
      (r) => this.setSummary(r));
  }
  improveExpBullet(i: number, b: number): void {
    const cur = this.draft().experience[i]?.bullets[b] ?? '';
    void this.refine(`exp-${i}-${b}`, 'experience', cur,
      'Rewrite this experience bullet as a strong, quantified achievement starting with an action verb.',
      (r) => this.setExpBullet(i, b, r));
  }
  improveProjBullet(i: number, b: number): void {
    const cur = this.draft().projects[i]?.bullets[b] ?? '';
    void this.refine(`proj-${i}-${b}`, 'project', cur,
      'Rewrite this project bullet to highlight impact and the technologies used.',
      (r) => this.setProjBullet(i, b, r));
  }

  // ─────────────────────────────────────────── headshot ────────────────────────────────────────

  private async refreshHeadshot(): Promise<void> {
    try {
      const blob = await firstValueFrom(this.api.resumeHeadshot());
      const prev = this.headshotUrl();
      this.headshotUrl.set(URL.createObjectURL(blob));
      if (prev) URL.revokeObjectURL(prev);
    } catch {
      this.headshotUrl.set(null);
    }
  }

  async onHeadshotFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.snack.open('Please choose an image file.', 'Dismiss', { duration: 4000 });
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      this.snack.open('That image is too large (max 6 MB).', 'Dismiss', { duration: 4000 });
      return;
    }
    this.headshotBusy.set(true);
    try {
      const base64 = await readFileAsBase64(file);
      await firstValueFrom(this.api.uploadResumeHeadshot({ imageBase64: base64, mime: file.type }));
      const m = this.master();
      if (m) this.master.set({ ...m, hasHeadshot: true });
      await this.refreshHeadshot();
      this.snack.open('Headshot saved — use it in the "Designed" export.', 'OK', { duration: 3000 });
    } catch {
      this.snack.open("Couldn't upload that image — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.headshotBusy.set(false);
    }
  }

  async removeHeadshot(): Promise<void> {
    if (!this.master()?.hasHeadshot) return;
    this.headshotBusy.set(true);
    try {
      await firstValueFrom(this.api.deleteResumeHeadshot());
      const prev = this.headshotUrl();
      if (prev) URL.revokeObjectURL(prev);
      this.headshotUrl.set(null);
      const m = this.master();
      if (m) this.master.set({ ...m, hasHeadshot: false });
      this.snack.open('Headshot removed', 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't remove the headshot — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.headshotBusy.set(false);
    }
  }

  // ─────────────────────────────────────────── applications ────────────────────────────────────

  isAppBusy(id: number): boolean { return this.appBusy().has(id); }
  private setAppBusy(id: number, on: boolean): void {
    this.appBusy.update((s) => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  openApplication(id: number): void { this.openAppId.set(id); }
  backToList(): void { this.openAppId.set(null); }

  /** Open the new-application dialog, then create + AI-tailor a copy off the master. */
  newApplication(): void {
    if (!this.master()) {
      this.snack.open('Save your master resume first.', 'OK', { duration: 3000 });
      return;
    }
    const ref = this.dialog.open(NewApplicationDialog, { autoFocus: false, panelClass: 'resume-dialog-pane' });
    ref.afterClosed().subscribe(async (req) => {
      if (!req) return;
      this.creatingApp.set(true);
      try {
        const app = await firstValueFrom(this.api.createResumeApplication(req));
        this.applications.update((a) => [app, ...a]);
        this.openAppId.set(app.id);
        this.snack.open(`Tailored for ${app.jobTitle || 'the role'}`, 'OK', { duration: 3000 });
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        this.snack.open(
          status === 503 ? 'AI is not configured right now — tailoring needs it.' : "Couldn't create that application — try again",
          'Dismiss',
          { duration: 4500 },
        );
      } finally {
        this.creatingApp.set(false);
      }
    });
  }

  /** Patch one field of the open application's local copy (saved explicitly via saveApplication). */
  patchOpenApp(mut: (a: ResumeApplicationDto) => ResumeApplicationDto): void {
    const id = this.openAppId();
    if (id == null) return;
    this.applications.update((apps) => apps.map((a) => (a.id === id ? mut(a) : a)));
  }

  setAppCoverLetter(v: string): void { this.patchOpenApp((a) => ({ ...a, coverLetter: v })); }
  setAppJobTitle(v: string): void { this.patchOpenApp((a) => ({ ...a, jobTitle: v })); }
  setAppCompany(v: string): void { this.patchOpenApp((a) => ({ ...a, company: v })); }

  async saveApplication(): Promise<void> {
    const app = this.openApp();
    if (!app || this.isAppBusy(app.id)) return;
    this.setAppBusy(app.id, true);
    try {
      const saved = await firstValueFrom(
        this.api.saveResumeApplication(app.id, {
          jobTitle: app.jobTitle,
          company: app.company,
          jobDescription: app.jobDescription,
          data: app.data,
          coverLetter: app.coverLetter,
        }),
      );
      this.applications.update((apps) => apps.map((a) => (a.id === saved.id ? saved : a)));
      this.snack.open('Application saved', 'OK', { duration: 2200 });
    } catch {
      this.snack.open("Couldn't save the application — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  /** Re-run the AI tailor on the open application's data against its pinned job description. */
  async reTailor(): Promise<void> {
    const app = this.openApp();
    if (!app || this.isAppBusy(app.id)) return;
    this.setAppBusy(app.id, true);
    try {
      const res = await firstValueFrom(
        this.api.tailorResume({ jobDescription: app.jobDescription, data: app.data }),
      );
      this.patchOpenApp((a) => ({ ...a, data: normalizeResumeData(res.data) }));
      this.snack.open('Re-tailored — review and save', 'OK', { duration: 3000 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.snack.open(
        status === 503 ? 'AI is not configured right now.' : "Couldn't re-tailor — try again",
        'Dismiss', { duration: 4000 },
      );
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  /** Regenerate the cover letter for the open application from its tailored data + job. */
  async regenerateCover(): Promise<void> {
    const app = this.openApp();
    if (!app || this.isAppBusy(app.id)) return;
    this.setAppBusy(app.id, true);
    try {
      const res = await firstValueFrom(
        this.api.resumeCoverLetter({
          jobTitle: app.jobTitle,
          company: app.company,
          jobDescription: app.jobDescription,
          data: app.data,
        }),
      );
      this.patchOpenApp((a) => ({ ...a, coverLetter: res.coverLetter }));
      this.snack.open('Cover letter regenerated — review and save', 'OK', { duration: 3000 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.snack.open(
        status === 503 ? 'AI is not configured right now.' : "Couldn't regenerate — try again",
        'Dismiss', { duration: 4000 },
      );
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  async deleteApplication(app: ResumeApplicationDto): Promise<void> {
    if (this.isAppBusy(app.id)) return;
    if (!confirm(`Delete the "${app.jobTitle || 'untitled'}" application?`)) return;
    this.setAppBusy(app.id, true);
    try {
      await firstValueFrom(this.api.deleteResumeApplication(app.id));
      this.applications.update((apps) => apps.filter((a) => a.id !== app.id));
      if (this.openAppId() === app.id) this.openAppId.set(null);
      this.snack.open('Application deleted', 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't delete — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  // ─────────────────────────────────────────── export / download ───────────────────────────────

  /** Download a resume/cover-letter export. `appId` set ⇒ source=application, else source=master. */
  async export(kind: ExportKind, format: ExportFormat, style: ExportStyle, appId?: number): Promise<void> {
    if (this.exporting()) return;
    // Saving first guarantees the server renders the latest edits.
    if (appId == null && this.dirty()) await this.save();
    else if (appId != null) {
      const app = this.applications().find((a) => a.id === appId);
      if (app) await this.saveApplicationById(appId);
    }
    this.exporting.set(true);
    try {
      const blob = await firstValueFrom(
        this.api.exportResume({
          source: appId != null ? 'application' : 'master',
          id: appId ?? null,
          kind,
          format,
          style,
        }),
      );
      const namePart = (this.draft().contact.fullName || 'resume').replace(/[^\w.-]+/g, '_').toLowerCase();
      const label = kind === 'cover' ? 'cover-letter' : 'resume';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${namePart}-${label}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.snack.open('Export failed — try again', 'Dismiss', { duration: 4000 });
    } finally {
      this.exporting.set(false);
    }
  }

  /** Persist one application by id without requiring it to be the open one (used before export). */
  private async saveApplicationById(id: number): Promise<void> {
    const app = this.applications().find((a) => a.id === id);
    if (!app) return;
    try {
      const saved = await firstValueFrom(
        this.api.saveResumeApplication(id, {
          jobTitle: app.jobTitle,
          company: app.company,
          jobDescription: app.jobDescription,
          data: app.data,
          coverLetter: app.coverLetter,
        }),
      );
      this.applications.update((apps) => apps.map((a) => (a.id === saved.id ? saved : a)));
    } catch {
      /* best-effort — export still proceeds against last-saved state */
    }
  }

  // ─────────────────────────────────────────── preview helpers ─────────────────────────────────

  /** A flat, human label for an experience date range ("Jun 2021 – Present"). */
  dateRange(start: string, end: string, current: boolean): string {
    const e = current ? 'Present' : end;
    if (start && e) return `${start} – ${e}`;
    return start || e || '';
  }
}
