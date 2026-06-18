import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

interface TechCard {
  name: string;
  role: string;
  icon: string;
}
interface Integration {
  name: string;
  powers: string;
  posture: string;
}
interface ArchNode {
  icon: string;
  title: string;
  text: string;
}

@Component({
  selector: 'app-technology-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './technology-page.html',
  styleUrls: ['./marketing-page.scss', './technology-page.scss'],
})
export class TechnologyPage {
  /** (1) The stack — every claim true per the codebase. */
  readonly stack: TechCard[] = [
    {
      name: 'Angular 21',
      role: 'Standalone-component, signals-based SPA — with Angular Material and ECharts driving the charts.',
      icon: 'web',
    },
    {
      name: '.NET 9',
      role: 'A minimal-API backend handling ingest, query, and auth.',
      icon: 'dns',
    },
    {
      name: 'EF Core 9 + Npgsql',
      role: 'Data access and migrations, applied automatically on startup.',
      icon: 'schema',
    },
    {
      name: 'PostgreSQL',
      role: 'The single source of truth — token rows, users, chat, and the tracker.',
      icon: 'database',
    },
    {
      name: 'SignalR',
      role: 'The real-time channel behind chat, live notifications, and force-logout — one hub at /api/hubs/chat.',
      icon: 'bolt',
    },
    {
      name: '@zxing/browser + BarcodeDetector',
      role: 'In-browser barcode scanning for the food tracker, using the native detector where available.',
      icon: 'qr_code_scanner',
    },
    {
      name: 'Docker + Docker Compose',
      role: 'The whole stack — api, web, and db — packaged to run anywhere.',
      icon: 'deployed_code',
    },
    {
      name: 'nginx',
      role: 'Serves the SPA and reverse-proxies the API, including SignalR WebSockets, and adds security headers.',
      icon: 'lan',
    },
    {
      name: 'AWS + GitHub Actions (OIDC)',
      role: 'Runs on a single small instance; a push to main auto-builds images to ECR and rolls them out via SSM. No telemetry, no seat pricing.',
      icon: 'rocket_launch',
    },
  ];

  /** (2) Integrations & APIs — name, what it powers, data posture. */
  readonly integrations: Integration[] = [
    {
      name: 'Google Identity Services',
      powers: 'Sign-in only.',
      posture: 'The ID token is validated server-side, and the account is pinned to its Google subject id.',
    },
    {
      name: 'Claude Code + OpenAI Codex',
      powers: 'Local JSONL usage logs from each tool.',
      posture: 'Only token counts and metadata are read — never the content of your prompts or files.',
    },
    {
      name: 'USDA FoodData Central',
      powers: 'Nutrition data for meal logging.',
      posture: 'Called server-side; the provider key stays out of the repo.',
    },
    {
      name: 'FatSecret',
      powers: 'Fallback food search when USDA finds nothing.',
      posture: 'Called server-side; the provider key stays out of the repo.',
    },
    {
      name: 'WorkoutX',
      powers: 'Exercise library, animated demos, and per-minute calorie estimates.',
      posture: 'Called server-side; the provider key stays out of the repo.',
    },
    {
      name: 'Discord (incoming webhook)',
      powers: 'Outbound spend digests and alerts.',
      posture: 'Validated to genuine Discord hosts and stored masked.',
    },
  ];

  /** (3) Architecture — the request path, end to end. */
  readonly arch: ArchNode[] = [
    {
      icon: 'computer',
      title: 'Reporter on each workstation',
      text: 'A tiny reporter — or a Windows desktop tray agent — parses the local logs and pushes only usage metadata to /api/ingest over HTTPS, with a revocable key.',
    },
    {
      icon: 'web',
      title: 'Angular SPA',
      text: 'The standalone-component, signals-based front end. Everything you see — dashboard, chat, tracker — talks to the API over REST and a SignalR hub.',
    },
    {
      icon: 'dns',
      title: '.NET 9 API (+ SignalR hub)',
      text: 'A minimal-API backend exposing REST plus a real-time SignalR hub. The food, exercise, and identity providers are all called from here, server-side.',
    },
    {
      icon: 'database',
      title: 'PostgreSQL',
      text: 'The single source of truth for token rows, users, chat, and the tracker — with EF Core migrations applied automatically on startup.',
    },
  ];

  /** (3) The external providers the API reaches out to, server-side. */
  readonly archProviders: string[] = [
    'Google Identity Services',
    'USDA FoodData Central',
    'FatSecret',
    'WorkoutX',
    'Discord',
  ];

  /** (4) Self-hosted by design. */
  readonly principles: ArchNode[] = [
    {
      icon: 'deployed_code',
      title: 'Docker-Composed, runs anywhere',
      text: 'api, web, and db ship as one Docker Compose stack. The live demo is one small AWS instance behind auto-HTTPS, with push-to-main auto-deploy.',
    },
    {
      icon: 'shield',
      title: 'Secrets stay out of the repo',
      text: 'Provider keys live in git-ignored config or AWS SSM. Every provider degrades gracefully — returning HTTP 503 — when it is not configured.',
    },
    {
      icon: 'lan',
      title: 'nginx in front',
      text: 'nginx serves the SPA and reverse-proxies the API, including SignalR WebSockets, and adds security headers.',
    },
    {
      icon: 'code',
      title: 'Open source',
      text: 'Your data stays on your infrastructure. The whole project is open source at github.com/itdept-ops/usage-iq.',
    },
  ];
}
