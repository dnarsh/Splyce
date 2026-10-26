import type { CommandPayloads } from "@splyce/pi/contracts";
import type { EngineConnectionState } from "./engine";

export type PromptPayload = CommandPayloads["session.prompt"];

export interface ComposerAvailability {
  connection: EngineConnectionState;
  sessionId: string | null;
  /** Command revisions are stale: the UI must refresh before sending. */
  stale: boolean;
  /** A prompt was already sent and is not settled yet. */
  pending: boolean;
}

const CONNECTION_REASONS: Partial<Record<EngineConnectionState, string>> = {
  disconnected: "Engine is not connected.",
  connecting: "Engine is still connecting.",
  unavailable: "Engine is unavailable.",
  error: "Engine reported an error.",
  busy: "A turn is running. Press Esc to cancel it.",
};

/** Honest reason sending is blocked, or null when allowed. */
export function sendBlockedReason(a: ComposerAvailability): string | null {
  if (a.pending) return "Sending the previous message.";
  const connection = CONNECTION_REASONS[a.connection];
  if (connection) return connection;
  if (!a.sessionId) return "No session is selected.";
  if (a.stale) return "Session state is out of date. Refresh before sending.";
  return null;
}

/** textarea.value is already LF-normalised; normalise again for pasted/set values. */
export const normalizeDraft = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

export function buildPrompt(
  draft: string,
  contextArtifactIds: readonly string[] = [],
): PromptPayload | null {
  const text = normalizeDraft(draft);
  if (text.trim() === "") return null;
  return contextArtifactIds.length > 0
    ? { text, contextArtifactIds: [...contextArtifactIds] }
    : { text };
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export type ComposerKeyAction = "send" | "cancel" | "none";

/** Maps a keydown to an action; never acts while an IME composition is active. */
export function keyAction(e: KeyLike, composing = false): ComposerKeyAction {
  if (composing || e.isComposing || e.keyCode === 229) return "none";
  if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey)) return "send";
  if (e.key === "Escape") return "cancel";
  return "none";
}
