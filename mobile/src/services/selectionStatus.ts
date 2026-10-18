import { formatDistance } from "./pathSelection";
import type { Snapshot } from "./selectionController";

// The one line under the card's numbers that says what is happening, or what
// the rider can do next: why growth stopped, and how to carry on.

export interface Status {
  text: string;
  tone: "info" | "error";
  /** Something is on its way: the card shows a spinner. */
  waiting: boolean;
}

/** Ahead of the end by this little, a reason reads as here rather than "in 10 ft". */
const HERE_M = 3;

export function statusFor(snap: Pick<Snapshot, "selection" | "grownM" | "mode" | "busy" | "preview" | "error">): Status | null {
  if (snap.error) return { text: snap.error, tone: "error", waiting: false };
  switch (snap.busy) {
    case "path":
      return { text: "Finding the way…", tone: "info", waiting: true };
    case "connect":
      return { text: "Joining that line…", tone: "info", waiting: true };
    case "more":
      return { text: "Loading more…", tone: "info", waiting: true };
    case "flip":
      return { text: "Turning it round…", tone: "info", waiting: true };
  }
  const selection = snap.selection;
  if (!selection || snap.preview) return null;
  if (snap.mode === "holding") return { text: "Lift your finger to stop", tone: "info", waiting: false };
  if (snap.grownM < selection.lengthM - 0.01) return { text: "Hold the selection to keep going", tone: "info", waiting: false };

  const { reason, aheadM } = selection.stop;
  const ahead = aheadM > HERE_M ? ` ${formatDistance(aheadM)} on` : "";
  switch (reason) {
    case "fork":
      return { text: `Fork${ahead ? ` ${formatDistance(aheadM)} ahead` : ""}: hold the way you want`, tone: "info", waiting: false };
    case "end":
      return { text: `The way ends${ahead || " here"}`, tone: "info", waiting: false };
    case "gap":
      return { text: "No data ahead: hold the next line to bridge the gap", tone: "info", waiting: false };
    case "loop":
      return { text: "It runs back into the selection here", tone: "info", waiting: false };
    case "limit":
    case "joined":
      return { text: "Hold the selection to keep going", tone: "info", waiting: false };
    case "cut":
      return { text: "Hold the next line to go on", tone: "info", waiting: false };
    case "unreachable":
      return null;
  }
}
