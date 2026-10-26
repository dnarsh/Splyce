import type { MemoryObservationRecord } from "@splyce/pi/contracts";

/** Engine-reported memory subsystem state; drives the honest empty state. */
export type MemoryStatus = "on" | "off" | "unavailable";

export interface MemoryEntry {
  observation: MemoryObservationRecord;
  /** Claim text resolved from claimArtifactId; null when the artifact is not readable. */
  claim: string | null;
  /** Where it was learned from, e.g. a session or file label. */
  source: string;
  scope: string;
  /** Locality of the extraction role that produced it. */
  locality: "local" | "hosted";
  /** Engine truth: deletion is "purge-pending" until the engine reports it complete. */
  state: "active" | "purge-pending";
}

export function emptyMessage(status: MemoryStatus): string {
  switch (status) {
    case "off":
      return "Memory is off. Nothing is being remembered.";
    case "unavailable":
      return "Memory is unavailable. Remembered items cannot be shown.";
    default:
      return "Nothing is remembered yet.";
  }
}

export const localityLabel = (l: MemoryEntry["locality"]): string =>
  l === "local" ? "Local" : "Cloud (hosted)";
