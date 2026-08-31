export class Footer {
  private container: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'app-footer-credit';

    // Built node by node rather than as an HTML string. Nothing here is
    // user data, but the app's one real content risk is a malicious IFC
    // whose property strings reach the DOM as markup, and that stays
    // impossible only while no `innerHTML` assignment exists to copy.
    // See the `no-restricted-syntax` rule in eslint.config.js.
    this.container.appendChild(document.createTextNode('Developed by '));

    const link = document.createElement('a');
    link.href = 'http://www.tommerdal.no/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Tømmerdal Consult AS';
    this.container.appendChild(link);

    parent.appendChild(this.container);
  }

  dispose(): void {
    this.container.remove();
  }
}
