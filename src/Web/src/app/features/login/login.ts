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

/** A life-domain module that boots under the OS kernel. `accent` maps to a
 *  fixed tech token (blue/cyan/violet) reused on every marketing page so a
 *  domain always wears the same color. */
interface Domain {
  key: string;
  icon: string;
  /** monospace boot status line, e.g. "work module: mounted" */
  boot: string;
  title: string;
  text: string;
  /** which of the three tech accents tints this domain */
  accent: 'blue' | 'cyan' | 'violet';
}
interface Agent {
  icon: string;
  /** the trigger — a sentence or a photo */
  cue: string;
  /** the action the agent takes */
  act: string;
}
interface Proof {
  icon: string;
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
  imports: [MatIconModule, RouterLink, MarketingNav, MarketingFooter],
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

  /** The hero "boot sequence" — monospace status lines that type in one at a time,
   *  ending on the kernel coming fully online. Ties the OS metaphor to the real
   *  reporter terminal the product actually runs. */
  readonly boot: string[] = [
    '$ usage-iq --boot',
    '  kernel: online',
    '  mounting work · body · home',
    '  mounting people · place · growth',
    '  agents: armed · permission-gated',
    '  ✓ one system · your entire life',
  ];

  /** The six life-domains that boot under the kernel — the breadth payload.
   *  Rendered both as the constellation satellites and the domain panels. */
  readonly domains: Domain[] = [
    {
      key: 'work',
      icon: 'monitoring',
      boot: 'work module: mounted',
      title: 'Work',
      text: 'AI cost intelligence: Claude Code + Codex spend, priced to the token, sliced any way you think — plus fleet leaderboards, share links and digests.',
      accent: 'blue',
    },
    {
      key: 'body',
      icon: 'fitness_center',
      boot: 'body module: mounted',
      title: 'Body',
      text: 'Food + macros, a WorkoutX exercise library, BMI/BMR/TDEE, weight trend, hydration, watch activity, coffee, 75-Hard and trophies.',
      accent: 'cyan',
    },
    {
      key: 'home',
      icon: 'home',
      boot: 'home module: mounted',
      title: 'Home',
      text: 'The Family Hub: shared calendar, lists, notes, reminders, polls, chores + allowance, bills + budget, and a meal planner that builds the grocery list.',
      accent: 'violet',
    },
    {
      key: 'people',
      icon: 'forum',
      boot: 'people module: mounted',
      title: 'People',
      text: 'Real-time chat: channels and DMs with reactions, curated contacts and circles, and notifications across an in-app bell, toasts and the browser.',
      accent: 'blue',
    },
    {
      key: 'place',
      icon: 'location_on',
      boot: 'place module: mounted',
      title: 'Place',
      text: "Locations and a private “where’s everyone” map — opt-in, on your own infrastructure, never shared outward.",
      accent: 'cyan',
    },
    {
      key: 'growth',
      icon: 'trending_up',
      boot: 'growth module: mounted',
      title: 'Growth',
      text: 'A resume builder that tailors to a job description and exports ATS-clean, plus goals that the OS tracks against the rest of your life.',
      accent: 'violet',
    },
  ];

  /** The agentic layer — assists that turn a sentence or a photo into a logged
   *  action, then hand you the pen. Every one is off by default, prefills only. */
  readonly agents: Agent[] = [
    {
      icon: 'photo_camera',
      cue: 'Snap a photo of your dinner',
      act: 'and it returns estimated macros, ready to log.',
    },
    {
      icon: 'mic',
      cue: '“Jogged two miles”',
      act: 'becomes a structured workout, scaled to your weight.',
    },
    {
      icon: 'event',
      cue: 'Drop a photo of a schedule',
      act: 'and a week of calendar events drafts itself.',
    },
    {
      icon: 'restaurant',
      cue: '“What can I eat with 500 calories left?”',
      act: 'gets answers that fit your day — not another chart.',
    },
    {
      icon: 'auto_awesome',
      cue: 'A daily coach reads your day',
      act: 'and a weekly review reads your week.',
    },
    {
      icon: 'calculate',
      cue: 'Set a goal',
      act: 'and a deterministic baseline is refined into a plan.',
    },
  ];

  /** The trust spine — back the breadth with verifiable substance. */
  readonly proofs: Proof[] = [
    {
      icon: 'shield_person',
      title: '49 server-enforced capabilities',
      text: 'Granular permissions re-checked on the server every request — not hidden in the UI. Google-pinned identity, full audit log, real-time force-logout.',
    },
    {
      icon: 'dns',
      title: 'Self-hosted, no telemetry',
      text: 'Angular + .NET 9 + PostgreSQL, Docker-composed to run anywhere, deployed keylessly to AWS. No seat pricing. Nothing phones home.',
    },
    {
      icon: 'devices',
      title: 'Desktop and native mobile',
      text: 'One system, two first-class platforms — the same data on a grand desktop surface and a native mobile shell.',
    },
    {
      icon: 'lock',
      title: 'Agents on a leash you hold',
      text: 'Every assist is off by default, permission-gated, sees only the minimum, and never auto-logs. It prefills; you confirm.',
    },
  ];

  readonly stats: Stat[] = [
    { value: 6, suffix: '', label: 'Life-domains, one OS' },
    { value: 49, suffix: '', label: 'Server-enforced caps' },
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
