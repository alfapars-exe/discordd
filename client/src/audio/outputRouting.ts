type OutputRoutingPolicy = {
  defaultSink: string;
  isCurrent: () => boolean;
  canFallback?: (failure: unknown) => boolean;
};

export function isMissingOutputDevice(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && "name" in failure && failure.name === "NotFoundError";
}

/** Route a selected sink without allowing a retired owner to restore default. */
export async function routeAudioOutput(
  selected: string,
  apply: (sink: string) => Promise<unknown>,
  policy: OutputRoutingPolicy,
): Promise<boolean> {
  if (!policy.isCurrent()) return false;
  const sink = !selected || selected === "default" ? policy.defaultSink : selected;
  try {
    await apply(sink);
    return false;
  } catch (failure) {
    if (!policy.isCurrent()) return false;
    if (sink === policy.defaultSink || !(policy.canFallback ?? isMissingOutputDevice)(failure)) throw failure;
    await apply(policy.defaultSink);
    return true;
  }
}
