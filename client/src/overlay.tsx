import { createRoot } from "react-dom/client";
import { i18nReady } from "./i18n";
import "./styles/globals.css";
import "./styles/voice-overlay.css";
import VoiceOverlayApp from "./components/voice/VoiceOverlayApp";

void i18nReady.then(ready => { if (ready) createRoot(document.getElementById("root")!).render(<VoiceOverlayApp />); });
