/** Bounded in-app route history for keyboard navigation; never delegates to browser/external history. */
let routes: string[] = [];
let cursor = -1;

export function observeAppRoute(path: string): void {
  if (!path) return;
  if (routes[cursor] === path) return;
  if (routes[cursor + 1] === path) { cursor++; return; }
  if (routes[cursor - 1] === path) { cursor--; return; }
  routes = routes.slice(0, cursor + 1);
  routes.push(path);
  if (routes.length > 100) routes.shift();
  cursor = routes.length - 1;
}

export function stepAppRouteHistory(direction: -1 | 1): string | undefined {
  const next = cursor + direction;
  if (next < 0 || next >= routes.length) return undefined;
  cursor = next;
  return routes[cursor];
}

export function resetAppRouteHistory(): void {
  routes = [];
  cursor = -1;
}
