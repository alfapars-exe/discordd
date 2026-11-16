/** Bounded diagnostics for synthetic panel fixtures. Preserve operation results,
 * promise identity and rejection identity; never retry or swallow a failure.
 */
export function createPanelSearchDiagnostics(limit = 16) {
  const failures = [];
  const watched = new WeakSet();
  function record(phase, error) {
    const entry = {
      phase: phase.slice(0, 64),
      name: typeof error?.name === "string" ? error.name.slice(0, 64) : typeof error,
      message: (typeof error?.message === "string" ? error.message : String(error)).slice(0, 256),
    };
    // Keep the first cause even when disposal produces many later aborts.
    if (failures.length >= limit) failures.splice(1, 1);
    failures.push(entry);
  }
  function observe(phase, operation) {
    try {
      const result = operation();
      if (result && typeof result.then === "function") void result.then(undefined, error => record(phase, error));
      return result;
    } catch (error) {
      record(phase, error);
      throw error;
    }
  }
  function wrap(target, phase, methods) {
    for (const name of methods) {
      const method = target[name];
      target[name] = function (...args) {
        return observe(`${phase}.${name}`, () => Reflect.apply(method, this, args));
      };
    }
    return target;
  }
  function wrapPool(pool) {
    const create = pool.create;
    pool.create = function (...args) {
      return wrap(observe("pool.create", () => Reflect.apply(create, this, args)), "spool", ["append", "drain", "dispose"]);
    };
    return wrap(pool, "pool", ["close"]);
  }
  function watchDatabase(db) {
    if (watched.has(db)) return;
    watched.add(db);
    for (const eventName of ["error", "abort"]) db.addEventListener(eventName, event => {
      record(`idb.${eventName}`, event.target?.error ?? new Error(`IndexedDB ${eventName}`));
    });
  }
  return { failures, observe, wrap, wrapPool, watchDatabase, reset: () => { failures.length = 0; } };
}
