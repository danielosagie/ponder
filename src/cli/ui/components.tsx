/**
 * Shared Ink primitives used by the setup wizard and doctor screen.
 *
 *   <Step status="ok" label="Playwriter CLI" detail="installed" />
 *   <SpinnerLine label="Probing Chrome bridge…" />
 *   <KV label="Recipes dir" value="~/.ponder/recipes" />
 *
 * Status icons match the brand palette — amber for in-flight,
 * pistachio for success, red-coral for failure — so a list of
 * checks reads as a cohesive design system rather than a pile
 * of unicode glyphs.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { THEME } from "./theme.js";

export type StepStatus = "pending" | "running" | "ok" | "skip" | "warn" | "error";

export interface StepProps {
  status: StepStatus;
  label: string;
  detail?: string;
  hint?: string;
}

const ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "",
  ok: "✓",
  skip: "·",
  warn: "!",
  error: "✗",
};

const COLOR: Record<StepStatus, string> = {
  pending: THEME.muted,
  running: THEME.amber,
  ok: THEME.success,
  skip: THEME.muted,
  warn: THEME.warning,
  error: THEME.error,
};

export function Step({
  status,
  label,
  detail,
  hint,
}: StepProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={hint ? 1 : 0}>
      <Box>
        <Box width={3}>
          {status === "running" ? (
            <Text color={COLOR.running}>
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={COLOR[status]}>{ICON[status]}</Text>
          )}
        </Box>
        <Text color={THEME.text}>{label}</Text>
        {detail ? (
          <>
            <Text color={THEME.muted}>  ·  </Text>
            <Text color={COLOR[status]}>{detail}</Text>
          </>
        ) : null}
      </Box>
      {hint ? (
        <Box marginLeft={3}>
          <Text color={THEME.muted}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface SpinnerLineProps {
  label: string;
  detail?: string;
}

export function SpinnerLine({
  label,
  detail,
}: SpinnerLineProps): React.ReactElement {
  return (
    <Box>
      <Box width={3}>
        <Text color={THEME.amber}>
          <Spinner type="dots" />
        </Text>
      </Box>
      <Text color={THEME.text}>{label}</Text>
      {detail ? (
        <>
          <Text color={THEME.muted}>  ·  </Text>
          <Text color={THEME.muted}>{detail}</Text>
        </>
      ) : null}
    </Box>
  );
}

export interface KVProps {
  label: string;
  value: string;
  /** Apply theme color to the value (e.g. error red, success green). */
  color?: string;
}

export function KV({ label, value, color }: KVProps): React.ReactElement {
  return (
    <Box>
      <Box width={18}>
        <Text color={THEME.muted}>{label}</Text>
      </Box>
      <Text color={color ?? THEME.text}>{value}</Text>
    </Box>
  );
}

export interface SectionProps {
  title: string;
  children: React.ReactNode;
}

export function Section({ title, children }: SectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={THEME.amber} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginLeft={1}>
        {children}
      </Box>
    </Box>
  );
}
