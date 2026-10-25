function containsControl(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
export function isGameActivityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !containsControl(value);
}
export function isGameActivityName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && value.trim().length > 0
    && !value.includes("/") && !value.includes("\\") && !containsControl(value);
}
