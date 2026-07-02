import { App } from './app';

/**
 * Smoke coverage for the App shell's security-relevant, dependency-free logic.
 *
 * The shell itself pulls in Router/HTTP/realtime services, so we exercise the pure
 * `initialsOf` email-masking helper directly rather than bootstrapping the whole
 * component. `initialsOf` is what renders avatars from a name and, crucially, is the
 * fallback that derives initials from an email WITHOUT leaking the address — a
 * regression here would surface raw PII in the UI.
 */
describe('App', () => {
  // Reach the private static helper without constructing the DI-heavy component.
  const initialsOf = (App as unknown as {
    initialsOf(name: string | null | undefined, email?: string | null): string;
  }).initialsOf;

  it('is defined', () => {
    expect(App).toBeTruthy();
  });

  it('derives initials from a full name', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
  });

  it('falls back to a single letter for a one-word name', () => {
    expect(initialsOf('Ada')).toBe('A');
  });

  it('masks an email into initials rather than exposing the address', () => {
    const result = initialsOf(null, 'ada.lovelace@example.com');
    expect(result).toBe('AL');
    expect(result).not.toContain('@');
    expect(result).not.toContain('example');
  });

  it('returns the "U" placeholder when nothing is provided', () => {
    expect(initialsOf(null)).toBe('U');
    expect(initialsOf('', '')).toBe('U');
  });
});
