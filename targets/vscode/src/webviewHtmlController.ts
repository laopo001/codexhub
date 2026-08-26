export class VscodeWebviewHtmlController {
  private renderedHtmlKey: string | null = null;

  constructor(private readonly setHtml: (html: string) => void) {}

  update(key: string, html: string, force = false): boolean {
    if (!force && this.renderedHtmlKey === key) return false;
    this.renderedHtmlKey = key;
    this.setHtml(html);
    return true;
  }

  reset() {
    this.renderedHtmlKey = null;
  }

  get currentKey() {
    return this.renderedHtmlKey;
  }
}
