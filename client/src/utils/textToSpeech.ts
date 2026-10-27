import i18n from "../i18n";
import { useAccessibilityStore } from "../stores/accessibilityStore";

const MAX_SPOKEN_CHARS = 500;

export function supportsTextToSpeech(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis?.speak === "function" && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Preview replaces queued speech and uses the same rate and language as messages. */
export function previewTextToSpeech(content: string): boolean {
  if (!supportsTextToSpeech()) return false;
  try {
    window.speechSynthesis.cancel();
    return speakMessage("", content);
  } catch { return false; }
}

/** Reads one incoming plaintext message when the account preference allows it. */
export function speakIncomingMessage(author: string, content: string | null | undefined): boolean {
  const prefs = useAccessibilityStore.getState();
  if (!prefs.ttsEnabled || !content?.trim()) return false;
  return speakText(author, content, MAX_SPOKEN_CHARS);
}

/** Explicit user action, independent of automatic incoming-message reading. */
export function speakMessage(author: string, content: string | null | undefined): boolean {
  return speakText(author, content, 4000);
}

function speakText(author: string, content: string | null | undefined, limit: number): boolean {
  const prefs = useAccessibilityStore.getState();
  if (!content?.trim()) return false;
  if (!supportsTextToSpeech()) return false;

  const normalized = content.replace(/https?:\/\/\S+/gi, " link ").replace(/\s+/g, " ").trim().slice(0, limit);
  if (!normalized) return false;

  try {
    const utterance = new SpeechSynthesisUtterance(author ? `${author}: ${normalized}` : normalized);
    utterance.rate = prefs.ttsRate;
    utterance.lang = i18n.language.startsWith("tr") ? "tr-TR" : "en-US";
    window.speechSynthesis.speak(utterance);
    return true;
  } catch { return false; }
}
