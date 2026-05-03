/**
 * screenShareCursorPatch — install once at app boot.
 *
 * LiveKit's `setScreenShareEnabled` API doesn't expose the
 * `cursor` getDisplayMedia constraint, so we monkey-patch
 * `navigator.mediaDevices.getDisplayMedia` to inject the user's preference
 * before LiveKit calls it. The patched function reads a module-local flag
 * that's kept in sync with the voice settings store via `subscribe`.
 *
 * Default cursor value is "always" (browser default + Discord/Zoom/Teams
 * default). Users can toggle to "never" in Voice Settings → Screen Share.
 *
 * Side-effect import: just `import "./utils/screenShareCursorPatch"` from
 * main.tsx. Patches once on first load; idempotent if re-imported.
 */

import { useVoiceStore } from "../stores/voiceStore";

let showCursor = true;

const md = navigator.mediaDevices;
const original = md?.getDisplayMedia?.bind(md);

if (original) {
  md.getDisplayMedia = function patched(
    constraints?: DisplayMediaStreamOptions,
  ): Promise<MediaStream> {
    const cursor = showCursor ? "always" : "never";
    const incomingVideo = constraints?.video;

    let video: MediaTrackConstraints | boolean;
    if (incomingVideo === false) {
      // Caller explicitly disabled video — leave them alone.
      video = false;
    } else if (typeof incomingVideo === "object" && incomingVideo !== null) {
      // Merge our cursor pref with caller's other constraints.
      video = { ...incomingVideo, cursor } as MediaTrackConstraints;
    } else {
      video = { cursor } as MediaTrackConstraints;
    }

    return original({ ...(constraints ?? {}), video });
  };

  // Initial flag from store, then keep it in sync. Using subscribe lets
  // toggle changes propagate without re-installing the patch.
  showCursor = useVoiceStore.getState().screenShareShowCursor;
  useVoiceStore.subscribe((state, prev) => {
    if (state.screenShareShowCursor !== prev.screenShareShowCursor) {
      showCursor = state.screenShareShowCursor;
    }
  });
}
