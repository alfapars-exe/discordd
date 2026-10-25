import { create } from "zustand";

// Transient, device-local coordination: overlapping recorders must not resume
// commands until the last recorder has stopped. Never persist capture state.
export const useShortcutCaptureStore = create(() => ({ active: false }));
const owners = new Set<symbol>();
export function beginShortcutCapture(): () => void {
  const owner = Symbol("shortcut-capture");
  owners.add(owner);
  useShortcutCaptureStore.setState({ active: true });
  return () => {
    owners.delete(owner);
    useShortcutCaptureStore.setState({ active: owners.size > 0 });
  };
}
