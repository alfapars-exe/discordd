/*!
 * GTCRN
 *
 * MIT License
 * 
 * Copyright (c) 2024 Rong Xiaobin
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/*!
 * pffft
 *
 * Copyright (c) 2020  Dario Mambro ( dario.mambro@gmail.com )
 * Copyright (c) 2019  Hayati Ayguen ( h_ayguen@web.de )
 * Copyright (c) 2013  Julien Pommier ( pommier@modartt.com )
 * 
 * Copyright (c) 2004 the University Corporation for Atmospheric
 * Research ("UCAR"). All rights reserved. Developed by NCAR's
 * Computational and Information Systems Laboratory, UCAR,
 * www.cisl.ucar.edu.
 * 
 * Redistribution and use of the Software in source and binary forms,
 * with or without modification, is permitted provided that the
 * following conditions are met:
 * 
 * - Neither the names of NCAR's Computational and Information Systems
 * Laboratory, the University Corporation for Atmospheric Research,
 * nor the names of its sponsors or contributors may be used to
 * endorse or promote products derived from this Software without
 * specific prior written permission.  
 * 
 * - Redistributions of source code must retain the above copyright
 * notices, this list of conditions, and the disclaimer below.
 * 
 * - Redistributions in binary form must reproduce the above copyright
 * notice, this list of conditions, and the disclaimer below in the
 * documentation and/or other materials provided with the
 * distribution.
 * 
 * THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
 * SOFTWARE.
 */
//#region src/GtcrnProcessor.ts
const F32 = Float32Array.BYTES_PER_ELEMENT;
const FRAME_SIZE = 256;
const SAMPLE_RATE = 16e3;
const FRAME_SIZE_48K = 768;
const SAMPLE_RATE_48K = 48e3;
var GtcrnProcessor = class {
	constructor(module, options = {}) {
		this.module = module;
		this.sampleRate = options.sampleRate ?? 16e3;
		if (this.sampleRate !== 16e3 && this.sampleRate !== 48e3) throw new Error(`Unsupported sample rate: ${String(this.sampleRate)}.`);
		this.frameSize = this.sampleRate === 48e3 ? 768 : 256;
		this.processNative = this.sampleRate === 48e3 ? module._gtcrn_process_48k : module._gtcrn_process;
		this.state = module._gtcrn_create();
		if (!this.state) throw new Error("Failed to create GTCRN state.");
		this.inPtr = module._malloc(this.frameSize * F32);
		this.outPtr = module._malloc(this.frameSize * F32);
		if (!this.inPtr || !this.outPtr) {
			this.destroy();
			throw new Error("Failed to allocate frame buffers.");
		}
	}
	/**
	* Denoise one frame. The default is 256 samples at 16 kHz; use
	* `{ sampleRate: 48000 }` for 768 samples at 48 kHz.
	*/
	process(frame) {
		if (!this.state) throw new Error("GtcrnProcessor is destroyed.");
		if (frame.length !== this.frameSize) throw new Error(`frame must have exactly ${this.frameSize} samples at ${this.sampleRate} Hz.`);
		this.module.HEAPF32.set(frame, this.inPtr / F32);
		this.processNative(this.state, this.inPtr, this.outPtr);
		return this.module.HEAPF32.slice(this.outPtr / F32, this.outPtr / F32 + this.frameSize);
	}
	destroy() {
		if (this.inPtr) this.module._free(this.inPtr);
		if (this.outPtr) this.module._free(this.outPtr);
		if (this.state) this.module._gtcrn_destroy(this.state);
		this.inPtr = this.outPtr = this.state = 0;
	}
};
//#endregion
//#region wasm-out/gtcrn.js
var Module = (() => {
	return (async function(moduleArg = {}) {
		var moduleRtn;
		var Module = moduleArg;
		var ENVIRONMENT_IS_WEB = typeof window == "object";
		var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
		typeof process == "object" && process.versions?.node && process.type;
		var _scriptName = import.meta.url;
		var scriptDirectory = "";
		function locateFile(path) {
			return scriptDirectory + path;
		}
		var readAsync, readBinary;
		if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
			try {
				scriptDirectory = new URL(".", _scriptName).href;
			} catch {}
			if (ENVIRONMENT_IS_WORKER) readBinary = (url) => {
				var xhr = new XMLHttpRequest();
				xhr.open("GET", url, false);
				xhr.responseType = "arraybuffer";
				xhr.send(null);
				return new Uint8Array(xhr.response);
			};
			readAsync = async (url) => {
				var response = await fetch(url, { credentials: "same-origin" });
				if (response.ok) return response.arrayBuffer();
				throw new Error(response.status + " : " + response.url);
			};
		}
		console.log.bind(console);
		var err = console.error.bind(console);
		var wasmBinary;
		var ABORT = false;
		var readyPromiseResolve, readyPromiseReject;
		var wasmMemory, HEAPU8;
		var runtimeInitialized = false;
		function updateMemoryViews() {
			var b = wasmMemory.buffer;
			new Int8Array(b);
			new Int16Array(b);
			HEAPU8 = new Uint8Array(b);
			new Uint16Array(b);
			new Int32Array(b);
			new Uint32Array(b);
			Module["HEAPF32"] = new Float32Array(b);
			new Float64Array(b);
			new BigInt64Array(b);
			new BigUint64Array(b);
		}
		function initRuntime() {
			runtimeInitialized = true;
			wasmExports["d"]();
		}
		var runDependencies = 0;
		var dependenciesFulfilled = null;
		function addRunDependency(id) {
			runDependencies++;
		}
		function removeRunDependency(id) {
			runDependencies--;
			if (runDependencies == 0) {
				if (dependenciesFulfilled) {
					var callback = dependenciesFulfilled;
					dependenciesFulfilled = null;
					callback();
				}
			}
		}
		function abort(what) {
			what = "Aborted(" + what + ")";
			err(what);
			ABORT = true;
			what += ". Build with -sASSERTIONS for more info.";
			var e = new WebAssembly.RuntimeError(what);
			readyPromiseReject?.(e);
			throw e;
		}
		var wasmBinaryFile;
		function findWasmBinary() {
			if (Module["locateFile"]) return locateFile("gtcrn.wasm");
			return new URL("gtcrn.wasm", import.meta.url).href;
		}
		function getBinarySync(file) {
			if (file == wasmBinaryFile && wasmBinary) return new Uint8Array(wasmBinary);
			if (readBinary) return readBinary(file);
			throw "both async and sync fetching of the wasm failed";
		}
		async function getWasmBinary(binaryFile) {
			if (!wasmBinary) try {
				var response = await readAsync(binaryFile);
				return new Uint8Array(response);
			} catch {}
			return getBinarySync(binaryFile);
		}
		async function instantiateArrayBuffer(binaryFile, imports) {
			try {
				var binary = await getWasmBinary(binaryFile);
				return await WebAssembly.instantiate(binary, imports);
			} catch (reason) {
				err(`failed to asynchronously prepare wasm: ${reason}`);
				abort(reason);
			}
		}
		async function instantiateAsync(binary, binaryFile, imports) {
			if (!binary && typeof WebAssembly.instantiateStreaming == "function") try {
				var response = fetch(binaryFile, { credentials: "same-origin" });
				return await WebAssembly.instantiateStreaming(response, imports);
			} catch (reason) {
				err(`wasm streaming compile failed: ${reason}`);
				err("falling back to ArrayBuffer instantiation");
			}
			return instantiateArrayBuffer(binaryFile, imports);
		}
		function getWasmImports() {
			return { a: wasmImports };
		}
		async function createWasm() {
			function receiveInstance(instance, module) {
				wasmExports = instance.exports;
				wasmMemory = wasmExports["c"];
				updateMemoryViews();
				assignWasmExports(wasmExports);
				removeRunDependency("wasm-instantiate");
				return wasmExports;
			}
			addRunDependency("wasm-instantiate");
			function receiveInstantiationResult(result) {
				return receiveInstance(result["instance"]);
			}
			var info = getWasmImports();
			wasmBinaryFile ??= findWasmBinary();
			return receiveInstantiationResult(await instantiateAsync(wasmBinary, wasmBinaryFile, info));
		}
		var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
		var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
			var endIdx = idx + maxBytesToRead;
			var endPtr = idx;
			while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
			if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
			var str = "";
			while (idx < endPtr) {
				var u0 = heapOrArray[idx++];
				if (!(u0 & 128)) {
					str += String.fromCharCode(u0);
					continue;
				}
				var u1 = heapOrArray[idx++] & 63;
				if ((u0 & 224) == 192) {
					str += String.fromCharCode((u0 & 31) << 6 | u1);
					continue;
				}
				var u2 = heapOrArray[idx++] & 63;
				if ((u0 & 240) == 224) u0 = (u0 & 15) << 12 | u1 << 6 | u2;
				else u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
				if (u0 < 65536) str += String.fromCharCode(u0);
				else {
					var ch = u0 - 65536;
					str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
				}
			}
			return str;
		};
		var UTF8ToString = (ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
		var ___assert_fail = (condition, filename, line, func) => abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [
			filename ? UTF8ToString(filename) : "unknown filename",
			line,
			func ? UTF8ToString(func) : "unknown function"
		]);
		var getHeapMax = () => 2147483648;
		var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
		var growMemory = (size) => {
			var pages = (size - wasmMemory.buffer.byteLength + 65535) / 65536 | 0;
			try {
				wasmMemory.grow(pages);
				updateMemoryViews();
				return 1;
			} catch (e) {}
		};
		var _emscripten_resize_heap = (requestedSize) => {
			var oldSize = HEAPU8.length;
			requestedSize >>>= 0;
			var maxHeapSize = getHeapMax();
			if (requestedSize > maxHeapSize) return false;
			for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
				var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
				overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
				if (growMemory(Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536)))) return true;
			}
			return false;
		};
		if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
		function assignWasmExports(wasmExports) {
			Module["_gtcrn_create"] = wasmExports["e"];
			Module["_free"] = wasmExports["f"];
			Module["_gtcrn_destroy"] = wasmExports["g"];
			Module["_gtcrn_model_run"] = wasmExports["h"];
			Module["_gtcrn_process"] = wasmExports["i"];
			Module["_gtcrn_process_48k"] = wasmExports["j"];
			Module["_malloc"] = wasmExports["k"];
		}
		var wasmImports = {
			a: ___assert_fail,
			b: _emscripten_resize_heap
		};
		var wasmExports = await createWasm();
		function run() {
			if (runDependencies > 0) {
				dependenciesFulfilled = run;
				return;
			}
			if (runDependencies > 0) {
				dependenciesFulfilled = run;
				return;
			}
			function doRun() {
				Module["calledRun"] = true;
				if (ABORT) return;
				initRuntime();
				readyPromiseResolve?.(Module);
			}
			doRun();
		}
		run();
		if (runtimeInitialized) moduleRtn = Module;
		else moduleRtn = new Promise((resolve, reject) => {
			readyPromiseResolve = resolve;
			readyPromiseReject = reject;
		});
		return moduleRtn;
	});
})();
//#endregion
export { FRAME_SIZE, FRAME_SIZE_48K, GtcrnProcessor, SAMPLE_RATE, SAMPLE_RATE_48K, Module as loadGtcrnModule };

//# sourceMappingURL=index.js.map