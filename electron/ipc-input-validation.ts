export function assertString(value: unknown, name: string, maxLen: number): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, got ${typeof value}`);
  }
  if (value.length > maxLen) {
    throw new RangeError(`${name} exceeds max length ${maxLen}`);
  }
}

export function assertFiniteNumber(
  value: unknown,
  name: string,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be in [${min}, ${max}]`);
  }
}

