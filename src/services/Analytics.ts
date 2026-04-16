import { CONFIG } from '../config';

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

function gtag(...args: unknown[]): void {
  window.dataLayer.push(args);
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
