import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

interface FeatureBlock {
  /** Section this block belongs to. The template renders a heading when the group changes. */
  group: string;
  icon: string;
  kicker: string;
  title: string;
  text: string;
  points: string[];
}

@Component({
  selector: 'app-features-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './features-page.html',
  styleUrl: './marketing-page.scss',
})
export class FeaturesPage {
  readonly blocks: FeatureBlock[] = [
    // ───────────────────────── A) AI usage intelligence ─────────────────────────
    {
      group: 'AI usage intelligence',
      icon: 'hub',
      kicker: 'Unified',
      title: 'Two agents, one number',
      text: 'Claude Code and OpenAI Codex write usage logs in different shapes. Usage IQ parses both from your local JSONL, de-duplicates the noise, and rolls them into a single source of truth.',
      points: [
        'Per-source breakdown, or everything combined',
        'Automatic de-duplication of repeated API events',
        'Sidechain / subagent spend counted — toggle it on or off',
      ],
    },
    {
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
      icon: 'bolt',
      kicker: 'Cache insight',
      title: 'Know what the cache buys you',
      text: 'Prompt caching is most of the savings on a busy day. Usage IQ surfaces your cache hit share and the dollars it saved against full input pricing.',
      points: [
        'Cache hit share across the current filter',
        'Estimated dollars saved versus uncached input',
        'Reactive to whatever range you have applied',
      ],
    },
    {
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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
      group: 'AI usage intelligence',
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

    // ───────────────────────── A2) Family Hub ─────────────────────────
    {
      group: 'Family Hub',
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
      group: 'Family Hub',
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
      group: 'Family Hub',
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
      group: 'Family Hub',
      icon: 'savings',
      kicker: 'Money & chores',
      title: 'Budgets, bills, and a fair share of chores',
      text: 'Track budgets, bills, and balances behind an extra finance permission, and split the household chores so everyone carries their part.',
      points: [
        'Finance double-gated for extra privacy',
        'An “explain my month” + money-coach AI',
        'Chores, shared fairly across the house',
      ],
    },

    // ───────────────────────── A3) Locations ─────────────────────────
    {
      group: 'Locations',
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

    // ───────────────────────── A4) AI everywhere ─────────────────────────
    {
      group: 'AI everywhere',
      icon: 'auto_awesome',
      kicker: 'On your terms',
      title: 'AI woven through — and off by default',
      text: 'Google Gemini powers a schedule-from-photo, day / meal / finance coaches, and an action-taking family assistant. Every AI feature is gated by its own permission and is OFF for everyone until you turn it on.',
      points: [
        'Separate AI permissions — everyone starts AI-off',
        'Schedule-from-photo, coaches, family assistant',
        'Falls back to a plain summary when AI is off',
      ],
    },
    {
      group: 'AI everywhere',
      icon: 'privacy_tip',
      kicker: 'Private by design',
      title: 'AI that respects your data',
      text: 'AI sees only the minimal context a feature needs. Uploaded images are digested in memory and never stored, and an admin AI-usage log records metadata only — never your prompt content.',
      points: [
        'Images digested in-memory, never stored',
        'AI-usage log: metadata only, never content',
        'Fixed providers — no user-supplied URLs',
      ],
    },

    // ───────────────────────── B) Team chat ─────────────────────────
    {
      group: 'Team chat',
      icon: 'forum',
      kicker: 'Real-time',
      title: 'Channels and DMs, live',
      text: 'A real-time SignalR layer powers channels and direct messages right inside the app — no third-party chat tool, no extra login.',
      points: [
        'Channels and one-to-one direct messages',
        'Emoji reactions on any message',
        'Typing indicators and unread counts',
      ],
    },
    {
      group: 'Team chat',
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
      group: 'Team chat',
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
      group: 'Team chat',
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

    // ───────────────────────── C) Food & fitness tracker ─────────────────────────
    {
      group: 'Food & fitness tracker',
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
      group: 'Food & fitness tracker',
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
      group: 'Food & fitness tracker',
      icon: 'monitor_heart',
      kicker: 'Body stats',
      title: 'The numbers behind the goal',
      text: 'BMI, BMR and TDEE, and a weight trend turn the daily log into progress you can actually see.',
      points: [
        'BMI from your current stats',
        'BMR / TDEE energy budget',
        'Weight trend over time',
      ],
    },
    {
      group: 'Food & fitness tracker',
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
      group: 'Food & fitness tracker',
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

    // ───────────────────────── D) Security & access ─────────────────────────
    {
      group: 'Security & access',
      icon: 'verified_user',
      kicker: 'Identity',
      title: 'Sign-in pinned to Google',
      text: 'Google sign-in gates the whole app, and every account is bound to its Google subject id so a borrowed email alone can’t get in.',
      points: [
        'Google identity, pinned to the subject id',
        'Open sign-up policy with a default permission set',
        'A kill switch to close sign-up instantly',
      ],
    },
    {
      group: 'Security & access',
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
      group: 'Security & access',
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
      group: 'Security & access',
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
