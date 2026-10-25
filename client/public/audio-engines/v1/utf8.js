// AudioWorkletGlobalScope does not consistently expose TextDecoder. Only the
// generated WASM glue's diagnostic strings use this small UTF-8 decoder.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(bytes = new Uint8Array()) {
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let result = '';
      for (let i = 0; i < input.length;) {
        let c = input[i++];
        if (c >= 0xf0) c = ((c & 7) << 18) | ((input[i++] & 63) << 12) | ((input[i++] & 63) << 6) | (input[i++] & 63);
        else if (c >= 0xe0) c = ((c & 15) << 12) | ((input[i++] & 63) << 6) | (input[i++] & 63);
        else if (c >= 0xc0) c = ((c & 31) << 6) | (input[i++] & 63);
        result += String.fromCodePoint(c);
      }
      return result;
    }
  };
}
