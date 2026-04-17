import { normalizeUrl } from '../loader/urlNormalizer';

export interface UrlSubmitEvent {
  rawUrl: string;
  normalizedUrl: string;
  provider?: string;
}

export class UrlInput {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private button: HTMLButtonElement;
  private messageEl: HTMLElement;
  private tokenContainer: HTMLElement;
  private tokenInput: HTMLInputElement;
  private tokenButton: HTMLButtonElement;
  private submitCallbacks: Array<(event: UrlSubmitEvent) => void> = [];
  private tokenRetryCallbacks: Array<(url: string, token: string) => void> = [];
  private lastFailedUrl: string | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'url-input-container';

    // URL row
    const row = document.createElement('div');
    row.className = 'url-input-row';

    this.input = document.createElement('input');
    this.input.type = 'url';
    this.input.className = 'url-input';
    this.input.placeholder = 'Paste a URL to an .ifc file...';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSubmit();
    });

    this.button = document.createElement('button');
    this.button.className = 'url-load-button';
    this.button.textContent = 'Load';
    this.button.addEventListener('click', () => this.handleSubmit());

    row.appendChild(this.input);
    row.appendChild(this.button);
    this.container.appendChild(row);

    // Message area
    this.messageEl = document.createElement('div');
    this.messageEl.className = 'url-message';
    this.container.appendChild(this.messageEl);

    // Token input (hidden by default)
    this.tokenContainer = document.createElement('div');
    this.tokenContainer.className = 'url-token-container';
    this.tokenContainer.style.display = 'none';

    const tokenLabel = document.createElement('span');
    tokenLabel.className = 'url-token-label';
    tokenLabel.textContent = 'Access token:';

    this.tokenInput = document.createElement('input');
    this.tokenInput.type = 'password';
    this.tokenInput.className = 'url-token-input';
    this.tokenInput.placeholder = 'Paste your access token...';
    this.tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleTokenRetry();
    });

    this.tokenButton = document.createElement('button');
    this.tokenButton.className = 'url-load-button';
    this.tokenButton.textContent = 'Retry';
    this.tokenButton.addEventListener('click', () => this.handleTokenRetry());

    this.tokenContainer.appendChild(tokenLabel);
    this.tokenContainer.appendChild(this.tokenInput);
    this.tokenContainer.appendChild(this.tokenButton);
    this.container.appendChild(this.tokenContainer);

    parent.appendChild(this.container);
  }

  onSubmit(callback: (event: UrlSubmitEvent) => void): void {
    this.submitCallbacks.push(callback);
  }

  onTokenRetry(callback: (url: string, token: string) => void): void {
    this.tokenRetryCallbacks.push(callback);
  }

  setUrl(url: string): void {
    this.input.value = url;
  }

  submit(): void {
    this.handleSubmit();
  }

  showMessage(text: string, type?: 'info' | 'error'): void {
    this.messageEl.textContent = text;
    this.messageEl.className = 'url-message' + (type ? ` url-message-${type}` : '');
  }

  showAuthPrompt(url: string): void {
    this.lastFailedUrl = url;
    this.showMessage('This file requires authentication.', 'error');
    this.tokenContainer.style.display = 'flex';
    this.tokenInput.value = '';
    this.tokenInput.focus();
  }

  clearInput(): void {
    this.input.value = '';
    this.showMessage('');
    this.hideToken();
  }

  private handleSubmit(): void {
    const rawUrl = this.input.value.trim();
    if (!rawUrl) return;

    if (!rawUrl.startsWith('https://')) {
      this.showMessage('Only HTTPS URLs are supported.', 'error');
      return;
    }

    this.hideToken();
    this.showMessage('');

    const { url, provider } = normalizeUrl(rawUrl);
    if (provider) {
      this.showMessage(`Detected ${provider} link, using direct download URL.`, 'info');
    }

    for (const cb of this.submitCallbacks) cb({ rawUrl, normalizedUrl: url, provider });
  }

  private handleTokenRetry(): void {
    const token = this.tokenInput.value.trim();
    if (!token || !this.lastFailedUrl) return;

    this.showMessage('');
    for (const cb of this.tokenRetryCallbacks) cb(this.lastFailedUrl, token);
  }

  private hideToken(): void {
    this.tokenContainer.style.display = 'none';
    this.tokenInput.value = '';
    this.lastFailedUrl = null;
  }

  dispose(): void {
    this.container.remove();
  }
}
