/**
 * Live feedback for the recovery passphrase field (pentest 2026-07-26,
 * finding H-10).
 *
 * Shared by the two places a passphrase can be set — Settings > Encryption and
 * RecoveryPasswordPrompt — so both show the SAME verdict for the same input.
 * Duplicating the markup would let the two drift into disagreeing about what
 * is acceptable, which is the confusing half of the bug we just fixed.
 *
 * This is feedback only. The gate that actually refuses a weak passphrase is
 * e2eeStore.setRecoveryPassword; nothing here can be relied on for security,
 * since a caller may skip the component entirely.
 */

import { useTranslation } from "react-i18next";
import {
  checkRecoveryPassphrase,
  RECOVERY_PASSPHRASE_MIN_LENGTH,
  RECOVERY_PASSPHRASE_MAX_LENGTH,
  type RecoveryPassphraseStrength as Strength,
} from "../../crypto/recoveryPassphrase";

const STRENGTH_I18N_KEY: Readonly<Record<Strength, string>> = {
  weak: "recoveryPasswordStrengthWeak",
  fair: "recoveryPasswordStrengthFair",
  good: "recoveryPasswordStrengthGood",
  strong: "recoveryPasswordStrengthStrong",
};

type Props = {
  /** Raw field value. Trimmed here to match what the store will evaluate. */
  passphrase: string;
};

function RecoveryPassphraseStrength({ passphrase }: Props) {
  const { t } = useTranslation("e2ee");

  // Interpolation values for whichever message we end up rendering; unused
  // ones are simply ignored by i18next.
  const limits = {
    min: RECOVERY_PASSPHRASE_MIN_LENGTH,
    max: RECOVERY_PASSPHRASE_MAX_LENGTH,
  };

  // Nothing typed yet: state the requirement instead of complaining about it.
  if (passphrase.length === 0) {
    return <p className="settings-hint">{t("recoveryPasswordPolicyHint", limits)}</p>;
  }

  const check = checkRecoveryPassphrase(passphrase.trim());

  return (
    <div className="e2ee-pwd-strength">
      <div className="e2ee-pwd-strength-bar">
        <div className={`e2ee-pwd-strength-fill ${check.strength}`} />
      </div>
      <div className="e2ee-pwd-strength-label">
        <span>
          {t("recoveryPasswordStrengthLabel")}: {t(STRENGTH_I18N_KEY[check.strength])}
        </span>
        {!check.ok && (
          <span className="e2ee-pwd-strength-reason">{t(check.i18nKey, limits)}</span>
        )}
      </div>
    </div>
  );
}

export default RecoveryPassphraseStrength;
