import { create } from "zustand";
import type { Channel } from "../types";
import { getThread, listThreads } from "../api/threads";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

type LoadStatus = "loading" | "ready" | "error";
type ParentRequest = { revision: number; promise: Promise<void> };
type ThreadRequest = { revision: number; serverID: string; threadID: string; promise: Promise<void> };
type Scope = { ownerId: string | null; authGeneration: number };
const requests = new Map<string, ParentRequest>();
const parentRevisions = new Map<string, number>();
const threadRequests = new Map<string, ThreadRequest>();
const threadRevisions = new Map<string, number>();
const serverRevisions = new Map<string, number>();

type State = Scope & {
  byID: Record<string, Channel>;
  byParent: Record<string, Channel[]>;
  loadedParents: Record<string, boolean>;
  serverIdByThread: Record<string, string>;
  statusByParent: Record<string, LoadStatus>;
  statusByThread: Record<string, LoadStatus>;
  remember: (channel: Channel, serverID: string) => void;
  remove: (threadID: string, serverID: string) => void;
  removeParent: (parentID: string, serverID: string) => void;
  loadParent: (serverID: string, parentID: string) => Promise<void>;
  loadThread: (serverID: string, threadID: string, force?: boolean) => Promise<void>;
};

const parentKey = (serverID: string, parentID: string) => JSON.stringify([serverID, parentID]);
const requestKey = (scope: Scope, serverID: string, parentID: string) => JSON.stringify([scope.ownerId, scope.authGeneration, serverID, parentID]);
const threadKey = (serverID: string, threadID: string) => JSON.stringify([serverID, threadID]);
const threadRequestKey = (scope: Scope, serverID: string, threadID: string) => JSON.stringify([scope.ownerId, scope.authGeneration, serverID, threadID]);
const nextParentRevision = (key: string) => {
  const next = (parentRevisions.get(key) ?? 0) + 1;
  parentRevisions.set(key, next);
  return next;
};
function removeParentRequests(serverID: string, parentID: string): void {
  for (const requestKeyValue of requests.keys()) {
    try {
      const parts = JSON.parse(requestKeyValue) as unknown[];
      if (parts[2] === serverID && parts[3] === parentID) requests.delete(requestKeyValue);
    } catch { /* Invalid internal keys are ignored. */ }
  }
}
function nextThreadRevision(serverID: string, threadID: string): number {
  const key = threadKey(serverID, threadID);
  const next = (threadRevisions.get(key) ?? 0) + 1;
  threadRevisions.set(key, next);
  for (const [requestKeyValue, request] of threadRequests) {
    if (request.serverID === serverID && request.threadID === threadID) threadRequests.delete(requestKeyValue);
  }
  return next;
}
function invalidateThreadRequestsForServer(serverID: string): string[] {
  serverRevisions.set(serverID, (serverRevisions.get(serverID) ?? 0) + 1);
  const invalidated: string[] = [];
  for (const [key, request] of threadRequests) if (request.serverID === serverID) {
    invalidated.push(request.threadID);
    threadRequests.delete(key);
  }
  return invalidated;
}
function validThread(channel: unknown, parentID?: string): channel is Channel {
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) return false;
  const value = channel as Partial<Channel>;
  return value.type === "thread" && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 100
    && typeof value.parent_channel_id === "string" && value.parent_channel_id.length > 0 && value.parent_channel_id.length <= 128
    && (!parentID || value.parent_channel_id === parentID);
}
function sameScope(state: State, scope: Scope): boolean {
  const current = getAuthSessionSnapshot();
  return !!scope.ownerId && current.ownerId === scope.ownerId && current.generation === scope.authGeneration
    && state.ownerId === scope.ownerId && state.authGeneration === scope.authGeneration;
}

const initialScope = getAuthSessionSnapshot();
export const useThreadStore = create<State>((set, get) => ({
  ownerId: initialScope.ownerId,
  authGeneration: initialScope.generation,
  byID: {},
  byParent: {},
  loadedParents: {},
  serverIdByThread: {},
  statusByParent: {},
  statusByThread: {},
  remember: (channel, serverID) => {
    if (!serverID || !validThread(channel)) return;
    const state = get();
    const scope = { ownerId: state.ownerId, authGeneration: state.authGeneration };
    if (!sameScope(state, scope)) return;
    const existingServer = state.serverIdByThread[channel.id];
    if (existingServer && existingServer !== serverID) return;
    const currentParent = channel.parent_channel_id!;
    nextThreadRevision(serverID, channel.id);
    const currentKey = parentKey(serverID, currentParent);
    nextParentRevision(currentKey);
    set((current) => {
      const byParent = { ...current.byParent };
      const old = current.byID[channel.id];
      if (old?.parent_channel_id && old.parent_channel_id !== currentParent) {
        const priorKey = parentKey(serverID, old.parent_channel_id);
        nextParentRevision(priorKey);
        byParent[old.parent_channel_id] = (byParent[old.parent_channel_id] ?? []).filter((item) => item.id !== channel.id);
      }
      const parentRows = (byParent[currentParent] ?? []).filter((item) => item.id !== channel.id);
      byParent[currentParent] = [channel, ...parentRows];
      return {
        byID: { ...current.byID, [channel.id]: channel },
        byParent,
        loadedParents: { ...current.loadedParents, [currentParent]: true },
        serverIdByThread: { ...current.serverIdByThread, [channel.id]: serverID },
        statusByParent: { ...current.statusByParent, [currentKey]: "ready" },
        statusByThread: { ...current.statusByThread, [channel.id]: "ready" },
      };
    });
  },
  remove: (threadID, serverID) => {
    if (!threadID || !serverID) return;
    nextThreadRevision(serverID, threadID);
    const state = get();
    if (state.serverIdByThread[threadID] !== serverID) return;
    const thread = state.byID[threadID];
    const key = thread?.parent_channel_id ? parentKey(serverID, thread.parent_channel_id) : "";
    if (key) {
      nextParentRevision(key);
      removeParentRequests(serverID, thread.parent_channel_id!);
    }
    set((current) => {
      const byID = { ...current.byID };
      const serverIdByThread = { ...current.serverIdByThread };
      delete byID[threadID];
      delete serverIdByThread[threadID];
      const byParent = { ...current.byParent };
      const statusByThread = { ...current.statusByThread };
      delete statusByThread[threadID];
      if (thread?.parent_channel_id) byParent[thread.parent_channel_id] = (byParent[thread.parent_channel_id] ?? []).filter((item) => item.id !== threadID);
      return { byID, serverIdByThread, byParent, statusByThread, ...(key ? { statusByParent: { ...current.statusByParent, [key]: "ready" } } : {}) };
    });
  },
  removeParent: (parentID, serverID) => {
    if (!parentID || !serverID) return;
    const key = parentKey(serverID, parentID);
    nextParentRevision(key);
    removeParentRequests(serverID, parentID);
    const invalidatedRequests = invalidateThreadRequestsForServer(serverID);
    set((current) => {
      const byID = { ...current.byID };
      const serverIdByThread = { ...current.serverIdByThread };
      const remaining = (current.byParent[parentID] ?? []).filter((thread) => {
        if (thread.parent_channel_id !== parentID || serverIdByThread[thread.id] !== serverID) return true;
        delete byID[thread.id];
        delete serverIdByThread[thread.id];
        return false;
      });
      const byParent = { ...current.byParent };
      if (remaining.length) byParent[parentID] = remaining;
      else delete byParent[parentID];
      const statusByParent = { ...current.statusByParent };
      delete statusByParent[key];
      const loadedParents = { ...current.loadedParents };
      const statusByThread = { ...current.statusByThread };
      for (const threadID of invalidatedRequests) if (statusByThread[threadID] === "loading") statusByThread[threadID] = "error";
      for (const threadID of Object.keys(statusByThread)) {
        if (current.serverIdByThread[threadID] === serverID && current.byID[threadID]?.parent_channel_id === parentID) delete statusByThread[threadID];
      }
      delete loadedParents[parentID];
      return { byID, serverIdByThread, byParent, statusByParent, loadedParents, statusByThread };
    });
  },
  loadParent: async (serverID, parentID) => {
    if (!serverID || !parentID) return;
    const state = get();
    const scope = { ownerId: state.ownerId, authGeneration: state.authGeneration };
    if (!sameScope(state, scope)) return;
    const key = requestKey(scope, serverID, parentID);
    const scopeKey = parentKey(serverID, parentID);
    const pending = requests.get(key);
    if (pending && pending.revision === (parentRevisions.get(scopeKey) ?? 0)) return pending.promise;
    const revision = nextParentRevision(scopeKey);
    set((current) => ({ statusByParent: { ...current.statusByParent, [scopeKey]: "loading" } }));
    const isCurrent = () => sameScope(get(), scope) && (parentRevisions.get(scopeKey) ?? 0) === revision;
    const request: ParentRequest = { revision, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const result = await listThreads(serverID, parentID, true, { expectedUserId: scope.ownerId!, isCurrent });
        if (!sameScope(get(), scope) || (parentRevisions.get(scopeKey) ?? 0) !== revision) return;
        if (!result.success || !result.data || !Array.isArray(result.data.threads)) {
          set((current) => ({ statusByParent: { ...current.statusByParent, [scopeKey]: "error" } }));
          return;
        }
        set((current) => {
          if (!sameScope(current, scope) || (parentRevisions.get(scopeKey) ?? 0) !== revision) return current;
          const oldRows = current.byParent[parentID] ?? [];
          const otherServerRows = oldRows.filter((thread) => current.serverIdByThread[thread.id] !== serverID);
          const threads: Channel[] = [];
          const seen = new Set<string>();
          for (const candidate of result.data!.threads) {
            if (!validThread(candidate, parentID) || seen.has(candidate.id)) continue;
            const existingServer = current.serverIdByThread[candidate.id];
            if (existingServer && existingServer !== serverID) continue;
            seen.add(candidate.id);
            threads.push(candidate);
          }
          const byID = { ...current.byID };
          const serverIdByThread = { ...current.serverIdByThread };
          const statusByThread = { ...current.statusByThread };
          for (const old of oldRows) {
            if (serverIdByThread[old.id] === serverID && old.parent_channel_id === parentID && !seen.has(old.id)) {
              nextThreadRevision(serverID, old.id);
              delete byID[old.id];
              delete serverIdByThread[old.id];
              delete statusByThread[old.id];
            }
          }
          for (const thread of threads) {
            nextThreadRevision(serverID, thread.id);
            byID[thread.id] = thread;
            serverIdByThread[thread.id] = serverID;
            statusByThread[thread.id] = "ready";
          }
          for (const threadID of invalidateThreadRequestsForServer(serverID)) {
            if (statusByThread[threadID] === "loading") statusByThread[threadID] = "error";
          }
          const byParent = { ...current.byParent, [parentID]: [...threads, ...otherServerRows] };
          return {
            byID, byParent, serverIdByThread,
            loadedParents: { ...current.loadedParents, [parentID]: true },
            statusByParent: { ...current.statusByParent, [scopeKey]: "ready" },
            statusByThread,
          };
        });
      } catch {
        if (sameScope(get(), scope) && (parentRevisions.get(scopeKey) ?? 0) === revision) {
          set((current) => ({ statusByParent: { ...current.statusByParent, [scopeKey]: "error" } }));
        }
      }
    })().finally(() => { if (requests.get(key) === request) requests.delete(key); });
    requests.set(key, request);
    return request.promise;
  },
  loadThread: async (serverID, threadID, force = false) => {
    if (!serverID || !threadID || serverID.length > 128 || threadID.length > 128) return;
    const state = get();
    const scope = { ownerId: state.ownerId, authGeneration: state.authGeneration };
    if (!sameScope(state, scope)) return;
    if (state.serverIdByThread[threadID] && state.serverIdByThread[threadID] !== serverID) {
      set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "error" } }));
      return;
    }
    if (!force && state.serverIdByThread[threadID] === serverID && state.byID[threadID]) {
      set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "ready" } }));
      return;
    }
    const key = threadRequestKey(scope, serverID, threadID);
    const revKey = threadKey(serverID, threadID);
    const pending = threadRequests.get(key);
    if (pending && pending.revision === (threadRevisions.get(revKey) ?? 0)) return pending.promise;
    if (threadRequests.size >= 64) {
      set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "error" } }));
      return;
    }
    const revision = threadRevisions.get(revKey) ?? 0;
    const serverRevision = serverRevisions.get(serverID) ?? 0;
    set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "loading" } }));
    const isCurrent = () => sameScope(get(), scope)
      && (threadRevisions.get(revKey) ?? 0) === revision
      && (serverRevisions.get(serverID) ?? 0) === serverRevision;
    const request: ThreadRequest = { revision, serverID, threadID, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const result = await getThread(serverID, threadID, { expectedUserId: scope.ownerId!, isCurrent });
        if (!sameScope(get(), scope)) return;
        if (!isCurrent()) {
          if (threadRequests.get(key) === request) {
            set((current) => current.statusByThread[threadID] === "loading" ? { statusByThread: { ...current.statusByThread, [threadID]: "error" } } : current);
          }
          return;
        }
        const channel = result.success ? result.data : undefined;
        if (!validThread(channel) || channel.id !== threadID) {
          set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "error" } }));
          return;
        }
        const current = get();
        const existingServer = current.serverIdByThread[threadID];
        if (existingServer && existingServer !== serverID) {
          set((now) => ({ statusByThread: { ...now.statusByThread, [threadID]: "error" } }));
          return;
        }
        const parentID = channel.parent_channel_id!;
        nextParentRevision(parentKey(serverID, parentID));
        nextThreadRevision(serverID, threadID);
        set((now) => {
          if (!sameScope(now, scope) || (serverRevisions.get(serverID) ?? 0) !== serverRevision) return now;
          const previous = now.byID[threadID];
          const byParent = { ...now.byParent };
          if (previous?.parent_channel_id && previous.parent_channel_id !== parentID) {
            byParent[previous.parent_channel_id] = (byParent[previous.parent_channel_id] ?? []).filter((item) => item.id !== threadID);
          }
          byParent[parentID] = [channel, ...(byParent[parentID] ?? []).filter((item) => item.id !== threadID)];
          return {
            byID: { ...now.byID, [threadID]: channel }, byParent,
            serverIdByThread: { ...now.serverIdByThread, [threadID]: serverID },
            statusByThread: { ...now.statusByThread, [threadID]: "ready" },
          };
        });
      } catch {
        if (sameScope(get(), scope) && threadRequests.get(key) === request && isCurrent()) {
          set((current) => ({ statusByThread: { ...current.statusByThread, [threadID]: "error" } }));
        }
      }
    })().finally(() => { if (threadRequests.get(key) === request) threadRequests.delete(key); });
    threadRequests.set(key, request);
    return request.promise;
  },
}));

function clearForAuthScope(scope: Scope) {
  requests.clear();
  threadRequests.clear();
  parentRevisions.clear();
  threadRevisions.clear();
  serverRevisions.clear();
  useThreadStore.setState({ ownerId: scope.ownerId, authGeneration: scope.authGeneration, byID: {}, byParent: {}, loadedParents: {}, serverIdByThread: {}, statusByParent: {}, statusByThread: {} });
}
subscribeAuthOwnerChanges((ownerId) => clearForAuthScope({ ownerId, authGeneration: getAuthSessionSnapshot().generation }));
subscribeAuthGenerationChanges((authGeneration) => clearForAuthScope({ ownerId: getAuthSessionSnapshot().ownerId, authGeneration }));
