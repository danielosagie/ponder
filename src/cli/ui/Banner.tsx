/**
 * Brand banner used at the top of every Ink screen.
 *
 *   ✦  p o n d e r
 *   Record · Replay · Drive your real Chrome
 *
 * The wordmark is rendered through ink-gradient with the
 * amber→coral palette defined in theme.ts. Underneath is a
 * muted tagline in soft gray.
 *
 * Designed to fit comfortably in an 80-column terminal — no
 * ASCII art is involved, so the banner stays readable when
 * piped through `tee` / CI logs (gradient gets stripped to
 * plain text without breaking layout).
 */

import React from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { THEME } from "./theme.js";

export interface BannerProps {
  /** Override the tagline shown beneath the wordmark. */
  tagline?: string;
  /** Compress to a single line — useful for sub-screens
   *  (doctor, attach) where the full banner would dominate. */
  compact?: boolean;
}

export function Banner({ tagline, compact }: BannerProps): React.ReactElement {
  const subtitle = tagline ?? "Record · Replay · Drive your real Chrome";
  if (compact) {
    return (
      <Box>
        <Text color={THEME.amber}>✦ </Text>
        <Gradient colors={[...THEME.gradient]}>
          <Text bold>ponder</Text>
        </Gradient>
        <Text color={THEME.muted}>  ·  {subtitle}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={THEME.amber}>✦  </Text>
        <Gradient colors={[...THEME.gradient]}>
          <Text bold>p o n d e r</Text>
        </Gradient>
      </Box>
      <Box marginLeft={3}>
        <Text color={THEME.muted}>{subtitle}</Text>
      </Box>
    </Box>
  );
}
