import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

interface FeatureBlock {
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
    {
      icon: 'hub',
      kicker: 'Unified',
      title: 'Two agents, one number',
      text: 'Claude Code and OpenAI Codex write usage logs in different shapes. Usage IQ parses both, de-duplicates the noise, and rolls them into a single source of truth.',
      points: [
        'Per-source breakdown, or everything combined',
        'Automatic de-duplication of repeated API events',
        'Sidechain / subagent spend counted — toggle on or off',
      ],
    },
    {
      icon: 'payments',
      kicker: 'Cost',
      title: 'Real dollars, your rates',
      text: 'Every token tier — input, output, and all three cache classes — is priced from a table you control. Change a rate and recompute historical cost without re-reading a single log.',
      points: [
        'Editable per-model pricing table',
        'Cache-read, 5-minute and 1-hour cache writes priced separately',
        'One-click recompute across all history',
      ],
    },
    {
      icon: 'filter_alt',
      kicker: 'Slice it',
      title: 'Filter any way you think',
      text: 'Date range, project, model, session, source. The dashboard, charts, and records table all move together so you can chase a spike to its exact cause.',
      points: [
        'Date presets and custom ranges',
        'Group by day, month, project, model, or session',
        'Paged, sortable record table with CSV export',
      ],
    },
    {
      icon: 'calendar_month',
      kicker: 'Rhythm',
      title: 'See how you actually work',
      text: 'A GitHub-style activity heatmap shows the hours your agents are busy, and a session drill-down breaks any day down to the individual run.',
      points: [
        'Active-hour heatmap by day',
        'Session-level drill-down with token + cost detail',
        'Hour-of-day chart on the main dashboard',
      ],
    },
    {
      icon: 'shield_person',
      kicker: 'Locked down',
      title: 'Yours, and only yours',
      text: 'Google sign-in gates the whole app. Permissions are per-user and re-checked on every request — not just hidden in the UI.',
      points: [
        'Google identity with an approved-account allowlist',
        'Granular, server-enforced permissions',
        'Full request audit log',
      ],
    },
    {
      icon: 'ios_share',
      kicker: 'Share',
      title: 'Show without giving away the keys',
      text: 'Generate a public, read-only link to a filtered dashboard. Set an expiry, label it, watch who opened it, and revoke it whenever you like.',
      points: [
        'Time-limited public share links',
        'Per-view IP and timestamp tracking',
        'Pop-out stat widgets per source',
      ],
    },
  ];
}
