/// <reference types="node" />
// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assets = new URL("../../../public/dtln/", import.meta.url);

describe("shipped DTLN inference", () => {
  it("ships every runtime variant with version-matched pinned hashes", () => {
    const manifest = JSON.parse(readFileSync(new URL("asset-manifest.json", assets), "utf8").replace(/^\uFEFF/, ""));
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(new URL(name, assets))).digest("hex"), name).toBe(hash);
    }
    for (const variant of ["", "_simd", "_threaded", "_simd_threaded"]) {
      expect(manifest.files[`tflite_web_api_cc${variant}.js`]).toBeTruthy();
      expect(manifest.files[`tflite_web_api_cc${variant}.wasm`]).toBeTruthy();
    }
  });

  it("runs the real shipped model through a classic-worker environment and disposes tensor state", async () => {
    // No microphone, remote service or browser is required: emulate only the
    // Worker host APIs, retaining the real JS loader, WASM and model bytes.
    const loadAsset = (url: string) => {
      const name = new URL(url, "http://dtln.local/").pathname.split("/").at(-1)!;
      return readFileSync(new URL(name, assets));
    };
    const messages: Record<string, unknown>[] = [];
    let resolveMessage: (() => void) | undefined;
    const firstMessage = new Promise<void>((resolve) => { resolveMessage = resolve; });
    const sandbox = createContext({
      console, setTimeout, clearTimeout, performance, TextDecoder, TextEncoder,
      URL, URLSearchParams, Blob, Response, Request, Headers,
      atob, btoa, WebAssembly,
      WorkerGlobalScope: class {},
      navigator: { hardwareConcurrency: 2, userAgent: "DTLN test worker" },
      location: { href: "http://dtln.local/inference-worker.js", origin: "http://dtln.local" },
      crossOriginIsolated: false, SharedArrayBuffer: undefined,
      fetch: async (url: string) => new Response(loadAsset(String(url)), { headers: { "Content-Type": String(url).endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } }),
      postMessage: (message: Record<string, unknown>) => { messages.push(message); resolveMessage?.(); },
    });
    sandbox.self = sandbox;
    sandbox.importScripts = (...urls: string[]) => {
      for (const url of urls) runInContext(loadAsset(url).toString("utf8"), sandbox, { filename: url });
    };
    runInContext(readFileSync(new URL("inference-worker.js", assets), "utf8"), sandbox);
    runInContext("reportError = error => self.postMessage({type:'error', message:error.stack || String(error)})", sandbox);
    await runInContext("self.onmessage({data:{type:'init',session:'integration',assetBase:'http://dtln.local/',port:{start(){},postMessage(){}}}})", sandbox);
    await firstMessage;
    expect(messages[0], JSON.stringify(messages)).toMatchObject({ type: "ready", session: "integration", sampleRate: 16000 });
    const result = runInContext(`(() => {
      const before = tf.memory().numTensors;
      for (let i = 0; i < 100; i++) processState.process(new Float32Array(128));
      const after = tf.memory().numTensors;
      processState.dispose();
      return { before, after, disposed: tf.memory().numTensors };
    })()`, sandbox);
    expect(result.after).toBe(result.before);
    expect(result.disposed).toBe(result.before - 2);
  }, 30000);
});
