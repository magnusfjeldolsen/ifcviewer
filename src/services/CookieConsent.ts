/**
 * Analytics consent, persisted in localStorage.
 *
 * A **decline expires**. Someone who declined once is asked again on their
 * next visit after `DECLINE_REPROMPT_DAYS`, because a decline is usually a
 * reflex at a banner rather than a considered position, and the whole point
 * of the analytics is to know how many people actually use the viewer.
 *
 * It expires rather than re-asking on every reload: a banner that comes back
 * every single time is a dark pattern, it trains people to dismiss it without
 * reading, and regulators treat repeated re-prompting after a refusal as
 * pressure rather than consent. One re-ask a month is the compromise — to
 * change the cadence, change the constant; `0` would ask on every load.
 *
 * An **accept never expires**, so the choice we act on is only ever
 * re-confirmed in the direction the user can always reverse from the cookie
 * icon.
 */
export type ConsentStatus = 'accepted' | 'declined' | 'pending';

/** Days a decline is honoured before the banner asks once more. */
export const DECLINE_REPROMPT_DAYS = 30;

const DECLINE_REPROMPT_MS = DECLINE_REPROMPT_DAYS * 24 * 60 * 60 * 1000;

/**
 * The stored shape. Written as JSON since the re-prompt needs a timestamp;
 * the older bare `"accepted"` / `"declined"` strings are still read (see
 * `readChoice`), so an existing visitor's accept is never lost.
 */
interface StoredChoice {
  status: 'accepted' | 'declined';
  /** When the choice was made, epoch ms. */
  at: number;
}

export class CookieConsent {
  private static readonly STORAGE_KEY = 'ifcviewer:cookieConsent';

  /**
   * The choice to act on right now. `pending` means "ask" — no choice yet, or
   * a decline old enough to re-ask.
   *
   * `now` is injectable so the expiry is testable without clock mocking.
   */
  static getStatus(now: number = Date.now()): ConsentStatus {
    const choice = CookieConsent.readChoice();
    if (!choice) return 'pending';
    if (choice.status === 'accepted') return 'accepted';
    return CookieConsent.declineExpired(choice, now) ? 'pending' : 'declined';
  }

  static accept(now: number = Date.now()): void {
    CookieConsent.write({ status: 'accepted', at: now });
  }

  static decline(now: number = Date.now()): void {
    // Writing the timestamp fresh on every decline is what makes a re-decline
    // buy another full period rather than re-asking immediately.
    CookieConsent.write({ status: 'declined', at: now });
  }

  /**
   * A decline with no usable timestamp counts as expired — that covers the
   * legacy bare `"declined"` string and a clock that was wrong when it was
   * written. Erring toward asking beats honouring a decline forever on the
   * strength of a timestamp we don't trust.
   */
  private static declineExpired(choice: StoredChoice, now: number): boolean {
    if (!Number.isFinite(choice.at) || choice.at > now) return true;
    return now - choice.at >= DECLINE_REPROMPT_MS;
  }

  private static readChoice(): StoredChoice | null {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CookieConsent.STORAGE_KEY);
    } catch {
      /* private browsing */
    }
    if (raw === null) return null;

    // Legacy format: the bare status string, written before decline expiry
    // existed. `at: 0` reads as an expired decline, which is exactly right —
    // those declines predate the re-prompt and are due to be asked again.
    if (raw === 'accepted' || raw === 'declined') return { status: raw, at: 0 };

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { status, at } = parsed as { status?: unknown; at?: unknown };
      if (status !== 'accepted' && status !== 'declined') return null;
      return { status, at: typeof at === 'number' ? at : 0 };
    } catch {
      // Corrupt value — treat it as no choice at all and ask.
      return null;
    }
  }

  private static write(choice: StoredChoice): void {
    try {
      localStorage.setItem(CookieConsent.STORAGE_KEY, JSON.stringify(choice));
    } catch {
      /* private browsing */
    }
  }
}
