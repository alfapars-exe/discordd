import { GameTestClient } from "./gameTestClient";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) throw new Error("local_development_only");
const client = new GameTestClient();
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const result = document.getElementById("result")!;
const error = document.getElementById("error")!;
let busy = false, connected = false;
function controls() {
  document.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy || (button.id !== "" && !connected); });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea").forEach(field => { field.disabled = busy; });
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true; controls(); error.textContent = "";
  try { await action(); } catch (problem) {
    error.textContent = problem instanceof Error ? problem.message : "request_failed";
    if (!connected) document.getElementById("identity")!.textContent = "Bağlı değil";
  }
  finally { busy = false; controls(); }
}
document.getElementById("connect-form")!.addEventListener("submit", event => {
  event.preventDefault();
  const token = input("game-token").value; input("game-token").value = "";
  void run(async () => {
    connected = false; result.textContent = ""; document.getElementById("received")!.replaceChildren();
    document.getElementById("identity")!.textContent = "Bağlanıyor…";
    const identity = await client.connect(token); connected = true;
    document.getElementById("identity")!.textContent = `${identity.username} · ${identity.id} · cihaz ${identity.device}`;
  });
});
document.getElementById("send-form")!.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => { const sent = await client.send(input("recipient").value.trim(), input("message").value); result.textContent = JSON.stringify(sent); input("message").value = ""; });
});
document.getElementById("poll")!.addEventListener("click", () => void run(async () => {
  const replies = await client.poll(input("recipient").value.trim());
  for (const reply of replies) { const item = document.createElement("li"); item.dataset.messageId = reply.id; item.textContent = reply.content; document.getElementById("received")!.append(item); }
  result.textContent = `${replies.length} yeni şifreli yanıt çözüldü.`;
}));
document.getElementById("disconnect")!.addEventListener("click", () => { client.disconnect(); connected = false; document.getElementById("identity")!.textContent = "Bağlı değil"; result.textContent = ""; document.getElementById("received")!.replaceChildren(); controls(); });
window.addEventListener("pagehide", () => client.disconnect());
