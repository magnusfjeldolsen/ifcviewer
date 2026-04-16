// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Analytics } from '../src/services/Analytics';

describe('Analytics', () => {
  beforeEach(() => {
    // Remove any previously injected gtag scripts
    document.querySelectorAll('script[src*="googletagmanager"]').forEach((s) => s.remove());
    window.dataLayer = [];
  });

  it('should inject gtag script on load()', () => {
    Analytics.load();
    const script = document.querySelector('script[src*="googletagmanager"]');
    expect(script).not.toBeNull();
    expect(script?.getAttribute('src')).toContain('G-71KTY05FQ8');
  });
});
