export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
}

export interface ClickOpts {
  button?: "left" | "right";
  double?: boolean;
  triple?: boolean;
}

export interface ScreenAdapter {
  screenshot(): Promise<Screenshot>;
  size(): Promise<{ width: number; height: number }>;
  click(x: number, y: number, opts?: ClickOpts): Promise<void>;
  drag(srcX: number, srcY: number, dstX: number, dstY: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressCombo(combo: string): Promise<void>;
  scroll(amount: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /**
   * True when the adapter clicks/types without moving the user's visible
   * cursor (e.g. nut.ts with cliclick installed). The Electron buddy overlay
   * uses this to decide whether to render its own ghost cursor.
   */
  readonly backgroundMode: boolean;
}
