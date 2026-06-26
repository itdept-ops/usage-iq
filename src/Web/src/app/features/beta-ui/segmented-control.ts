import {
  ChangeDetectionStrategy, Component, computed, input, model, output,
} from '@angular/core';

/** One segment in the control. `key` is echoed back on selection. */
export interface Segment {
  /** Stable identifier echoed back via the model + (change). */
  key: string;
  /** Visible label. */
  label: string;
}

/**
 * BETA-KIT SegmentedControl — an iOS-style segmented control with an animated pill indicator
 * that springs between options. The selected segment's text inverts over the gradient pill;
 * the pill itself is the page accent (--accent-a/--accent-b). A new beta-kit primitive (no
 * flagship equivalent). Keyboard accessible (arrow keys move selection); role="tablist"-ish
 * radiogroup semantics. The indicator slides with --ease-spring and collapses to instant under
 * reduced-motion. Dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-segmented
 *   inputs:    segments (Segment[], required), value (model<string>, two-way — the selected key),
 *              label (string, aria-label for the group), disabled (boolean, default false)
 *   outputs:   change (string — the newly selected key); the implicit valueChange also fires
 *
 * Usage: `<app-bs-segmented [segments]="tabs" [(value)]="tab" label="View" (change)="onTab($event)" />`
 */
@Component({
  selector: 'app-bs-segmented',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bs-seg', role: 'radiogroup', '[attr.aria-label]': 'label() || null' },
  template: `
    <span class="bs-seg-pill" aria-hidden="true"
          [style.width.%]="pillWidth()"
          [style.transform]="'translateX(' + pillX() + '%)'"></span>
    @for (s of segments(); track s.key; let i = $index) {
      <button type="button" class="bs-seg-btn" role="radio"
              [class.is-active]="value() === s.key"
              [attr.aria-checked]="value() === s.key"
              [disabled]="disabled()"
              (click)="select(s.key)"
              (keydown)="onKeydown($event, i)">
        {{ s.label }}
      </button>
    }
  `,
  styles: [`
    /* ALL structural styling lives on the HOST. The control's class (\`bs-seg\`) sits on the host
       element, which belongs to the PARENT's view — so under emulated encapsulation a plain
       \`.bs-seg { … }\` rule compiles to \`.bs-seg[_ngcontent-…]\` and NEVER matches the host (the host
       only carries \`_nghost-…\`). The host must therefore be targeted via \`:host(.bs-seg)\`, which is
       also a higher-specificity guard (0,2,0) so a consumer setting \`display\` on the element (a
       single class, 0,1,0) can never collapse the control's internal flex row. Critically this
       includes \`position: relative\`: the pill is \`position:absolute\` and MUST be contained by the
       control, otherwise it escapes to a distant positioned ancestor and stretches to its height. */
    :host(.bs-seg) {
      position: relative; display: inline-flex; align-items: stretch;
      padding: 4px; gap: 0;
      background: var(--bg-sink); border: 1px solid var(--hairline);
      border-radius: var(--r-pill); box-shadow: var(--press);
      width: 100%; box-sizing: border-box;
    }
    .bs-seg-pill {
      position: absolute; top: 4px; bottom: 4px; left: 4px;
      border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      box-shadow: var(--lift-1);
      transition: transform 360ms var(--ease-spring-up), width 360ms var(--ease-spring-up);
      will-change: transform, width;
    }
    .bs-seg-btn {
      position: relative; z-index: 1; flex: 1 1 0; min-width: 0; min-height: 38px;
      display: flex; align-items: center; justify-content: center;
      padding: 8px 12px; border: none; background: transparent;
      font-family: var(--font-ui); font-size: 13px; font-weight: 700;
      letter-spacing: .01em; color: var(--ink-dim);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: color 200ms var(--ease-out);
    }
    .bs-seg-btn.is-active { color: #fff; }
    .bs-seg-btn:disabled { opacity: .45; pointer-events: none; }
    .bs-seg-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-pill); }
    @media (prefers-reduced-motion: reduce) {
      .bs-seg-pill { transition: none; }
    }
  `],
})
export class BetaSegmentedControl {
  /** The segments, left to right. */
  readonly segments = input.required<Segment[]>();
  /** Two-way selected key. Defaults to the first segment if unset/unknown. */
  readonly value = model<string>('');
  /** aria-label for the group. */
  readonly label = input<string>('');
  /** When true the control is inert. */
  readonly disabled = input<boolean>(false);
  /** Fired with the newly selected key. */
  readonly change = output<string>();

  /** Index of the active segment (falls back to 0 when value is unset/unknown). */
  private readonly activeIndex = computed(() => {
    const segs = this.segments();
    const i = segs.findIndex(s => s.key === this.value());
    return i < 0 ? 0 : i;
  });

  /** Pill width as a % of the inner track (equal slices). */
  protected readonly pillWidth = computed(() => {
    const n = this.segments().length || 1;
    return 100 / n;
  });
  /** Pill translateX as a % of its OWN width (so each step = 100% = one slice). */
  protected readonly pillX = computed(() => this.activeIndex() * 100);

  protected select(key: string): void {
    if (this.disabled() || key === this.value()) return;
    this.value.set(key);
    this.change.emit(key);
  }

  protected onKeydown(e: KeyboardEvent, i: number): void {
    const segs = this.segments();
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % segs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + segs.length) % segs.length;
    else return;
    e.preventDefault();
    this.select(segs[next].key);
  }
}
