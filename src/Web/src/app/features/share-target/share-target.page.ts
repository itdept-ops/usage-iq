import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';

import { AuthService } from '../../core/auth';
import { PERM } from '../../core/models';
import { toLocalDate } from '../../core/tracker-store';
import { AddFoodDialog, AddFoodData } from '../tracker/add-food-dialog';

/**
 * Web Share Target landing page (GET).
 *
 * When the app is installed as a PWA it registers a `share_target` in the manifest pointing at `/share`
 * (method GET, params title/text/url). When the OS share sheet routes content INTO the app, the browser
 * opens `/share?title=…&text=…&url=…`. This tiny, guarded, render-nothing component:
 *
 *   1. Reads the shared title/text/url query params (all optional).
 *   2. Assembles them into a single human text string.
 *   3. Routes that text to the most useful destination — the food tracker's Add-food dialog in DESCRIBE
 *      mode, pre-seeded with the shared text (the existing {@link AddFoodDialog} `prefillQuery` seam, the
 *      SAME path the tracker page itself uses). The user edits/confirms; NOTHING auto-logs.
 *
 * Guards (it must never strand or surprise the user):
 *   - Unauthenticated → replace into the app's resolved home/login (the auth/permission guards take over).
 *   - No usable shared text → just go home (nothing to do).
 *   - No tracker access → go home (we don't open a dialog the user can't use).
 *
 * This is purely additive: the share-target only RECEIVES content (no POST / no file handling — that needs
 * a custom service worker and is out of scope). It opens the dialog itself (injecting MatDialog like the
 * tracker page does) so no existing page had to be modified.
 */
@Component({
  selector: 'app-share-target',
  standalone: true,
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShareTargetPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);

  ngOnInit(): void {
    // Everything below is best-effort: a share target must NEVER throw or block. Any surprise falls
    // through to a quiet redirect home.
    try {
      // Unauthenticated (or expired session) → hand off to the normal landing; the route guards will
      // bounce an unauthenticated caller to /login. replaceUrl so /share never sits in history.
      if (!this.auth.isAuthenticated()) {
        void this.router.navigateByUrl(this.auth.homeRoute(), { replaceUrl: true });
        return;
      }

      const text = this.assembleSharedText();

      // No usable shared text, or no tracker access → nothing meaningful to do; just land home.
      if (!text || !this.auth.hasPermission(PERM.trackerSelf)) {
        void this.router.navigateByUrl(this.auth.homeRoute(), { replaceUrl: true });
        return;
      }

      // Land on the tracker (replaceUrl: drop /share from history), then open Add-food in DESCRIBE mode
      // pre-seeded with the shared text via the existing prefillQuery seam. We open it ourselves rather
      // than touching the tracker page. afterClosed routing is the dialog's own concern (it logs nothing
      // unless the user confirms).
      void this.router
        .navigate(['/tracker'], { replaceUrl: true })
        .then(() => this.openPrefilledAddFood(text))
        .catch(() => {
          /* navigation cancelled (e.g. a guard) — nothing to clean up */
        });
    } catch {
      // Absolutely never strand the user on a blank /share page.
      try {
        void this.router.navigateByUrl('/', { replaceUrl: true });
      } catch {
        /* give up silently */
      }
    }
  }

  /**
   * Fold the (all-optional) shared title/text/url params into a single, de-duplicated text string. A share
   * may carry any subset (e.g. a browser "share page" sends title+url; a notes app sends text). We keep the
   * order title → text → url and drop a url that's already echoed inside the text so we don't seed dupes.
   */
  private assembleSharedText(): string {
    const params = this.route.snapshot.queryParamMap;
    const title = (params.get('title') ?? '').trim();
    const text = (params.get('text') ?? '').trim();
    const url = (params.get('url') ?? '').trim();

    const parts: string[] = [];
    if (title) parts.push(title);
    if (text) parts.push(text);
    // Only append the url if neither the title nor the text already contains it (common for page shares).
    if (url && !title.includes(url) && !text.includes(url)) parts.push(url);

    return parts.join('\n').trim();
  }

  /** Open the existing Add-food dialog pre-seeded in Describe mode (mirrors Tracker.openAddFood). */
  private openPrefilledAddFood(prefillQuery: string): void {
    const data: AddFoodData = {
      date: toLocalDate(new Date()),
      meal: this.defaultMeal(),
      prefillQuery,
    };
    this.dialog.open(AddFoodDialog, {
      data,
      width: '500px',
      maxWidth: '95vw',
      panelClass: 'tracker-dialog',
      autoFocus: false,
    });
  }

  /** A sensible default meal slot by local time of day (matches the tracker's quick-add heuristic). */
  private defaultMeal(): AddFoodData['meal'] {
    const h = new Date().getHours();
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snack';
  }
}
