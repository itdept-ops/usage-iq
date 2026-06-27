import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
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

/**
 * Public "Technology" page — reframed to the Agentic Life OS spine as
 * "the engine under the OS": the proof that one builder engineered a real,
 * production, self-hosted system. Every factual claim is preserved verbatim
 * in substance; only the framing/visuals carry the OS metaphor.
 *
 * Bare layout (own chrome): marketing nav + footer, the shared orb/grid
 * backdrop, and scroll-revealed sections. The IntersectionObserver reveal is
 * gated behind `.js-reveal` so a no-JS / reduced-motion render shows everything.
 */
@Component({
  selector: 'app-technology-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './technology-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./marketing-page.scss', './technology-page.scss'],
})
export class TechnologyPage implements AfterViewInit, OnDestroy {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private zone = inject(NgZone);

  /** Boot-sequence status lines for the hero terminal — the OS coming online. */
  readonly bootLines: { tag: string; ok: string }[] = [
    { tag: 'kernel', ok: '.NET 9 minimal-API · online' },
    { tag: 'store', ok: 'PostgreSQL · single source of truth' },
    { tag: 'realtime', ok: 'SignalR hub · mounted' },
    { tag: 'surface', ok: 'Angular SPA · rendered' },
    { tag: 'host', ok: 'Docker + nginx · self-hosted' },
  ];

  /** (1) The stack — every claim true per the codebase. */
  readonly stack: TechCard[] = [
    {
      name: 'Angular 22',
      role: 'Standalone-component, signals-based SPA — with Angular Material and ECharts driving the charts.',
      icon: 'web',
    },
    {
      name: '.NET 9',
      role: 'A minimal-API backend handling ingest, query, and auth — the kernel every module boots on.',
      icon: 'dns',
    },
    {
      name: 'EF Core 9 + Npgsql',
      role: 'Data access and migrations, applied automatically on startup.',
      icon: 'schema',
    },
    {
      name: 'PostgreSQL',
      role: 'The single source of truth — token rows, users, chat, and the tracker, all in one database.',
      icon: 'database',
    },
    {
      name: 'SignalR',
      role: 'The real-time channel behind chat, live notifications, and force-logout — one hub at /api/hubs/chat.',
      icon: 'bolt',
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
      posture:
        'The ID token is validated server-side, and the account is pinned to its Google subject id.',
    },
    {
      name: 'Claude Code + OpenAI Codex',
      powers: 'Local JSONL usage logs from each tool.',
      posture:
        'Only token counts and metadata are read — never the content of your prompts or files.',
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

  private observer?: IntersectionObserver;
  private revealFailsafe?: ReturnType<typeof setTimeout>;

  ngAfterViewInit(): void {
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const els = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-reveal]'));

    // No observer support, or motion is reduced → reveal everything immediately.
    if (reduce || typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }

    // Arm the hidden→reveal state only now that JS + IntersectionObserver are
    // confirmed available, so a no-JS render can never strand a section at opacity:0.
    this.host.nativeElement.classList.add('js-reveal');

    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('is-in');
              this.observer?.unobserve(e.target);
            }
          }
        },
        { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
      );
      els.forEach((el) => this.observer!.observe(el));
      // Failsafe: if the observer never fires (throttled/backgrounded tab),
      // reveal everything. Idempotent with the per-element reveals above.
      this.revealFailsafe = setTimeout(() => els.forEach((el) => el.classList.add('is-in')), 2500);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    if (this.revealFailsafe !== undefined) clearTimeout(this.revealFailsafe);
  }
}
