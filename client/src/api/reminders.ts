import { apiClient,getAuthGeneration } from "./client";

export type MessageReminder = {
  id: string;
  source_kind: "channel" | "dm";
  server_id?: string | null;
  channel_id: string;
  message_id: string;
  due_at: string;
  status: "scheduled" | "delivered" | "cancelled";
};

export type ReminderSource = Pick<MessageReminder, "source_kind" | "server_id" | "channel_id" | "message_id">;

type ReminderRequestContext={expectedUserId?:string;isCurrent?:()=>boolean};
function scope(context:ReminderRequestContext){
  const generation=getAuthGeneration();
  return {query:context.expectedUserId?`?expected_user_id=${encodeURIComponent(context.expectedUserId)}`:"",options:{timeoutMs:15000,isCurrent:()=>generation===getAuthGeneration()&&(!context.isCurrent||context.isCurrent())}};
}
export function listReminders(context:ReminderRequestContext={}) {
  const request=scope(context);return apiClient<{reminders:MessageReminder[]}>(`/users/me/reminders${request.query}`,request.options);
}
export function createReminder(body:ReminderSource&{due_at:string;request_id?:string},context:ReminderRequestContext={}){
  const request=scope(context);return apiClient<MessageReminder>(`/users/me/reminders${request.query}`,{...request.options,method:"POST",body});
}
export function updateReminder(id:string,due_at:string,context:ReminderRequestContext={}){
  const request=scope(context);return apiClient<MessageReminder>(`/users/me/reminders/${encodeURIComponent(id)}${request.query}`,{...request.options,method:"PATCH",body:{due_at}});
}
export function cancelReminder(id:string,context:ReminderRequestContext={}){
  const request=scope(context);return apiClient<void>(`/users/me/reminders/${encodeURIComponent(id)}${request.query}`,{...request.options,method:"DELETE"});
}
