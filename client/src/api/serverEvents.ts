import { apiClient, getAuthGeneration } from "./client";

export type ServerEvent = {
  id: string;
  server_id: string;
  creator_id: string;
  name: string;
  description: string;
  starts_at: string;
  ends_at?: string | null;
  channel_id?: string | null;
  status: "scheduled" | "cancelled";
  version: number;
  interested: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateServerEventRequest = {
  name: string;
  description: string;
  starts_at: string;
  ends_at?: string | null;
  channel_id?: string | null;
};

export type UpdateServerEventRequest = CreateServerEventRequest & {
  expected_version: number;
};

export type ServerEventListOptions = {
  limit?: number;
  beforeId?: string;
};

export type ServerEventRequestContext = {
  expectedUserId?: string;
  isCurrent?: () => boolean;
};

function requestScope(context: ServerEventRequestContext = {}) {
  const generation = getAuthGeneration();
  return {
    options: {
      timeoutMs: 15000,
      isCurrent: () => generation === getAuthGeneration() && (!context.isCurrent || context.isCurrent()),
    },
    expectedUserId: context.expectedUserId,
  };
}

function scopedPath(path: string, expectedUserId?: string, query?: URLSearchParams): string {
	const params = query ?? new URLSearchParams();
	if (expectedUserId) params.set("expected_user_id", expectedUserId);
	const suffix = params.toString();
  return `${path}${suffix ? `?${suffix}` : ""}`;
}

export function listServerEvents(serverId: string, options: ServerEventListOptions = {}, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  const query = new URLSearchParams();
  if (options.limit !== undefined) {
    const requested = Number.isFinite(options.limit) ? Math.floor(options.limit) : 50;
    query.set("limit", String(Math.max(1, Math.min(100, requested))));
  }
  if (options.beforeId) query.set("before_id", options.beforeId);
  return apiClient<{ events: ServerEvent[] }>(
    scopedPath(`/servers/${encodeURIComponent(serverId)}/events`, scope.expectedUserId, query),
    scope.options,
  );
}

export function getServerEvent(serverId: string, eventId: string, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ServerEvent>(
    scopedPath(`/servers/${encodeURIComponent(serverId)}/events/${encodeURIComponent(eventId)}`, scope.expectedUserId),
    scope.options,
  );
}

export function createServerEvent(serverId: string, body: CreateServerEventRequest, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ServerEvent>(scopedPath(`/servers/${encodeURIComponent(serverId)}/events`, scope.expectedUserId), {
    ...scope.options,
    method: "POST",
    body,
  });
}

export function updateServerEvent(serverId: string, eventId: string, body: UpdateServerEventRequest, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ServerEvent>(
    scopedPath(`/servers/${encodeURIComponent(serverId)}/events/${encodeURIComponent(eventId)}`, scope.expectedUserId),
    { ...scope.options, method: "PATCH", body },
  );
}

export function cancelServerEvent(serverId: string, eventId: string, expectedVersion: number, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ServerEvent>(
    scopedPath(`/servers/${encodeURIComponent(serverId)}/events/${encodeURIComponent(eventId)}/cancel`, scope.expectedUserId),
    { ...scope.options, method: "POST", body: { expected_version: expectedVersion } },
  );
}

export function setServerEventInterested(serverId: string, eventId: string, interested: boolean, context: ServerEventRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<{ interested: boolean }>(
    scopedPath(`/servers/${encodeURIComponent(serverId)}/events/${encodeURIComponent(eventId)}/rsvp`, scope.expectedUserId),
    { ...scope.options, method: "PUT", body: { interested } },
  );
}
