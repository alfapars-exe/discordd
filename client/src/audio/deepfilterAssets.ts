/**
 * deepfilterAssets — resolves where the DeepFilterNet3 WASM + ONNX model are
 * served from. The deepfilternet3-noise-filter package appends
 * `/v2/pkg/df_bg.wasm` / `/v2/models/DeepFilterNet3_onnx.tar.gz` to this base
 * and passes the result straight to fetch(), so the base must be
 * route-independent on web and relative on native — see resolvePublicAssetBase
 * for the full rationale (the same gotcha bit DTLN with the opposite sign).
 */

import { resolvePublicAssetBase } from "./publicAssetBase";

/**
 * Base URL for the DeepFilterNet3 assets (public/deepfilter). Web →
 * "/deepfilter" (origin-absolute, route-independent), native → "./deepfilter"
 * (relative to index.html). Thin wrapper over resolvePublicAssetBase so
 * DeepFilter and DTLN share one implementation.
 *
 * @param native   true for Electron/Capacitor shells (utils/constants.isNativeApp)
 * @param baseUrl  import.meta.env.BASE_URL ("/" in dev, "./" in prod builds)
 */
export function resolveDeepFilterBase(native: boolean, baseUrl: string): string {
  return resolvePublicAssetBase("deepfilter", native, baseUrl);
}
