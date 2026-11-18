export function mfaErrorKey(code: string | undefined) {
  switch (code) {
    case "MFA_REQUIRED": return "sessions.factorRequired";
    case "MFA_INVALID": return "mfa.invalid";
    case "MFA_RATE_LIMITED": return "mfa.rateLimited";
  }
}
