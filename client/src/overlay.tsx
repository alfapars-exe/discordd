import { createRoot } from "react-dom/client";
import "./i18n";
import "./styles/globals.css";
import "./styles/voice-overlay.css";
import VoiceOverlayApp from "./components/voice/VoiceOverlayApp";

createRoot(document.getElementById("root")!).render(<VoiceOverlayApp />);
