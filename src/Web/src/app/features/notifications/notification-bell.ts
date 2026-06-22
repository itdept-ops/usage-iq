import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ChatRealtime } from '../../core/chat-realtime';
import { NotificationDto } from '../../core/models';
import { timeAgo } from '../../shared/format';

/** Material icon name per notification wire `type`, with a sensible fallback. */
const TYPE_ICON: Record<string, string> = {
  directMessage: 'alternate_email',
  mention: 'campaign',
  channelMessage: 'forum',
  systemSyncFailed: 'sync_problem',
  systemUserJoined: 'person_add',
  systemFleetOffline: 'cloud_off',
};

/** Short human label per notification type, used as the browser-notification title prefix. */
const TYPE_LABEL: Record<string, string> = {
  directMessage: 'Direct message',
  mention: 'Mention',
  channelMessage: 'New message',
  systemSyncFailed: 'Sync failed',
  systemUserJoined: 'New teammate',
  systemFleetOffline: 'Fleet offline',
};

/**
 * The toolbar notification bell. Renders the unread badge from {@link ChatRealtime.inboxUnread} and a
 * dropdown of recent {@link ChatRealtime.notifications} (newest-first). Row click marks that one read
 * and navigates to its link. Header actions mark all read / open the preferences dialog.
 *
 * It also owns the two LIVE surfaces, both driven by an effect on {@link ChatRealtime.liveNotification}
 * (which fires ONLY for hub-delivered notifications, never for the initial inbox load or a reconnect
 * re-fetch — so the backlog is never replayed):
 *   • In-app toast (MatSnackBar) when the `surfaceToasts` pref is on.
 *   • Browser/OS notification when `surfaceBrowser` is on, permission is granted, and the tab is hidden.
 * A per-instance dedupe set guards against the same notification id surfacing twice.
 *
 * The component is rendered by the app shell only when authed + chat.read, so the gating lives there;
 * this component assumes it is allowed to read the inbox.
 */
@Component({
  selector: 'app-notification-bell',
  imports: [
    MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule,
  ],
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.scss',
})
export class NotificationBell {
  private chat = inject(ChatRealtime);
  private router = inject(Router);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly timeAgo = timeAgo;

  /** Recent notifications for the dropdown (newest-first; already deduped by the service). */
  readonly notifications = this.chat.notifications;
  /** Unread notification count for the badge. */
  readonly unread = this.chat.inboxUnread;

  /** Heartbeat so the relative "time ago" labels stay fresh while the menu is open. */
  readonly now = signal(Date.now());

  /** Badge text: capped at "99+", empty (hidden) at zero. */
  readonly badgeText = computed(() => {
    const n = this.unread();
    if (n <= 0) return '';
    return n > 99 ? '99+' : String(n);
  });

  /** Accessible label for the bell button, reflecting the unread count. */
  readonly ariaLabel = computed(() => {
    const n = this.unread();
    if (n <= 0) return 'Notifications';
    return `Notifications, ${n} unread`;
  });

  /** Ids we've already surfaced live (toast/browser) so the same notification never fires twice. */
  private readonly surfaced = new Set<number>();

  constructor() {
    // LIVE-surface effect. Reads liveNotification() (set ONLY by the hub's ReceiveNotification) so the
    // initial inbox load / reconnect re-fetch never replay as toasts. The wrapper's seq changes on every
    // arrival, re-firing this effect even for a repeated id; the dedupe set keeps any single id to one
    // surface. Preferences are read freshly each time so a mid-session pref change takes effect.
    effect(() => {
      const live = this.chat.liveNotification();
      if (!live) return;
      const n = live.notification;
      if (this.surfaced.has(n.id)) return;
      this.surfaced.add(n.id);
      this.now.set(Date.now());

      const prefs = this.chat.preferences();
      if (prefs.surfaceToasts) this.showToast(n);
      if (prefs.surfaceBrowser) this.showBrowserNotification(n);
    });
  }

  /** Material icon for a notification's type. */
  iconFor(type: string): string {
    return TYPE_ICON[type] ?? 'notifications';
  }

  /** Open a notification: mark it read (if unread) and follow its link when present. */
  open(n: NotificationDto): void {
    if (!n.isRead) {
      this.chat
        .markNotificationsRead([n.id])
        .catch(() => this.snack.open('Could not update notifications', 'Dismiss', { duration: 4000 }));
    }
    this.navigate(n.link);
  }

  /** Mark every notification read (header action). */
  markAllRead(): void {
    this.chat
      .markAllNotificationsRead()
      .catch(() => this.snack.open('Could not update notifications', 'Dismiss', { duration: 4000 }));
  }

  /**
   * Open the delivery-preferences dialog (available to anyone with chat.read). The dialog component is
   * lazy-imported so its template + MatSlideToggle/MatDialog deps stay out of the eager app-shell chunk.
   */
  async openPreferences(): Promise<void> {
    const { NotificationPreferencesDialog } = await import('./notification-preferences-dialog');
    this.dialog.open(NotificationPreferencesDialog, {
      width: '480px',
      maxWidth: '95vw',
      panelClass: 'ax-dialog',
      autoFocus: false,
    });
  }

  /**
   * On open: refresh the relative-time heartbeat, and reconcile the panel's accessibility role with
   * its real markup. MatMenu hardcodes role="menu" on its panel root (for arrow-key menu semantics),
   * but our panel holds plain Tab-navigable buttons, not menuitems — so we relabel the panel root as a
   * labelled popover region. Focus is left on the panel root (MatMenu focuses it when there are no
   * focusable menu items, which is always the case here), giving deterministic, predictable focus.
   */
  onMenuOpened(): void {
    this.now.set(Date.now());
    if (typeof document === 'undefined') return;
    const panel = document.querySelector<HTMLElement>('.notif-menu.mat-mdc-menu-panel');
    if (panel) {
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'Notifications');
    }
  }

  // ---- live surfaces ----

  private showToast(n: NotificationDto): void {
    const ref = this.snack.open(n.text, n.link ? 'View' : 'Dismiss', {
      duration: 6000,
      horizontalPosition: 'right',
      verticalPosition: 'bottom',
    });
    if (n.link) ref.onAction().subscribe(() => this.navigate(n.link));
  }

  private showBrowserNotification(n: NotificationDto): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden) return; // only when the tab is backgrounded

    const title = n.actorName
      ? `${TYPE_LABEL[n.type] ?? 'Notification'} · ${n.actorName}`
      : (TYPE_LABEL[n.type] ?? 'Notification');
    try {
      const browserNotif = new Notification(title, { body: n.text, tag: `uiq-notif-${n.id}` });
      browserNotif.onclick = () => {
        window.focus();
        browserNotif.close();
        this.navigate(n.link);
      };
    } catch {
      // Constructing a Notification can throw in some embedded contexts; ignore — the bell still shows it.
    }
  }

  /** Navigate to a notification link (an in-app path like /chat?c=..&m=..). No-ops when absent. */
  private navigate(link: string | undefined): void {
    if (!link) return;
    void this.router.navigateByUrl(link);
  }
}
