export type ConsentStatus = 'accepted' | 'declined' | 'pending';

export class CookieConsent {
  private static readonly STORAGE_KEY = 'ifcviewer:cookieConsent';

  static getStatus(): ConsentStatus {
    try {
      const value = localStorage.getItem(CookieConsent.STORAGE_KEY);
      if (value === 'accepted' || value === 'declined') return value;
    } catch {
      /* private browsing */
    }
    return 'pending';
  }

  static accept(): void {
    try {
      localStorage.setItem(CookieConsent.STORAGE_KEY, 'accepted');
    } catch {
      /* private browsing */
    }
  }

  static decline(): void {
    try {
      localStorage.setItem(CookieConsent.STORAGE_KEY, 'declined');
    } catch {
      /* private browsing */
    }
  }
}
