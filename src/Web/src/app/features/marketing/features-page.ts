import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

/** One installed capability of the OS, grouped under the life-domain (subsystem) it belongs to. */
interface FeatureBlock {
  /** The subsystem (life-domain) this block belongs to. The template renders a heading when it changes. */
  group: string;
  icon: string;
  kicker: string;
  title: string;
  text: string;
  points: string[];
}

/** Per-subsystem header metadata: the OS framing line + the accent it always wears (drawn only from the three --tech accents). */
interface Subsystem {
  group: string;
  /** monospace boot status line shown under the subsystem heading. */
  status: string;
  /** one-line description of what this module is. */
  lead: string;
  /** which --tech accent token this domain is tinted with, app-wide. */
  accent: 'blue' | 'cyan' | 'violet';
}

@Component({
  selector: 'app-features-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './features-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./features-page.scss'],
})
export class FeaturesPage implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private io?: IntersectionObserver;

  /** Gentle scroll-reveal: toggle `.is-in` on `.reveal` elements as they enter. */
  ngAfterViewInit(): void {
    const root = this.host.nativeElement as HTMLElement;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    const reduce =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduce || typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('is-in'));
      return;
    }

    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            this.io?.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
    );
    targets.forEach((el) => this.io!.observe(el));
  }

  ngOnDestroy(): void {
    this.io?.disconnect();
  }

  /** Subsystem metadata, keyed by group name (rendered as a "module" header). */
  readonly subsystems: Record<string, Subsystem> = {
    'Work · AI cost intelligence': {
      group: 'Work · AI cost intelligence',
      status: 'work module: mounted',
      lead: 'Claude Code + Codex spend, priced to the token and sliced any way you think.',
      accent: 'blue',
    },
    'Body · the tracker': {
      group: 'Body · the tracker',
      status: 'body module: mounted',
      lead: 'Food, training, and the numbers behind the goal — your whole physical day, logged.',
      accent: 'cyan',
    },
    'Home · the Family Hub': {
      group: 'Home · the Family Hub',
      status: 'home module: mounted',
      lead: 'One calendar, the lists, the money, and the meal plan that becomes the grocery run.',
      accent: 'violet',
    },
    'People · live chat': {
      group: 'People · live chat',
      status: 'people module: mounted',
      lead: 'Real-time channels and DMs, in the app — curated, never an open directory.',
      accent: 'blue',
    },
    'Place · locations': {
      group: 'Place · locations',
      status: 'place module: mounted',
      lead: 'A private "where’s everyone" map — opt-in, by name, never by email.',
      accent: 'cyan',
    },
    'The agentic layer': {
      group: 'The agentic layer',
      status: 'agents: armed · off by default',
      lead: 'Gemini assists wired through every domain — they turn a sentence or a photo into a logged action, then hand you the pen.',
      accent: 'violet',
    },
    'The access spine': {
      group: 'The access spine',
      status: 'kernel: ok · 39 caps enforced',
      lead: 'The security and self-hosting floor that makes one system safe to run a whole life on.',
      accent: 'blue',
    },
  };

  /** Ordered list of subsystem names, used to render module headers in order. */
  readonly groupOrder: string[] = Object.keys(this.subsystems);

  readonly blocks: FeatureBlock[] = [
    // ───────────────────────── Work · AI cost intelligence ─────────────────────────
    {
      group: 'Work · AI cost intelligence',
      icon: 'hub',
      kicker: 'Unified',
      title: 'Two agents, one number',
      text: 'Claude Code and OpenAI Codex write usage logs in different shapes. The OS parses both from your local JSONL, de-duplicates the noise, and rolls them into a single source of truth.',
      points: [
        'Per-source breakdown, or everything combined',
        'Automatic de-duplication of repeated API events',
        'Sidechain / subagent spend counted — toggle it on or off',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'payments',
      kicker: 'Real cost',
      title: 'Real dollars, your rates',
      text: 'Every token tier is priced from a table you control. Change a rate and recompute historical cost in one click, without re-reading a single log file.',
      points: [
        'Editable per-model pricing table',
        'Input, output, cache-read, and 5-minute / 1-hour cache writes priced separately',
        'One-click recompute across all history',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'filter_alt',
      kicker: 'Slice it',
      title: 'Filter any way you think',
      text: 'Date range, project, model, source, machine, user. The dashboard, charts, and records table all move together so you can chase a spike to its exact cause.',
      points: [
        'Date presets and custom ranges',
        'Group by day, month, project, model, source, machine, or user',
        'Paged, sortable record table with streamed CSV export',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'calendar_month',
      kicker: 'Rhythm',
      title: 'See how you actually work',
      text: 'A GitHub-style activity heatmap shows cost, tokens, and the hours your agents are busy, with an estimate of time spent working alongside AI and a drill-down to the individual session.',
      points: [
        'Heatmap of cost, tokens, and active hours by day',
        'Estimated time-with-AI from your session rhythm',
        'Session-level drill-down with token + cost detail',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'bolt',
      kicker: 'Cache insight',
      title: 'Know what the cache buys you',
      text: 'Prompt caching is most of the savings on a busy day. The OS surfaces your cache hit share and the dollars it saved against full input pricing.',
      points: [
        'Cache hit share across the current filter',
        'Estimated dollars saved versus uncached input',
        'Reactive to whatever range you have applied',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'bookmark',
      kicker: 'Saved views',
      title: 'Pin the questions you ask twice',
      text: 'Save a filter and grouping as a named view, then reload it in a click. Each view is yours, scoped to your account.',
      points: [
        'Name, rename, and delete per-user views',
        'Captures the full filter plus group-by and range',
        'Reapplies through the normal dashboard path',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'leaderboard',
      kicker: 'Fleet',
      title: 'See the whole team at a glance',
      text: 'Per-machine and per-user leaderboards roll the fleet up by spend and tokens. Attribution is derived on the server, so it cannot be spoofed by a client.',
      points: [
        'Per-machine and per-user spend leaderboards',
        'Server-derived attribution — unspoofable',
        'Drill from any row back into the filtered dashboard',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'sensors',
      kicker: 'Reporter',
      title: 'A reporter that minds its own business',
      text: 'A lightweight reporter and a Windows desktop tray agent read the logs already on your machine and post only usage metadata to your server with a revocable key.',
      points: [
        'Reads local JSONL — never prompt or response content',
        'Posts to /api/ingest with a scoped, revocable key',
        'Windows tray agent or headless reporter, your choice',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'ios_share',
      kicker: 'Share',
      title: 'Show without giving away the keys',
      text: 'Generate a public, read-only link to a filtered dashboard. Set an expiry, label it, watch who opened it, and revoke it whenever you like.',
      points: [
        'Time-limited, read-only public share links',
        'Per-view IP and timestamp logging, revocable any time',
        'Pop-out stat widgets per source',
      ],
    },
    {
      group: 'Work · AI cost intelligence',
      icon: 'notifications_active',
      kicker: 'Digests',
      title: 'Spend lands in your channel',
      text: 'Daily and weekly Discord digests summarize spend with a trend and your top project and model. Threshold and security alerts fire when something needs eyes.',
      points: [
        'Daily / weekly spend digest with trend',
        'Top project and model called out',
        'Threshold and security alerts, on your terms',
      ],
    },

    // ───────────────────────── Body · the tracker ─────────────────────────
    {
      group: 'Body · the tracker',
      icon: 'restaurant',
      kicker: 'Meals',
      title: 'Log meals with real macros',
      text: 'Track breakfast, lunch, dinner, and snacks with calories and macros sourced from USDA FoodData Central, with a FatSecret fallback and barcode scanning.',
      points: [
        'USDA FoodData Central with a FatSecret fallback',
        'Barcode scanning to find a food fast',
        'Save manual foods to reuse them later',
      ],
    },
    {
      group: 'Body · the tracker',
      icon: 'fitness_center',
      kicker: 'Exercise',
      title: 'A WorkoutX exercise library',
      text: 'Pick from a WorkoutX library with animated demos. Calories are auto-estimated from the exercise’s per-minute rate, with a manual override when you know better.',
      points: [
        'Animated demos from the WorkoutX library',
        'Per-minute calorie auto-estimate, manual override',
        'Save your go-to exercises for one-tap logging',
      ],
    },
    {
      group: 'Body · the tracker',
      icon: 'monitor_heart',
      kicker: 'Body stats',
      title: 'The numbers behind the goal',
      text: 'BMI, BMR and TDEE, and a weight trend turn the daily log into progress you can actually see.',
      points: ['BMI from your current stats', 'BMR / TDEE energy budget', 'Weight trend over time'],
    },
    {
      group: 'Body · the tracker',
      icon: 'water_drop',
      kicker: 'Hydration & watch',
      title: 'Hydration and watch activity, counted',
      text: 'A daily hydration counter and smartwatch stats — steps, distance, and active calories — feed straight into the day’s net-calorie math.',
      points: [
        'Daily hydration counter with quick-add',
        'Steps, distance, and active calories',
        'Active calories add to, or override, logged exercise',
      ],
    },
    {
      group: 'Body · the tracker',
      icon: 'emoji_events',
      kicker: 'Challenge',
      title: '75-Hard, coffee, and trophies',
      text: 'Run the 75-Hard challenge, keep a coffee count, and earn trophies as streaks and milestones land — the gamified edge that keeps the daily log a habit.',
      points: [
        'The 75-Hard challenge, tracked day by day',
        'A coffee counter for the part of the day that’s honest',
        'Trophies for streaks and milestones hit',
      ],
    },
    {
      group: 'Body · the tracker',
      icon: 'diversity_3',
      kicker: 'Sharing',
      title: 'Share your log with the right people',
      text: 'Share your day with chat contacts, and let coaches or admins with the right capability view everyone’s log read-only.',
      points: [
        'Share your log with chosen chat contacts',
        'Coaches / admins can view all logs',
        'Viewers see read-only; only you can write',
      ],
    },

    // ───────────────────────── Home · the Family Hub ─────────────────────────
    {
      group: 'Home · the Family Hub',
      icon: 'calendar_month',
      kicker: 'One calendar',
      title: 'The whole house, one calendar',
      text: 'A Sunday–Saturday week, month, and agenda calendar backed by each member’s own Google Calendar. Opt in and everyone’s events overlay in one color-coded view — or drop in a photo of a schedule and let AI draft the events.',
      points: [
        'Synced with each member’s own Google Calendar',
        'Opt-in, color-coded family overlay',
        'Snap a schedule photo/PDF → AI drafts the events',
      ],
    },
    {
      group: 'Home · the Family Hub',
      icon: 'restaurant_menu',
      kicker: 'Meals → macros → groceries',
      title: 'Plan dinner, get the grocery list',
      text: 'Plan the week’s meals and the same data flows everywhere: pull each meal’s macros, push a planned meal straight into your fitness tracker, and extrapolate the ingredients into the shared grocery list.',
      points: [
        'Weekly meal planner for the household',
        'Macros pulled per meal; push a meal to your tracker',
        'Ingredients roll into the shared grocery list',
      ],
    },
    {
      group: 'Home · the Family Hub',
      icon: 'checklist',
      kicker: 'Stay on top of it',
      title: 'Lists, notes, reminders, polls',
      text: 'Shared grocery and to-do lists, family notes, reminders so nothing slips, shared timers, and quick polls to settle a plan or pick a time together.',
      points: [
        'Shared lists, notes, and reminders',
        'Shared timers and countdowns',
        'Polls to pick a time or settle a plan',
      ],
    },
    {
      group: 'Home · the Family Hub',
      icon: 'savings',
      kicker: 'Money & chores',
      title: 'Budgets, bills, and a fair share of chores',
      text: 'Track budgets, bills, and balances behind an extra finance permission, and split the household chores so everyone carries their part.',
      points: [
        'Finance double-gated for extra privacy',
        'An “explain my month” + money-coach AI',
        'Chores + allowance, shared fairly across the house',
      ],
    },

    // ───────────────────────── People · live chat ─────────────────────────
    {
      group: 'People · live chat',
      icon: 'forum',
      kicker: 'Real-time',
      title: 'Channels and DMs, live',
      text: 'A real-time SignalR layer powers channels and direct messages right inside the OS — no third-party chat tool, no extra login.',
      points: [
        'Channels and one-to-one direct messages',
        'Emoji reactions on any message',
        'Typing indicators and unread counts',
      ],
    },
    {
      group: 'People · live chat',
      icon: 'groups',
      kicker: 'Circles',
      title: 'Admins shape who talks to whom',
      text: 'Contacts and circles are admin-curated, so each person can only message the people you have approved for them.',
      points: [
        'Admins choose each person’s contacts',
        'Curated circles keep DMs in bounds',
        'No open directory of the whole org',
      ],
    },
    {
      group: 'People · live chat',
      icon: 'notifications',
      kicker: 'Notifications',
      title: 'Reached the way you want',
      text: 'An in-app bell, toasts, and browser notifications keep people in the loop, with per-user triggers so nobody drowns in noise.',
      points: [
        'In-app bell, toasts, and browser notifications',
        'Per-user notification triggers',
        'Unread counts that follow you across the app',
      ],
    },
    {
      group: 'People · live chat',
      icon: 'gavel',
      kicker: 'Moderation',
      title: 'Keep the room in order',
      text: 'Moderators can edit or delete other people’s messages and archive channels when a conversation has run its course.',
      points: [
        'Edit or delete others’ messages',
        'Archive channels that are done',
        'A dedicated, grantable moderation capability',
      ],
    },

    // ───────────────────────── Place · locations ─────────────────────────
    {
      group: 'Place · locations',
      icon: 'person_pin_circle',
      kicker: 'Where’s everyone',
      title: 'See the family on a map',
      text: 'Members who opt in show up on a shared “Where’s everyone” map — by name, never by email. Your own location is private by default; you choose whether to share it with the household.',
      points: [
        'Opt-in only — private by default',
        'A household “Where’s everyone” map (OpenStreetMap)',
        'Your own location history, just for you',
      ],
    },

    // ───────────────────────── The agentic layer ─────────────────────────
    {
      group: 'The agentic layer',
      icon: 'auto_awesome',
      kicker: 'It acts',
      title: 'AI that turns a sentence into a logged action',
      text: 'Google Gemini powers schedule-from-photo, day / meal / finance coaches, macro and exercise estimation, and an action-taking family assistant. The agents prefill the action — you confirm it. Every assist is gated by its own permission and is OFF for everyone until you turn it on.',
      points: [
        'Snap a meal → macros; say a workout → a structured entry',
        'Photo of a schedule → a week of calendar events drafts itself',
        'Separate AI permissions — everyone starts AI-off',
      ],
    },
    {
      group: 'The agentic layer',
      icon: 'privacy_tip',
      kicker: 'On a leash you hold',
      title: 'AI that respects your data',
      text: 'Every agent sees only the minimal context its feature needs and never auto-logs — it prefills, you confirm. Uploaded images are digested in memory and never stored, and an admin AI-usage log records metadata only — never your prompt content.',
      points: [
        'Never auto-logs — it prefills, you confirm',
        'Images digested in-memory, never stored',
        'AI-usage log: metadata only, never content — fixed providers',
      ],
    },

    // ───────────────────────── The access spine ─────────────────────────
    {
      group: 'The access spine',
      icon: 'verified_user',
      kicker: 'Identity',
      title: 'Sign-in pinned to Google',
      text: 'Google sign-in gates the whole OS, and every account is bound to its Google subject id so a borrowed email alone can’t get in.',
      points: [
        'Google identity, pinned to the subject id',
        'Open sign-up policy with a default permission set',
        'A kill switch to close sign-up instantly',
      ],
    },
    {
      group: 'The access spine',
      icon: 'shield_person',
      kicker: 'Permissions',
      title: '39 capabilities, server-enforced',
      text: 'A catalog of 39 granular capabilities across seven groups decides what each user can do, re-checked on the server every single request — not just hidden in the UI. One-click presets get a friend, family member, teammate, or your kids set up fast.',
      points: [
        '39-capability catalog (AI perms are their own group, off by default)',
        'Re-checked server-side on every request',
        'Presets + a home-page picker per user',
      ],
    },
    {
      group: 'The access spine',
      icon: 'dns',
      kicker: 'Yours',
      title: 'Self-hosted, open source, nothing phoning home',
      text: 'Angular + .NET 9 + PostgreSQL, Docker-composed to run anywhere and deployed keylessly to AWS. Open source, self-hosted on your infrastructure — no telemetry, no seat pricing.',
      points: [
        'Runs on your own servers, Docker-composed',
        'Open source at github.com/itdept-ops/usage-iq',
        'No telemetry, no seat pricing — your data, your infra',
      ],
    },
    {
      group: 'The access spine',
      icon: 'logout',
      kicker: 'Force-logout',
      title: 'End a live session on demand',
      text: 'Sign a user out of their active session in real time — without disabling the account — by invalidating their outstanding tokens.',
      points: [
        'Real-time force-logout of live sessions',
        'Account stays enabled; they can sign back in',
        'Distinct from disable, which blocks re-login',
      ],
    },
    {
      group: 'The access spine',
      icon: 'fact_check',
      kicker: 'Auditability',
      title: 'A record of what happened',
      text: 'A full audit log and a request/response activity log give you a paper trail for every meaningful action and call.',
      points: [
        'Audit log of privileged actions',
        'Request / response activity log',
        'Searchable from the Activity page',
      ],
    },
  ];
}
