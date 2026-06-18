import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from '../marketing/marketing-nav';
import { MarketingFooter } from '../marketing/marketing-footer';

interface Pillar { icon: string; kicker: string; title: string; text: string; }
interface Skill { name: string; tag: string; }
interface SkillGroup { label: string; icon: string; skills: Skill[]; }
interface Metric { value: string; suffix: string; label: string; }
interface Cert { short: string; full: string; }

/**
 * Public "About" page for Junior Fortunato.
 *
 * Bare layout: shared marketing nav + footer, the landing's animated grid/orb
 * backdrop, and a sequence of scroll-revealed chapters. All heavy motion is
 * gated behind `prefers-reduced-motion` and the IntersectionObserver reveal
 * degrades gracefully (everything is visible if JS/observer is unavailable).
 */
@Component({
  selector: 'app-about',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './about.html',
  styleUrl: './about.scss',
})
export class About implements AfterViewInit, OnDestroy {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private zone = inject(NgZone);

  /** Identity. */
  readonly name = 'Junior Fortunato';
  readonly descriptor = 'Software engineer · Agentic-AI builder · Founder · U.S. Army veteran';
  readonly initials = 'JF';

  /**
   * Optional portrait. Defaults to `null`, which renders the gradient-ringed
   * glowing "JF" monogram. Set to a non-null URL to render an <img> instead;
   * an (error) on that image falls back to the monogram automatically.
   */
  readonly photoUrl = signal<string | null>('junior.jpg');

  /** Drives the monogram fallback when a supplied photo fails to load. */
  readonly photoFailed = signal(false);

  onPhotoError(): void {
    this.photoFailed.set(true);
  }

  /** True when we should actually attempt to render the <img>. */
  showPhoto(): boolean {
    return this.photoUrl() !== null && !this.photoFailed();
  }

  /** Headline metrics for the animated counters. */
  readonly metrics: Metric[] = [
    { value: '3', suffix: '+', label: 'Years building with agentic AI' },
    { value: '6', suffix: '', label: 'Critical positions qualified' },
    { value: '1', suffix: '', label: 'Software company founded' },
    { value: '100', suffix: '%', label: 'Production systems shipped solo' },
  ];

  /** The three identity pillars surfaced under the hero. */
  readonly pillars: Pillar[] = [
    {
      icon: 'terminal',
      kicker: 'Engineer',
      title: 'Ships production systems, solo',
      text: 'Full-stack across C#/.NET, Angular, TypeScript, Python and SQL — design, build, deploy and operate, end to end.',
    },
    {
      icon: 'smart_toy',
      kicker: 'Agentic AI',
      title: 'Builds with the machines that build',
      text: 'An early adopter of OpenAI Codex and Claude — orchestrating multi-agent workflows that review, refactor, test and document code.',
    },
    {
      icon: 'rocket_launch',
      kicker: 'Founder · Veteran',
      title: 'Owns the whole mission',
      text: 'Founded and built a software company alone; before that, led mission-critical military communications under real pressure.',
    },
  ];

  /** Tech / skills grid. */
  readonly skillGroups: SkillGroup[] = [
    {
      label: 'Languages',
      icon: 'code',
      skills: [
        { name: 'C# / .NET', tag: 'core' },
        { name: 'TypeScript', tag: 'core' },
        { name: 'Python', tag: 'automation' },
        { name: 'SQL', tag: 'data' },
      ],
    },
    {
      label: 'Frontend',
      icon: 'web',
      skills: [
        { name: 'Angular', tag: 'spa' },
        { name: 'RxJS · Signals', tag: 'reactive' },
        { name: 'SCSS', tag: 'design' },
      ],
    },
    {
      label: 'Cloud & DevOps',
      icon: 'cloud',
      skills: [
        { name: 'AWS', tag: 'primary' },
        { name: 'Azure · GCP', tag: 'multi' },
        { name: 'Docker', tag: 'containers' },
        { name: 'CI/CD · OIDC', tag: 'pipelines' },
      ],
    },
    {
      label: 'Data & Infra',
      icon: 'storage',
      skills: [
        { name: 'PostgreSQL', tag: 'rdbms' },
        { name: 'Networking', tag: 'vlan/subnet' },
        { name: 'Security', tag: 'hardening' },
      ],
    },
    {
      label: 'Agentic AI',
      icon: 'auto_awesome',
      skills: [
        { name: 'Claude', tag: 'anthropic' },
        { name: 'OpenAI Codex', tag: 'codex cli' },
        { name: 'Multi-agent', tag: 'orchestration' },
        { name: 'Prompt engineering', tag: 'craft' },
      ],
    },
  ];

  /** Optional, technical-only credentials strip. */
  readonly certs: Cert[] = [
    { short: 'CISSP', full: 'Certified Information Systems Security Professional' },
    { short: 'AWS SA', full: 'AWS Certified Solutions Architect' },
    { short: 'CCNP', full: 'Cisco Certified Network Professional' },
    { short: 'RHCSA', full: 'Red Hat Certified System Administrator' },
    { short: 'Security+', full: 'CompTIA Security+' },
    { short: 'Network+', full: 'CompTIA Network+' },
  ];

  /** Marquee of capabilities for the agentic-AI flourish. */
  readonly marquee = [
    'rapid prototyping',
    'automated code review',
    'refactoring at scale',
    'QA planning',
    'documentation generation',
    'process automation',
    'adversarial security review',
    'multi-agent orchestration',
  ];

  private observer?: IntersectionObserver;
  private counted = false;

  constructor() {
    // Counters animate once, after the first paint, when the hero is on screen.
    afterNextRender(() => this.zone.runOutsideAngular(() => this.runCounters()));
  }

  ngAfterViewInit(): void {
    const reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const els = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-reveal]'),
    );

    // No observer support, or motion is reduced → reveal everything immediately.
    if (reduce || typeof IntersectionObserver === 'undefined') {
      els.forEach(el => el.classList.add('is-in'));
      return;
    }

    // Arm the hidden→reveal state only now that we know JS + IntersectionObserver are available, so a
    // no-JS render (or this code never running) can never leave a chapter stuck at opacity:0.
    this.host.nativeElement.classList.add('js-reveal');

    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        entries => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('is-in');
              this.observer?.unobserve(e.target);
            }
          }
        },
        { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
      );
      els.forEach(el => this.observer!.observe(el));
      // Failsafe: if the observer never delivers (throttled/backgrounded tab), reveal everything so
      // no chapter can stay hidden. Idempotent with the per-element reveals above.
      setTimeout(() => els.forEach(el => el.classList.add('is-in')), 2500);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  /** Lightweight count-up for the hero metrics; respects reduced motion. */
  private runCounters(): void {
    if (this.counted) return;
    this.counted = true;

    const reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nodes = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-count]'),
    );

    for (const node of nodes) {
      const target = Number(node.dataset['count'] ?? '0');
      if (reduce || !Number.isFinite(target) || target === 0) {
        node.textContent = String(target);
        continue;
      }
      const duration = 1100;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - t, 3);
        node.textContent = String(Math.round(target * eased));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
}
