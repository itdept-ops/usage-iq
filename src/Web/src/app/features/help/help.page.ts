import {
  ChangeDetectionStrategy, Component, computed, signal,
} from '@angular/core';

import { BetaAccordion, BetaAccordionItem, BetaSectionHeader, BetaEmptyState } from '../beta-ui';

/** One frequently-asked question + its answer, tagged with a section so the list stays scannable. */
interface Faq {
  /** The question shown on the accordion header. */
  q: string;
  /** The answer body (plain prose; rendered inside the expanded panel). */
  a: string;
  /** Section label used to group + colour the list. */
  section: string;
}

/**
 * HELP CENTER (mobile) — a searchable FAQ / help surface built on the shared beta-ui "Strata"
 * foundation (`@use '../beta-ui/beta-kit'`). A hero header carries a live search input that filters
 * the seeded Q&As by question, answer, or section; the matches render as {@link BetaAccordionItem}
 * rows inside a single-open {@link BetaAccordion}, each expanding to reveal its answer inline. When
 * a query matches nothing we drop a {@link BetaEmptyState}.
 *
 * PUBLIC-OR-AUTHED: the `/help` route carries no guard (anyone can reach it), so this page holds no
 * session/permission state and calls no Api — it is entirely static content + a client-side filter.
 * Standalone + OnPush + signals + @if/@for, matching the FiMobile mobile-page conventions. ISOLATED:
 * consumes the kit primitives (never modifies them), touches no core service, adds no npm deps.
 */
@Component({
  selector: 'app-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './help.page.scss',
  imports: [BetaAccordion, BetaAccordionItem, BetaSectionHeader, BetaEmptyState],
  template: `
    <div class="scroll">

      <!-- HERO — title + tagline + the live search field. -->
      <header class="hero">
        <span class="hero__eyebrow">Usage IQ</span>
        <h1 class="hero__title">Help Center</h1>
        <p class="hero__sub">Answers about agents, family, privacy, and your data.</p>

        <div class="search" role="search">
          <span class="search__ic" aria-hidden="true">search</span>
          <input class="search__input" type="search" inputmode="search"
                 autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="Search help…" aria-label="Search help"
                 [value]="query()" (input)="onSearch($event)" />
          @if (query()) {
            <button type="button" class="search__clear" (click)="clear()" aria-label="Clear search">×</button>
          }
        </div>
      </header>

      <!-- RESULTS — the filtered FAQ list, one accordion open at a time. -->
      @if (results().length > 0) {
        <app-bs-section-header
          [title]="query() ? 'Results' : 'Frequently asked'"
          [subtitle]="results().length + (results().length === 1 ? ' article' : ' articles')"
          icon="help_outline" />

        <app-bs-accordion [single]="true">
          @for (f of results(); track f.q) {
            <app-bs-accordion-item [label]="f.q" [hint]="f.section">
              <p class="ans">{{ f.a }}</p>
            </app-bs-accordion-item>
          }
        </app-bs-accordion>
      } @else {
        <app-bs-empty
          icon="search_off"
          title="No matches"
          [body]="'Nothing matched “' + query() + '”. Try a different word.'" />
      }

      <p class="foot">Still stuck? Reach out from Settings &rarr; Support and an agent will help.</p>

      <div class="scroll__foot"></div>
    </div>
  `,
})
export class HelpPage {
  /** The seeded FAQ corpus — real Usage IQ answers across the core capabilities. */
  protected readonly faqs: Faq[] = [
    {
      section: 'AI agents',
      q: 'How do AI agents log things for me?',
      a: 'Once you turn AI on, your agents can act on your behalf — logging meals, water, moves, and expenses from a short note, a photo, or a proactive nudge. Every automated action is recorded in the AI usage log so you can always see exactly what an agent did and undo it if needed.',
    },
    {
      section: 'AI agents',
      q: 'Is AI on by default?',
      a: 'No. AI is off for everyone until you opt in, and each AI capability is a separate permission you grant individually. You stay in control — nothing is analysed or acted on until you switch it on.',
    },
    {
      section: 'Family',
      q: 'How do I invite my family?',
      a: 'From the Family Hub, open the members list and send an invite. Kids can join with a Google login; everyone you add shares one private space for calendars, lists, chores, and finances. You choose what each member can see and do.',
    },
    {
      section: 'Family',
      q: 'Can my kids have their own logins?',
      a: 'Yes. Children join the Hub with their own Google account, which lets them complete chores, earn allowance, and see the shared family calendar — all within the limits you set as a parent.',
    },
    {
      section: 'Privacy',
      q: 'Who can see my location?',
      a: 'Location is opt-in and off until you enable it. When on, only the people you have explicitly shared with — your family in the Hub, or an admin for fleet tools — can see it on the map. You can turn location off at any time and it stops sharing immediately.',
    },
    {
      section: 'Privacy',
      q: 'Can other people see my email address?',
      a: 'No. Your email is never shown to other members — people are identified by name and public profile only. Email addresses are visible solely to administrators in the Users table for account management.',
    },
    {
      section: 'Tracker',
      q: 'How are my tracker goals calculated?',
      a: 'We start from a deterministic baseline computed from your profile (age, height, weight, activity, and your goal), then AI can optionally refine the targets. Any food suggestion always hard-excludes your allergies and dietary restrictions — that is a strict rule, not a preference.',
    },
    {
      section: 'Tracker',
      q: 'Can I share my tracker with family or contacts?',
      a: 'Yes. You can share your food and fitness tracker with chosen contacts or family members so they can follow your progress. Sharing is per-person and you can revoke it whenever you like.',
    },
    {
      section: 'Offline & apps',
      q: 'Does Usage IQ work offline?',
      a: 'Usage IQ is a Progressive Web App (PWA), so you can install it to your home screen and keep viewing recently loaded pages when your connection drops. New logging and syncing resume automatically once you are back online.',
    },
    {
      section: 'Offline & apps',
      q: 'How do I install Usage IQ on my phone?',
      a: 'Open Usage IQ in your mobile browser and choose “Add to Home Screen” from the share or menu. It installs like a native app — full-screen, with its own icon — and launches straight into the mobile experience.',
    },
    {
      section: 'Your data',
      q: 'Can I export my data?',
      a: 'Yes. You own your data and can export it from Settings — your logs, meals, and shared views come out in a portable format so you can keep a copy or move it elsewhere.',
    },
  ];

  /** The current search query (trimmed on read). */
  protected readonly query = signal('');

  /** The filtered FAQs: a case-insensitive match on question, answer, or section. */
  protected readonly results = computed<Faq[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.faqs;
    return this.faqs.filter(f =>
      f.q.toLowerCase().includes(q) ||
      f.a.toLowerCase().includes(q) ||
      f.section.toLowerCase().includes(q),
    );
  });

  protected onSearch(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
  }

  protected clear(): void {
    this.query.set('');
  }
}
