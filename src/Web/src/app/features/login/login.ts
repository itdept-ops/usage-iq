import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChildren,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from '../marketing/marketing-nav';
import { MarketingFooter } from '../marketing/marketing-footer';
import { BuiltWithBadge } from './built-with-badge';

/** A life-domain orbiting the OS core. `glyph` selects one of the custom inline
 *  SVG domain marks rendered in the template (body/home/money/people/mind/comms);
 *  `accent` tints the satellite + module card (indigo/violet/cyan). */
interface Domain {
  key: string;
  /** which custom SVG domain glyph to render */
  glyph: 'body' | 'home' | 'money' | 'people' | 'mind' | 'comms';
  title: string;
  text: string;
  /** which scoped landing accent tints this domain */
  accent: 'indigo' | 'violet' | 'cyan';
}
interface Agent {
  /** which custom SVG agent glyph to render */
  glyph: 'pulse' | 'bolt' | 'insight' | 'recap' | 'search' | 'capture';
  /** the trigger — a sentence or a photo */
  cue: string;
  /** the action the agent takes */
  act: string;
}
interface Proof {
  /** which custom SVG platform glyph to render */
  glyph: 'key' | 'server' | 'install' | 'devices';
  title: string;
  text: string;
}
interface Stat {
  value: number;
  suffix: string;
  label: string;
}

@Component({
  selector: 'app-login',
  imports: [MatIconModule, RouterLink, MarketingNav, MarketingFooter, BuiltWithBadge],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './login.scss',
})
export class Login {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  /** Elements opted into scroll-reveal via the #reveal template ref. */
  private reveals = viewChildren<ElementRef<HTMLElement>>('reveal');

  /** Forwarded to /signin so a deep-linked guard redirect survives the marketing detour. */
  readonly returnUrl = signal<string | null>(null);

  /** The six life-domains orbiting the OS core — the breadth payload.
   *  Rendered both as the hero orbit satellites and the Life Modules constellation. */
  readonly domains: Domain[] = [
    {
      key: 'body',
      glyph: 'body',
      title: 'Body',
      text: 'Food + macros, an exercise library, sleep & recovery, meds & vitals, hydration, coffee, weight trend, 75-Hard — and a daily “Day in the Life” recap.',
      accent: 'cyan',
    },
    {
      key: 'home',
      glyph: 'home',
      title: 'Home & Family',
      text: 'The shared Hub: calendar, lists, notes, chores + allowance, recipes and a meal planner that builds the grocery list for the whole household.',
      accent: 'violet',
    },
    {
      key: 'money',
      glyph: 'money',
      title: 'Money',
      text: 'A full finance vertical: budgets, bills, net-worth and savings tracking, with bank-statement import to keep the whole picture current.',
      accent: 'indigo',
    },
    {
      key: 'people',
      glyph: 'people',
      title: 'People & Place',
      text: 'Contacts, family and fleet on one identity spine, plus opt-in location maps and history replay — a private “where’s everyone”, hosted by you.',
      accent: 'cyan',
    },
    {
      key: 'mind',
      glyph: 'mind',
      title: 'Mind',
      text: 'Journal and mood, habit streaks and the 75-Hard challenge — the inner-life layer the rest of your life is finally measured against.',
      accent: 'violet',
    },
    {
      key: 'comms',
      glyph: 'comms',
      title: 'Comms',
      text: 'Real-time chat — channels and DMs with reactions — and notifications across an in-app bell, toasts and the browser. The OS talks to you.',
      accent: 'indigo',
    },
  ];

  /** The agentic layer — the OS working FOR you. Proactive agents, ask-that-acts,
   *  the insight engine, the daily recap, and search. Every one is off by default,
   *  permission-gated, and prefills only. */
  readonly agents: Agent[] = [
    {
      glyph: 'recap',
      cue: 'Proactive agents work while you sleep',
      act: '— running on a cadence and dropping what matters into the Agent Inbox.',
    },
    {
      glyph: 'bolt',
      cue: 'Ask that acts',
      act: '— “jogged two miles”, “add milk to the list” becomes a confirm-chip action across any domain.',
    },
    {
      glyph: 'insight',
      cue: 'The Insight engine reads across domains',
      act: '— spend, macros, calendar, goals — and turns the patterns into plain language.',
    },
    {
      glyph: 'pulse',
      cue: 'A Day-in-the-Life recap reads your day',
      act: 'and hands back a clear summary — not another chart to decode.',
    },
    {
      glyph: 'search',
      cue: 'Search Everything',
      act: 'spans every module at once, so one box finds anything in your life.',
    },
    {
      glyph: 'capture',
      cue: 'Snap a photo or speak an intent',
      act: 'and the OS drafts the structured entry, ready for you to confirm.',
    },
  ];

  /** One platform — the trust + craft spine under the whole OS. */
  readonly proofs: Proof[] = [
    {
      glyph: 'key',
      title: 'One login for everything',
      text: 'A single Google-pinned identity opens every module — no twenty accounts, no twenty passwords. 50+ capabilities, re-checked on the server every request.',
    },
    {
      glyph: 'server',
      title: 'Your data on your servers',
      text: 'Self-hosted and open source — Angular + .NET 9 + PostgreSQL, Docker-composed to run anywhere. No seat pricing, no telemetry, nothing phones home.',
    },
    {
      glyph: 'install',
      title: 'A deep installable PWA',
      text: 'Install it like a native app and keep working offline — the OS is built to live on your home screen, not just a browser tab.',
    },
    {
      glyph: 'devices',
      title: 'Desktop + full mobile, real-time',
      text: 'Two first-class platforms — every page twinned for the phone — over one live database, with real-time chat, notifications and force-logout.',
    },
  ];

  readonly stats: Stat[] = [
    { value: 6, suffix: '', label: 'Life modules, one OS' },
    { value: 50, suffix: '+', label: 'Server-enforced caps' },
    { value: 2, suffix: '', label: 'First-class platforms' },
    { value: 100, suffix: '%', label: 'Self-hosted, yours' },
  ];

  /** Live count for each stat, mirrors `stats` by index. */
  readonly counts = signal<number[]>(this.stats.map(() => 0));

  constructor() {
    const ru = this.route.snapshot.queryParamMap.get('returnUrl');
    if (ru) this.returnUrl.set(ru);

    afterNextRender(() => {
      this.observeReveals();
      this.armCounters();
    });
  }

  /** [queryParams] binding — only forwards returnUrl when one is present. */
  signinParams(): Record<string, string> {
    const ru = this.returnUrl();
    return ru ? { returnUrl: ru } : {};
  }

  /** Progressive scroll-reveal: add `.in` as each opted-in element enters the viewport.
   *  Content is visible by default; we only arm the hidden→rise state (via the
   *  `js-reveal` host class) when IO is supported and motion is allowed. A safety
   *  timer reveals everything if the observer hasn't fired, so nothing can get
   *  stuck invisible on a backgrounded/throttled tab. */
  private observeReveals(): void {
    const els = this.reveals().map((r) => r.nativeElement);
    if (!els.length) return;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) return; // stay visible, no arming

    const hostEl = this.host.nativeElement;
    hostEl.classList.add('js-reveal');

    const revealAll = () => els.forEach((el) => el.classList.add('in'));

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));

    // Fallback: if the observer never delivers (throttled tab), reveal everything.
    const failsafe = setTimeout(revealAll, 2500);
    // Reveal-on-first-paint guard: also clear the failsafe once anything reveals.
    const armed = els[0];
    const mo = new MutationObserver(() => {
      if (armed.classList.contains('in')) {
        clearTimeout(failsafe);
        mo.disconnect();
      }
    });
    mo.observe(armed, { attributes: true, attributeFilter: ['class'] });

    // Tear down on navigation away so the timer can't fire on detached nodes.
    this.destroyRef.onDestroy(() => {
      io.disconnect();
      mo.disconnect();
      clearTimeout(failsafe);
    });
  }

  private settleCounts(): void {
    this.counts.set(this.stats.map((s) => s.value));
  }

  /** Count the stat band up once it scrolls into view (skipped under reduced-motion). */
  private armCounters(): void {
    const band = this.host.nativeElement.querySelector<HTMLElement>('.stats');
    if (!band) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      this.settleCounts();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          clearTimeout(failsafe);
          this.runCounters();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(band);
    // If the observer never fires (throttled tab), snap to final values.
    const failsafe = setTimeout(() => {
      io.disconnect();
      this.settleCounts();
    }, 3000);

    // Tear down on navigation away so the timer can't fire on detached nodes.
    this.destroyRef.onDestroy(() => {
      io.disconnect();
      clearTimeout(failsafe);
    });
  }

  private runCounters(): void {
    const start = performance.now();
    const dur = 1400;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      // easeOutCubic for a punchy settle
      const e = 1 - Math.pow(1 - t, 3);
      this.counts.set(this.stats.map((s) => Math.round(s.value * e)));
      if (t < 1) requestAnimationFrame(tick);
      else this.counts.set(this.stats.map((s) => s.value));
    };
    requestAnimationFrame(tick);
  }

  scrollTop(ev: Event): void {
    ev.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
