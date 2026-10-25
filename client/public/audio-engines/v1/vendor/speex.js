var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/SpeexPreprocessCtlRequest.ts
var SpeexPreprocessCtlRequest = {
  /** Set preprocessor denoiser state */
  SET_DENOISE: 0,
  /** Get preprocessor denoiser state */
  GET_DENOISE: 1,
  /** Set preprocessor Automatic Gain Control state */
  SET_AGC: 2,
  /** Get preprocessor Automatic Gain Control state */
  GET_AGC: 3,
  /** Set preprocessor Voice Activity Detection state */
  SET_VAD: 4,
  /** Get preprocessor Voice Activity Detection state */
  GET_VAD: 5,
  /** Set preprocessor Automatic Gain Control level (float) */
  SET_AGC_LEVEL: 6,
  /** Get preprocessor Automatic Gain Control level (float) */
  GET_AGC_LEVEL: 7,
  // NOTE: de-reverberation is currently disabled
  // /** Set preprocessor dereverb state */
  // SET_DEREVERB: 8,
  // /** Get preprocessor dereverb state */
  // GET_DEREVERB: 9,
  // NOTE: de-reverberation is currently disabled
  // /** Set preprocessor dereverb level */
  // SET_DEREVERB_LEVEL: 10,
  // /** Get preprocessor dereverb level */
  // GET_DEREVERB_LEVEL: 11,
  // NOTE: de-reverberation is currently disabled
  // /** Set preprocessor dereverb decay */
  // SET_DEREVERB_DECAY: 12,
  // /** Get preprocessor dereverb decay */
  // GET_DEREVERB_DECAY: 13,
  /** Set probability required for the VAD to go from silence to voice */
  SET_PROB_START: 14,
  /** Get probability required for the VAD to go from silence to voice */
  GET_PROB_START: 15,
  /** Set probability required for the VAD to stay in the voice state (integer percent) */
  SET_PROB_CONTINUE: 16,
  /** Get probability required for the VAD to stay in the voice state (integer percent) */
  GET_PROB_CONTINUE: 17,
  /** Set maximum attenuation of the noise in dB (negative number) */
  SET_NOISE_SUPPRESS: 18,
  /** Get maximum attenuation of the noise in dB (negative number) */
  GET_NOISE_SUPPRESS: 19,
  /** Set maximum attenuation of the residual echo in dB (negative number) */
  SET_ECHO_SUPPRESS: 20,
  /** Get maximum attenuation of the residual echo in dB (negative number) */
  GET_ECHO_SUPPRESS: 21,
  /** Set maximum attenuation of the residual echo in dB when near end is active (negative number) */
  SET_ECHO_SUPPRESS_ACTIVE: 22,
  /** Get maximum attenuation of the residual echo in dB when near end is active (negative number) */
  GET_ECHO_SUPPRESS_ACTIVE: 23,
  // NOTE: needs SpeexEchoState pointer
  // /** Set the corresponding echo canceller state so that residual echo suppression can be performed (NULL for no residual echo suppression) */
  // SET_ECHO_STATE: 24,
  // /** Get the corresponding echo canceller state */
  // GET_ECHO_STATE: 25,
  /** Set maximal gain increase in dB/second (int32) */
  SET_AGC_INCREMENT: 26,
  /** Get maximal gain increase in dB/second (int32) */
  GET_AGC_INCREMENT: 27,
  /** Set maximal gain decrease in dB/second (int32) */
  SET_AGC_DECREMENT: 28,
  /** Get maximal gain decrease in dB/second (int32) */
  GET_AGC_DECREMENT: 29,
  /** Set maximal gain in dB (int32) */
  SET_AGC_MAX_GAIN: 30,
  /** Get maximal gain in dB (int32) */
  GET_AGC_MAX_GAIN: 31,
  /*  Can't set loudness */
  /** Get loudness */
  GET_AGC_LOUDNESS: 33,
  /*  Can't set gain */
  /** Get current gain (int32 percent) */
  GET_AGC_GAIN: 35,
  /*  Can't set spectrum size */
  /** Get spectrum size for power spectrum (int32) */
  GET_PSD_SIZE: 37,
  /*  Can't set power spectrum */
  /** Get power spectrum (int32[] of squared values) */
  GET_PSD: 39,
  /*  Can't set noise size */
  /** Get spectrum size for noise estimate (int32)  */
  GET_NOISE_PSD_SIZE: 41,
  /*  Can't set noise estimate */
  /** Get noise estimate (int32[] of squared values) */
  GET_NOISE_PSD: 43,
  /* Can't set speech probability */
  /** Get speech probability in last frame (int32).  */
  GET_PROB: 45,
  /** Set preprocessor Automatic Gain Control level (int32) */
  SET_AGC_TARGET: 46,
  /** Get preprocessor Automatic Gain Control level (int32) */
  GET_AGC_TARGET: 47
};

// src/SpeexPreprocessor.ts
var I16_BYTE_SIZE = Int16Array.BYTES_PER_ELEMENT;
var I32_BYTE_SIZE = Int32Array.BYTES_PER_ELEMENT;
var F32_BYTE_SIZE = Float32Array.BYTES_PER_ELEMENT;
var I16_MAX_NUMBER = 2 ** 16 / 2 - 1;
var SpeexPreprocessor = class {
  constructor(speexModule, frameSize, samplingRate) {
    this.speexModule = speexModule;
    this.frameSize = frameSize;
    this.samplingRate = samplingRate;
    this.state = this.speexModule._speex_preprocess_state_init(
      this.frameSize,
      this.samplingRate
    );
    this.processBuffPtr = this.speexModule._malloc(
      this.frameSize * I16_BYTE_SIZE
    );
    this.processI16Buff = new Int16Array(this.frameSize);
    if (!this.processBuffPtr) {
      this.destroy();
      throw Error("Failed to allocate process buffer.");
    }
  }
  mallocCtlBuffPtr() {
    if (this.ctlBuffPtr !== void 0) return;
    this.ctlBuffPtr = this.speexModule._malloc(
      4
      /** I32_BYTE_SIZE && F32_BYTE_SIZE */
    );
    if (!this.ctlBuffPtr) {
      throw Error("Failed to allocate ctl buffer.");
    }
  }
  ctl(req, output) {
    const res = this.speexModule._speex_preprocess_ctl(this.state, req, output);
    if (res === -1) {
      throw new Error(`Unknown request: ${req}`);
    }
  }
  ctlGetI32(req) {
    this.mallocCtlBuffPtr();
    const ctlBuffIndex = this.ctlBuffPtr / I32_BYTE_SIZE;
    this.ctl(req, this.ctlBuffPtr);
    return this.speexModule.HEAP32[ctlBuffIndex];
  }
  ctlSetI32(req, value) {
    this.mallocCtlBuffPtr();
    const ctlBuffIndex = this.ctlBuffPtr / I32_BYTE_SIZE;
    this.speexModule.HEAP32[ctlBuffIndex] = value;
    this.ctl(req, this.ctlBuffPtr);
  }
  ctlGetBool(req) {
    return this.ctlGetI32(req) === 1;
  }
  ctlSetBool(req, value) {
    this.ctlSetI32(req, value ? 1 : 0);
  }
  ctlGetF32(req) {
    this.mallocCtlBuffPtr();
    const ctlBuffIndex = this.ctlBuffPtr / F32_BYTE_SIZE;
    this.ctl(req, this.ctlBuffPtr);
    return this.speexModule.HEAPF32[ctlBuffIndex];
  }
  ctlSetF32(req, value) {
    this.mallocCtlBuffPtr();
    const ctlBuffIndex = this.ctlBuffPtr / F32_BYTE_SIZE;
    this.speexModule.HEAPF32[ctlBuffIndex] = value;
    this.ctl(req, this.ctlBuffPtr);
  }
  ctlGetI32Array(req, size) {
    const buffPtr = this.speexModule._malloc(size * I32_BYTE_SIZE);
    const buffIndex = buffPtr / I32_BYTE_SIZE;
    this.ctl(req, buffPtr);
    const result = new Int32Array(size);
    const res = this.speexModule.HEAP32.subarray(buffIndex, buffIndex + size);
    result.set(res);
    this.speexModule._free(buffPtr);
    return result;
  }
  get denoise() {
    return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_DENOISE);
  }
  set denoise(value) {
    this.ctlSetBool(SpeexPreprocessCtlRequest.SET_DENOISE, value);
  }
  get agc() {
    return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_AGC);
  }
  set agc(value) {
    this.ctlSetBool(SpeexPreprocessCtlRequest.SET_AGC, value);
  }
  get vad() {
    return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_VAD);
  }
  set vad(value) {
    this.ctlSetBool(SpeexPreprocessCtlRequest.SET_VAD, value);
  }
  get agcLevel() {
    return this.ctlGetF32(SpeexPreprocessCtlRequest.GET_AGC_LEVEL);
  }
  set agcLevel(value) {
    this.ctlSetF32(SpeexPreprocessCtlRequest.SET_AGC_LEVEL, value);
  }
  get probStart() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB_START);
  }
  set probStart(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_PROB_START, value);
  }
  get probContinue() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB_CONTINUE);
  }
  set probContinue(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_PROB_CONTINUE, value);
  }
  get noiseSuppress() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_NOISE_SUPPRESS);
  }
  set noiseSuppress(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_NOISE_SUPPRESS, value);
  }
  get echoSuppress() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_ECHO_SUPPRESS);
  }
  set echoSuppress(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_ECHO_SUPPRESS, value);
  }
  get echoSuppressActive() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_ECHO_SUPPRESS_ACTIVE);
  }
  set echoSuppressActive(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_ECHO_SUPPRESS_ACTIVE, value);
  }
  get agcIncrement() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_INCREMENT);
  }
  set agcIncrement(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_INCREMENT, value);
  }
  get agcDecrement() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_DECREMENT);
  }
  set agcDecrement(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_DECREMENT, value);
  }
  get agcMaxGain() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_MAX_GAIN);
  }
  set agcMaxGain(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_MAX_GAIN, value);
  }
  get agcLoudness() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_LOUDNESS);
  }
  get agcGain() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_GAIN);
  }
  get psdSize() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PSD_SIZE);
  }
  get psd() {
    return this.ctlGetI32Array(SpeexPreprocessCtlRequest.GET_PSD, this.psdSize);
  }
  get noisePsdSize() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_NOISE_PSD_SIZE);
  }
  get noisePsd() {
    return this.ctlGetI32Array(
      SpeexPreprocessCtlRequest.GET_NOISE_PSD,
      this.noisePsdSize
    );
  }
  get prob() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB);
  }
  get agcTarget() {
    return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_TARGET);
  }
  set agcTarget(value) {
    this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_TARGET, value);
  }
  assertFrameSize(frame) {
    if (frame.length !== this.frameSize) {
      throw new Error(
        `Frame size differs. Expected: ${this.frameSize}. Actual: ${frame.length}.`
      );
    }
  }
  processInt16(frame) {
    this.assertFrameSize(frame);
    const processBuffIndex = this.processBuffPtr / I16_BYTE_SIZE;
    this.speexModule.HEAP16.set(frame, processBuffIndex);
    const vad = this.speexModule._speex_preprocess_run(
      this.state,
      this.processBuffPtr
    );
    const processedBuff = this.speexModule.HEAP16.subarray(
      processBuffIndex,
      processBuffIndex + this.frameSize
    );
    frame.set(processedBuff);
    return vad === 1;
  }
  process(frame) {
    this.assertFrameSize(frame);
    for (let i = 0; i < frame.length; i++) {
      this.processI16Buff[i] = frame[i] * I16_MAX_NUMBER;
    }
    const vad = this.processInt16(this.processI16Buff);
    for (let i = 0; i < frame.length; i++) {
      frame[i] = this.processI16Buff[i] / I16_MAX_NUMBER;
    }
    return vad;
  }
  destroy() {
    this.speexModule._free(this.processBuffPtr);
    if (this.ctlBuffPtr !== void 0) {
      this.speexModule._free(this.ctlBuffPtr);
    }
  }
};

// wasm-out/speex.js
var Module = /* @__PURE__ */ (() => {
  return async function(moduleArg = {}) {
    var moduleRtn;
    var Module2 = moduleArg;
    var readyPromiseResolve, readyPromiseReject;
    var readyPromise = new Promise((resolve, reject) => {
      readyPromiseResolve = resolve;
      readyPromiseReject = reject;
    });
    var ENVIRONMENT_IS_WEB = typeof window == "object";
    var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
    var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
    var _scriptName = import.meta.url;
    var scriptDirectory = "";
    function locateFile(path) {
      return scriptDirectory + path;
    }
    var readAsync, readBinary;
    if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
      try {
        scriptDirectory = new URL(".", _scriptName).href;
      } catch {
      }
      {
        if (ENVIRONMENT_IS_WORKER) {
          readBinary = (url) => {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, false);
            xhr.responseType = "arraybuffer";
            xhr.send(null);
            return new Uint8Array(xhr.response);
          };
        }
        readAsync = async (url) => {
          var response = await fetch(url, { credentials: "same-origin" });
          if (response.ok) {
            return response.arrayBuffer();
          }
          throw new Error(response.status + " : " + response.url);
        };
      }
    } else {
    }
    var out = console.log.bind(console);
    var err = console.error.bind(console);
    var wasmBinary;
    var wasmMemory;
    var ABORT = false;
    var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAP64, HEAPU64, HEAPF64;
    var runtimeInitialized = false;
    function updateMemoryViews() {
      var b = wasmMemory.buffer;
      HEAP8 = new Int8Array(b);
      Module2["HEAP16"] = HEAP16 = new Int16Array(b);
      HEAPU8 = new Uint8Array(b);
      HEAPU16 = new Uint16Array(b);
      Module2["HEAP32"] = HEAP32 = new Int32Array(b);
      HEAPU32 = new Uint32Array(b);
      Module2["HEAPF32"] = HEAPF32 = new Float32Array(b);
      HEAPF64 = new Float64Array(b);
      HEAP64 = new BigInt64Array(b);
      HEAPU64 = new BigUint64Array(b);
    }
    function preRun() {
    }
    function initRuntime() {
      runtimeInitialized = true;
      wasmExports["f"]();
    }
    function postRun() {
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
      readyPromiseReject(e);
      throw e;
    }
    var wasmBinaryFile;
    function findWasmBinary() {
      if (Module2["locateFile"]) {
        return locateFile("speex.wasm");
      }
      return new URL("speex.wasm", import.meta.url).href;
    }
    function getBinarySync(file) {
      if (file == wasmBinaryFile && wasmBinary) {
        return new Uint8Array(wasmBinary);
      }
      if (readBinary) {
        return readBinary(file);
      }
      throw "both async and sync fetching of the wasm failed";
    }
    async function getWasmBinary(binaryFile) {
      if (!wasmBinary) {
        try {
          var response = await readAsync(binaryFile);
          return new Uint8Array(response);
        } catch {
        }
      }
      return getBinarySync(binaryFile);
    }
    async function instantiateArrayBuffer(binaryFile, imports) {
      try {
        var binary = await getWasmBinary(binaryFile);
        var instance = await WebAssembly.instantiate(binary, imports);
        return instance;
      } catch (reason) {
        err(`failed to asynchronously prepare wasm: ${reason}`);
        abort(reason);
      }
    }
    async function instantiateAsync(binary, binaryFile, imports) {
      if (!binary && typeof WebAssembly.instantiateStreaming == "function") {
        try {
          var response = fetch(binaryFile, { credentials: "same-origin" });
          var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
          return instantiationResult;
        } catch (reason) {
          err(`wasm streaming compile failed: ${reason}`);
          err("falling back to ArrayBuffer instantiation");
        }
      }
      return instantiateArrayBuffer(binaryFile, imports);
    }
    function getWasmImports() {
      return { a: wasmImports };
    }
    async function createWasm() {
      function receiveInstance(instance, module) {
        wasmExports = instance.exports;
        wasmMemory = wasmExports["e"];
        updateMemoryViews();
        removeRunDependency("wasm-instantiate");
        return wasmExports;
      }
      addRunDependency("wasm-instantiate");
      function receiveInstantiationResult(result2) {
        return receiveInstance(result2["instance"]);
      }
      var info = getWasmImports();
      wasmBinaryFile != null ? wasmBinaryFile : wasmBinaryFile = findWasmBinary();
      try {
        var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
        var exports = receiveInstantiationResult(result);
        return exports;
      } catch (e) {
        readyPromiseReject(e);
        return Promise.reject(e);
      }
    }
    class ExitStatus {
      constructor(status) {
        __publicField(this, "name", "ExitStatus");
        this.message = `Program terminated with exit(${status})`;
        this.status = status;
      }
    }
    var getHeapMax = () => 2147483648;
    var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
    var growMemory = (size) => {
      var b = wasmMemory.buffer;
      var pages = (size - b.byteLength + 65535) / 65536 | 0;
      try {
        wasmMemory.grow(pages);
        updateMemoryViews();
        return 1;
      } catch (e) {
      }
    };
    var _emscripten_resize_heap = (requestedSize) => {
      var oldSize = HEAPU8.length;
      requestedSize >>>= 0;
      var maxHeapSize = getHeapMax();
      if (requestedSize > maxHeapSize) {
        return false;
      }
      for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) {
          return true;
        }
      }
      return false;
    };
    var _fd_close = (fd) => 52;
    var INT53_MAX = 9007199254740992;
    var INT53_MIN = -9007199254740992;
    var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
    function _fd_seek(fd, offset, whence, newOffset) {
      offset = bigintToI53Checked(offset);
      return 70;
    }
    var printCharBuffers = [null, [], []];
    var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
    var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
      var endIdx = idx + maxBytesToRead;
      var endPtr = idx;
      while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
      if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
        return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
      }
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
        if ((u0 & 240) == 224) {
          u0 = (u0 & 15) << 12 | u1 << 6 | u2;
        } else {
          u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
        }
        if (u0 < 65536) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 65536;
          str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
        }
      }
      return str;
    };
    var printChar = (stream, curr) => {
      var buffer = printCharBuffers[stream];
      if (curr === 0 || curr === 10) {
        (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
        buffer.length = 0;
      } else {
        buffer.push(curr);
      }
    };
    var _fd_write = (fd, iov, iovcnt, pnum) => {
      var num = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >> 2];
        var len = HEAPU32[iov + 4 >> 2];
        iov += 8;
        for (var j = 0; j < len; j++) {
          printChar(fd, HEAPU8[ptr + j]);
        }
        num += len;
      }
      HEAPU32[pnum >> 2] = num;
      return 0;
    };
    {
      if (Module2["wasmBinary"]) wasmBinary = Module2["wasmBinary"];
    }
    var wasmImports = { d: _emscripten_resize_heap, c: _fd_close, b: _fd_seek, a: _fd_write };
    var wasmExports = await createWasm();
    var ___wasm_call_ctors = wasmExports["f"];
    var _speex_preprocess_state_init = Module2["_speex_preprocess_state_init"] = wasmExports["g"];
    var _speex_preprocess_state_destroy = Module2["_speex_preprocess_state_destroy"] = wasmExports["h"];
    var _speex_preprocess_run = Module2["_speex_preprocess_run"] = wasmExports["i"];
    var _speex_preprocess_ctl = Module2["_speex_preprocess_ctl"] = wasmExports["j"];
    var _free = Module2["_free"] = wasmExports["k"];
    var _malloc = Module2["_malloc"] = wasmExports["l"];
    function run() {
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      preRun();
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      function doRun() {
        Module2["calledRun"] = true;
        if (ABORT) return;
        initRuntime();
        readyPromiseResolve(Module2);
        postRun();
      }
      {
        doRun();
      }
    }
    function preInit() {
    }
    preInit();
    run();
    moduleRtn = readyPromise;
    return moduleRtn;
  };
})();
var speex_default = Module;
export {
  SpeexPreprocessor,
  speex_default as loadSpeexModule
};
/*!
license of speex.wasm

---

Copyright 2002-2008 	Xiph.org Foundation
Copyright 2002-2008 	Jean-Marc Valin
Copyright 2005-2007	Analog Devices Inc.
Copyright 2005-2008	Commonwealth Scientific and Industrial Research
                        Organisation (CSIRO)
Copyright 1993, 2002, 2006 David Rowe
Copyright 2003 		EpicGames
Copyright 1992-1994	Jutta Degener, Carsten Bormann

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of the Xiph.org Foundation nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
//# sourceMappingURL=index.js.map