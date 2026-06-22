import { CommonModule } from '@angular/common';
import {
  Component, ElementRef, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {
  MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA,
} from '@angular/material/dialog';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  AccessPolicy, AuditEntry, ChatContactDto, LoginEvent, ManagedUser, PermissionItem, PermissionPreset,
  PERM, PERM_GROUP_ORDER,
} from '../../core/models';

/**
 * Tiny modal that prompts for the email-reveal key (single password-style input). Closes with the
 * trimmed key on submit, or `undefined` on cancel. The key lives only in the caller's memory — this
 * dialog never persists it. Kept in this file to keep the email-gate feature self-contained.
 */
@Component({
  selector: 'app-email-reveal-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
  ],
  template: `
    <h2 mat-dialog-title id="email-reveal-title">Show emails</h2>
    <mat-dialog-content>
      <p class="erd-sub">Enter the reveal key to show real email addresses on this page. The key is held in
        memory only for this session and is never saved.</p>
      <form (ngSubmit)="submit()">
        <mat-form-field appearance="outline" class="erd-field" subscriptSizing="dynamic">
          <mat-label>Reveal key</mat-label>
          <input matInput #keyInput type="password" name="revealKey" autocomplete="off"
                 aria-label="Email reveal key" [(ngModel)]="key" cdkFocusInitial />
          <mat-icon matPrefix>lock</mat-icon>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button color="primary" type="button" [disabled]="!key.trim()"
              (click)="submit()">Show emails</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .erd-sub { margin: 0 0 14px; max-width: 380px; font-size: 13px; line-height: 1.5; color: var(--tech-text-secondary); }
    .erd-field { width: 100%; }
    [mat-dialog-title] { font-family: var(--tech-font-ui); }
  `],
})
export class EmailRevealDialog {
  private ref = inject(MatDialogRef<EmailRevealDialog, string | undefined>);
  key = '';

  submit(): void {
    const k = this.key.trim();
    if (k) this.ref.close(k);
  }

  cancel(): void { this.ref.close(undefined); }
}

/**
 * A named-button confirm dialog for sensitive actions (AI/destructive grants, disable, force-logout,
 * delete). Unlike the routine Undo-toast path, these REQUIRE a deliberate click on a labelled button so a
 * fast click can't fat-finger a token-spending grant or a disruptive change. The confirm button carries
 * the action's own verb (never a bare "OK") and can be tinted as a danger action.
 */
interface ConfirmData {
  title: string;
  /** Body lines (e.g. the named affected users + what will change). */
  lines: string[];
  /** The labelled confirm button text (the action's verb, e.g. "Disable 3 users"). */
  confirmLabel: string;
  /** Tint the confirm button as a destructive/danger action. */
  danger?: boolean;
}

@Component({
  selector: 'app-users-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @for (l of data.lines; track $index) { <p class="ucd-line">{{ l }}</p> }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close(false)">Cancel</button>
      <button mat-flat-button type="button" [class.ucd-danger]="data.danger" color="primary"
              cdkFocusInitial (click)="ref.close(true)">{{ data.confirmLabel }}</button>
    </mat-dialog-actions>
  `,
  styles: [`
    [mat-dialog-title] { font-family: var(--tech-font-ui); }
    .ucd-line { margin: 0 0 8px; width: 100%; font-size: 13px; line-height: 1.5; color: var(--tech-text-secondary); }
    .ucd-line:last-child { margin-bottom: 0; }
    .ucd-danger { --mdc-filled-button-container-color: var(--tech-error, #ff5c6c); --mdc-filled-button-label-text-color: #fff; }
  `],
})
export class UsersConfirmDialog {
  readonly ref = inject(MatDialogRef<UsersConfirmDialog, boolean>);
  readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

/** Lazy-loaded login-history state for one user's detail. */
interface LoginHistory {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  events: LoginEvent[];
}

/** Lazy-loaded chat-contacts (circle) state for one user's detail. Only shown to contact managers. */
interface ContactsState {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  /** That user's current contacts. */
  contacts: ChatContactDto[];
  /** Search box for the add-control (filters the directory). */
  query: string;
  /** AppUser id currently being added/removed (disables that control + shows progress). */
  busyUserId: number | null;
}

/** A catalog group with its ordered permission items — drives the grouped accordions + summaries. */
interface PermGroup {
  name: string;
  perms: PermissionItem[];
  /** True for the AI group, rendered as a visually distinct section that gates token-spending features. */
  isAi: boolean;
}

/** How the list is filtered by capability: a single permission key, the "has AI" axis, or none. */
type CapFilter = 'all' | 'ai' | 'enabled' | 'disabled' | 'perm';

/** A landing-page option for the "Lands on" picker (route + label), shown only when the user can reach it. */
interface HomeOption { route: string; label: string; }

/** The delta of a staged grant-set vs an applied role: keys added on top of, and removed from, the role. */
interface RoleDelta { added: string[]; removed: string[]; }

@Component({
  selector: 'app-users',
  imports: [
    CommonModule, RouterLink, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatCheckboxModule, MatSlideToggleModule, MatProgressBarModule, MatProgressSpinnerModule,
    MatTooltipModule, MatMenuModule, MatSelectModule, MatSnackBarModule, MatDialogModule,
  ],
  templateUrl: './users.html',
  styleUrl: './users.scss',
})
export class Users {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  /**
   * Shared robust sizing for every dialog this page opens. `maxWidth:95vw` overrides Material's default
   * 80vw cap so a fixed `width` reflows to the viewport on phones; `maxHeight:90dvh` + the `app-dialog`
   * panelClass (whose global rule lets the CONTENT scroll) keep the action row reachable on tall lists.
   */
  private static readonly DIALOG_OPTS = { maxWidth: '95vw', maxHeight: '90dvh', panelClass: 'app-dialog' } as const;

  /** The detail heading — selection moves focus here (accessibility). */
  private detailHeading = viewChild<ElementRef<HTMLElement>>('detailHeading');

  // ---- Email reveal (gated by a key) ----
  // The key lives in COMPONENT MEMORY ONLY — never localStorage, never a URL. Null => emails are masked.
  private revealKey: string | null = null;
  /** True once a key has yielded real emails — drives the toggle label/icon + masked placeholders. */
  readonly emailsRevealed = signal(false);
  /** In-flight guard for the reveal/hide re-fetch (disables the toggle, shows progress). */
  readonly revealing = signal(false);

  /** The caller's own email, used to detect a successful reveal (their own email is always returned real). */
  private get myEmail(): string | null {
    return this.auth.session()?.email?.toLowerCase() ?? null;
  }

  readonly perms = signal<PermissionItem[]>([]);
  readonly presets = signal<PermissionPreset[]>([]);
  readonly users = signal<ManagedUser[]>([]);
  readonly audit = signal<AuditEntry[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  // The user currently being force-logged-out / home-set (disables those controls + shows busy state).
  readonly loggingOutId = signal<number | null>(null);
  readonly homeSavingId = signal<number | null>(null);

  // ---- Search + filter ----
  /** Free-text search across name + email (email matched only when revealed). */
  readonly search = signal('');
  /** Capability filter axis + (for 'perm') its key. */
  readonly capFilter = signal<CapFilter>('all');
  readonly filterPerm = signal<string>('');
  /** Filter to a single role's exact key-set (a clean role match), or '' for any. */
  readonly filterRole = signal<string>('');

  // ---- Master-detail selection ----
  /** The AppUser id currently open in the detail pane (null = none). */
  readonly selectedId = signal<number | null>(null);
  /** On narrow screens, the card grid drills into a full-screen detail; this flags that drill-in. */
  readonly mobileDetailOpen = signal(false);

  // ---- Staged edit (the working copy of the selected user; Save flushes it via the existing PUT) ----
  /** The selected user's staged grant set (mutated by toggles/role-picks until Save). */
  readonly draftPerms = signal<Set<string>>(new Set());
  /** The selected user's staged enabled flag. */
  readonly draftEnabled = signal(true);
  /** The role key the admin last APPLIED to the selected user (drives the delta badge), or '' if none. */
  readonly appliedRole = signal<string>('');

  // ---- Bulk selection ----
  /** AppUser ids currently checked for a bulk action. */
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly bulkRunning = signal(false);
  readonly bulkDone = signal(0);
  readonly bulkTotal = signal(0);

  // ---- Per-user detail lazy data (login history + contacts) ----
  readonly logins = signal<Map<number, LoginHistory>>(new Map());
  readonly contacts = signal<Map<number, ContactsState>>(new Map());
  readonly directory = signal<ChatContactDto[]>([]);
  private directoryLoaded = false;
  /** Polite SR announcement (selection change + contacts add/remove); read by an aria-live region. */
  readonly liveStatus = signal('');
  /** Visible only to contact managers; mirrors the chat.contacts.manage backend gate. */
  readonly canManageContacts = computed(() => this.auth.hasPermission(PERM.chatContactsManage));
  readonly canEditContacts = computed(() => this.canManageContacts());

  // new-user form
  readonly newEmail = signal('');
  readonly newEnabled = signal(true);
  readonly newPerms = signal<Set<string>>(new Set([PERM.dashboardView]));
  readonly adding = signal(false);
  readonly addOpen = signal(false);

  // access policy (open sign-up + default permissions)
  readonly policy = signal<AccessPolicy | null>(null);
  readonly policyPerms = signal<Set<string>>(new Set());
  readonly savingPolicy = signal(false);
  readonly canManage = computed(() => this.auth.hasPermission(PERM.usersManage));

  /** Collapsed-state of each detail group accordion (keyed by group name). AI panel is separate. */
  readonly collapsedGroups = signal<Set<string>>(new Set());

  /**
   * route -> the permission key(s) that grant access; the caller needs ANY one. Mirrors auth.ts's
   * homePerms (and the backend HomeRoutes.Map) EXACTLY so the "Lands on" picker only offers pages the
   * TARGET user can actually reach (intersect their grant set with this map).
   */
  private static readonly homePerms: Readonly<Record<string, readonly string[]>> = {
    '/': [PERM.dashboardView],
    '/calendar': [PERM.calendarView],
    '/pricing': [PERM.pricingView],
    '/reporter': [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf],
    '/fleet': [PERM.fleetView, PERM.reporterManage],
    '/tracker': [PERM.trackerSelf],
    '/family': [PERM.familyUse],
    '/chat': [PERM.chatRead],
    '/locations': [PERM.locationSelf],
    '/users': [PERM.usersView],
    '/activity': [PERM.activityView],
    '/settings': [PERM.settingsView],
  };

  /** Landing-page options in nav order (route + label) — mirrors app.ts's homeOptionDefs. */
  private static readonly homeOptionDefs: readonly HomeOption[] = [
    { route: '/', label: 'Dashboard' },
    { route: '/calendar', label: 'Calendar' },
    { route: '/pricing', label: 'Pricing' },
    { route: '/reporter', label: 'Reporter' },
    { route: '/fleet', label: 'Fleet' },
    { route: '/tracker', label: 'Tracker' },
    { route: '/family', label: 'Family' },
    { route: '/chat', label: 'Chat' },
    { route: '/locations', label: 'My locations' },
    { route: '/users', label: 'Users' },
    { route: '/activity', label: 'Activity' },
    { route: '/settings', label: 'Settings' },
  ];

  /**
   * Permission catalog grouped by the server-provided group, in PERM_GROUP_ORDER. Any group the order
   * list doesn't mention is appended after. The AI group is flagged for its separate, tinted section.
   */
  readonly groups = computed<PermGroup[]>(() => {
    const byGroup = new Map<string, PermissionItem[]>();
    for (const p of this.perms()) {
      (byGroup.get(p.group) ?? byGroup.set(p.group, []).get(p.group)!).push(p);
    }
    const ordered: PermGroup[] = [];
    const mk = (name: string, perms: PermissionItem[]): PermGroup =>
      ({ name, perms, isAi: perms.some(p => p.isAi) });
    for (const name of PERM_GROUP_ORDER) {
      const perms = byGroup.get(name);
      if (perms?.length) { ordered.push(mk(name, perms)); byGroup.delete(name); }
    }
    for (const [name, perms] of byGroup) if (perms.length) ordered.push(mk(name, perms));
    return ordered;
  });

  /** The non-AI (feature-access) groups — the accordion spine of the detail editor. */
  readonly featureGroups = computed(() => this.groups().filter(g => !g.isAi));
  /** The AI groups (normally exactly one) — rendered as a separated, tinted panel. */
  readonly aiGroups = computed(() => this.groups().filter(g => g.isAi));
  /** Every AI permission key (for the AI summary, AI filter, AI badge). */
  readonly aiKeys = computed(() => new Set(this.aiGroups().flatMap(g => g.perms.map(p => p.key))));

  /** Quick label/description lookup for a permission key (for summaries + menus). */
  readonly permByKey = computed(() => {
    const m = new Map<string, PermissionItem>();
    for (const p of this.perms()) m.set(p.key, p);
    return m;
  });

  /**
   * The permission keys the server refuses to persist as an open-sign-up default (mirrors the backend's
   * Permissions.IsDefaultable). New accounts must never INHERIT these — admin/privileged/private/
   * token-spending capabilities granted deliberately per user. Hidden from the default-permissions picker.
   */
  private readonly nonDefaultable = new Set<string>([
    PERM.usersManage, PERM.chatModerate, PERM.chatContactsManage, PERM.trackerViewAll,
    PERM.familyUse, PERM.familyFinance,
    PERM.locationSelf, PERM.locationShare,
    PERM.trackerAi, PERM.familyAi, PERM.familyAiAssistant, PERM.financeAi, PERM.chatAi, PERM.aiVision,
  ]);

  /** Catalog groups for the default-permissions picker, filtered to server-defaultable keys. */
  readonly policyGroups = computed<PermGroup[]>(() =>
    this.groups()
      .map(g => ({ ...g, perms: g.perms.filter(p => !this.nonDefaultable.has(p.key)) }))
      .filter(g => g.perms.length),
  );

  // ---- The selected user + its derived editor state ----

  /** The currently-selected user row (the canonical saved copy — the draft signals hold edits). */
  readonly selected = computed<ManagedUser | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.users().find(u => u.id === id) ?? null;
  });

  /**
   * Detect which role a permission SET matches exactly (a clean role match), or '' if none. Used to seed
   * the role picker when a user is selected, and to label the list rows + the role filter.
   */
  matchRole(permKeys: string[] | Set<string>): string {
    const have = permKeys instanceof Set ? permKeys : new Set(permKeys);
    for (const p of this.presets()) {
      if (p.permissions.length !== have.size) continue;
      if (p.permissions.every(k => have.has(k))) return p.key;
    }
    return '';
  }

  /** The role currently reflected by the STAGED grants ('' = custom / no clean match). */
  readonly draftRole = computed(() => this.matchRole(this.draftPerms()));

  /**
   * The delta of the staged grants vs the APPLIED role: what's been added on top, and removed from, the
   * role. Empty when no role is applied or the draft matches it exactly. Drives the "+x / −y" badge.
   */
  readonly roleDelta = computed<RoleDelta>(() => {
    const role = this.presets().find(p => p.key === this.appliedRole());
    if (!role) return { added: [], removed: [] };
    const roleSet = new Set(role.permissions);
    const draft = this.draftPerms();
    const added = [...draft].filter(k => !roleSet.has(k));
    const removed = role.permissions.filter(k => !draft.has(k));
    return { added, removed };
  });

  /** Whether the staged edits differ from the saved row (drives the dirty Save bar). */
  readonly dirty = computed(() => {
    const u = this.selected();
    if (!u) return false;
    if (this.draftEnabled() !== u.isEnabled) return true;
    const saved = new Set(u.permissions);
    const draft = this.draftPerms();
    if (saved.size !== draft.size) return true;
    for (const k of draft) if (!saved.has(k)) return true;
    return false;
  });

  /** The grant DIFF vs the saved row: keys added (+) and removed (−) by the staged edits. */
  readonly saveDiff = computed<RoleDelta>(() => {
    const u = this.selected();
    if (!u) return { added: [], removed: [] };
    const saved = new Set(u.permissions);
    const draft = this.draftPerms();
    return {
      added: [...draft].filter(k => !saved.has(k)),
      removed: u.permissions.filter(k => !draft.has(k)),
    };
  });

  /** The total count of staged changes (grant adds + removes + an enabled flip) for the Save bar. */
  readonly saveCount = computed(() => {
    const d = this.saveDiff();
    const u = this.selected();
    const enabledFlip = u && this.draftEnabled() !== u.isEnabled ? 1 : 0;
    return d.added.length + d.removed.length + enabledFlip;
  });

  /** True when the staged save adds any AI key, or disables the user — needs a named-button confirm. */
  readonly saveNeedsConfirm = computed(() => {
    const u = this.selected();
    if (!u) return false;
    const ai = this.aiKeys();
    const disabling = u.isEnabled && !this.draftEnabled();
    return disabling || this.saveDiff().added.some(k => ai.has(k));
  });

  /** The "Lands on" home-page options for the SELECTED user — pages their SAVED grant set can reach. */
  readonly homeOptions = computed<HomeOption[]>(() => {
    const u = this.selected();
    if (!u) return [];
    const held = new Set(u.permissions);
    return Users.homeOptionDefs.filter(o => {
      const req = Users.homePerms[o.route];
      return req && req.some(k => held.has(k));
    });
  });

  /** The users left after the search box + capability/role filter. */
  readonly filteredUsers = computed<ManagedUser[]>(() => {
    const q = this.search().trim().toLowerCase();
    const cap = this.capFilter();
    const permKey = this.filterPerm();
    const role = this.presets().find(p => p.key === this.filterRole());
    const roleSet = role ? new Set(role.permissions) : null;
    const ai = this.aiKeys();

    return this.users().filter(u => {
      if (q) {
        const hay = `${u.name ?? ''} ${u.email ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleSet) {
        if (u.permissions.length !== roleSet.size) return false;
        if (!u.permissions.every(k => roleSet.has(k))) return false;
      }
      switch (cap) {
        case 'ai': if (!u.permissions.some(k => ai.has(k))) return false; break;
        case 'enabled': if (!u.isEnabled) return false; break;
        case 'disabled': if (u.isEnabled) return false; break;
        case 'perm': if (permKey && !u.permissions.includes(permKey)) return false; break;
      }
      return true;
    });
  });

  /** True when any search/filter is narrowing the list. */
  readonly isFiltering = computed(() =>
    !!this.search().trim() || this.capFilter() !== 'all' || !!this.filterRole(),
  );

  // ---- Bulk selection helpers ----
  isSelected(id: number): boolean { return this.selectedIds().has(id); }
  readonly bulkCount = computed(() => this.selectedIds().size);
  readonly allVisibleSelected = computed(() => {
    const vis = this.filteredUsers();
    if (!vis.length) return false;
    const sel = this.selectedIds();
    return vis.every(u => sel.has(u.id));
  });
  readonly someVisibleSelected = computed(() => {
    const sel = this.selectedIds();
    const n = this.filteredUsers().filter(u => sel.has(u.id)).length;
    return n > 0 && n < this.filteredUsers().length;
  });

  constructor() {
    this.load();
    // When the selected user changes, move focus to the detail heading + announce (accessibility).
    effect(() => {
      const u = this.selected();
      if (!u) return;
      queueMicrotask(() => {
        this.detailHeading()?.nativeElement.focus();
        this.liveStatus.set(`Editing ${u.name || this.userLabel(u)}.`);
      });
    });
  }

  private load(): void {
    this.loading.set(true);
    forkJoin({
      perms: this.api.permissionCatalog(),
      presets: this.api.permissionPresets(),
      users: this.api.users(this.revealKey ?? undefined),
    }).subscribe({
      next: r => {
        this.perms.set(r.perms);
        this.presets.set(r.presets);
        this.users.set(r.users);
        this.pruneSelection();
        this.reconcileSelection();
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.snack.open('Failed to load users', 'Dismiss', { duration: 4000 }); },
    });
    this.loadAudit();
    this.loadPolicy();
  }

  /** Drop any bulk-selected ids that no longer exist (e.g. after a reload/delete). */
  private pruneSelection(): void {
    const live = new Set(this.users().map(u => u.id));
    this.selectedIds.update(s => {
      const next = new Set([...s].filter(id => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }

  /** After a reload, keep the open detail in sync (re-seed the draft from the fresh saved row, or close). */
  private reconcileSelection(): void {
    const id = this.selectedId();
    if (id == null) return;
    const u = this.users().find(x => x.id === id);
    if (!u) { this.selectedId.set(null); this.mobileDetailOpen.set(false); return; }
    this.seedDraft(u);
  }

  private loadPolicy(): void {
    this.api.getAccessPolicy().subscribe({
      next: p => { this.policy.set(p); this.policyPerms.set(new Set(p.defaultPermissions)); },
      error: () => { /* non-critical — panel hides if policy unavailable */ },
    });
  }

  private loadAudit(): void {
    this.api.auditLog(this.revealKey ?? undefined).subscribe({ next: a => this.audit.set(a), error: () => { /* non-critical */ } });
  }

  // ---- Search + filter ----
  clearFilters(): void {
    this.search.set('');
    this.capFilter.set('all');
    this.filterPerm.set('');
    this.filterRole.set('');
  }

  /** Toggle a capability axis chip; clicking the active one clears it. */
  toggleCap(cap: CapFilter): void {
    this.capFilter.update(c => c === cap ? 'all' : cap);
    if (this.capFilter() !== 'perm') this.filterPerm.set('');
  }

  setFilterPerm(key: string): void {
    this.filterPerm.set(key);
    this.capFilter.set(key ? 'perm' : 'all');
  }

  setFilterRole(key: string): void { this.filterRole.set(key); }

  // ---- Email-reveal toggle ----
  toggleEmails(): void {
    if (this.emailsRevealed()) { this.hideEmails(); return; }
    this.promptForKey();
  }

  private promptForKey(): void {
    const ref = this.dialog.open(EmailRevealDialog, { ...Users.DIALOG_OPTS, width: '380px', autoFocus: 'dialog', restoreFocus: true });
    ref.afterClosed().subscribe((key: string | undefined) => {
      if (!key) return;
      this.applyRevealKey(key);
    });
  }

  private applyRevealKey(key: string): void {
    this.revealing.set(true);
    forkJoin({ users: this.api.users(key), audit: this.api.auditLog(key) }).subscribe({
      next: ({ users, audit }) => {
        this.revealing.set(false);
        if (this.didReveal(users, audit)) {
          this.revealKey = key;
          this.users.set(users);
          this.audit.set(audit);
          this.reconcileSelection();
          this.emailsRevealed.set(true);
          this.snack.open('Emails revealed', 'OK', { duration: 2000 });
        } else {
          this.revealKey = null;
          this.snack.open('Incorrect key', 'Dismiss', { duration: 4000 });
        }
      },
      error: () => {
        this.revealing.set(false);
        this.snack.open('Incorrect key', 'Dismiss', { duration: 4000 });
      },
    });
  }

  private didReveal(users: ManagedUser[], audit: AuditEntry[]): boolean {
    const mine = this.myEmail;
    const isOther = (e: string | null) => !!e && e.toLowerCase() !== mine;
    return users.some(u => isOther(u.email))
      || audit.some(a => isOther(a.actorEmail) || isOther(a.targetEmail));
  }

  private hideEmails(): void {
    this.revealKey = null;
    this.emailsRevealed.set(false);
    this.load();
  }

  // ---- Master-detail selection ----

  /** Open a user in the detail pane (seeds the staged edit + lazy-loads detail data). */
  select(u: ManagedUser, mobileDrill = false): void {
    // Guard an unsaved edit before switching away (themed confirm, matching the rest of the page).
    if (this.selectedId() != null && this.selectedId() !== u.id && this.dirty()) {
      this.confirmDiscard(() => this.openDetail(u, mobileDrill));
      return;
    }
    this.openDetail(u, mobileDrill);
  }

  /** Commit the selection + lazy-load its detail data (the non-guarded body of `select`). */
  private openDetail(u: ManagedUser, mobileDrill: boolean): void {
    this.selectedId.set(u.id);
    this.seedDraft(u);
    if (mobileDrill) this.mobileDetailOpen.set(true);
    if (!this.logins().has(u.id)) this.loadLogins(u.id);
    if (this.canEditContacts()) {
      if (!this.contacts().has(u.id)) this.loadContacts(u);
      this.ensureDirectory();
    }
  }

  /**
   * Themed "discard unsaved changes?" confirm — reuses UsersConfirmDialog so the prompt is sized/styled
   * like the rest of the area (replaces the OS-native `confirm()`). Runs `onDiscard` only on accept.
   */
  private confirmDiscard(onDiscard: () => void): void {
    const ref = this.dialog.open(UsersConfirmDialog, {
      ...Users.DIALOG_OPTS, width: '420px',
      data: {
        title: 'Discard unsaved changes?',
        lines: ['You have unsaved changes to this user.', 'They will be lost if you continue.'],
        confirmLabel: 'Discard changes',
        danger: true,
      } as ConfirmData,
    });
    ref.afterClosed().subscribe(ok => { if (ok) onDiscard(); });
  }

  /** Seed the staged draft from a saved row + detect its current role. */
  private seedDraft(u: ManagedUser): void {
    this.draftPerms.set(new Set(u.permissions));
    this.draftEnabled.set(u.isEnabled);
    this.appliedRole.set(this.matchRole(u.permissions));
    this.collapsedGroups.set(new Set());
  }

  /** Close the detail (mobile Back / deselect). Guards an unsaved edit with the themed confirm. */
  closeDetail(): void {
    if (this.dirty()) { this.confirmDiscard(() => this.doCloseDetail()); return; }
    this.doCloseDetail();
  }

  private doCloseDetail(): void {
    this.mobileDetailOpen.set(false);
    this.selectedId.set(null);
  }

  /** Revert the staged edit back to the saved row. */
  resetDraft(): void {
    const u = this.selected();
    if (u) this.seedDraft(u);
  }

  // ---- Login history ----
  loginHistory(id: number): LoginHistory | undefined { return this.logins().get(id); }

  private setLoginHistory(id: number, state: LoginHistory): void {
    this.logins.update(m => new Map(m).set(id, state));
  }

  private loadLogins(id: number): void {
    this.setLoginHistory(id, { loading: true, loaded: false, error: false, events: [] });
    this.api.userLogins(id).subscribe({
      next: events => this.setLoginHistory(id, { loading: false, loaded: true, error: false, events }),
      error: () => this.setLoginHistory(id, { loading: false, loaded: true, error: true, events: [] }),
    });
  }

  // ---- Access summary (readable "what they can DO") — derived from the STAGED draft ----

  /**
   * A readable summary of a grant set's FEATURE (non-AI) access, grouped: the groups they hold at least
   * one permission in, each with its granted labels. Drives the plain-language access summary.
   */
  accessSummary(permKeys: Set<string>): { name: string; labels: string[] }[] {
    const out: { name: string; labels: string[] }[] = [];
    for (const g of this.featureGroups()) {
      const labels = g.perms.filter(p => permKeys.has(p.key)).map(p => p.label);
      if (labels.length) out.push({ name: g.name, labels });
    }
    return out;
  }

  /** The AI capabilities held (labels), for the distinct AI line in the summary. */
  aiSummary(permKeys: Set<string>): string[] {
    return this.aiGroups().flatMap(g => g.perms).filter(p => permKeys.has(p.key)).map(p => p.label);
  }

  /**
   * A single plain-language sentence of what a user can DO, derived from grants. Reused for both the
   * one-line list/card summary and the mandatory per-user summary line ("Manages the family, tracks
   * fitness, uses Family & Chat AI; no admin or finance").
   */
  oneLineSummary(u: ManagedUser): string {
    return this.summaryFor(new Set(u.permissions));
  }

  /** Plain-language summary of a grant set (used by oneLineSummary + the live detail echo). */
  summaryFor(held: Set<string>): string {
    const has = (k: string) => held.has(k);
    const parts: string[] = [];
    if (has(PERM.usersManage)) parts.push('Administers users');
    else if (has(PERM.usersView)) parts.push('Views users');
    if (has(PERM.familyUse)) parts.push(has(PERM.familyFinance) ? 'manages the family incl. finance' : 'manages the family');
    if (has(PERM.trackerSelf)) parts.push('tracks fitness');
    if (has(PERM.chatRead)) parts.push('uses chat');
    if (has(PERM.dashboardView)) parts.push('sees usage');
    if (has(PERM.locationSelf)) parts.push('shares location');

    const ai = this.aiSummary(held);
    let sentence = parts.length
      ? parts.join(', ').replace(/^./, c => c.toUpperCase())
      : 'No access yet';
    if (ai.length) sentence += `; uses AI (${ai.length})`;
    else sentence += '; no AI';
    return sentence;
  }

  /** True when a grant set holds any AI permission (drives the AI badge). */
  hasAnyAi(permKeys: string[] | Set<string>): boolean {
    const ai = this.aiKeys();
    const it = permKeys instanceof Set ? permKeys : new Set(permKeys);
    for (const k of it) if (ai.has(k)) return true;
    return false;
  }

  /** A short role/AI badge label for a list row ("Administrator", "Family member", "Custom"). */
  roleLabel(u: ManagedUser): string {
    const key = this.matchRole(u.permissions);
    if (key) return this.presets().find(p => p.key === key)?.label ?? 'Custom';
    return u.permissions.length ? 'Custom' : 'No role';
  }

  // ---- Detail editor: grant toggles + role picker ----

  draftHas(key: string): boolean { return this.draftPerms().has(key); }

  toggleDraftPerm(key: string, checked: boolean): void {
    this.draftPerms.update(s => {
      const next = new Set(s);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  /** Apply a role to the staged draft — SEEDS the grants (replaces the draft) + records the applied role. */
  applyRole(roleKey: string): void {
    const role = this.presets().find(p => p.key === roleKey);
    if (!role) return;
    this.draftPerms.set(new Set(role.permissions));
    this.appliedRole.set(roleKey);
    this.liveStatus.set(`Seeded ${role.label}. Review and Save.`);
  }

  /** "Reset to role" — restore the applied role's exact grant set (clears the delta). */
  resetToRole(): void {
    const role = this.presets().find(p => p.key === this.appliedRole());
    if (role) this.draftPerms.set(new Set(role.permissions));
  }

  /** Count of a group's permissions currently on in the draft (for the accordion "N of M on" header). */
  groupOnCount(g: PermGroup): number {
    const draft = this.draftPerms();
    return g.perms.filter(p => draft.has(p.key)).length;
  }

  isGroupCollapsed(name: string): boolean { return this.collapsedGroups().has(name); }

  toggleGroup(name: string): void {
    this.collapsedGroups.update(s => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // ---- Home-route ("Lands on") picker ----

  /** Set (or clear) the SELECTED user's landing page via adminSetHomeRoute (PATCH /api/users/{id}/home). */
  setHomeRoute(route: string | null): void {
    const u = this.selected();
    if (!u) return;
    const value = route || null;
    this.homeSavingId.set(u.id);
    this.api.adminSetHomeRoute(u.id, value).subscribe({
      next: updated => {
        this.homeSavingId.set(null);
        this.users.update(list => list.map(x => x.id === updated.id ? updated : x));
        this.loadAudit();
        this.snack.open(`Set landing page for ${u.name || this.userLabel(u)}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.homeSavingId.set(null);
        this.snack.open(err.error?.message ?? 'Could not set landing page', 'Dismiss', { duration: 5000 });
      },
    });
  }

  // ---- Stage-and-save ----

  /** Flush the staged edit to the server (the existing per-user PUT). Routine vs sensitive paths differ. */
  save(): void {
    const u = this.selected();
    if (!u || !this.dirty()) return;
    if (this.saveNeedsConfirm()) { this.confirmAndSave(u); return; }
    this.commitSave(u, /*announceUndo*/ true);
  }

  /** Named-button confirm for an AI/disable-bearing save before committing. */
  private confirmAndSave(u: ManagedUser): void {
    const diff = this.saveDiff();
    const ai = this.aiKeys();
    const aiAdds = diff.added.filter(k => ai.has(k)).map(k => this.permByKey().get(k)?.label ?? k);
    const disabling = u.isEnabled && !this.draftEnabled();
    const lines = [`User: ${u.name || this.userLabel(u)}.`];
    if (aiAdds.length) lines.push(`Grants token-spending AI: ${aiAdds.join(', ')}.`);
    if (disabling) lines.push('Disables the account — they can no longer sign in.');
    const ref = this.dialog.open(UsersConfirmDialog, {
      ...Users.DIALOG_OPTS, width: '440px',
      data: { title: 'Confirm sensitive changes', lines, confirmLabel: 'Save changes', danger: disabling } as ConfirmData,
    });
    ref.afterClosed().subscribe(ok => { if (ok) this.commitSave(u, /*announceUndo*/ false); });
  }

  /** The actual PUT. On the routine path, offer an Undo snackbar that re-saves the prior grant set. */
  private commitSave(u: ManagedUser, announceUndo: boolean): void {
    const prior = { permissions: [...u.permissions], isEnabled: u.isEnabled };
    const body = { name: u.name, isEnabled: this.draftEnabled(), permissions: [...this.draftPerms()] };
    this.saving.set(true);
    this.api.updateUser(u.id, body).subscribe({
      next: updated => {
        this.saving.set(false);
        this.users.update(list => list.map(x => x.id === updated.id ? updated : x));
        this.seedDraft(updated);
        this.loadAudit();
        if (announceUndo) {
          const ref = this.snack.open(`Saved ${this.userLabel(u)}`, 'Undo', { duration: 6000 });
          ref.onAction().subscribe(() => this.undoSave(u.id, prior));
        } else {
          this.snack.open(`Saved ${this.userLabel(u)}`, 'OK', { duration: 2500 });
        }
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.snack.open(err.error?.message ?? 'Save failed', 'Dismiss', { duration: 5000 });
        this.load();
      },
    });
  }

  /** Re-save a user's prior grant set (the Undo action of a routine save). */
  private undoSave(id: number, prior: { permissions: string[]; isEnabled: boolean }): void {
    const u = this.users().find(x => x.id === id);
    const name = u ? this.userLabel(u) : `user #${id}`;
    this.api.updateUser(id, { name: u?.name, isEnabled: prior.isEnabled, permissions: prior.permissions }).subscribe({
      next: updated => {
        this.users.update(list => list.map(x => x.id === updated.id ? updated : x));
        if (this.selectedId() === id) this.seedDraft(updated);
        this.loadAudit();
        this.snack.open(`Reverted ${name}`, 'OK', { duration: 2500 });
      },
      error: () => this.snack.open('Could not undo', 'Dismiss', { duration: 4000 }),
    });
  }

  /**
   * Force-log a user out of their current session (invalidates their active JWT). Non-destructive — the
   * account stays enabled and they can sign back in. Named-button confirm (disruptive).
   */
  forceLogout(u: ManagedUser): void {
    const ref = this.dialog.open(UsersConfirmDialog, {
      ...Users.DIALOG_OPTS, width: '420px',
      data: {
        title: 'Sign out of all sessions?',
        lines: [
          `${u.name || this.userLabel(u)} will be signed out of every active session.`,
          'Non-destructive — the account stays enabled and they can sign back in.',
        ],
        confirmLabel: 'Sign out',
      } as ConfirmData,
    });
    ref.afterClosed().subscribe(ok => {
      if (!ok) return;
      this.loggingOutId.set(u.id);
      this.api.forceLogout(u.id).subscribe({
        next: () => {
          this.loggingOutId.set(null);
          this.loadAudit();
          this.snack.open(`Signed ${u.name || this.userLabel(u)} out of their sessions.`, 'OK', { duration: 2500 });
        },
        error: (err: HttpErrorResponse) => {
          this.loggingOutId.set(null);
          this.snack.open(err.error?.message ?? 'Could not sign user out', 'Dismiss', { duration: 5000 });
        },
      });
    });
  }

  remove(u: ManagedUser): void {
    const ref = this.dialog.open(UsersConfirmDialog, {
      ...Users.DIALOG_OPTS, width: '420px',
      data: {
        title: 'Remove user?',
        lines: [`${u.name || this.userLabel(u)} will lose access immediately.`, 'This cannot be undone.'],
        confirmLabel: 'Remove user',
        danger: true,
      } as ConfirmData,
    });
    ref.afterClosed().subscribe(ok => {
      if (!ok) return;
      this.api.deleteUser(u.id).subscribe({
        next: () => {
          this.users.update(list => list.filter(x => x.id !== u.id));
          this.selectedIds.update(s => { if (!s.has(u.id)) return s; const n = new Set(s); n.delete(u.id); return n; });
          if (this.selectedId() === u.id) { this.selectedId.set(null); this.mobileDetailOpen.set(false); }
          this.loadAudit();
          this.snack.open(`Removed ${this.userLabel(u)}`, 'OK', { duration: 2500 });
        },
        error: (err: HttpErrorResponse) => this.snack.open(err.error?.message ?? 'Delete failed', 'Dismiss', { duration: 5000 }),
      });
    });
  }

  // ---- Contacts (the circle) — admin editor in the detail (chat.contacts.manage) ----
  contactsState(id: number): ContactsState | undefined { return this.contacts().get(id); }

  private setContactsState(id: number, patch: Partial<ContactsState>): void {
    this.contacts.update(m => {
      const prev = m.get(id) ?? { loading: false, loaded: false, error: false, contacts: [], query: '', busyUserId: null };
      return new Map(m).set(id, { ...prev, ...patch });
    });
  }

  private loadContacts(u: ManagedUser): void {
    this.setContactsState(u.id, { loading: true, loaded: false, error: false, contacts: [], query: '', busyUserId: null });
    this.api.userContacts(u.id).subscribe({
      next: contacts => this.setContactsState(u.id, { loading: false, loaded: true, error: false, contacts }),
      error: () => this.setContactsState(u.id, { loading: false, loaded: true, error: true, contacts: [] }),
    });
  }

  private ensureDirectory(): void {
    if (this.directoryLoaded) return;
    this.directoryLoaded = true;
    this.api.chatDirectory().subscribe({
      next: dir => this.directory.set(dir),
      error: () => { this.directoryLoaded = false; },
    });
  }

  setContactsQuery(id: number, q: string): void { this.setContactsState(id, { query: q }); }

  addCandidates(u: ManagedUser): ChatContactDto[] {
    const state = this.contactsState(u.id);
    const have = new Set((state?.contacts ?? []).map(c => c.userId));
    const q = (state?.query ?? '').trim().toLowerCase();
    return this.directory()
      .filter(c => c.userId !== u.id && !have.has(c.userId))
      .filter(c => !q || c.name.toLowerCase().includes(q));
  }

  addContact(u: ManagedUser, contactUserId: number): void {
    const added = this.directory().find(c => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.addUserContact(u.id, contactUserId).subscribe({
      next: contacts => {
        this.setContactsState(u.id, { contacts, query: '', busyUserId: null });
        this.liveStatus.set(`Added ${added?.name || 'contact'} to circle.`);
        this.loadAudit();
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.snack.open(err.error?.message ?? 'Could not add contact', 'Dismiss', { duration: 5000 });
      },
    });
  }

  removeContact(u: ManagedUser, contactUserId: number): void {
    const removed = this.contactsState(u.id)?.contacts.find(c => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.removeUserContact(u.id, contactUserId).subscribe({
      next: contacts => {
        this.setContactsState(u.id, { contacts, busyUserId: null });
        this.liveStatus.set(`Removed ${removed?.name || 'contact'} from circle.`);
        this.loadAudit();
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.snack.open(err.error?.message ?? 'Could not remove contact', 'Dismiss', { duration: 5000 });
      },
    });
  }

  contactInitials(c: ChatContactDto): string {
    const parts = (c.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  userInitial(u: ManagedUser): string {
    return ((u.name || u.email || '?').charAt(0) || '?').toUpperCase();
  }

  isMasked(u: ManagedUser): boolean { return u.email == null; }

  private userLabel(u: ManagedUser): string { return u.email || u.name || `user #${u.id}`; }

  // ---- Bulk selection + actions (CLIENT-SIDE via the existing per-user updateUser) ----

  toggleSelect(id: number, checked: boolean): void {
    this.selectedIds.update(s => {
      const next = new Set(s);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  toggleSelectAllVisible(checked: boolean): void {
    const vis = this.filteredUsers().map(u => u.id);
    this.selectedIds.update(s => {
      const next = new Set(s);
      for (const id of vis) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }

  clearSelection(): void { this.selectedIds.set(new Set()); }

  private selectedUsers(): ManagedUser[] {
    const sel = this.selectedIds();
    return this.users().filter(u => sel.has(u.id));
  }

  /** A short newline list of the affected users for the named confirm (capped, "+N more"). */
  private nameList(users: ManagedUser[], cap = 8): string {
    const names = users.map(u => u.name || this.userLabel(u));
    if (names.length <= cap) return names.join(', ');
    return `${names.slice(0, cap).join(', ')} +${names.length - cap} more`;
  }

  /** Apply a role to every selected user (REPLACES + SAVES each). Named confirm. */
  bulkApplyRole(roleKey: string): void {
    const role = this.presets().find(p => p.key === roleKey);
    const targets = this.selectedUsers();
    if (!role || !targets.length) return;
    this.confirmBulk(
      `Apply "${role.label}" to ${targets.length} user(s)?`,
      [`Replaces each one's permissions with the role, then saves.`, this.nameList(targets)],
      `Apply role`,
      this.hasAnyAi(role.permissions),
      () => this.runBulk(targets, u => ({ ...this.payload(u), permissions: [...role.permissions] }), `Applied "${role.label}" to`),
    );
  }

  bulkGrant(key: string): void {
    const targets = this.selectedUsers().filter(u => !u.permissions.includes(key));
    const label = this.permByKey().get(key)?.label ?? key;
    if (!targets.length) { this.snack.open(`All selected users already have "${label}"`, 'OK', { duration: 2500 }); return; }
    const ai = this.aiKeys().has(key);
    const run = () => this.runBulk(targets, u => ({ ...this.payload(u), permissions: [...new Set([...u.permissions, key])] }), `Granted "${label}" to`);
    if (ai) {
      this.confirmBulk(`Grant token-spending "${label}" to ${targets.length} user(s)?`,
        ['This is an AI capability that spends tokens.', this.nameList(targets)], `Grant ${label}`, true, run);
    } else { run(); }
  }

  bulkRevoke(key: string): void {
    const targets = this.selectedUsers().filter(u => u.permissions.includes(key));
    const label = this.permByKey().get(key)?.label ?? key;
    if (!targets.length) { this.snack.open(`No selected user has "${label}"`, 'OK', { duration: 2500 }); return; }
    this.runBulk(targets, u => ({ ...this.payload(u), permissions: u.permissions.filter(k => k !== key) }), `Revoked "${label}" from`);
  }

  bulkSetEnabled(enabled: boolean): void {
    const targets = this.selectedUsers().filter(u => u.isEnabled !== enabled);
    if (!targets.length) { this.snack.open(`Selected users are already ${enabled ? 'enabled' : 'disabled'}`, 'OK', { duration: 2500 }); return; }
    const run = () => this.runBulk(targets, u => ({ ...this.payload(u), isEnabled: enabled }), `${enabled ? 'Enabled' : 'Disabled'}`);
    if (!enabled) {
      this.confirmBulk(`Disable ${targets.length} user(s)?`,
        ['They can no longer sign in until re-enabled.', this.nameList(targets)], 'Disable', false, run, /*danger*/ true);
    } else { run(); }
  }

  /** Open a named-button confirm for a bulk action; runs `onConfirm` on accept. */
  private confirmBulk(title: string, lines: string[], confirmLabel: string, _ai: boolean, onConfirm: () => void, danger = false): void {
    const ref = this.dialog.open(UsersConfirmDialog, {
      ...Users.DIALOG_OPTS, width: '460px', data: { title, lines, confirmLabel, danger } as ConfirmData,
    });
    ref.afterClosed().subscribe(ok => { if (ok) onConfirm(); });
  }

  private payload(u: ManagedUser): { name?: string; isEnabled: boolean; permissions: string[] } {
    return { name: u.name, isEnabled: u.isEnabled, permissions: u.permissions };
  }

  /**
   * Run a bulk mutation over a set of users sequentially via the existing per-user updateUser endpoint.
   * Updates the local rows from each response, tracks progress, and reports one summary toast.
   */
  private runBulk(
    targets: ManagedUser[],
    build: (u: ManagedUser) => { name?: string; isEnabled: boolean; permissions: string[] },
    verb: string,
  ): void {
    this.bulkRunning.set(true);
    this.bulkDone.set(0);
    this.bulkTotal.set(targets.length);
    let failures = 0;

    const step = (i: number): void => {
      if (i >= targets.length) {
        this.bulkRunning.set(false);
        this.loadAudit();
        if (this.selectedId() != null) this.reconcileSelection();
        const ok = targets.length - failures;
        const msg = failures ? `${verb} ${ok} user(s); ${failures} failed` : `${verb} ${ok} user(s)`;
        this.snack.open(msg, 'OK', { duration: 3500 });
        return;
      }
      const u = targets[i];
      this.api.updateUser(u.id, build(u)).subscribe({
        next: updated => {
          this.users.update(list => list.map(x => x.id === updated.id ? updated : x));
          this.bulkDone.set(i + 1);
          step(i + 1);
        },
        error: () => { failures++; this.bulkDone.set(i + 1); step(i + 1); },
      });
    };
    step(0);
  }

  // ---- Add user ----
  newHasPerm(key: string): boolean { return this.newPerms().has(key); }

  toggleNewPerm(key: string, checked: boolean): void {
    const set = new Set(this.newPerms());
    if (checked) set.add(key); else set.delete(key);
    this.newPerms.set(set);
  }

  applyRoleToNew(roleKey: string): void {
    const role = this.presets().find(p => p.key === roleKey);
    if (!role) return;
    this.newPerms.set(new Set(role.permissions));
    this.addOpen.set(true);
    this.snack.open(`Seeded "${role.label}" — review and Add`, 'OK', { duration: 3000 });
  }

  addUser(): void {
    const email = this.newEmail().trim().toLowerCase();
    if (!email.includes('@')) { this.snack.open('Enter a valid email address', 'Dismiss', { duration: 3000 }); return; }
    this.adding.set(true);
    this.api.createUser({ email, isEnabled: this.newEnabled(), permissions: [...this.newPerms()] }).subscribe({
      next: u => {
        this.adding.set(false);
        this.users.update(list => [...list, u].sort((a, b) => (a.email ?? a.name).localeCompare(b.email ?? b.name)));
        this.newEmail.set('');
        this.newEnabled.set(true);
        this.newPerms.set(new Set([PERM.dashboardView]));
        this.addOpen.set(false);
        this.loadAudit();
        this.snack.open(`Added ${u.email}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.adding.set(false);
        this.snack.open(err.error?.message ?? 'Could not add user', 'Dismiss', { duration: 5000 });
      },
    });
  }

  // ---- Access policy ----
  setOpenSignup(enabled: boolean): void {
    this.policy.update(p => p ? { ...p, openSignupEnabled: enabled } : p);
  }

  policyHasPerm(key: string): boolean { return this.policyPerms().has(key); }

  togglePolicyPerm(key: string, checked: boolean): void {
    const set = new Set(this.policyPerms());
    if (checked) set.add(key); else set.delete(key);
    this.policyPerms.set(set);
  }

  savePolicy(): void {
    const p = this.policy();
    if (!p) return;
    this.savingPolicy.set(true);
    const body: AccessPolicy = { openSignupEnabled: p.openSignupEnabled, defaultPermissions: [...this.policyPerms()] };
    this.api.updateAccessPolicy(body).subscribe({
      next: saved => {
        this.savingPolicy.set(false);
        this.policy.set(saved);
        this.policyPerms.set(new Set(saved.defaultPermissions));
        this.loadAudit();
        this.snack.open('Access policy saved', 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingPolicy.set(false);
        this.snack.open(err.error?.message ?? 'Could not save access policy', 'Dismiss', { duration: 5000 });
      },
    });
  }
}
