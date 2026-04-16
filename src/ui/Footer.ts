export class Footer {
  private container: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'app-footer-credit';
    this.container.innerHTML =
      'Developed by <a href="http://www.tommerdal.no/" target="_blank" rel="noopener noreferrer">Tømmerdal Consult AS</a>';
    parent.appendChild(this.container);
  }

  dispose(): void {
    this.container.remove();
  }
}
