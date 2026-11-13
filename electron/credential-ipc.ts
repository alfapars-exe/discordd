import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { sanitizeUpstreamOrigin } from "./api-proxy";
import { toPublicCredentials, type Credentials } from "./credentials";
import type { SavedLoginResult } from "./credential-login";
import { assertString } from "./ipc-input-validation";

type CredentialOperations = {
  save: (username: string, password: string, origin: string) => void;
  load: () => Credentials | null;
  clear: () => void;
  login: (origin: unknown) => Promise<SavedLoginResult>;
};

/** Remember-me IPC boundary. Passwords remain inside the main process. */
export function registerCredentialIPC(
  ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  operations: CredentialOperations,
): void {
  ipc.handle("save-credentials", (event, username: unknown, password: unknown, upstream: unknown) => {
    assertTrusted(event);
    assertString(username, "username", 512);
    assertString(password, "password", 4096);
    const origin = sanitizeUpstreamOrigin(typeof upstream === "string" ? upstream : null);
    if (!origin) throw new Error("Invalid credential origin");
    return operations.save(username, password, origin);
  });
  ipc.handle("load-credentials", event => {
    assertTrusted(event);
    return toPublicCredentials(operations.load());
  });
  ipc.handle("login-with-saved-credentials", (event, upstream: unknown) => {
    assertTrusted(event);
    return operations.login(upstream);
  });
  ipc.handle("clear-credentials", event => {
    assertTrusted(event);
    return operations.clear();
  });
}
