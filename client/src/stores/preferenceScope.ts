/** Preference binding generation, without importing UI stores. A reset also
 * retires same-user backend bindings; an account ID alone is not sufficient.
 */
let generation = 0;
export function getPreferenceScopeGeneration(): number { return generation; }
export function retirePreferenceScope(): void { generation++; }
export function capturePreferenceScope(): () => boolean {
  const captured = generation;
  return () => captured === generation;
}
