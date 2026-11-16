import { dirname, resolve } from "node:path";

/** Intercept only relative extensionless imports of these fixture modules.
 * Virtual wrappers re-export absolute .ts paths to reach the real module.
 */
export function controlledPanelCryptoImport(source, importer, root) {
  if (!source.startsWith(".") || !importer || importer.startsWith("\0")) return null;
  const target = resolve(dirname(importer.split("?")[0]), source);
  if (target === resolve(root, "src/crypto/cachedSearchSnapshot")) return "index";
  if (target === resolve(root, "src/crypto/cachedSearchDeletionSpool")) return "spool";
  if (target === resolve(root, "src/crypto/keyStorage")) return "cache";
  return null;
}
