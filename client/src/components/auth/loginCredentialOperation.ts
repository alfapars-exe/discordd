type CredentialBridge = Pick<NonNullable<Window["electronAPI"]>, "saveCredentials" | "clearCredentials">;

/** Select the native IPC operation without adding an asynchronous boundary.
 * The login handler owns awaiting it, displaying failures and navigation.
 */
export function loginCredentialOperation(
  bridge: CredentialBridge | undefined,
  remember: boolean,
  username: string,
  password: string,
  origin: string,
): Promise<void> | undefined {
  if (remember) return bridge?.saveCredentials(username, password, origin);
  return bridge?.clearCredentials();
}
