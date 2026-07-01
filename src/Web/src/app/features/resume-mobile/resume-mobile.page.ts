import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  ResumeState, ResumeDto, ResumeApplicationDto, ResumeData,
  ResumeExperience, ResumeEducation, ResumeProject, ResumeCertification,
  ResumeChatMessage,
} from '../../core/models';
import { readFileAsBase64 } from '../tracker/ai-image';
import {
  emptyResumeData, normalizeResumeData, cloneResumeData,
  emptyExperience, emptyEducation, emptyProject, emptyCertification, emptyLink, moveItem,
} from '../resume/resume-data.util';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaFab,
  BetaToaster, ToastController, type Segment,
} from '../beta-ui';

/** The accordion section keys in the master editor (only one open at a time). */
type SectionKey =
  | 'contact' | 'summary' | 'experience' | 'education'
  | 'skills' | 'projects' | 'certifications' | 'headshot';

type ExportFormat = 'pdf' | 'docx';
type ExportStyle = 'ats' | 'designed';

/** Which export target the export sheet is configured for: the master, or one application. */
interface ExportTarget {
  appId: number | null;
  jobTitle: string;
}

/**
 * Resume Builder — the MOBILE twin of the live `/resume` Tool, rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`) with a signature TEAL → INDIGO accent. It is a usable, phone-first
 * resume workshop over the SAME owner-scoped `/api/resume` endpoints the live page uses:
 *   • an IMMERSIVE hero with a tiny "sections filled / applications / skills" stat strip,
 *   • a {@link BetaSegmentedControl} flipping between the EDITOR and APPLICATIONS,
 *   • a section-by-section ACCORDION editor (contact / summary / experience / education / skills /
 *     projects / certifications / headshot) with add/remove/reorder + per-section "Improve with AI",
 *   • an explicit sticky SAVE bar (dirty-aware) for the master,
 *   • an AI ASSISTANT chat in a {@link BetaBottomSheet} (interview + refine over /resume/ai/chat),
 *   • APPLICATIONS — per-job tailored copies + cover letters you can edit, re-tailor, regenerate, export,
 *   • EXPORT (PDF/DOCX × ATS/Designed) for the master and any application, via a small export sheet.
 * Before a master exists, an ONBOARDING choice: upload+parse an existing resume, start blank, or
 * interview with the assistant.
 *
 * DATA PARITY + PRIVACY: every read/write goes straight through the SAME owner-scoped `/api/resume`
 * methods the live page calls — {@link Api.resumeState}, {@link Api.saveResume}, {@link Api.deleteResume},
 * {@link Api.parseResume}, headshot up/down/delete, the AI tailor/cover/refine/chat endpoints,
 * {@link Api.createResumeApplication} / save / delete, and {@link Api.exportResume} VERBATIM. The save body
 * is built exactly like the live editor; the server enforces ownership + sanitization and stays the source
 * of truth. This page only ever touches the CALLER's own resume — never anyone else's, never an email.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/resume` route (same `resume.use`). It imports only
 * the kit + the shared Api/models + the live page's pure {@link resume-data.util} factories. No live page
 * is imported or modified. Mobile-first (44px targets, safe-area, no 390px overflow); the harness mocks the
 * API so it renders cleanly with ZERO data.
 */
@Component({
  selector: 'app-resume-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="rm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="rm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="rm-hero">
          <p class="rm-hero__kicker"><mat-icon aria-hidden="true">description</mat-icon> Resume Builder</p>
          <h1 class="rm-hero__title">{{ hasMaster() ? (title() || 'My Resume') : 'Build your resume' }}</h1>
          <p class="rm-hero__sub">AI-powered resume builder with per-job tailoring and export.</p>

          @if (!loading() && !errored() && hasMaster()) {
            <div class="rm-stats">
              <div class="rm-stat">
                <span class="rm-stat__n mono-num">{{ filledCount() }}/{{ totalSections }}</span>
                <span class="rm-stat__l">sections</span>
              </div>
              <div class="rm-stat">
                <span class="rm-stat__n mono-num">{{ applications().length }}</span>
                <span class="rm-stat__l">{{ applications().length === 1 ? 'application' : 'applications' }}</span>
              </div>
              <div class="rm-stat">
                <span class="rm-stat__n mono-num">{{ draft().skills.length }}</span>
                <span class="rm-stat__l">skills</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <div class="rm-skel" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="64px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="rm-state">
            <span class="rm-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="rm-state__title">Couldn't load your resume</h2>
            <p class="rm-state__body">Something went wrong reaching your workshop. Give it another go.</p>
            <button type="button" class="rm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (!hasMaster()) {
          <!-- ─── ONBOARDING ─── -->
          <div class="rm-onboard">
            <button type="button" class="rm-ob" (click)="uploadInput.click()" [disabled]="parsing()">
              <span class="rm-ob__ic" aria-hidden="true">
                @if (parsing()) { <mat-icon class="rm-spin">progress_activity</mat-icon> }
                @else { <mat-icon>upload_file</mat-icon> }
              </span>
              <span class="rm-ob__body">
                <span class="rm-ob__title">{{ parsing() ? 'Reading your file…' : 'Upload a resume' }}</span>
                <span class="rm-ob__sub">PDF, DOCX, image or text — AI parses it into sections.</span>
              </span>
              <mat-icon class="rm-ob__go" aria-hidden="true">chevron_right</mat-icon>
            </button>

            <button type="button" class="rm-ob" (click)="startBlank()" [disabled]="parsing() || saving()">
              <span class="rm-ob__ic" aria-hidden="true"><mat-icon>edit_note</mat-icon></span>
              <span class="rm-ob__body">
                <span class="rm-ob__title">Start blank</span>
                <span class="rm-ob__sub">Fill in each section yourself, section by section.</span>
              </span>
              <mat-icon class="rm-ob__go" aria-hidden="true">chevron_right</mat-icon>
            </button>

            <button type="button" class="rm-ob" (click)="startAi()" [disabled]="parsing() || saving()">
              <span class="rm-ob__ic" aria-hidden="true"><mat-icon>auto_awesome</mat-icon></span>
              <span class="rm-ob__body">
                <span class="rm-ob__title">Interview with AI</span>
                <span class="rm-ob__sub">The assistant asks questions and drafts it with you.</span>
              </span>
              <mat-icon class="rm-ob__go" aria-hidden="true">chevron_right</mat-icon>
            </button>
          </div>

        } @else {
          <!-- ─── EDITOR | APPLICATIONS ─── -->
          <div class="rm-seg-wrap">
            <app-bs-segmented class="rm-seg"
              [segments]="tabSegments()" [value]="tab()" label="Resume view"
              (change)="setTab($event)" />
          </div>

          @if (tab() === 'editor') {
            <!-- ── MASTER EDITOR: accordion sections ── -->
            <div class="rm-acc">

              <!-- CONTACT -->
              <section class="rm-sec" [class.is-open]="open() === 'contact'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('contact')"
                        [attr.aria-expanded]="open() === 'contact'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>badge</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Contact</span>
                    <span class="rm-sec__sub">{{ draft().contact.fullName || 'Name, headline, links' }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'contact') {
                  <div class="rm-sec__body">
                    <label class="rm-field">
                      <span class="rm-field__label">Full name</span>
                      <input class="rm-input" type="text" autocomplete="off" maxlength="120"
                             [ngModel]="draft().contact.fullName" (ngModelChange)="setContact('fullName', $event)"
                             name="c-name" placeholder="Jane Doe" />
                    </label>
                    <label class="rm-field">
                      <span class="rm-field__label">Headline</span>
                      <input class="rm-input" type="text" autocomplete="off" maxlength="160"
                             [ngModel]="draft().contact.headline" (ngModelChange)="setContact('headline', $event)"
                             name="c-headline" placeholder="Senior Frontend Engineer" />
                    </label>
                    <div class="rm-row">
                      <label class="rm-field">
                        <span class="rm-field__label">Email</span>
                        <input class="rm-input" type="email" inputmode="email" autocomplete="off"
                               [ngModel]="draft().contact.email" (ngModelChange)="setContact('email', $event)"
                               name="c-email" placeholder="you@example.com" />
                      </label>
                      <label class="rm-field">
                        <span class="rm-field__label">Phone</span>
                        <input class="rm-input" type="tel" inputmode="tel" autocomplete="off"
                               [ngModel]="draft().contact.phone" (ngModelChange)="setContact('phone', $event)"
                               name="c-phone" placeholder="(555) 555-5555" />
                      </label>
                    </div>
                    <label class="rm-field">
                      <span class="rm-field__label">Location</span>
                      <input class="rm-input" type="text" autocomplete="off"
                             [ngModel]="draft().contact.location" (ngModelChange)="setContact('location', $event)"
                             name="c-loc" placeholder="City, State" />
                    </label>

                    <span class="rm-mini-title">Links</span>
                    @for (lnk of draft().contact.links; track $index; let li = $index) {
                      <div class="rm-link">
                        <input class="rm-input rm-link__label" type="text" placeholder="Label"
                               [ngModel]="lnk.label" (ngModelChange)="setLink(li, 'label', $event)"
                               [name]="'lnk-l-' + li" autocomplete="off" />
                        <input class="rm-input rm-link__url" type="url" inputmode="url" placeholder="https://…"
                               [ngModel]="lnk.url" (ngModelChange)="setLink(li, 'url', $event)"
                               [name]="'lnk-u-' + li" autocomplete="off" />
                        <button type="button" class="rm-icon-btn" (click)="removeLink(li)" aria-label="Remove link">
                          <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
                        </button>
                      </div>
                    }
                    <button type="button" class="rm-add" (click)="addLink()">
                      <mat-icon aria-hidden="true">add</mat-icon> Add link
                    </button>
                  </div>
                }
              </section>

              <!-- SUMMARY -->
              <section class="rm-sec" [class.is-open]="open() === 'summary'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('summary')"
                        [attr.aria-expanded]="open() === 'summary'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>notes</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Summary</span>
                    <span class="rm-sec__sub">{{ draft().summary ? truncate(draft().summary) : 'A short professional intro' }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'summary') {
                  <div class="rm-sec__body">
                    <textarea class="rm-input rm-area" rows="5" name="summary"
                              [ngModel]="draft().summary" (ngModelChange)="setSummary($event)"
                              placeholder="Results-driven engineer with…"></textarea>
                    <button type="button" class="rm-ai" [disabled]="isRefining('summary') || !draft().summary.trim()"
                            (click)="improveSummary()">
                      @if (isRefining('summary')) { <mat-icon class="rm-spin" aria-hidden="true">progress_activity</mat-icon> Polishing… }
                      @else { <mat-icon aria-hidden="true">auto_awesome</mat-icon> Improve with AI }
                    </button>
                  </div>
                }
              </section>

              <!-- EXPERIENCE -->
              <section class="rm-sec" [class.is-open]="open() === 'experience'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('experience')"
                        [attr.aria-expanded]="open() === 'experience'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>work</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Experience</span>
                    <span class="rm-sec__sub">{{ countLabel(draft().experience.length, 'role') }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'experience') {
                  <div class="rm-sec__body">
                    @for (exp of draft().experience; track $index; let i = $index) {
                      <div class="rm-entry">
                        <div class="rm-entry__bar">
                          <span class="rm-entry__n">{{ exp.title || exp.company || ('Role ' + (i + 1)) }}</span>
                          <span class="rm-entry__tools">
                            <button type="button" class="rm-icon-btn" (click)="moveExperience(i, -1)" [disabled]="i === 0" aria-label="Move up">
                              <mat-icon aria-hidden="true">arrow_upward</mat-icon>
                            </button>
                            <button type="button" class="rm-icon-btn" (click)="moveExperience(i, 1)" [disabled]="i === draft().experience.length - 1" aria-label="Move down">
                              <mat-icon aria-hidden="true">arrow_downward</mat-icon>
                            </button>
                            <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeExperience(i)" aria-label="Remove role">
                              <mat-icon aria-hidden="true">delete_outline</mat-icon>
                            </button>
                          </span>
                        </div>
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Title</span>
                            <input class="rm-input" type="text" [ngModel]="exp.title" (ngModelChange)="setExperience(i, 'title', $event)" [name]="'e-t-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field"><span class="rm-field__label">Company</span>
                            <input class="rm-input" type="text" [ngModel]="exp.company" (ngModelChange)="setExperience(i, 'company', $event)" [name]="'e-c-' + i" autocomplete="off" />
                          </label>
                        </div>
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Start</span>
                            <input class="rm-input" type="text" placeholder="Jun 2021" [ngModel]="exp.startDate" (ngModelChange)="setExperience(i, 'startDate', $event)" [name]="'e-s-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field"><span class="rm-field__label">End</span>
                            <input class="rm-input" type="text" placeholder="Present" [disabled]="exp.current" [ngModel]="exp.endDate" (ngModelChange)="setExperience(i, 'endDate', $event)" [name]="'e-e-' + i" autocomplete="off" />
                          </label>
                        </div>
                        <label class="rm-field"><span class="rm-field__label">Location</span>
                          <input class="rm-input" type="text" [ngModel]="exp.location" (ngModelChange)="setExperience(i, 'location', $event)" [name]="'e-l-' + i" autocomplete="off" />
                        </label>
                        <button type="button" class="rm-check" [class.is-on]="exp.current" (click)="setExperience(i, 'current', !exp.current)">
                          <span class="rm-check__box" aria-hidden="true"><mat-icon>{{ exp.current ? 'check_box' : 'check_box_outline_blank' }}</mat-icon></span>
                          I currently work here
                        </button>

                        <span class="rm-mini-title">Highlights</span>
                        @for (b of exp.bullets; track $index; let bi = $index) {
                          <div class="rm-bullet">
                            <textarea class="rm-input rm-bullet__txt" rows="2" [ngModel]="b" (ngModelChange)="setExpBullet(i, bi, $event)" [name]="'e-b-' + i + '-' + bi" placeholder="Shipped…"></textarea>
                            <div class="rm-bullet__tools">
                              <button type="button" class="rm-icon-btn" [disabled]="isRefining('exp-' + i + '-' + bi) || !b.trim()" (click)="improveExpBullet(i, bi)" aria-label="Improve bullet with AI">
                                <mat-icon class="rm-ai-ic" [class.rm-spin]="isRefining('exp-' + i + '-' + bi)" aria-hidden="true">{{ isRefining('exp-' + i + '-' + bi) ? 'progress_activity' : 'auto_awesome' }}</mat-icon>
                              </button>
                              <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeExpBullet(i, bi)" aria-label="Remove bullet">
                                <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
                              </button>
                            </div>
                          </div>
                        }
                        <button type="button" class="rm-add rm-add--sm" (click)="addExpBullet(i)">
                          <mat-icon aria-hidden="true">add</mat-icon> Add highlight
                        </button>
                      </div>
                    }
                    <button type="button" class="rm-add" (click)="addExperience()">
                      <mat-icon aria-hidden="true">add</mat-icon> Add a role
                    </button>
                  </div>
                }
              </section>

              <!-- EDUCATION -->
              <section class="rm-sec" [class.is-open]="open() === 'education'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('education')"
                        [attr.aria-expanded]="open() === 'education'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>school</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Education</span>
                    <span class="rm-sec__sub">{{ countLabel(draft().education.length, 'entry', 'entries') }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'education') {
                  <div class="rm-sec__body">
                    @for (ed of draft().education; track $index; let i = $index) {
                      <div class="rm-entry">
                        <div class="rm-entry__bar">
                          <span class="rm-entry__n">{{ ed.school || ('Entry ' + (i + 1)) }}</span>
                          <span class="rm-entry__tools">
                            <button type="button" class="rm-icon-btn" (click)="moveEducation(i, -1)" [disabled]="i === 0" aria-label="Move up"><mat-icon aria-hidden="true">arrow_upward</mat-icon></button>
                            <button type="button" class="rm-icon-btn" (click)="moveEducation(i, 1)" [disabled]="i === draft().education.length - 1" aria-label="Move down"><mat-icon aria-hidden="true">arrow_downward</mat-icon></button>
                            <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeEducation(i)" aria-label="Remove entry"><mat-icon aria-hidden="true">delete_outline</mat-icon></button>
                          </span>
                        </div>
                        <label class="rm-field"><span class="rm-field__label">School</span>
                          <input class="rm-input" type="text" [ngModel]="ed.school" (ngModelChange)="setEducation(i, 'school', $event)" [name]="'ed-s-' + i" autocomplete="off" />
                        </label>
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Degree</span>
                            <input class="rm-input" type="text" [ngModel]="ed.degree" (ngModelChange)="setEducation(i, 'degree', $event)" [name]="'ed-d-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field"><span class="rm-field__label">Field</span>
                            <input class="rm-input" type="text" [ngModel]="ed.field" (ngModelChange)="setEducation(i, 'field', $event)" [name]="'ed-f-' + i" autocomplete="off" />
                          </label>
                        </div>
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Start</span>
                            <input class="rm-input" type="text" [ngModel]="ed.startDate" (ngModelChange)="setEducation(i, 'startDate', $event)" [name]="'ed-st-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field"><span class="rm-field__label">End</span>
                            <input class="rm-input" type="text" [ngModel]="ed.endDate" (ngModelChange)="setEducation(i, 'endDate', $event)" [name]="'ed-en-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field rm-field--sm"><span class="rm-field__label">GPA</span>
                            <input class="rm-input" type="text" [ngModel]="ed.gpa" (ngModelChange)="setEducation(i, 'gpa', $event)" [name]="'ed-g-' + i" autocomplete="off" />
                          </label>
                        </div>
                        <label class="rm-field"><span class="rm-field__label">Location</span>
                          <input class="rm-input" type="text" [ngModel]="ed.location" (ngModelChange)="setEducation(i, 'location', $event)" [name]="'ed-loc-' + i" autocomplete="off" placeholder="City, State" />
                        </label>
                        <label class="rm-field"><span class="rm-field__label">Details</span>
                          <textarea class="rm-input rm-area" rows="2" [ngModel]="ed.details" (ngModelChange)="setEducation(i, 'details', $event)" [name]="'ed-det-' + i" placeholder="Honors, coursework, activities…"></textarea>
                        </label>
                      </div>
                    }
                    <button type="button" class="rm-add" (click)="addEducation()">
                      <mat-icon aria-hidden="true">add</mat-icon> Add education
                    </button>
                  </div>
                }
              </section>

              <!-- SKILLS -->
              <section class="rm-sec" [class.is-open]="open() === 'skills'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('skills')"
                        [attr.aria-expanded]="open() === 'skills'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Skills</span>
                    <span class="rm-sec__sub">{{ countLabel(draft().skills.length, 'skill') }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'skills') {
                  <div class="rm-sec__body">
                    <span class="rm-field__label">Comma or line separated</span>
                    <textarea class="rm-input rm-area" rows="4" name="skills"
                              [ngModel]="skillsText()" (ngModelChange)="setSkillsText($event)"
                              placeholder="TypeScript, Angular, Node.js, AWS"></textarea>
                    @if (draft().skills.length) {
                      <div class="rm-chips">
                        @for (s of draft().skills; track $index) { <span class="rm-chip">{{ s }}</span> }
                      </div>
                    }
                  </div>
                }
              </section>

              <!-- PROJECTS -->
              <section class="rm-sec" [class.is-open]="open() === 'projects'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('projects')"
                        [attr.aria-expanded]="open() === 'projects'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>rocket_launch</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Projects</span>
                    <span class="rm-sec__sub">{{ countLabel(draft().projects.length, 'project') }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'projects') {
                  <div class="rm-sec__body">
                    @for (pr of draft().projects; track $index; let i = $index) {
                      <div class="rm-entry">
                        <div class="rm-entry__bar">
                          <span class="rm-entry__n">{{ pr.name || ('Project ' + (i + 1)) }}</span>
                          <span class="rm-entry__tools">
                            <button type="button" class="rm-icon-btn" (click)="moveProject(i, -1)" [disabled]="i === 0" aria-label="Move up"><mat-icon aria-hidden="true">arrow_upward</mat-icon></button>
                            <button type="button" class="rm-icon-btn" (click)="moveProject(i, 1)" [disabled]="i === draft().projects.length - 1" aria-label="Move down"><mat-icon aria-hidden="true">arrow_downward</mat-icon></button>
                            <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeProject(i)" aria-label="Remove project"><mat-icon aria-hidden="true">delete_outline</mat-icon></button>
                          </span>
                        </div>
                        <label class="rm-field"><span class="rm-field__label">Name</span>
                          <input class="rm-input" type="text" [ngModel]="pr.name" (ngModelChange)="setProject(i, 'name', $event)" [name]="'p-n-' + i" autocomplete="off" />
                        </label>
                        <label class="rm-field"><span class="rm-field__label">Description</span>
                          <input class="rm-input" type="text" [ngModel]="pr.description" (ngModelChange)="setProject(i, 'description', $event)" [name]="'p-d-' + i" autocomplete="off" />
                        </label>
                        <label class="rm-field"><span class="rm-field__label">Link</span>
                          <input class="rm-input" type="url" inputmode="url" [ngModel]="pr.link" (ngModelChange)="setProject(i, 'link', $event)" [name]="'p-l-' + i" autocomplete="off" placeholder="https://…" />
                        </label>
                        <span class="rm-mini-title">Highlights</span>
                        @for (b of pr.bullets; track $index; let bi = $index) {
                          <div class="rm-bullet">
                            <textarea class="rm-input rm-bullet__txt" rows="2" [ngModel]="b" (ngModelChange)="setProjBullet(i, bi, $event)" [name]="'p-b-' + i + '-' + bi" placeholder="Built…"></textarea>
                            <div class="rm-bullet__tools">
                              <button type="button" class="rm-icon-btn" [disabled]="isRefining('proj-' + i + '-' + bi) || !b.trim()" (click)="improveProjBullet(i, bi)" aria-label="Improve bullet with AI">
                                <mat-icon class="rm-ai-ic" [class.rm-spin]="isRefining('proj-' + i + '-' + bi)" aria-hidden="true">{{ isRefining('proj-' + i + '-' + bi) ? 'progress_activity' : 'auto_awesome' }}</mat-icon>
                              </button>
                              <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeProjBullet(i, bi)" aria-label="Remove bullet"><mat-icon aria-hidden="true">remove_circle_outline</mat-icon></button>
                            </div>
                          </div>
                        }
                        <button type="button" class="rm-add rm-add--sm" (click)="addProjBullet(i)">
                          <mat-icon aria-hidden="true">add</mat-icon> Add highlight
                        </button>
                      </div>
                    }
                    <button type="button" class="rm-add" (click)="addProject()">
                      <mat-icon aria-hidden="true">add</mat-icon> Add a project
                    </button>
                  </div>
                }
              </section>

              <!-- CERTIFICATIONS -->
              <section class="rm-sec" [class.is-open]="open() === 'certifications'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('certifications')"
                        [attr.aria-expanded]="open() === 'certifications'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>verified</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Certifications</span>
                    <span class="rm-sec__sub">{{ countLabel(draft().certifications.length, 'certification') }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'certifications') {
                  <div class="rm-sec__body">
                    @for (ct of draft().certifications; track $index; let i = $index) {
                      <div class="rm-entry">
                        <div class="rm-entry__bar">
                          <span class="rm-entry__n">{{ ct.name || ('Certification ' + (i + 1)) }}</span>
                          <span class="rm-entry__tools">
                            <button type="button" class="rm-icon-btn rm-icon-btn--del" (click)="removeCertification(i)" aria-label="Remove certification"><mat-icon aria-hidden="true">delete_outline</mat-icon></button>
                          </span>
                        </div>
                        <label class="rm-field"><span class="rm-field__label">Name</span>
                          <input class="rm-input" type="text" [ngModel]="ct.name" (ngModelChange)="setCertification(i, 'name', $event)" [name]="'ct-n-' + i" autocomplete="off" />
                        </label>
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Issuer</span>
                            <input class="rm-input" type="text" [ngModel]="ct.issuer" (ngModelChange)="setCertification(i, 'issuer', $event)" [name]="'ct-i-' + i" autocomplete="off" />
                          </label>
                          <label class="rm-field rm-field--sm"><span class="rm-field__label">Date</span>
                            <input class="rm-input" type="text" [ngModel]="ct.date" (ngModelChange)="setCertification(i, 'date', $event)" [name]="'ct-da-' + i" autocomplete="off" />
                          </label>
                        </div>
                      </div>
                    }
                    <button type="button" class="rm-add" (click)="addCertification()">
                      <mat-icon aria-hidden="true">add</mat-icon> Add certification
                    </button>
                  </div>
                }
              </section>

              <!-- HEADSHOT -->
              <section class="rm-sec" [class.is-open]="open() === 'headshot'">
                <button type="button" class="rm-sec__head" (click)="toggleSection('headshot')"
                        [attr.aria-expanded]="open() === 'headshot'">
                  <span class="rm-sec__ic" aria-hidden="true"><mat-icon>account_circle</mat-icon></span>
                  <span class="rm-sec__titles">
                    <span class="rm-sec__title">Headshot</span>
                    <span class="rm-sec__sub">{{ master()?.hasHeadshot ? 'Used in the “Designed” export' : 'Optional — for the Designed export' }}</span>
                  </span>
                  <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                </button>
                @if (open() === 'headshot') {
                  <div class="rm-sec__body rm-headshot">
                    <div class="rm-headshot__preview" [class.is-empty]="!headshotUrl()">
                      @if (headshotUrl(); as url) {
                        <img [src]="url" alt="Your headshot" />
                      } @else {
                        <mat-icon aria-hidden="true">person</mat-icon>
                      }
                    </div>
                    <div class="rm-headshot__actions">
                      <button type="button" class="rm-add rm-add--sm" [disabled]="headshotBusy()" (click)="headshotInput.click()">
                        @if (headshotBusy()) { <mat-icon class="rm-spin" aria-hidden="true">progress_activity</mat-icon> Working… }
                        @else { <mat-icon aria-hidden="true">upload</mat-icon> {{ master()?.hasHeadshot ? 'Replace' : 'Upload' }} }
                      </button>
                      @if (master()?.hasHeadshot) {
                        <button type="button" class="rm-add rm-add--sm rm-add--del" [disabled]="headshotBusy()" (click)="removeHeadshot()">
                          <mat-icon aria-hidden="true">delete_outline</mat-icon> Remove
                        </button>
                      }
                    </div>
                  </div>
                }
              </section>

              <!-- TITLE + SHARE + DELETE -->
              <section class="rm-sec rm-sec--meta is-open">
                <div class="rm-sec__body">
                  <label class="rm-field"><span class="rm-field__label">Resume title</span>
                    <input class="rm-input" type="text" [ngModel]="title()" (ngModelChange)="title.set($event)" name="r-title" placeholder="My Resume" maxlength="120" autocomplete="off" />
                  </label>
                  <button type="button" class="rm-check" [class.is-on]="shareWithContacts()" (click)="shareWithContacts.set(!shareWithContacts())">
                    <span class="rm-check__box" aria-hidden="true"><mat-icon>{{ shareWithContacts() ? 'check_box' : 'check_box_outline_blank' }}</mat-icon></span>
                    Share read-only with my contacts
                  </button>
                  <button type="button" class="rm-danger" (click)="deleteMaster()">
                    <mat-icon aria-hidden="true">delete_forever</mat-icon> Delete resume &amp; applications
                  </button>
                </div>
              </section>
            </div>

            <div class="rm-savebar-spacer" aria-hidden="true"></div>

          } @else if (tab() === 'preview') {
            <!-- ── LIVE PREVIEW (mirrors the desktop pv__* layout off draft()) ── -->
            @if (previewHasContent()) {
              <div class="rm-pv-wrap">
                <div class="pv" [class.pv--designed]="!!headshotUrl()">
                  <header class="pv__head">
                    @if (headshotUrl(); as url) {
                      <img class="pv__photo" [src]="url" alt="" width="76" height="76" loading="lazy" />
                    }
                    <div class="pv__id">
                      <h2 class="pv__name">{{ draft().contact.fullName || 'Your Name' }}</h2>
                      @if (draft().contact.headline) { <p class="pv__headline">{{ draft().contact.headline }}</p> }
                      <p class="pv__contact">
                        @if (draft().contact.email) { <span>{{ draft().contact.email }}</span> }
                        @if (draft().contact.phone) { <span>{{ draft().contact.phone }}</span> }
                        @if (draft().contact.location) { <span>{{ draft().contact.location }}</span> }
                      </p>
                      @if (draft().contact.links.length) {
                        <p class="pv__links">
                          @for (lnk of draft().contact.links; track $index) {
                            @if (lnk.url || lnk.label) { <span>{{ lnk.label || lnk.url }}</span> }
                          }
                        </p>
                      }
                    </div>
                  </header>

                  @if (draft().summary) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Summary</h3>
                      <p class="pv__text">{{ draft().summary }}</p>
                    </section>
                  }

                  @if (draft().experience.length) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Experience</h3>
                      @for (exp of draft().experience; track $index) {
                        <div class="pv__entry">
                          <div class="pv__entry-head">
                            <span class="pv__entry-title">{{ exp.title || 'Role' }}@if (exp.company) {<span class="pv__at"> · {{ exp.company }}</span>}</span>
                            <span class="pv__entry-date">{{ dateRange(exp.startDate, exp.endDate, exp.current) }}</span>
                          </div>
                          @if (exp.location) { <p class="pv__entry-sub">{{ exp.location }}</p> }
                          @if (exp.bullets.length) {
                            <ul class="pv__bullets">
                              @for (b of exp.bullets; track $index) { @if (b.trim()) { <li>{{ b }}</li> } }
                            </ul>
                          }
                        </div>
                      }
                    </section>
                  }

                  @if (draft().education.length) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Education</h3>
                      @for (edu of draft().education; track $index) {
                        <div class="pv__entry">
                          <div class="pv__entry-head">
                            <span class="pv__entry-title">{{ edu.degree || edu.school || 'Education' }}@if (edu.field) {<span class="pv__at"> · {{ edu.field }}</span>}</span>
                            <span class="pv__entry-date">{{ dateRange(edu.startDate, edu.endDate, false) }}</span>
                          </div>
                          @if (edu.school && edu.degree) { <p class="pv__entry-sub">{{ edu.school }}</p> }
                          @if (edu.location) { <p class="pv__entry-sub">{{ edu.location }}</p> }
                          @if (edu.details) { <p class="pv__entry-sub">{{ edu.details }}</p> }
                        </div>
                      }
                    </section>
                  }

                  @if (draft().skills.length) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Skills</h3>
                      <div class="pv__skills">
                        @for (s of draft().skills; track $index) { <span class="pv__skill">{{ s }}</span> }
                      </div>
                    </section>
                  }

                  @if (draft().projects.length) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Projects</h3>
                      @for (proj of draft().projects; track $index) {
                        <div class="pv__entry">
                          <span class="pv__entry-title">{{ proj.name || 'Project' }}</span>
                          @if (proj.description) { <p class="pv__entry-sub">{{ proj.description }}</p> }
                          @if (proj.bullets.length) {
                            <ul class="pv__bullets">
                              @for (b of proj.bullets; track $index) { @if (b.trim()) { <li>{{ b }}</li> } }
                            </ul>
                          }
                        </div>
                      }
                    </section>
                  }

                  @if (draft().certifications.length) {
                    <section class="pv__sec">
                      <h3 class="pv__sec-h">Certifications</h3>
                      @for (cert of draft().certifications; track $index) {
                        <p class="pv__cert">
                          {{ cert.name }}@if (cert.issuer) {<span class="pv__at"> · {{ cert.issuer }}</span>}@if (cert.date) {<span class="pv__entry-date"> {{ cert.date }}</span>}
                        </p>
                      }
                    </section>
                  }
                </div>
              </div>
            } @else {
              <div class="rm-empty">
                <span class="rm-empty__orb"><mat-icon aria-hidden="true">visibility</mat-icon></span>
                <h2 class="rm-empty__title">Nothing to preview yet</h2>
                <p class="rm-empty__body">Fill in a section in the Editor and it appears here, formatted like your export.</p>
              </div>
            }
            <div class="rm-savebar-spacer" aria-hidden="true"></div>

          } @else {
            <!-- ── APPLICATIONS ── -->
            @if (applications().length) {
              <div class="rm-apps">
                @for (app of applications(); track app.id) {
                  <div class="rm-app">
                    <button type="button" class="rm-app__head" (click)="toggleApp(app.id)"
                            [attr.aria-expanded]="openAppId() === app.id">
                      <span class="rm-app__ic" aria-hidden="true"><mat-icon>work_outline</mat-icon></span>
                      <span class="rm-app__titles">
                        <span class="rm-app__title">{{ app.jobTitle || 'Untitled role' }}</span>
                        <span class="rm-app__sub">{{ app.company || 'No company' }}</span>
                      </span>
                      <mat-icon class="rm-sec__chev" aria-hidden="true">expand_more</mat-icon>
                    </button>
                    @if (openAppId() === app.id) {
                      <div class="rm-app__body">
                        <div class="rm-row">
                          <label class="rm-field"><span class="rm-field__label">Job title</span>
                            <input class="rm-input" type="text" [ngModel]="app.jobTitle" (ngModelChange)="setAppJobTitle($event)" [name]="'a-jt-' + app.id" autocomplete="off" />
                          </label>
                          <label class="rm-field"><span class="rm-field__label">Company</span>
                            <input class="rm-input" type="text" [ngModel]="app.company" (ngModelChange)="setAppCompany($event)" [name]="'a-co-' + app.id" autocomplete="off" />
                          </label>
                        </div>

                        <span class="rm-mini-title">Cover letter</span>
                        <textarea class="rm-input rm-area" rows="6" [ngModel]="app.coverLetter" (ngModelChange)="setAppCoverLetter($event)" [name]="'a-cl-' + app.id" placeholder="Dear hiring manager…"></textarea>

                        <details class="rm-jd">
                          <summary class="rm-jd__summary">
                            <mat-icon aria-hidden="true">description</mat-icon>
                            <span>Pinned job description</span>
                            <mat-icon class="rm-jd__chev" aria-hidden="true">expand_more</mat-icon>
                          </summary>
                          <p class="rm-jd__text">{{ app.jobDescription || 'No job description saved.' }}</p>
                        </details>

                        <div class="rm-app__ai">
                          <button type="button" class="rm-ai" [disabled]="isAppBusy(app.id)" (click)="reTailor()">
                            @if (isAppBusy(app.id)) { <mat-icon class="rm-spin" aria-hidden="true">progress_activity</mat-icon> }
                            @else { <mat-icon aria-hidden="true">tune</mat-icon> }
                            Re-tailor
                          </button>
                          <button type="button" class="rm-ai" [disabled]="isAppBusy(app.id)" (click)="regenerateCover()">
                            <mat-icon aria-hidden="true">auto_awesome</mat-icon> New cover letter
                          </button>
                        </div>

                        <div class="rm-app__actions">
                          <button type="button" class="rm-btn rm-btn--ghost" [disabled]="isAppBusy(app.id)" (click)="openExport(app.id, app.jobTitle)">
                            <mat-icon aria-hidden="true">download</mat-icon> Export
                          </button>
                          <button type="button" class="rm-btn rm-btn--save" [disabled]="isAppBusy(app.id)" (click)="saveApplication()">
                            @if (isAppBusy(app.id)) { <span class="rm-spin-dot" aria-hidden="true"></span> Saving… }
                            @else { <mat-icon aria-hidden="true">check</mat-icon> Save }
                          </button>
                        </div>
                        <button type="button" class="rm-danger rm-danger--sm" [disabled]="isAppBusy(app.id)" (click)="deleteApplication(app)">
                          <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete application
                        </button>
                      </div>
                    }
                  </div>
                }
              </div>
            } @else {
              <div class="rm-empty">
                <span class="rm-empty__orb"><mat-icon aria-hidden="true">work_history</mat-icon></span>
                <h2 class="rm-empty__title">No tailored applications yet</h2>
                <p class="rm-empty__body">Tap the + to tailor your resume + a cover letter for a specific job.</p>
              </div>
            }
            <div class="rm-savebar-spacer" aria-hidden="true"></div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── EDITOR: floating AI assistant + sticky save bar ─── -->
    @if (!loading() && !errored() && hasMaster() && tab() === 'editor') {
      <app-bs-fab class="rm-editor-fab" icon="auto_awesome" label="AI assistant" [extended]="false" [fixed]="true" (action)="openChat()" />
      <div class="rm-savebar" [class.is-dirty]="dirty()">
        <button type="button" class="rm-savebar__export" (click)="openExport(null, '')">
          <mat-icon aria-hidden="true">download</mat-icon>
        </button>
        <span class="rm-savebar__hint">{{ dirty() ? 'Unsaved changes' : 'All changes saved' }}</span>
        <button type="button" class="rm-savebar__btn" [disabled]="!dirty() || saving()" (click)="save()">
          @if (saving()) { <mat-icon class="rm-spin" aria-hidden="true">progress_activity</mat-icon> Saving… }
          @else { <mat-icon aria-hidden="true">check</mat-icon> Save }
        </button>
      </div>
    }

    <!-- ─── APPLICATIONS: new-application FAB ─── -->
    @if (!loading() && !errored() && hasMaster() && tab() === 'apps') {
      <app-bs-fab icon="add" label="New application" [extended]="true" [fixed]="true" (action)="openNewApp()" />
    }

    <!-- ─── NEW-APPLICATION SHEET ─── -->
    <app-bs-sheet [(open)]="newAppOpen" detent="full" [dismissable]="!creatingApp()" label="New application">
      <form class="rm-form" (ngSubmit)="createApplication()">
        <div class="rm-form__head">
          <h3 class="rm-form__title">Tailor for a job</h3>
          <button type="button" class="rm-form__close" (click)="newAppOpen.set(false)" [disabled]="creatingApp()" aria-label="Cancel"><mat-icon aria-hidden="true">close</mat-icon></button>
        </div>
        <label class="rm-field"><span class="rm-field__label">Job title</span>
          <input class="rm-input" type="text" [ngModel]="naTitle()" (ngModelChange)="naTitle.set($event)" name="na-title" placeholder="Senior Engineer" autocomplete="off" />
        </label>
        <label class="rm-field"><span class="rm-field__label">Company</span>
          <input class="rm-input" type="text" [ngModel]="naCompany()" (ngModelChange)="naCompany.set($event)" name="na-company" placeholder="Acme Inc." autocomplete="off" />
        </label>
        <label class="rm-field"><span class="rm-field__label">Job description</span>
          <textarea class="rm-input rm-area" rows="8" [ngModel]="naJd()" (ngModelChange)="naJd.set($event)" name="na-jd" placeholder="Paste the job posting here — the AI tailors your resume to it."></textarea>
        </label>
        <div class="rm-app__actions">
          <button type="button" class="rm-btn rm-btn--ghost" (click)="newAppOpen.set(false)" [disabled]="creatingApp()">Cancel</button>
          <button type="submit" class="rm-btn rm-btn--save" [disabled]="creatingApp() || !naJd().trim()">
            @if (creatingApp()) { <span class="rm-spin-dot" aria-hidden="true"></span> Tailoring… }
            @else { <mat-icon aria-hidden="true">auto_awesome</mat-icon> Tailor &amp; create }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <!-- ─── EXPORT SHEET ─── -->
    <app-bs-sheet [(open)]="exportOpen" detent="half" [dismissable]="!exporting()" label="Export">
      <div class="rm-export">
        <div class="rm-form__head">
          <h3 class="rm-form__title">
            Export {{ exportTarget()?.appId != null ? (exportTarget()?.jobTitle || 'application') : 'master resume' }}
          </h3>
          <button type="button" class="rm-form__close" (click)="exportOpen.set(false)" [disabled]="exporting()" aria-label="Close"><mat-icon aria-hidden="true">close</mat-icon></button>
        </div>

        <span class="rm-mini-title">Resume</span>
        <div class="rm-export__grid">
          <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('resume', 'pdf', 'ats')"><mat-icon aria-hidden="true">picture_as_pdf</mat-icon><b>ATS PDF</b><i>Plain, parser-friendly</i></button>
          <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('resume', 'pdf', 'designed')"><mat-icon aria-hidden="true">auto_awesome</mat-icon><b>Designed PDF</b><i>Two-column, headshot</i></button>
          <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('resume', 'docx', 'ats')"><mat-icon aria-hidden="true">description</mat-icon><b>ATS DOCX</b><i>Editable Word</i></button>
          <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('resume', 'docx', 'designed')"><mat-icon aria-hidden="true">description</mat-icon><b>Designed DOCX</b><i>Styled Word</i></button>
        </div>

        @if (exportTarget()?.appId != null) {
          <span class="rm-mini-title">Cover letter</span>
          <div class="rm-export__grid">
            <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('cover', 'pdf', 'ats')"><mat-icon aria-hidden="true">picture_as_pdf</mat-icon><b>Cover PDF</b><i>One page</i></button>
            <button type="button" class="rm-export__btn" [disabled]="exporting()" (click)="doExport('cover', 'docx', 'ats')"><mat-icon aria-hidden="true">description</mat-icon><b>Cover DOCX</b><i>Editable Word</i></button>
          </div>
        }

        @if (exporting()) {
          <p class="rm-export__busy"><mat-icon class="rm-spin" aria-hidden="true">progress_activity</mat-icon> Preparing your download…</p>
        }
      </div>
    </app-bs-sheet>

    <!-- ─── AI ASSISTANT CHAT SHEET ─── -->
    <app-bs-sheet [(open)]="chatOpen" detent="full" label="AI assistant">
      <div class="rm-chat">
        <div class="rm-form__head">
          <h3 class="rm-form__title"><mat-icon class="rm-chat__spark" aria-hidden="true">auto_awesome</mat-icon> Assistant</h3>
          <span class="rm-chat__head-tools">
            @if (chatLog().length) {
              <button type="button" class="rm-chat__clear" (click)="clearChat()" [disabled]="chatBusy()">
                <mat-icon aria-hidden="true">delete_sweep</mat-icon> Clear
              </button>
            }
            <button type="button" class="rm-form__close" (click)="chatOpen.set(false)" aria-label="Close"><mat-icon aria-hidden="true">close</mat-icon></button>
          </span>
        </div>

        <div class="rm-chat__log">
          @if (!chatLog().length) {
            <div class="rm-chat__hint">
              <mat-icon aria-hidden="true">tips_and_updates</mat-icon>
              <p>Ask me to interview you, fill gaps, or sharpen a section. I can see your resume as context.</p>
              <div class="rm-chat__chips">
                @for (s of chatSuggestions; track $index) {
                  <button type="button" class="rm-chat__chip" [disabled]="chatBusy()" (click)="useChatSuggestion(s)">{{ s }}</button>
                }
              </div>
            </div>
          }
          @for (m of chatLog(); track $index) {
            <div class="rm-msg" [class.rm-msg--me]="m.role === 'user'">
              <span class="rm-msg__bubble">{{ m.content }}</span>
            </div>
          }
          @if (chatBusy()) {
            <div class="rm-msg"><span class="rm-msg__bubble rm-msg__bubble--typing"><span></span><span></span><span></span></span></div>
          }
        </div>

        <form class="rm-chat__bar" (ngSubmit)="sendChat()">
          <textarea class="rm-input rm-chat__input" rows="1" [ngModel]="chatInput()" (ngModelChange)="chatInput.set($event)"
                    name="chat-input" placeholder="Ask the assistant…" [disabled]="chatBusy()"></textarea>
          <button type="submit" class="rm-chat__send" [disabled]="chatBusy() || !chatInput().trim()" aria-label="Send">
            <mat-icon aria-hidden="true">arrow_upward</mat-icon>
          </button>
        </form>
      </div>
    </app-bs-sheet>

    <!-- hidden file inputs -->
    <input #uploadInput type="file" accept=".pdf,.docx,.doc,.txt,image/*,application/pdf" hidden (change)="onUploadFile($event)" />
    <input #headshotInput type="file" accept="image/*" hidden (change)="onHeadshotFile($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './resume-mobile.page.scss',
})
export class ResumeMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly master = signal<ResumeDto | null>(null);
  readonly applications = signal<ResumeApplicationDto[]>([]);

  /** The live, editable copy of the master's data (forked from the server, saved explicitly). */
  readonly draft = signal<ResumeData>(emptyResumeData());
  readonly title = signal('My Resume');
  readonly shareWithContacts = signal(false);

  /** The last-saved snapshot string; drives the dirty state. */
  private readonly savedSnapshot = signal('');
  readonly dirty = computed(
    () => this.savedSnapshot() !== this.snapshotOf(this.draft(), this.title(), this.shareWithContacts()),
  );

  readonly saving = signal(false);
  readonly parsing = signal(false);
  readonly creatingApp = signal(false);
  readonly exporting = signal(false);
  readonly headshotBusy = signal(false);
  readonly headshotUrl = signal<string | null>(null);

  /** Section keys currently running an AI refine (so only that control disables). */
  private readonly refiningSet = signal<Set<string>>(new Set());
  /** Per-application in-flight ids. */
  private readonly appBusy = signal<Set<number>>(new Set());

  readonly hasMaster = computed(() => this.master() !== null);

  /** Editor | Preview | Applications. */
  readonly tab = signal<'editor' | 'preview' | 'apps'>('editor');
  /** Which accordion section is open (single-open). */
  readonly open = signal<SectionKey | null>('contact');
  /** Which application is expanded. */
  readonly openAppId = signal<number | null>(null);

  // ---- sheets ----
  readonly newAppOpen = signal(false);
  readonly exportOpen = signal(false);
  readonly chatOpen = signal(false);
  readonly exportTarget = signal<ExportTarget | null>(null);

  // ---- new-application form ----
  readonly naTitle = signal('');
  readonly naCompany = signal('');
  readonly naJd = signal('');

  // ---- chat ----
  readonly chatLog = signal<ResumeChatMessage[]>([]);
  readonly chatInput = signal('');
  readonly chatBusy = signal(false);

  readonly skeletonCells = Array.from({ length: 5 }, (_, i) => i);
  readonly totalSections = 7;

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'editor', label: 'Editor' },
    { key: 'preview', label: 'Preview' },
    { key: 'apps', label: `Applications${this.applications().length ? ' · ' + this.applications().length : ''}` },
  ]);

  /** Starter prompts shown when the assistant conversation is empty (mirrors the desktop AI panel). */
  readonly chatSuggestions = [
    'Interview me to build my resume from scratch',
    'How can I make my summary stronger?',
    'What is missing from my experience section?',
    'Suggest skills for my target role',
  ];

  /** The current application being edited (the one expanded), or null. */
  readonly openApp = computed(() => this.applications().find((a) => a.id === this.openAppId()) ?? null);

  /** Skills as a comma-joined editable string. */
  readonly skillsText = computed(() => this.draft().skills.join(', '));

  /** How many of the 7 content sections have at least one filled entry. */
  readonly filledCount = computed(() => {
    const d = this.draft();
    let n = 0;
    if (d.contact.fullName.trim() || d.contact.email.trim()) n++;
    if (d.summary.trim()) n++;
    if (d.experience.length) n++;
    if (d.education.length) n++;
    if (d.skills.length) n++;
    if (d.projects.length) n++;
    if (d.certifications.length) n++;
    return n;
  });

  constructor() {
    void this.reload();
    this.destroyRef.onDestroy(() => {
      const u = this.headshotUrl();
      if (u) URL.revokeObjectURL(u);
    });
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const state: ResumeState = await firstValueFrom(this.api.resumeState());
      this.applyState(state);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Resume refreshed', { tone: 'success', durationMs: 1600 });
      }
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

  // ─────────────── NAV ───────────────

  setTab(key: string): void {
    this.tab.set(key === 'apps' ? 'apps' : key === 'preview' ? 'preview' : 'editor');
  }
  toggleSection(key: SectionKey): void { this.open.update((cur) => (cur === key ? null : key)); }
  toggleApp(id: number): void { this.openAppId.update((cur) => (cur === id ? null : id)); }

  // ─────────────── ONBOARDING ───────────────

  startBlank(): void {
    this.draft.set(emptyResumeData());
    this.title.set('My Resume');
    this.shareWithContacts.set(false);
    this.savedSnapshot.set('__new__');
    this.open.set('contact');
    void this.save();
  }

  startAi(): void {
    this.startBlank();
    setTimeout(() => this.openChat(), 250);
    this.toast.show('Ask the assistant to interview you.', { tone: 'neutral', durationMs: 3500 });
  }

  async onUploadFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      this.toast.show('That file is too large (max 12 MB).', { tone: 'warn' });
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
      this.open.set('contact');
      await this.save();
      this.toast.show('Imported — review each section.', { tone: 'success', durationMs: 3000 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.toast.show(
        status === 503 ? 'AI parsing is not configured. Start blank instead.' : "Couldn't read that file — try another.",
        { tone: 'warn' },
      );
    } finally {
      this.parsing.set(false);
    }
  }

  // ─────────────── MASTER SAVE / DELETE ───────────────

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
      this.toast.show('Resume saved', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't save — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  async deleteMaster(): Promise<void> {
    if (!this.master()) return;
    if (typeof confirm === 'function' && !confirm('Delete your resume and all tailored applications? This can\'t be undone.')) return;
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
      this.tab.set('editor');
      this.toast.show('Resume deleted', { tone: 'success', durationMs: 2200 });
    } catch {
      this.toast.show("Couldn't delete — try again", { tone: 'warn' });
    }
  }

  // ─────────────── DRAFT MUTATORS (mirror the live editor) ───────────────

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

  addExperience(): void { this.patch((d) => d.experience.unshift(emptyExperience())); }
  removeExperience(i: number): void { this.patch((d) => d.experience.splice(i, 1)); }
  moveExperience(i: number, delta: number): void { this.patch((d) => moveItem(d.experience, i, delta)); }
  setExperience<K extends keyof ResumeExperience>(i: number, key: K, v: ResumeExperience[K]): void {
    this.patch((d) => (d.experience[i][key] = v));
  }
  addExpBullet(i: number): void { this.patch((d) => d.experience[i].bullets.push('')); }
  removeExpBullet(i: number, b: number): void { this.patch((d) => d.experience[i].bullets.splice(b, 1)); }
  setExpBullet(i: number, b: number, v: string): void { this.patch((d) => (d.experience[i].bullets[b] = v)); }

  addEducation(): void { this.patch((d) => d.education.unshift(emptyEducation())); }
  removeEducation(i: number): void { this.patch((d) => d.education.splice(i, 1)); }
  moveEducation(i: number, delta: number): void { this.patch((d) => moveItem(d.education, i, delta)); }
  setEducation<K extends keyof ResumeEducation>(i: number, key: K, v: ResumeEducation[K]): void {
    this.patch((d) => (d.education[i][key] = v));
  }

  setSkillsText(v: string): void {
    const list = v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    this.patch((d) => (d.skills = list));
  }

  addProject(): void { this.patch((d) => d.projects.unshift(emptyProject())); }
  removeProject(i: number): void { this.patch((d) => d.projects.splice(i, 1)); }
  moveProject(i: number, delta: number): void { this.patch((d) => moveItem(d.projects, i, delta)); }
  setProject<K extends keyof ResumeProject>(i: number, key: K, v: ResumeProject[K]): void {
    this.patch((d) => (d.projects[i][key] = v));
  }
  addProjBullet(i: number): void { this.patch((d) => d.projects[i].bullets.push('')); }
  removeProjBullet(i: number, b: number): void { this.patch((d) => d.projects[i].bullets.splice(b, 1)); }
  setProjBullet(i: number, b: number, v: string): void { this.patch((d) => (d.projects[i].bullets[b] = v)); }

  addCertification(): void { this.patch((d) => d.certifications.unshift(emptyCertification())); }
  removeCertification(i: number): void { this.patch((d) => d.certifications.splice(i, 1)); }
  setCertification<K extends keyof ResumeCertification>(i: number, key: K, v: ResumeCertification[K]): void {
    this.patch((d) => (d.certifications[i][key] = v));
  }

  // ─────────────── PER-SECTION AI REFINE ───────────────

  isRefining(key: string): boolean { return this.refiningSet().has(key); }
  private setRefining(key: string, on: boolean): void {
    this.refiningSet.update((s) => {
      const next = new Set(s);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  private async refine(
    sectionKey: string, section: string, content: string, instruction: string,
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
        this.toast.show('Polished with AI', { tone: 'success', durationMs: 1800 });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.toast.show(status === 503 ? 'AI is not configured right now.' : "Couldn't refine — try again", { tone: 'warn' });
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

  // ─────────────── HEADSHOT ───────────────

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
    if (!file.type.startsWith('image/')) { this.toast.show('Please choose an image file.', { tone: 'warn' }); return; }
    if (file.size > 6 * 1024 * 1024) { this.toast.show('That image is too large (max 6 MB).', { tone: 'warn' }); return; }
    this.headshotBusy.set(true);
    try {
      const base64 = await readFileAsBase64(file);
      await firstValueFrom(this.api.uploadResumeHeadshot({ imageBase64: base64, mime: file.type }));
      const m = this.master();
      if (m) this.master.set({ ...m, hasHeadshot: true });
      await this.refreshHeadshot();
      this.toast.show('Headshot saved — use it in the Designed export.', { tone: 'success', durationMs: 2600 });
    } catch {
      this.toast.show("Couldn't upload that image — try again", { tone: 'warn' });
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
      this.toast.show('Headshot removed', { tone: 'success', durationMs: 2000 });
    } catch {
      this.toast.show("Couldn't remove the headshot — try again", { tone: 'warn' });
    } finally {
      this.headshotBusy.set(false);
    }
  }

  // ─────────────── APPLICATIONS ───────────────

  isAppBusy(id: number): boolean { return this.appBusy().has(id); }
  private setAppBusy(id: number, on: boolean): void {
    this.appBusy.update((s) => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  openNewApp(): void {
    if (!this.master()) { this.toast.show('Save your master resume first.', { tone: 'neutral' }); return; }
    this.naTitle.set('');
    this.naCompany.set('');
    this.naJd.set('');
    this.newAppOpen.set(true);
  }

  async createApplication(): Promise<void> {
    if (this.creatingApp() || !this.naJd().trim()) return;
    this.creatingApp.set(true);
    try {
      const app = await firstValueFrom(this.api.createResumeApplication({
        jobTitle: this.naTitle().trim(),
        company: this.naCompany().trim(),
        jobDescription: this.naJd().trim(),
      }));
      this.applications.update((a) => [app, ...a]);
      this.newAppOpen.set(false);
      this.tab.set('apps');
      this.openAppId.set(app.id);
      this.toast.show(`Tailored for ${app.jobTitle || 'the role'}`, { tone: 'success', durationMs: 2600 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.toast.show(status === 503 ? 'AI is not configured — tailoring needs it.' : "Couldn't create that application — try again", { tone: 'warn' });
    } finally {
      this.creatingApp.set(false);
    }
  }

  private patchOpenApp(mut: (a: ResumeApplicationDto) => ResumeApplicationDto): void {
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
      const saved = await firstValueFrom(this.api.saveResumeApplication(app.id, {
        jobTitle: app.jobTitle, company: app.company, jobDescription: app.jobDescription,
        data: app.data, coverLetter: app.coverLetter,
      }));
      this.applications.update((apps) => apps.map((a) => (a.id === saved.id ? saved : a)));
      this.toast.show('Application saved', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't save the application — try again", { tone: 'warn' });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  async reTailor(): Promise<void> {
    const app = this.openApp();
    if (!app || this.isAppBusy(app.id)) return;
    this.setAppBusy(app.id, true);
    try {
      const res = await firstValueFrom(this.api.tailorResume({ jobDescription: app.jobDescription, data: app.data }));
      this.patchOpenApp((a) => ({ ...a, data: normalizeResumeData(res.data) }));
      this.toast.show('Re-tailored — review and save', { tone: 'success', durationMs: 2600 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.toast.show(status === 503 ? 'AI is not configured right now.' : "Couldn't re-tailor — try again", { tone: 'warn' });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  async regenerateCover(): Promise<void> {
    const app = this.openApp();
    if (!app || this.isAppBusy(app.id)) return;
    this.setAppBusy(app.id, true);
    try {
      const res = await firstValueFrom(this.api.resumeCoverLetter({
        jobTitle: app.jobTitle, company: app.company, jobDescription: app.jobDescription, data: app.data,
      }));
      this.patchOpenApp((a) => ({ ...a, coverLetter: res.coverLetter }));
      this.toast.show('Cover letter regenerated — review and save', { tone: 'success', durationMs: 2600 });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.toast.show(status === 503 ? 'AI is not configured right now.' : "Couldn't regenerate — try again", { tone: 'warn' });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  async deleteApplication(app: ResumeApplicationDto): Promise<void> {
    if (this.isAppBusy(app.id)) return;
    if (typeof confirm === 'function' && !confirm(`Delete the "${app.jobTitle || 'untitled'}" application?`)) return;
    this.setAppBusy(app.id, true);
    try {
      await firstValueFrom(this.api.deleteResumeApplication(app.id));
      this.applications.update((apps) => apps.filter((a) => a.id !== app.id));
      if (this.openAppId() === app.id) this.openAppId.set(null);
      this.toast.show('Application deleted', { tone: 'success', durationMs: 2000 });
    } catch {
      this.toast.show("Couldn't delete — try again", { tone: 'warn' });
    } finally {
      this.setAppBusy(app.id, false);
    }
  }

  // ─────────────── EXPORT ───────────────

  openExport(appId: number | null, jobTitle: string): void {
    this.exportTarget.set({ appId, jobTitle });
    this.exportOpen.set(true);
  }

  async doExport(kind: 'resume' | 'cover', format: ExportFormat, style: ExportStyle): Promise<void> {
    if (this.exporting()) return;
    const target = this.exportTarget();
    const appId = target?.appId ?? null;
    // Save the latest edits first so the server renders them.
    if (appId == null) { if (this.dirty()) await this.save(); }
    else { await this.saveApplicationById(appId); }
    this.exporting.set(true);
    try {
      const blob = await firstValueFrom(this.api.exportResume({
        source: appId != null ? 'application' : 'master',
        id: appId ?? null, kind, format, style,
      }));
      const namePart = (this.draft().contact.fullName || 'resume').replace(/[^\w.-]+/g, '_').toLowerCase();
      const label = kind === 'cover' ? 'cover-letter' : 'resume';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${namePart}-${label}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast.show('Your download is ready.', { tone: 'success', durationMs: 2200 });
      this.exportOpen.set(false);
    } catch {
      this.toast.show('Export failed — try again', { tone: 'warn' });
    } finally {
      this.exporting.set(false);
    }
  }

  private async saveApplicationById(id: number): Promise<void> {
    const app = this.applications().find((a) => a.id === id);
    if (!app) return;
    try {
      const saved = await firstValueFrom(this.api.saveResumeApplication(id, {
        jobTitle: app.jobTitle, company: app.company, jobDescription: app.jobDescription,
        data: app.data, coverLetter: app.coverLetter,
      }));
      this.applications.update((apps) => apps.map((a) => (a.id === saved.id ? saved : a)));
    } catch {
      /* best-effort — export still proceeds against last-saved state */
    }
  }

  // ─────────────── AI CHAT ───────────────

  openChat(): void { this.chatOpen.set(true); }

  /** Send one of the empty-state starter prompts. */
  useChatSuggestion(text: string): void {
    if (this.chatBusy()) return;
    this.chatInput.set(text);
    void this.sendChat();
  }

  /** Wipe the assistant conversation back to the empty state. */
  clearChat(): void {
    if (this.chatBusy()) return;
    this.chatLog.set([]);
    this.chatInput.set('');
  }

  async sendChat(): Promise<void> {
    const text = this.chatInput().trim();
    if (!text || this.chatBusy()) return;
    const history = [...this.chatLog(), { role: 'user', content: text }];
    this.chatLog.set(history);
    this.chatInput.set('');
    this.chatBusy.set(true);
    try {
      const res = await firstValueFrom(this.api.resumeChat({ messages: history, data: this.draft() }));
      this.chatLog.update((log) => [...log, { role: 'assistant', content: res.reply }]);
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.chatLog.update((log) => [...log, {
        role: 'assistant',
        content: status === 503 ? 'The AI assistant is not configured right now.' : "Sorry, I couldn't respond — try again.",
      }]);
    } finally {
      this.chatBusy.set(false);
    }
  }

  // ─────────────── PRESENTATION HELPERS ───────────────

  truncate(v: string, max = 48): string {
    const s = v.trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  countLabel(n: number, singular: string, plural = singular + 's'): string {
    return n ? `${n} ${n === 1 ? singular : plural}` : `No ${plural} yet`;
  }

  /** A flat, human label for a date range ("Jun 2021 – Present"); mirrors the live preview. */
  dateRange(start: string, end: string, current: boolean): string {
    const e = current ? 'Present' : end;
    if (start && e) return `${start} – ${e}`;
    return start || e || '';
  }

  /** True when the draft has any renderable content (drives the preview empty state). */
  readonly previewHasContent = computed(() => {
    const d = this.draft();
    return !!(
      d.contact.fullName.trim() || d.contact.headline.trim() || d.summary.trim() ||
      d.experience.length || d.education.length || d.skills.length ||
      d.projects.length || d.certifications.length
    );
  });
}
