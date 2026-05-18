/**
 * Ponder CLI theme — the amber→coral brand palette.
 *
 * Used by Banner.tsx + the Ink components in setup / doctor / attach.
 * Pure data; no React imports so it can be required from anywhere.
 *
 * Hex values chosen to keep the gradient legible on the dark
 * terminal backgrounds most developers run (iTerm, Terminal,
 * Warp, Alacritty). Each color has a chalk-safe fallback name
 * for terminals that don't support 24-bit color — when ink/chalk
 * detect a truecolor terminal they use the hex; otherwise they
 * downgrade to the named ANSI color.
 */

export const THEME = {
  /** Banner gradient (left → right). Two stops keep the transition
   *  smooth across narrow terminals; three would compress on a
   *  6-character "ponder" rendering. */
  gradient: ["#FFB020", "#FF6F61"] as const,
  /** Amber accent — primary highlight (active step, links). */
  amber: "#FFB020",
  /** Coral accent — secondary highlight (success when warmth fits). */
  coral: "#FF6F61",
  /** Soft gold for subdued highlights / borders. */
  gold: "#FFD479",
  /** Muted gray for secondary copy. ink prints it as #888 on
   *  truecolor and as 'gray' otherwise. */
  muted: "#9CA3AF",
  /** Body text — slightly off-white to soften the contrast. */
  text: "#E5E7EB",
  /** Success — warm pistachio rather than pure green so it sits
   *  comfortably next to the amber/coral. */
  success: "#A8E063",
  /** Warning — closer to amber to keep palette coherence. */
  warning: "#F5A524",
  /** Error — a red-coral that still fits the warm palette. */
  error: "#FF4D4F",
} as const;

export type ThemeKey = keyof typeof THEME;
