import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { UnitService } from '../../core/unit.service';
import { TrackerStore } from '../../core/tracker-store';
import {
  ActivityLevel,
  DietPattern,
  EatingWindow,
  GoalPlanDto,
  LifeStage,
  PERM,
  ProteinBasis,
  Sex,
  TrackerProfileDto,
  TrainingType,
  UnitSystem,
} from '../../core/models';
import { StatsInputs, ageFrom, computeStats } from '../tracker/units';
import { OnboardingCard, OnboardingResult } from '../tracker/onboarding-card';
import {
  BetaAccordion, BetaAccordionItem, BetaBottomSheet, BetaChip, BetaChipGroup, BetaEmptyState,
  BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile, BetaSuccess, BetaToaster,
  ToastController, type Segment,
} from '../beta-ui';

const GOALS: { value: string; label: string; icon: string }[] = [
  { value: 'LoseWeight', label: 'Lose weight', icon: 'trending_down' },
  { value: 'Maintain', label: 'Maintain', icon: 'remove' },
  { value: 'GainMuscle', label: 'Gain muscle', icon: 'fitness_center' },
  { value: 'Endurance', label: 'Endurance', icon: 'directions_run' },
];

const SEXES: { value: Sex; label: string }[] = [
  { value: 'Unspecified', label: 'Prefer not to say' },
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

const ACTIVITY_LEVELS: { value: ActivityLevel; label: string }[] = [
  { value: 'Sedentary', label: 'Sedentary' },
  { value: 'Light', label: 'Light (1–3 days/wk)' },
  { value: 'Moderate', label: 'Moderate (3–5 days/wk)' },
  { value: 'Active', label: 'Active (6–7 days/wk)' },
  { value: 'VeryActive', label: 'Very active' },
];

const DIET_PATTERNS: { value: DietPattern; label: string }[] = [
  { value: 'Balanced', label: 'Balanced' },
  { value: 'HighProtein', label: 'High protein' },
  { value: 'LowCarb', label: 'Low carb' },
  { value: 'Keto', label: 'Keto' },
  { value: 'Vegetarian', label: 'Vegetarian' },
  { value: 'Vegan', label: 'Vegan' },
  { value: 'Mediterranean', label: 'Mediterranean' },
  { value: 'Paleo', label: 'Paleo' },
];

const TRAINING_TYPES: { value: TrainingType; label: string }[] = [
  { value: 'None', label: 'None' },
  { value: 'Strength', label: 'Strength' },
  { value: 'Endurance', label: 'Endurance' },
  { value: 'Hybrid', label: 'Hybrid' },
];

const EATING_WINDOWS: { value: EatingWindow; label: string }[] = [
  { value: 'None', label: 'No fasting' },
  { value: 'W16x8', label: '16:8' },
  { value: 'W18x6', label: '18:6' },
  { value: 'OMAD', label: 'OMAD' },
];

/** Weight drift (kg) past which the check-in banner suggests a recompute. */
const CHECKIN_DRIFT_KG = 1.5;
/** Baseline staleness (days) past which the check-in banner suggests a recompute. */
const CHECKIN_STALE_DAYS = 90;

/**
 * Tracker Profile "My Plan" — the MOBILE twin of the live `/tracker/profile` page (route owned by the
 * platform split: phones with `platform.mobile` render this; desktop keeps {@link ProfilePage}). A goal-
 * focused, native-feel re-presentation of the SAME "My Profile & Goal" surface:
 *
 *  1. The VERBATIM first-run onboarding gate — when the baseline is incomplete (current weight, height,
 *     DOB, explicit sex) it renders the same blocking {@link OnboardingCard} the live page uses, persists
 *     through the {@link TrackerStore}, and seeds today's weigh-in. (Same predicate, same store calls.)
 *  2. A goal builder — goal chips + the body-profile fields (weight / height / DOB / sex / activity) +
 *     calorie + macro targets, with a LIVE Estimated-TDEE preview ({@link computeStats}, the exact TS twin
 *     of the backend TrackerStats.Compute the live page reads) surfaced as kit {@link BetaStatTile}s, and
 *     a one-tap "Use suggested" to fill the targets. Optional AI affordances are gated by `tracker.ai`.
 *  3. Dated PLAN HISTORY — the read-only newest-first {@link GoalPlanDto} list from `Api.goalPlans`, top
 *     row badged "Active today", each tap-expandable into a kit {@link BetaBottomSheet} of its snapshot.
 *
 * DATA PARITY + ISOLATION: every figure comes from the SAME endpoints the live page uses
 * (`Api.trackerProfile`, `Api.goalPlans`, the AI `Api.suggestGoal` / `Api.naturalGoal`) and saves through
 * the SAME `TrackerStore.saveProfile`; the preview reuses the SAME `computeStats` + `UnitService` rate/
 * weight seams, so the number agrees with the desktop page exactly. No live page is imported or modified;
 * the only shared imports are the kit + the tracker's own Api/models/store/units/onboarding card. Mobile-
 * first (44px targets, safe-area insets), degrades gracefully (skeletons, empty + error states) and
 * renders cleanly with zero data (the screenshot harness mocks the API).
 */
@Component({
  selector: 'app-tracker-profile-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile, BetaBottomSheet, BetaToaster,
    BetaEmptyState, BetaAccordion, BetaAccordionItem, BetaChip, BetaChipGroup, BetaSuccess,
    OnboardingCard,
  ],
  template: `
    <app-bs-pull-refresh class="pm-ptr" [busy]="refreshing()" [disabled]="needsBaseline()" (refresh)="reload()">
      <div class="pm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="pm-hero">
          <p class="pm-hero__kicker"><mat-icon aria-hidden="true">flag</mat-icon> My Plan</p>
          <h1 class="pm-hero__title">Profile &amp; Goal</h1>
          @if (!loading()) {
            <p class="pm-hero__sub">{{ heroSub() }}</p>
          }
        </header>

        @if (baselineDone()) {
          <!-- BRIEF COMPLETION CONFIRMATION (after the blocking onboarding baseline saves) -->
          <app-bs-success
            icon="celebration" tone="success"
            title="You're all set"
            body="Your baseline is saved. Let's dial in your goal and daily targets."
            primaryLabel="Build my plan" primaryIcon="arrow_forward"
            (primary)="baselineDone.set(false)" />

        } @else if (loading()) {
          <!-- SKELETON -->
          <div class="pm-skel">
            <app-bs-skeleton height="132px" radius="var(--r-card)" />
            <app-bs-skeleton height="180px" radius="var(--r-card)" />
            <app-bs-skeleton height="120px" radius="var(--r-card)" />
          </div>

        } @else if (needsBaseline()) {
          <!-- BLOCKING ONBOARDING GATE (same card the live page uses) -->
          <div class="pm-onboard">
            <app-tracker-onboarding
              [profile]="onboardingSeed()" [saving]="savingBaseline()"
              (completed)="onBaselineComplete($event)" />
          </div>

        } @else {

          <!-- ─── LIVE TDEE PREVIEW ─── -->
          <section class="pm-card pm-preview">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">local_fire_department</mat-icon> Estimate</span>
              <span class="pm-conf" [attr.data-c]="confidence()">{{ confidenceLabel() }}</span>
            </div>
            <div class="pm-tiles">
              <app-bs-stat-tile label="Est. TDEE" unit="kcal/day" [value]="fmtNum(preview().tdee)" />
              <app-bs-stat-tile label="BMR" unit="kcal" [value]="fmtNum(preview().bmr)" />
              <app-bs-stat-tile label="BMI" [value]="fmtNum(preview().bmi)" [unit]="preview().bmiCategory || ''" />
              <app-bs-stat-tile label="Suggested" unit="kcal/day" [value]="fmtNum(preview().suggestedCalorieGoal)" />
            </div>
            @if (preview().tdee == null) {
              <p class="pm-preview__hint">Fill in your weight, height, age &amp; sex below to see your estimate.</p>
            }
          </section>

          <!-- ─── CHECK-IN BANNER (weight drift / stale baseline → recompute) ─── -->
          @if (checkIn(); as ci) {
            <section class="pm-checkin" role="status">
              <mat-icon class="pm-checkin__ic" aria-hidden="true">event_available</mat-icon>
              <div class="pm-checkin__body">
                <p class="pm-checkin__msg">{{ ci.reason }}</p>
                <p class="pm-checkin__sub">Recompute your targets from your current numbers?</p>
              </div>
              <div class="pm-checkin__acts">
                <button type="button" class="pm-checkin__go" (click)="recomputeFromCheckIn()">Recompute</button>
                <button type="button" class="pm-checkin__x" (click)="checkInDismissed.set(true)" aria-label="Dismiss">
                  <mat-icon aria-hidden="true">close</mat-icon>
                </button>
              </div>
            </section>
          }

          <!-- ─── GOAL CHIPS ─── -->
          <section class="pm-card">
            <div class="pm-card__head"><span class="pm-card__title"><mat-icon aria-hidden="true">my_location</mat-icon> Goal</span></div>
            <div class="pm-goals" role="radiogroup" aria-label="Goal">
              @for (g of goals; track g.value) {
                <button type="button" class="pm-goal" role="radio"
                        [class.is-on]="goal() === g.value" [attr.aria-checked]="goal() === g.value"
                        (click)="goal.set(g.value)">
                  <mat-icon aria-hidden="true">{{ g.icon }}</mat-icon>
                  <span>{{ g.label }}</span>
                </button>
              }
            </div>
          </section>

          <!-- ─── BODY PROFILE ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">accessibility_new</mat-icon> About you</span>
              <app-bs-segmented class="pm-units" [segments]="unitSegments" [value]="unitSystem()"
                                label="Units" (change)="onUnitChange($any($event))" />
            </div>

            <div class="pm-fields">
              <!-- weight + goal weight -->
              <div class="pm-macros pm-macros--2">
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Current weight</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="decimal" [ngModel]="weightDisp()" (ngModelChange)="weightDisp.set($event)" placeholder="—" />
                    <span class="pm-field__suf">{{ weightUnit }}</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Goal weight</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="decimal" [ngModel]="goalWeightDisp()" (ngModelChange)="goalWeightDisp.set($event)" placeholder="—" />
                    <span class="pm-field__suf">{{ weightUnit }}</span>
                  </span>
                </label>
              </div>

              <!-- height -->
              @if (imperial()) {
                <div class="pm-field pm-field--split">
                  <span class="pm-field__lbl">Height</span>
                  <span class="pm-field__pair">
                    <span class="pm-field__in">
                      <input type="number" inputmode="numeric" [ngModel]="heightFt()" (ngModelChange)="heightFt.set($event)" placeholder="—" />
                      <span class="pm-field__suf">ft</span>
                    </span>
                    <span class="pm-field__in">
                      <input type="number" inputmode="numeric" [ngModel]="heightIn()" (ngModelChange)="heightIn.set($event)" placeholder="—" />
                      <span class="pm-field__suf">in</span>
                    </span>
                  </span>
                </div>
              } @else {
                <label class="pm-field">
                  <span class="pm-field__lbl">Height</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="heightCm()" (ngModelChange)="heightCm.set($event)" placeholder="—" />
                    <span class="pm-field__suf">cm</span>
                  </span>
                </label>
              }

              <!-- DOB -->
              <label class="pm-field">
                <span class="pm-field__lbl">Date of birth</span>
                <span class="pm-field__in">
                  <input type="date" [max]="todayIso" [ngModel]="dateOfBirth()" (ngModelChange)="dateOfBirth.set($event || null)" />
                </span>
              </label>

              <!-- sex -->
              <label class="pm-field">
                <span class="pm-field__lbl">Sex</span>
                <span class="pm-field__in pm-field__in--select">
                  <select [ngModel]="sex()" (ngModelChange)="sex.set($event)">
                    @for (s of sexes; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
                  </select>
                </span>
              </label>

              <!-- activity -->
              <label class="pm-field">
                <span class="pm-field__lbl">Activity level</span>
                <span class="pm-field__in pm-field__in--select">
                  <select [ngModel]="activityLevel()" (ngModelChange)="activityLevel.set($event)">
                    @for (a of activityLevels; track a.value) { <option [value]="a.value">{{ a.label }}</option> }
                  </select>
                </span>
              </label>
            </div>
          </section>

          <!-- ─── TARGETS ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">restaurant</mat-icon> Daily targets</span>
              @if (hasSuggestion()) {
                <button type="button" class="pm-mini" (click)="useSuggested()">
                  <mat-icon aria-hidden="true">auto_awesome</mat-icon> Use suggested
                </button>
              }
            </div>

            <div class="pm-fields">
              <label class="pm-field">
                <span class="pm-field__lbl">Calories</span>
                <span class="pm-field__in">
                  <input type="number" inputmode="numeric" [ngModel]="dailyCalorieGoal()" (ngModelChange)="dailyCalorieGoal.set($event)" placeholder="—" />
                  <span class="pm-field__suf">kcal</span>
                </span>
              </label>
              <div class="pm-macros">
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Protein</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="proteinGoalG()" (ngModelChange)="proteinGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Carbs</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="carbGoalG()" (ngModelChange)="carbGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Fat</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="fatGoalG()" (ngModelChange)="fatGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
              </div>

              <!-- hydration / steps / coffee -->
              <div class="pm-macros pm-macros--3">
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Hydration</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="hydrationGoalDisp()" (ngModelChange)="hydrationGoalDisp.set($event)" [placeholder]="hydrationDefaultHint" />
                    <span class="pm-field__suf">{{ volumeUnit }}</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Steps</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="stepGoal()" (ngModelChange)="stepGoal.set($event)" placeholder="10000" />
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Coffee</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="coffeeGoalCups()" (ngModelChange)="coffeeGoalCups.set($event)" placeholder="3" />
                    <span class="pm-field__suf">cups</span>
                  </span>
                </label>
              </div>

              <!-- share with contacts -->
              <button type="button" class="pm-toggle" role="switch" [attr.aria-checked]="shareWithContacts()"
                      (click)="shareWithContacts.set(!shareWithContacts())">
                <span class="pm-toggle__txt">
                  <span class="pm-toggle__lbl">Share progress with contacts</span>
                  <span class="pm-toggle__sub">Let contacts you share with see your tracker summary.</span>
                </span>
                <span class="pm-toggle__sw" [class.is-on]="shareWithContacts()" aria-hidden="true"><i></i></span>
              </button>
            </div>

            @if (showAi()) {
              <div class="pm-ai">
                <!-- Describe your goal (free-text → naturalGoal prefill) -->
                <label class="pm-field pm-ai__describe">
                  <span class="pm-field__lbl">Describe your goal</span>
                  <span class="pm-field__in">
                    <input type="text" [ngModel]="goalText()" (ngModelChange)="goalText.set($event)"
                           placeholder="e.g. lose 10 lbs in 3 months" />
                  </span>
                </label>
                <div class="pm-ai__row">
                  <button type="button" class="pm-ai__btn" [disabled]="!canDescribeGoal()" (click)="describeGoalWithAi()">
                    @if (goalLoading()) { <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Reading… }
                    @else { <mat-icon aria-hidden="true">bolt</mat-icon> Set from description }
                  </button>
                  <button type="button" class="pm-ai__btn" [disabled]="aiLoading()" (click)="suggestWithAi()">
                    @if (aiLoading()) { <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Thinking… }
                    @else { <mat-icon aria-hidden="true">auto_awesome</mat-icon> Suggest with AI }
                  </button>
                </div>

                @if (goalTimeline() || goalRealistic() !== null || goalRationale()) {
                  <div class="pm-ai__chips">
                    @if (goalTimeline(); as t) { <span class="pm-ai__chip"><mat-icon aria-hidden="true">schedule</mat-icon>{{ t }}</span> }
                    @if (goalRealistic() !== null) {
                      <span class="pm-ai__chip" [attr.data-ok]="goalRealistic()">
                        <mat-icon aria-hidden="true">{{ goalRealistic() ? 'check_circle' : 'warning' }}</mat-icon>
                        {{ goalRealistic() ? 'Realistic timeline' : 'May be aggressive' }}
                      </span>
                    }
                  </div>
                  @if (goalRationale(); as gr) { <p class="pm-ai__why">{{ gr }}</p> }
                }

                @if (aiRationale(); as r) { <p class="pm-ai__why">{{ r }}</p> }
                @if (aiSafety(); as s) { <p class="pm-ai__safety"><mat-icon aria-hidden="true">info</mat-icon> {{ s }}</p> }
              </div>
            }
          </section>

          <!-- ─── FINE-TUNE (optional refinements) ─── -->
          <section class="pm-card pm-fine">
            <button type="button" class="pm-fine__head" [attr.aria-expanded]="refineOpen()" (click)="refineOpen.set(!refineOpen())">
              <span class="pm-card__title"><mat-icon aria-hidden="true">tune</mat-icon> Fine-tune</span>
              @if (dietSummary().length) {
                <span class="pm-fine__tags">
                  @for (t of dietSummary(); track t) { <span class="pm-fine__tag">{{ t }}</span> }
                </span>
              }
              <mat-icon class="pm-fine__chev" [class.is-open]="refineOpen()" aria-hidden="true">expand_more</mat-icon>
            </button>

            @if (refineOpen()) {
              <div class="pm-fine__body">
                <app-bs-accordion [single]="true">

                  <!-- PACE & COMPOSITION -->
                  <app-bs-accordion-item label="Pace &amp; body composition">
                    <div class="pm-fields">
                      <!-- weekly pace -->
                      <label class="pm-field">
                        <span class="pm-field__lbl">Weekly pace (− lose / + gain)</span>
                        <span class="pm-field__in">
                          <input type="number" inputmode="decimal" [step]="rateStep" [ngModel]="weeklyRateDisp()" (ngModelChange)="weeklyRateDisp.set($event)" placeholder="Auto" />
                          <span class="pm-field__suf">{{ rateUnit }}</span>
                        </span>
                      </label>

                      <!-- body fat + navy-tape estimate -->
                      <label class="pm-field">
                        <span class="pm-field__lbl">Body fat</span>
                        <span class="pm-field__in">
                          <input type="number" inputmode="decimal" [ngModel]="bodyFatPct()" (ngModelChange)="bodyFatPct.set($event)" placeholder="Optional" />
                          <span class="pm-field__suf">%</span>
                        </span>
                      </label>
                      <div class="pm-macros" [class.pm-macros--3]="sex() === 'Female'" [class.pm-macros--2]="sex() !== 'Female'">
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Neck</span>
                          <span class="pm-field__in">
                            <input type="number" inputmode="decimal" [ngModel]="neckDisp()" (ngModelChange)="neckDisp.set($event)" placeholder="—" />
                            <span class="pm-field__suf">{{ lengthUnit }}</span>
                          </span>
                        </label>
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Waist</span>
                          <span class="pm-field__in">
                            <input type="number" inputmode="decimal" [ngModel]="waistDisp()" (ngModelChange)="waistDisp.set($event)" placeholder="—" />
                            <span class="pm-field__suf">{{ lengthUnit }}</span>
                          </span>
                        </label>
                        @if (sex() === 'Female') {
                          <label class="pm-field pm-field--macro">
                            <span class="pm-field__lbl">Hip</span>
                            <span class="pm-field__in">
                              <input type="number" inputmode="decimal" [ngModel]="hipDisp()" (ngModelChange)="hipDisp.set($event)" placeholder="—" />
                              <span class="pm-field__suf">{{ lengthUnit }}</span>
                            </span>
                          </label>
                        }
                      </div>
                      @if (navyBodyFatPct(); as bf) {
                        <button type="button" class="pm-mini pm-fine__navy" (click)="applyNavyBodyFat()">
                          <mat-icon aria-hidden="true">straighten</mat-icon> Use tape estimate: {{ bf }}%
                        </button>
                      }
                    </div>
                  </app-bs-accordion-item>

                  <!-- DIET & TRAINING -->
                  <app-bs-accordion-item label="Diet &amp; training">
                    <div class="pm-fields">
                      <!-- diet pattern -->
                      <label class="pm-field">
                        <span class="pm-field__lbl">Diet pattern</span>
                        <span class="pm-field__in pm-field__in--select">
                          <select [ngModel]="dietPattern()" (ngModelChange)="dietPattern.set($event)">
                            @for (d of dietPatterns; track d.value) { <option [value]="d.value">{{ d.label }}</option> }
                          </select>
                        </span>
                      </label>

                      <!-- protein basis + training type -->
                      <div class="pm-macros pm-macros--2">
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Protein basis</span>
                          <span class="pm-field__in pm-field__in--select">
                            <select [ngModel]="proteinBasis()" (ngModelChange)="proteinBasis.set($event)">
                              @for (b of proteinBases; track b.value) { <option [value]="b.value">{{ b.label }}</option> }
                            </select>
                          </span>
                        </label>
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Training</span>
                          <span class="pm-field__in pm-field__in--select">
                            <select [ngModel]="trainingType()" (ngModelChange)="trainingType.set($event)">
                              @for (t of trainingTypes; track t.value) { <option [value]="t.value">{{ t.label }}</option> }
                            </select>
                          </span>
                        </label>
                      </div>
                    </div>
                  </app-bs-accordion-item>

                  <!-- MEALS & LIFE STAGE -->
                  <app-bs-accordion-item label="Meals &amp; life stage">
                    <div class="pm-fields">
                      <!-- life stage (+ trimester) -->
                      <div class="pm-macros" [class.pm-macros--2]="showTrimester()">
                        <label class="pm-field" [class.pm-field--macro]="showTrimester()">
                          <span class="pm-field__lbl">Life stage</span>
                          <span class="pm-field__in pm-field__in--select">
                            <select [ngModel]="lifeStage()" (ngModelChange)="lifeStage.set($event)">
                              @for (l of lifeStages; track l.value) { <option [value]="l.value">{{ l.label }}</option> }
                            </select>
                          </span>
                        </label>
                        @if (showTrimester()) {
                          <label class="pm-field pm-field--macro">
                            <span class="pm-field__lbl">Trimester</span>
                            <span class="pm-field__in">
                              <input type="number" inputmode="numeric" min="1" max="3" [ngModel]="trimester()" (ngModelChange)="trimester.set($event)" placeholder="1–3" />
                            </span>
                          </label>
                        }
                      </div>

                      <!-- meals per day + eating window -->
                      <div class="pm-macros pm-macros--2">
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Meals / day</span>
                          <span class="pm-field__in">
                            <input type="number" inputmode="numeric" min="1" max="8" [ngModel]="mealsPerDay()" (ngModelChange)="mealsPerDay.set($event)" placeholder="—" />
                          </span>
                        </label>
                        <label class="pm-field pm-field--macro">
                          <span class="pm-field__lbl">Eating window</span>
                          <span class="pm-field__in pm-field__in--select">
                            <select [ngModel]="eatingWindow()" (ngModelChange)="eatingWindow.set($event)">
                              @for (w of eatingWindows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
                            </select>
                          </span>
                        </label>
                      </div>
                    </div>
                  </app-bs-accordion-item>

                  <!-- ALLERGIES & RESTRICTIONS (chips) -->
                  <app-bs-accordion-item label="Allergies &amp; restrictions"
                                         [hint]="restrictionList().length ? (restrictionList().length + ' set') : ''">
                    <div class="pm-fields">
                      <label class="pm-field">
                        <span class="pm-field__lbl">Add a restriction</span>
                        <span class="pm-field__in">
                          <input type="text" [ngModel]="restrictionDraft()" (ngModelChange)="restrictionDraft.set($event)"
                                 (keydown.enter)="$event.preventDefault(); addRestriction()"
                                 placeholder="e.g. peanuts" />
                          <button type="button" class="pm-restrict__add" aria-label="Add restriction"
                                  [disabled]="!restrictionDraft().trim()" (click)="addRestriction()">
                            <mat-icon aria-hidden="true">add</mat-icon>
                          </button>
                        </span>
                      </label>

                      @if (restrictionList().length) {
                        <app-bs-chip-group label="Allergies and restrictions">
                          @for (r of restrictionList(); track r; let i = $index) {
                            <app-bs-chip [label]="r" icon="🚫" removable (removed)="removeRestriction(i)" />
                          }
                        </app-bs-chip-group>
                      }

                      <p class="pm-fine__note">Used only to constrain AI meal ideas — never a calorie input.</p>
                    </div>
                  </app-bs-accordion-item>

                </app-bs-accordion>
              </div>
            }
          </section>

          <!-- ─── PLAN HISTORY ─── -->
          <section class="pm-card pm-history">
            <div class="pm-card__head"><span class="pm-card__title"><mat-icon aria-hidden="true">history</mat-icon> Plan history</span></div>

            @if (plansLoading()) {
              <div class="pm-skel"><app-bs-skeleton height="64px" radius="var(--r-tile)" /><app-bs-skeleton height="64px" radius="var(--r-tile)" /></div>
            } @else if (!plans().length) {
              <app-bs-empty compact icon="event_note"
                title="No plan history yet"
                body="Your saved targets will appear here each time you update your plan." />
            } @else {
              <ul class="pm-plans">
                @for (p of plans(); track p.effectiveFrom; let i = $index) {
                  <li>
                    <button type="button" class="pm-plan" (click)="openPlan(p)">
                      <span class="pm-plan__orb" aria-hidden="true">
                        <mat-icon>{{ i === 0 ? 'flag' : 'history' }}</mat-icon>
                      </span>
                      <span class="pm-plan__main">
                        <span class="pm-plan__when">
                          {{ planEffectiveFrom(p.effectiveFrom) }}
                          @if (i === 0) { <span class="pm-plan__active">Active today</span> }
                        </span>
                        <span class="pm-plan__sub">
                          {{ goalLabel(p.goal) }}
                          @if (planRate(p.weeklyRateKg); as r) { · {{ r }} }
                          @if (p.dailyCalorieGoal != null) { · {{ p.dailyCalorieGoal }} kcal }
                        </span>
                      </span>
                      <mat-icon class="pm-plan__go" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <p class="pm-foot" aria-hidden="true">Estimate mirrors your tracker · Save to version a new plan</p>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── STICKY SAVE BAR (hidden during the onboarding gate + the completion confirmation) ─── -->
    @if (!loading() && !needsBaseline() && !baselineDone()) {
      <div class="pm-savebar">
        <button type="button" class="pm-back" (click)="backToTracker()" aria-label="Back to tracker">
          <mat-icon aria-hidden="true">arrow_back</mat-icon>
        </button>
        <button type="button" class="pm-save" [disabled]="saving()" (click)="save()">
          @if (saving()) { <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Saving… }
          @else { <mat-icon aria-hidden="true">check</mat-icon> Save plan }
        </button>
      </div>
    }

    <!-- ─── PLAN DETAIL SHEET ─── -->
    <app-bs-sheet [(open)]="sheetOpen" detent="half" [label]="'Plan detail'">
      @if (selectedPlan(); as p) {
        <div class="pmd">
          <div class="pmd__head">
            <span class="pmd__when">{{ planEffectiveFrom(p.effectiveFrom) }}</span>
            <span class="pmd__goal">{{ goalLabel(p.goal) }}</span>
          </div>
          <div class="pmd__grid">
            @if (planRate(p.weeklyRateKg); as r) { <div class="pmd__cell"><i>Pace</i><b>{{ r }}</b></div> }
            @if (p.dailyCalorieGoal != null) { <div class="pmd__cell"><i>Calories</i><b>{{ p.dailyCalorieGoal }} kcal</b></div> }
            @if (p.proteinGoalG != null) { <div class="pmd__cell"><i>Protein</i><b>{{ p.proteinGoalG }} g</b></div> }
            @if (p.carbGoalG != null) { <div class="pmd__cell"><i>Carbs</i><b>{{ p.carbGoalG }} g</b></div> }
            @if (p.fatGoalG != null) { <div class="pmd__cell"><i>Fat</i><b>{{ p.fatGoalG }} g</b></div> }
            @if (planWeight(p.weightKg); as w) { <div class="pmd__cell"><i>Weight</i><b>{{ w }}</b></div> }
            @if (p.bodyFatPct != null) { <div class="pmd__cell"><i>Body fat</i><b>{{ p.bodyFatPct }}%</b></div> }
            @if (activityLabel(p.activityLevel); as a) { <div class="pmd__cell"><i>Activity</i><b>{{ a }}</b></div> }
            @if (dietLabel(p.dietPattern); as d) { <div class="pmd__cell"><i>Diet</i><b>{{ d }}</b></div> }
          </div>
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './tracker-profile-mobile.page.scss',
})
export class TrackerProfileMobilePage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private units = inject(UnitService);
  private router = inject(Router);
  private store = inject(TrackerStore);
  private toast = inject(ToastController);

  /** Master gate: every AI affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = signal(this.auth.hasPermission(PERM.trackerAi));

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;
  readonly dietPatterns = DIET_PATTERNS;
  readonly trainingTypes = TRAINING_TYPES;
  readonly eatingWindows = EATING_WINDOWS;
  readonly lifeStages: { value: LifeStage; label: string }[] = [
    { value: 'None', label: 'None' },
    { value: 'Pregnant', label: 'Pregnant' },
    { value: 'Breastfeeding', label: 'Breastfeeding' },
  ];
  readonly proteinBases: { value: ProteinBasis; label: string }[] = [
    { value: 'PerBodyweight', label: 'Per bodyweight' },
    { value: 'PerLeanMass', label: 'Per lean mass' },
  ];
  readonly unitSegments: Segment[] = [
    { key: 'Imperial', label: 'lb / ft' },
    { key: 'Metric', label: 'kg / cm' },
  ];

  private readonly profile = signal<TrackerProfileDto | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly savingBaseline = signal(false);
  /** Brief full-screen confirmation shown once the blocking onboarding baseline is saved. */
  readonly baselineDone = signal(false);

  readonly plans = signal<GoalPlanDto[]>([]);
  readonly plansLoading = signal(false);

  // ---- plan detail sheet ----
  readonly sheetOpen = signal(false);
  readonly selectedPlan = signal<GoalPlanDto | null>(null);

  // ---- core goal/macro fields ----
  readonly goal = signal<string>('Maintain');
  readonly dailyCalorieGoal = signal<number | null>(null);
  readonly proteinGoalG = signal<number | null>(null);
  readonly carbGoalG = signal<number | null>(null);
  readonly fatGoalG = signal<number | null>(null);
  readonly stepGoal = signal<number | null>(null);
  readonly coffeeGoalCups = signal<number | null>(null);
  readonly shareWithContacts = signal<boolean>(false);

  // ---- body profile ----
  readonly dateOfBirth = signal<string | null>(null);
  readonly sex = signal<Sex>('Unspecified');
  readonly activityLevel = signal<ActivityLevel>('Sedentary');

  // ---- optional goal-builder refinements (the Fine-tune panel) ----
  /** Weekly pace held in the DISPLAYED rate unit (lb/wk or kg/wk); converted to canonical kg/wk on save. */
  readonly weeklyRateDisp = signal<number | null>(null);
  readonly bodyFatPct = signal<number | null>(null);
  readonly dietPattern = signal<DietPattern>('Balanced');
  readonly trainingType = signal<TrainingType>('None');
  readonly proteinBasis = signal<ProteinBasis>('PerBodyweight');
  readonly lifeStage = signal<LifeStage>('None');
  readonly trimester = signal<number | null>(null);
  readonly mealsPerDay = signal<number | null>(null);
  readonly eatingWindow = signal<EatingWindow>('None');
  /** Canonical restrictions field the save() serializes — a comma-string; the chip UI mutates only this. */
  readonly restrictions = signal<string | null>(null);
  /** In-flight text for the "add a restriction" input above the chip group. */
  readonly restrictionDraft = signal('');

  // ---- Navy-tape circumferences, held in the DISPLAYED unit (in or cm) ----
  readonly neckDisp = signal<number | null>(null);
  readonly waistDisp = signal<number | null>(null);
  readonly hipDisp = signal<number | null>(null);
  /** Whether the optional "Fine-tune" panel is expanded. */
  readonly refineOpen = signal(false);

  readonly unitSystem = this.units.unitSystem;
  readonly imperial = this.units.imperial;

  // ---- unit-aware body inputs (display units; converted to metric on save) ----
  readonly heightCm = signal<number | null>(null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  readonly weightDisp = signal<number | null>(null);
  readonly goalWeightDisp = signal<number | null>(null);
  readonly hydrationGoalDisp = signal<number | null>(null);

  // ---- AI suggestion ----
  readonly aiLoading = signal(false);
  readonly aiRationale = signal<string | null>(null);
  readonly aiSafety = signal<string | null>(null);

  // ---- AI natural-goal ("describe your goal" free-text) ----
  readonly goalText = signal('');
  readonly goalLoading = signal(false);
  readonly goalTimeline = signal<string | null>(null);
  readonly goalRealistic = signal<boolean | null>(null);
  readonly goalRationale = signal<string | null>(null);

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !!this.profile();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    try {
      const p = await firstValueFrom(this.api.trackerProfile());
      this.applyProfile(p);
    } catch {
      this.applyProfile(null);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
    if (!this.needsBaseline()) void this.loadPlans();
  }

  private async loadPlans(): Promise<void> {
    this.plansLoading.set(true);
    try {
      this.plans.set(await firstValueFrom(this.api.goalPlans()));
    } catch {
      this.plans.set([]);
    } finally {
      this.plansLoading.set(false);
    }
  }

  /** Seed every form signal + the app-wide unit preference from a loaded profile (or sensible defaults). */
  private applyProfile(p: TrackerProfileDto | null): void {
    this.profile.set(p);
    this.units.setLocal(p?.unitSystem ?? 'Imperial');

    this.goal.set(p?.goal || 'Maintain');
    this.dailyCalorieGoal.set(p?.dailyCalorieGoal ?? null);
    this.proteinGoalG.set(p?.proteinGoalG ?? null);
    this.carbGoalG.set(p?.carbGoalG ?? null);
    this.fatGoalG.set(p?.fatGoalG ?? null);
    this.stepGoal.set(p?.stepGoal ?? null);
    this.coffeeGoalCups.set(p?.coffeeGoalCups ?? null);
    this.shareWithContacts.set(p?.shareWithContacts ?? false);

    this.dateOfBirth.set(p?.dateOfBirth ?? null);
    this.sex.set(p?.sex ?? 'Unspecified');
    this.activityLevel.set(p?.activityLevel ?? 'Sedentary');

    this.weeklyRateDisp.set(this.toRateDisp(p?.weeklyRateKg));
    this.bodyFatPct.set(p?.bodyFatPct ?? null);
    this.dietPattern.set(p?.dietPattern ?? 'Balanced');
    this.trainingType.set(p?.trainingType ?? 'None');
    this.proteinBasis.set(p?.proteinBasis ?? 'PerBodyweight');
    this.lifeStage.set(p?.lifeStage ?? 'None');
    this.trimester.set(p?.trimester ?? null);
    this.mealsPerDay.set(p?.mealsPerDay ?? null);
    this.eatingWindow.set(p?.eatingWindow ?? 'None');
    this.restrictions.set(p?.restrictions ?? null);

    this.neckDisp.set(this.toLenDisp(p?.neckCm));
    this.waistDisp.set(this.toLenDisp(p?.waistCm));
    this.hipDisp.set(this.toLenDisp(p?.hipCm));

    this.heightCm.set(p?.heightCm ?? null);
    if (p?.heightCm != null) {
      const { ft, in: inches } = this.units.heightToFtIn(p.heightCm);
      this.heightFt.set(ft);
      this.heightIn.set(inches);
    } else {
      this.heightFt.set(null);
      this.heightIn.set(null);
    }
    this.weightDisp.set(this.toDisp(p?.weightKg));
    this.goalWeightDisp.set(this.toDisp(p?.goalWeightKg));
    this.hydrationGoalDisp.set(this.toVolDisp(p?.hydrationGoalMl));
  }

  // ─────────────── ONBOARDING GATE (verbatim predicate from the live page) ───────────────

  readonly needsBaseline = computed(() => {
    const p = this.profile();
    return p == null || p.weightKg == null || p.heightCm == null || !p.dateOfBirth || p.sex === 'Unspecified';
  });

  readonly onboardingSeed = computed<TrackerProfileDto | null>(() => this.profile());

  async onBaselineComplete(result: OnboardingResult): Promise<void> {
    if (this.savingBaseline()) return;
    this.savingBaseline.set(true);
    try {
      await this.store.saveProfile(result.profile);
      const today = this.store.date();
      const history = await this.store.weightHistory(7).catch(() => []);
      if (!history.some((w) => w.date === today)) {
        await this.store.logWeight({ date: today, weightKg: result.weightKg });
      }
      await this.reload();
      this.baselineDone.set(true);
    } catch {
      this.toast.show('Could not save your baseline', { tone: 'warn' });
    } finally {
      this.savingBaseline.set(false);
    }
  }

  // ─────────────── UNIT-AWARE HELPERS (mirror the live page) ───────────────

  get weightUnit(): string { return this.units.weightUnit(); }
  get volumeUnit(): string { return this.units.volumeUnit(); }
  get lengthUnit(): string { return this.units.lengthUnit(); }
  /** Weekly-pace suffix ('lb/wk' | 'kg/wk'). */
  get rateUnit(): string { return this.units.rateUnit(); }
  /** Sensible step for the weekly-pace input in the active unit (0.1 lb/wk, 0.05 kg/wk). */
  get rateStep(): number { return this.units.imperial() ? 0.1 : 0.05; }
  get hydrationDefaultHint(): string { return `~${this.units.formatVolume(2000)}`; }

  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    return Math.round(this.units.weightToDisplay(kg) * 10) / 10;
  }
  private toVolDisp(ml: number | null | undefined): number | null {
    if (ml == null) return null;
    return Math.round(this.units.volumeToDisplay(ml));
  }
  private toLenDisp(cm: number | null | undefined): number | null {
    if (cm == null) return null;
    return Math.round(this.units.lengthToDisplay(cm) * 10) / 10;
  }
  /** A canonical kg/wk pace as a DISPLAY value (lb/wk or kg/wk); null passes through. */
  private toRateDisp(kgPerWk: number | null | undefined): number | null {
    if (kgPerWk == null) return null;
    return Math.round(this.units.rateToDisplay(kgPerWk) * 100) / 100;
  }
  private toCm(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.lengthToCanonical(disp);
  }
  private currentHydrationGoalMl(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return Math.round(this.units.volumeToCanonical(disp));
  }
  /** A display pace (lb/wk or kg/wk) back to canonical kg/wk; null passes through (0 = no preference). */
  private currentWeeklyRateKg(disp: number | null): number | null {
    if (disp == null) return null;
    return Math.round(this.units.rateToCanonical(disp) * 1000) / 1000;
  }

  /** The canonical kg/wk pace from the in-flight display value — what the calc + save consume. */
  readonly weeklyRateKg = computed<number | null>(() => this.currentWeeklyRateKg(this.weeklyRateDisp()));

  private currentHeightCm(): number | null {
    if (this.imperial()) {
      const ft = this.heightFt(), inches = this.heightIn();
      if ((ft == null || ft <= 0) && (inches == null || inches <= 0)) return null;
      return this.units.heightFromFtIn(ft ?? 0, inches ?? 0);
    }
    const cm = this.heightCm();
    return cm != null && cm > 0 ? cm : null;
  }

  private currentWeightKg(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.weightToCanonical(disp);
  }

  /** Switch units — convert the in-flight display values so the body reads the same in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';
    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());
    const gKg = this.currentWeightKg(this.goalWeightDisp());
    const hydMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());
    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());
    const rateKg = this.currentWeeklyRateKg(this.weeklyRateDisp());

    this.units.setLocal(sys);

    if (cm != null) {
      if (toImperial) {
        const { ft, in: inches } = this.units.heightToFtIn(cm);
        this.heightFt.set(ft);
        this.heightIn.set(inches);
      } else {
        this.heightCm.set(Math.round(cm));
      }
    }
    this.weightDisp.set(this.toDisp(wKg));
    this.goalWeightDisp.set(this.toDisp(gKg));
    this.hydrationGoalDisp.set(this.toVolDisp(hydMl));
    this.neckDisp.set(this.toLenDisp(neckCm));
    this.waistDisp.set(this.toLenDisp(waistCm));
    this.hipDisp.set(this.toLenDisp(hipCm));
    this.weeklyRateDisp.set(this.toRateDisp(rateKg));
  }

  // ─────────────── LIVE PREVIEW (same computeStats the live page reads) ───────────────

  readonly statsInputs = computed<StatsInputs>(() => ({
    weightKg: this.currentWeightKg(this.weightDisp()),
    heightCm: this.currentHeightCm(),
    age: ageFrom(this.dateOfBirth(), new Date()),
    sex: this.sex(),
    activityLevel: this.activityLevel(),
    goal: this.goal(),
    dailyCalorieGoal: this.dailyCalorieGoal(),
    weeklyRateKg: this.weeklyRateKg(),
    bodyFatPct: this.bodyFatPct(),
    dietPattern: this.dietPattern(),
    trainingType: this.trainingType(),
    proteinBasis: this.proteinBasis(),
    lifeStage: this.lifeStage(),
    trimester: this.lifeStage() === 'Pregnant' ? this.trimester() : null,
  }));

  readonly preview = computed(() => computeStats(this.statsInputs()));
  readonly hasSuggestion = computed(() => this.preview().suggestedCalorieGoal != null);
  readonly showTrimester = computed(() => this.lifeStage() === 'Pregnant');

  readonly confidence = computed<'low' | 'med' | 'high'>(() => {
    const s = this.preview();
    if (s.tdee == null) return 'low';
    if (this.bodyFatPct() != null) return 'high';
    return 'med';
  });
  readonly confidenceLabel = computed(() => {
    switch (this.confidence()) {
      case 'high': return 'High confidence';
      case 'med': return 'Good estimate';
      default: return 'Rough estimate';
    }
  });

  readonly heroSub = computed(() => {
    if (this.needsBaseline()) return 'Set up your baseline to unlock your plan.';
    const tdee = this.preview().tdee;
    if (tdee != null) return `Burning ~${tdee.toLocaleString()} kcal/day at your activity level.`;
    return 'Dial in your goal and daily targets.';
  });

  /** A preview number for a tile, "—" when null. */
  fmtNum(n: number | null | undefined): string {
    return n == null ? '—' : String(n);
  }

  useSuggested(): void {
    const s = this.preview();
    if (s.suggestedCalorieGoal != null) this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
    if (s.suggestedProteinG != null) this.proteinGoalG.set(s.suggestedProteinG);
    if (s.suggestedCarbG != null) this.carbGoalG.set(s.suggestedCarbG);
    if (s.suggestedFatG != null) this.fatGoalG.set(s.suggestedFatG);
  }

  // ─────────────── NAVY-TAPE BODY FAT (mirror the live page) ───────────────

  readonly navyBodyFatPct = computed<number | null>(() => {
    const heightCm = this.currentHeightCm();
    const sex = this.sex();
    if (heightCm == null || heightCm <= 0 || sex === 'Unspecified') return null;
    const neck = this.toCm(this.neckDisp());
    const waist = this.toCm(this.waistDisp());
    if (neck == null || waist == null) return null;

    let pct: number;
    if (sex === 'Female') {
      const hip = this.toCm(this.hipDisp());
      if (hip == null) return null;
      const v = waist + hip - neck;
      if (v <= 0) return null;
      pct = 163.205 * Math.log10(v) - 97.684 * Math.log10(heightCm) - 78.387;
    } else {
      const v = waist - neck;
      if (v <= 0) return null;
      pct = 86.01 * Math.log10(v) - 70.041 * Math.log10(heightCm) + 36.76;
    }
    if (!Number.isFinite(pct)) return null;
    pct = Math.round(pct * 10) / 10;
    return pct > 0 && pct < 100 ? pct : null;
  });

  applyNavyBodyFat(): void {
    const bf = this.navyBodyFatPct();
    if (bf != null) this.bodyFatPct.set(bf);
  }

  // ─────────────── DIETARY RESTRICTIONS AS CHIPS (mutate only restrictions()) ───────────────

  /** The restrictions comma-string parsed into trimmed, non-empty tokens for chip rendering. */
  readonly restrictionList = computed<string[]>(() =>
    (this.restrictions() ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );

  /** Commit the draft as a new restriction chip (de-duped, case-insensitive); no-op when blank/dup. */
  addRestriction(): void {
    const raw = this.restrictionDraft().trim();
    if (!raw) return;
    const list = this.restrictionList();
    if (!list.some((t) => t.toLowerCase() === raw.toLowerCase())) {
      this.restrictions.set([...list, raw].join(', '));
    }
    this.restrictionDraft.set('');
  }

  /** Remove the restriction at the given index (from the × on its chip). */
  removeRestriction(index: number): void {
    const next = this.restrictionList().filter((_, i) => i !== index);
    this.restrictions.set(next.length ? next.join(', ') : null);
  }

  /** A compact read-only digest of what the AI meal recommenders are told (eating style · restrictions · pace). */
  readonly dietSummary = computed<string[]>(() => {
    const parts: string[] = [];
    const pat = this.dietPattern();
    if (pat && pat !== 'Balanced') parts.push(DIET_PATTERNS.find((d) => d.value === pat)?.label ?? pat);

    const raw = (this.restrictions() ?? '').trim();
    if (raw) {
      raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .forEach((t) => parts.push(`no ${t.toLowerCase()}`));
    }

    const rate = this.weeklyRateKg();
    if (rate != null && rate !== 0) {
      const dir = rate < 0 ? 'cutting' : 'gaining';
      const disp = this.units.formatWeight(Math.abs(rate), Math.abs(rate) < 1 ? 2 : 1);
      if (disp) parts.push(`${dir} ${disp}/wk`);
    }

    const win = this.eatingWindow();
    if (win && win !== 'None') parts.push(win === 'OMAD' ? 'OMAD' : win.replace('W', '').replace('x', ':'));
    return parts;
  });

  // ─────────────── NON-BLOCKING CHECK-IN BANNER (mirror the live page) ───────────────

  readonly checkInDismissed = signal(false);
  readonly checkIn = computed<{ reason: string } | null>(() => {
    if (this.checkInDismissed()) return null;
    const p = this.profile();
    if (!p) return null;
    const latestKg = p.weightKg;

    if (p.goalBasisWeightKg != null && latestKg != null) {
      const drift = Math.abs(latestKg - p.goalBasisWeightKg);
      if (drift >= CHECKIN_DRIFT_KG) {
        return { reason: `Your weight has moved ${this.units.formatWeight(drift, 1)} since your last target.` };
      }
    }
    if (p.baselineReviewedUtc) {
      const reviewed = new Date(p.baselineReviewedUtc).getTime();
      if (Number.isFinite(reviewed)) {
        const days = (Date.now() - reviewed) / 86_400_000;
        if (days >= CHECKIN_STALE_DAYS) {
          return { reason: `It's been over ${Math.round(days)} days since you last reviewed your target.` };
        }
      }
    }
    return null;
  });

  recomputeFromCheckIn(): void {
    this.useSuggested();
    this.checkInDismissed.set(true);
    this.toast.show('Targets recomputed — review and Save to keep them.', { tone: 'success', durationMs: 3200 });
  }

  // ─────────────── AI SUGGESTION (gated; same endpoint as the live page) ───────────────

  async suggestWithAi(): Promise<void> {
    if (this.aiLoading()) return;
    this.aiLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.suggestGoal());
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.aiRationale.set(res.rationale ?? null);
      this.aiSafety.set(res.safetyNote ?? null);
    } catch {
      this.useSuggested();
      this.aiRationale.set(null);
      this.aiSafety.set(null);
      this.toast.show('AI offline — filled a calculated estimate you can adjust', { tone: 'warn' });
    } finally {
      this.aiLoading.set(false);
    }
  }

  // ─────────────── AI NATURAL-GOAL ("describe your goal" → prefill) ───────────────

  readonly canDescribeGoal = computed(() => this.goalText().trim().length > 0 && !this.goalLoading());

  async describeGoalWithAi(): Promise<void> {
    const text = this.goalText().trim();
    if (!text || this.goalLoading()) return;
    this.goalLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.naturalGoal({ text }));
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.goalTimeline.set(res.timeline ?? null);
      this.goalRealistic.set(res.realistic);
      this.goalRationale.set(res.rationale ?? null);
      this.aiSafety.set(res.safetyNote ?? null);
    } catch {
      this.useSuggested();
      this.goalTimeline.set(null);
      this.goalRealistic.set(null);
      this.goalRationale.set(null);
      this.aiSafety.set(null);
      this.toast.show('AI offline — filled a calculated estimate you can adjust', { tone: 'warn' });
    } finally {
      this.goalLoading.set(false);
    }
  }

  // ─────────────── PLAN HISTORY RENDERING (unit-aware, copied from the live page) ───────────────

  readonly goalLabel = (g: string): string => GOALS.find((x) => x.value === g)?.label ?? g;
  readonly activityLabel = (a: string | undefined): string =>
    a ? (ACTIVITY_LEVELS.find((x) => x.value === a)?.label ?? a) : '';
  readonly dietLabel = (d: string | undefined): string =>
    d ? (DIET_PATTERNS.find((x) => x.value === d)?.label ?? d) : '';

  planRate(kgPerWk: number | null | undefined): string | null {
    if (kgPerWk == null || kgPerWk === 0) return null;
    const disp = this.units.rateToDisplay(Math.abs(kgPerWk));
    const sign = kgPerWk < 0 ? '−' : '+';
    return `${sign}${disp.toFixed(disp < 1 ? 2 : 1)} ${this.units.rateUnit()}`;
  }

  planWeight(kg: number | null | undefined): string | null {
    return this.units.formatWeight(kg, 1);
  }

  planEffectiveFrom(date: string): string {
    if (!date || date.startsWith('0001-01-01')) return 'Initial plan';
    const d = new Date(date + 'T00:00:00');
    if (!Number.isFinite(d.getTime())) return date;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  openPlan(p: GoalPlanDto): void {
    this.selectedPlan.set(p);
    this.sheetOpen.set(true);
  }

  // ─────────────── SAVE ───────────────

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  /** Persist the profile through the store (versioning a GoalPlan server-side when targets change), then reload. */
  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);

    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const goalWeightKg = this.currentWeightKg(this.goalWeightDisp());
    const hydrationGoalMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());
    const roundedWeight = weightKg != null ? Math.round(weightKg * 100) / 100 : undefined;
    const reAnchor = this.checkInDismissed();

    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());
    const restrictionsCsv =
      (this.restrictions() ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .join(', ') || null;
    const trimester = this.lifeStage() === 'Pregnant' ? this.num(this.trimester()) : undefined;
    const prev = this.profile();

    const body: TrackerProfileDto = {
      ...(prev ?? { shareWithContacts: false, sex: 'Unspecified', activityLevel: 'Sedentary' }),
      goal: this.goal(),
      weightKg: roundedWeight,
      dailyCalorieGoal: this.num(this.dailyCalorieGoal()),
      proteinGoalG: this.num(this.proteinGoalG()),
      carbGoalG: this.num(this.carbGoalG()),
      fatGoalG: this.num(this.fatGoalG()),
      shareWithContacts: this.shareWithContacts(),
      dateOfBirth: this.dateOfBirth() || null,
      heightCm: heightCm != null ? Math.round(heightCm * 10) / 10 : undefined,
      sex: this.sex(),
      activityLevel: this.activityLevel(),
      goalWeightKg: goalWeightKg != null ? Math.round(goalWeightKg * 100) / 100 : undefined,
      unitSystem: this.unitSystem(),
      hydrationGoalMl: hydrationGoalMl ?? undefined,
      stepGoal: this.num(this.stepGoal()),
      coffeeGoalCups: this.num(this.coffeeGoalCups()),
      weeklyRateKg: this.weeklyRateKg() ?? undefined,
      bodyFatPct: this.num(this.bodyFatPct()),
      neckCm: neckCm != null ? Math.round(neckCm * 10) / 10 : undefined,
      waistCm: waistCm != null ? Math.round(waistCm * 10) / 10 : undefined,
      hipCm: hipCm != null ? Math.round(hipCm * 10) / 10 : undefined,
      dietPattern: this.dietPattern(),
      restrictions: restrictionsCsv,
      trainingType: this.trainingType(),
      proteinBasis: this.proteinBasis(),
      lifeStage: this.lifeStage(),
      trimester,
      mealsPerDay: this.num(this.mealsPerDay()),
      eatingWindow: this.eatingWindow(),
      goalBasisWeightKg: reAnchor ? roundedWeight : (prev?.goalBasisWeightKg ?? undefined),
      baselineReviewedUtc: reAnchor ? new Date().toISOString() : (prev?.baselineReviewedUtc ?? undefined),
    };

    try {
      await this.store.saveProfile(body);
      await this.reload();
      this.toast.show('Plan saved', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show('Could not save your plan', { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  backToTracker(): void {
    void this.router.navigate(['/tracker']);
  }
}
