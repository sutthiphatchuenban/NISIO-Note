declare module "webview-bun" {
  export interface Size {
    width: number;
    height: number;
    hint: SizeHint;
  }

  export enum SizeHint {
    NONE = 0,
    MIN = 1,
    MAX = 2,
    FIXED = 3,
  }

  export class Webview {
    constructor(debug?: boolean, size?: Size, window?: unknown);
    title: string;
    size: Size;
    setHTML(html: string): void;
    navigate(url: string): void;
    init(source: string): void;
    eval(source: string): void;
    run(): void;
    bind(name: string, callback: (...args: any[]) => any): void;
    unbind(name: string): void;
    return(seq: string, status: number, result: string): void;
    destroy(): void;
  }

  export function unload(): void;
}
