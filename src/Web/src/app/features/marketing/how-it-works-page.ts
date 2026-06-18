import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

interface Stage {
  n: string;
  icon: string;
  title: string;
  text: string;
  detail: string;
}
interface Faq { q: string; a: string; }

@Component({
  selector: 'app-how-it-works-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './how-it-works-page.html',
  styleUrl: './marketing-page.scss',
})
export class HowItWorksPage {
  readonly stages: Stage[] = [
    {
      n: '01',
      icon: 'terminal',
      title: 'A reporter watches your machine',
      text: 'A tiny background agent reads the JSONL logs Claude Code and Codex already write to disk.',
      detail: 'It de-duplicates locally before sending — so a re-run never double-counts, and only genuinely new records leave your machine.',
    },
    {
      n: '02',
      icon: 'cloud_upload',
      title: 'New usage posts to your server',
      text: 'The reporter authenticates with an ingest key and POSTs new records to /api/ingest over HTTPS.',
      detail: 'Keys are revocable, scoped, and never committed. The last-synced indicator on the dashboard updates the moment a post lands.',
    },
    {
      n: '03',
      icon: 'database',
      title: 'Postgres stores the truth',
      text: 'Records are priced from your editable rate table and bucketed into your display timezone.',
      detail: 'Every token tier is stored separately, so cost can be recomputed at any time without re-reading a single log file.',
    },
    {
      n: '04',
      icon: 'monitoring',
      title: 'You explore it all',
      text: 'Filter, chart, drill into sessions, export CSV, or share a read-only link.',
      detail: 'The dashboard, calendar heatmap, and records table all respond to the same filters, so any spike is one click from its cause.',
    },
    {
      n: '05',
      icon: 'forum',
      title: 'Your team talks in real time',
      text: 'The same server runs a SignalR hub that powers in-app channels and direct messages.',
      detail: 'Messages, reactions, typing indicators, and unread counts push live over WebSockets — and notifications reach an in-app bell, toasts, and the browser. No third-party chat tool in the loop.',
    },
    {
      n: '06',
      icon: 'restaurant',
      title: 'The tracker pulls in nutrition & exercise',
      text: 'The food & fitness tracker calls out to nutrition and exercise data sources, server-side.',
      detail: 'Foods come from USDA FoodData Central with a FatSecret fallback and barcode lookup; exercises and their calorie estimates come from the WorkoutX library. Your server makes those calls — your logs stay in your Postgres.',
    },
  ];

  readonly faqs: Faq[] = [
    {
      q: 'Does my code or prompt content leave my machine?',
      a: 'No. The reporter only reads usage metadata — token counts, model names, timestamps, project paths. It never reads or sends the contents of your prompts or files.',
    },
    {
      q: 'Where does it all run?',
      a: 'On one self-hosted server. The usage dashboard, the real-time chat hub, and the food & fitness tracker are the same .NET 9 API, Angular front end, and PostgreSQL database — packaged with Docker Compose. The live demo runs on a single small AWS instance behind auto-HTTPS.',
    },
    {
      q: 'Are chat and the tracker self-hosted too, or some outside service?',
      a: 'Self-hosted. Chat is a SignalR hub on your own server and messages live in your Postgres. The tracker stores every meal, exercise, weight, hydration, and watch-activity entry in that same database. Nothing in chat or the tracker depends on a third-party SaaS to function.',
    },
    {
      q: 'Where does the food and exercise data come from?',
      a: 'Food nutrition is looked up from USDA FoodData Central, with a FatSecret fallback and barcode scanning; foods you enter by hand can be saved for reuse. Exercises come from a built-in WorkoutX library with animated demos and per-minute calorie estimates you can override. Your server makes those lookups — the resulting log entries are stored locally.',
    },
    {
      q: 'How is cost calculated?',
      a: 'From a per-model pricing table you control, with input, output, cache-read, and 5-minute and 1-hour cache writes priced independently. Change a rate and recompute history in one click.',
    },
    {
      q: 'Who can sign in?',
      a: 'Google accounts, each pinned to its Google subject id. An open sign-up policy with a default permission set lets new accounts in, governed by a kill switch you can flip; 25 server-enforced capabilities decide what each user can do, re-checked every request, and every request is written to an audit log.',
    },
    {
      q: 'Can I sign someone out without locking them out?',
      a: 'Yes. Force-logout invalidates a user’s outstanding tokens and ends their live session in real time, while leaving the account enabled so they can sign back in. That is distinct from disabling an account, which blocks re-login entirely.',
    },
  ];
}
