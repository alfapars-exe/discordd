/** Keep new-password rules aligned with models.ValidateNewPassword. */
export function newPasswordError(password: string): "passwordTooShort" | "passwordTooLong" | null {
  if ([...password].length < 8) return "passwordTooShort";
  if (new TextEncoder().encode(password).length > 72) return "passwordTooLong";
  return null;
}
