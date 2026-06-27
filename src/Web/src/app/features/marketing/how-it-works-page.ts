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

/** One stage in the boot/run sequence. `boot` is the monospace status line motif. */
interface Stage {
  n: string;
  icon: string;
  domain: string;
  accent: 'blue' | 'violet' | 'cyan';
  boot: string;
  title: string;
  text: string;
  detail: string;
}
interface Faq {
  q: string;
  a: string;
}

@Component({
  selector: 'app-how-it-works-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './how-it-works-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./marketing-page.scss', './how-it-works-page.scss'],
})
export class HowItWorksPage implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private io?: IntersectionObserver;

  ngAfterViewInit(): void {
    const els = Array.from(
      (this.host.nativeElement as HTMLElement).querySelectorAll('.reveal'),
    );
    const reduce =
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    this.io = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            obs.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    els.forEach((el) => this.io!.observe(el));
  }

  ngOnDestroy(): void {
    this.io?.disconnect();
  }

  /** The kernel coming online: data flows in, the source of truth forms, the live + AI layers light up. */
  readonly stages: Stage[] = [
    {
      n: '01',
      icon: 'terminal',
      domain: 'Work',
      accent: 'blue',
      boot: 'reporter: watching ~/.claude · ~/.codex',
      title: 'A reporter watches your machine',
      text: 'A tiny background agent reads the JSONL logs Claude Code and Codex already write to disk — token counts, model names, timestamps, project paths. Never your prompts or files.',
      detail:
        'It de-duplicates locally before anything is sent, so a re-run never double-counts and only genuinely new records ever leave your machine.',
    },
    {
      n: '02',
      icon: 'cloud_upload',
      domain: 'Ingest',
      accent: 'blue',
      boot: 'ingest: POST /api/ingest · 200 ok',
      title: 'New usage posts to your server',
      text: 'The reporter authenticates with a scoped ingest key and POSTs only the new records to your own server over HTTPS — no third party in the path.',
      detail:
        'Keys are revocable and never committed. The last-synced indicator updates the moment a post lands, so you always know the OS is current.',
    },
    {
      n: '03',
      icon: 'database',
      domain: 'Kernel',
      accent: 'violet',
      boot: 'postgres: single source of truth mounted',
      title: 'Postgres becomes the single source of truth',
      text: 'Every domain writes to one PostgreSQL database — work spend, meals, workouts, weight, chat, the family calendar, locations. One login, one schema, one system that finally knows the whole picture.',
      detail:
        'AI spend is priced from your editable rate table and bucketed into your timezone; every token tier is stored separately so cost can be recomputed any time without re-reading a single log file.',
    },
    {
      n: '04',
      icon: 'dashboard',
      domain: 'Workspace',
      accent: 'blue',
      boot: 'workspace: explore layer online',
      title: 'The workspace lights up on top',
      text: 'Filter, chart, drill into sessions, plan a week of meals, log a workout, split the bills, export CSV, or share a read-only link. Because it is all one database, a spike is one click from its cause.',
      detail:
        'The dashboard, calendar heatmap, tracker, and Family Hub all read the same truth — so the parts behave like one OS, not fifteen apps that have never met.',
    },
    {
      n: '05',
      icon: 'forum',
      domain: 'People',
      accent: 'cyan',
      boot: 'signalr: realtime hub connected',
      title: 'The real-time layer comes online',
      text: 'The same server runs a SignalR hub powering in-app channels and direct messages, plus a private "where’s everyone" map.',
      detail:
        'Messages, reactions, typing indicators, and unread counts push live over WebSockets; notifications reach an in-app bell, toasts, and the browser. No outside chat tool in the loop.',
    },
    {
      n: '06',
      icon: 'auto_awesome',
      domain: 'Agents',
      accent: 'cyan',
      boot: 'agents: armed · off by default · permission-gated',
      title: 'The agents wire into every domain',
      text: 'A team of server-side Gemini agents threads through the OS. Snap a plate and it estimates macros; say "jogged two miles" and it becomes a structured, weight-scaled entry; drop a photo of a schedule and a week of calendar events drafts itself.',
      detail:
        'Every agent is off by default, permission-gated, sees only the minimum, and never auto-logs — it prefills, you confirm. Nutrition comes from USDA FoodData Central with a FatSecret fallback and barcode lookup; exercises and calories from the WorkoutX library. Your server makes those calls; your data stays in your Postgres.',
    },
  ];

  readonly faqs: Faq[] = [
    {
      q: 'Does my code or prompt content leave my machine?',
      a: 'No. The reporter only reads usage metadata — token counts, model names, timestamps, project paths. It never reads or sends the contents of your prompts or files, and the AI agents see only the minimum a task needs, with images handled in memory and never retained.',
    },
    {
      q: 'Where does the whole OS run?',
      a: 'On one self-hosted server. The AI-usage analytics, the real-time chat hub, the Family Hub, the food & fitness tracker, and the agentic AI layer are the same .NET 9 API, Angular front end, and PostgreSQL database — packaged with Docker Compose to run anywhere. The live demo runs on a single small AWS instance behind auto-HTTPS, deployed keylessly via OIDC.',
    },
    {
      q: 'Are chat, the Hub, and the tracker self-hosted too, or some outside service?',
      a: 'Self-hosted. Chat is a SignalR hub on your own server with messages in your Postgres. The Family Hub stores every calendar event, list, note, chore, and budget line in that same database, and the tracker stores every meal, exercise, weight, hydration, and watch-activity entry there too. Nothing core depends on a third-party SaaS to function.',
    },
    {
      q: 'What do the agents actually do, and can they act without me?',
      a: 'They turn a sentence or a photo into a logged action — then hand you the pen. An agent estimates macros from a description or plate, parses a meal into ingredients, scales workout calories to your weight, drafts calendar events from a schedule photo, calculates a goal, and coaches your day or week. Every one is off by default, permission-gated, and never auto-logs: it prefills the form and waits for you to confirm. AI that acts, on a leash you hold.',
    },
    {
      q: 'Where does the food and exercise data come from?',
      a: 'Food nutrition is looked up from USDA FoodData Central, with a FatSecret fallback and barcode scanning; foods you enter by hand can be saved for reuse. Exercises come from a built-in WorkoutX library with animated demos and per-minute calorie estimates you can override. Your server makes those lookups, and the resulting entries are stored locally in your Postgres.',
    },
    {
      q: 'How is AI cost calculated?',
      a: 'From a per-model pricing table you control, with input, output, cache-read, and 5-minute and 1-hour cache writes priced independently. Change a rate and recompute history in one click — no log file is ever re-read.',
    },
    {
      q: 'Who can sign in, and how is access enforced?',
      a: 'Google accounts, each pinned to its Google subject id. An open sign-up policy with a default permission set lets new accounts in, governed by a kill switch you can flip. 49 server-enforced capabilities across nine groups (AI permissions are their own group, off by default) decide what each user can do — re-checked on the server every request, never hidden only in the UI, with every request written to an audit log.',
    },
    {
      q: 'Can I sign someone out without locking them out?',
      a: 'Yes. Force-logout invalidates a user’s outstanding tokens and ends their live session in real time, while leaving the account enabled so they can sign back in. That is distinct from disabling an account, which blocks re-login entirely.',
    },
  ];
}
