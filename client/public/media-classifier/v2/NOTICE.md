# Local disturbing-media model candidate

This directory contains unchanged, pinned third-party artifacts, not a claim of
classification accuracy or completed product acceptance. No media is uploaded
to the model provider. The application worker and independent category policy
use these assets; browser, quality and real-device acceptance remain pending.

## Model

- Repository: https://huggingface.co/OwenElliott/image-safety-classifier-xs
- Revision: `54f4560bd9c5ee92d45dc30418a8f8680e80de6d`
- Original path: `onnx/image-safety-classifier-xs.onnx`
- Author-provided model card: `MODEL_CARD.md` (declares MIT).
- Base SwiftFormer license: `SWIFTFORMER-LICENSE` (Apache-2.0).
- Output order: NSFL, NSFW, SFW. Normalization and softmax are embedded.
- Input: RGB resized to 224 x 224, float32 NCHW, range 0–255.

## Runtime and preprocessing notices

ONNX Runtime Web 1.30.0: Microsoft and contributors; see
`ONNX-RUNTIME-LICENSE` and `ONNX-ThirdPartyNotices.txt`. JavaScript and WASM
artifacts were copied unchanged from the 1.30.0 npm package. They are served
locally; no CDN dependency is required.

Pillow license: `PILLOW-LICENSE`. The independent TypeScript resize implementation
is regression-tested against Pillow 13.0.0 byte output. This does not establish
browser image-decoder, color-profile, alpha, or EXIF parity.

Integrity and actual synthetic inference can be checked from the repository root:

`node scripts/verify-vendored-disturbing-runtime.mjs`

The model's NSFL training class is underrepresented. Thresholds are provisional;
synthetic inference is not accuracy, safety, browser, or real-device acceptance.
Uncertain or failed classification must never be interpreted as safe content.
