import { CONFIG } from '../config';

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gtag(..._args: unknown[]): void {
  // Must use `arguments` (not rest params) — gtag.js only recognises
  // Arguments objects in the dataLayer queue, not plain Arrays.
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments);
}

export class Analytics {
  private static loaded = false;

  static load(): void {
    if (Analytics.loaded) return;
    if (!CONFIG.GA_MEASUREMENT_ID) return;

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${CONFIG.GA_MEASUREMENT_ID}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    gtag('js', new Date());
    gtag('config', CONFIG.GA_MEASUREMENT_ID);

    Analytics.loaded = true;
  }
}
