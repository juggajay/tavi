// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
    viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean; focusOnClick: boolean;
    addEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
    focus(): void;
  }
}
