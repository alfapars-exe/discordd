import i18n from "../i18n";
import { useAccessibilityStore } from "../stores/accessibilityStore";

const MAX_SPOKEN_CHARS = 500;

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
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return false;

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
