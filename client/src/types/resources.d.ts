/**
 * i18next resource typing — augments CustomTypeOptions so `t()` / `useTranslation()`
 * calls get compile-time key checking.
 *
 * Only the `errors` namespace gets exact key typing (typeof the EN JSON —
 * en and tr are required to share the same key set, see i18n/index.ts).
 * Every other namespace is intentionally kept as a loose `Record<string, string>`
 * — they're still valid entries in `resources` (so `useTranslation("auth")`,
 * `t(key, { ns: "voice" })`, etc. keep compiling) but their individual keys are
 * NOT checked. A full-strict pass (typing every namespace with its exact JSON
 * shape) was tried and reverted: it broke ~29 pre-existing call sites across the
 * app (dynamic `t(variableKey)` calls, cross-namespace TFunction handoffs,
 * pattern-matched keys like `${string}_title`) that are out of scope for this
 * change. Tightening those is a separate, larger effort.
 */
import type enErrors from "../i18n/locales/en/errors.json";

type LooseNamespace = Record<string, string>;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: LooseNamespace;
      auth: LooseNamespace;
      channels: LooseNamespace;
      chat: LooseNamespace;
      settings: LooseNamespace;
      voice: LooseNamespace;
      landing: LooseNamespace;
      servers: LooseNamespace;
      dm: LooseNamespace;
      e2ee: LooseNamespace;
      soundboard: LooseNamespace;
      music: LooseNamespace;
      privacy: LooseNamespace;
      terms: LooseNamespace;
      audit: LooseNamespace;
      errors: typeof enErrors;
    };
  }
}
