import { render, screen, fireEvent } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import NotificationItem from "./NotificationItem";
import en from "../../i18n/locales/en/inbox.json";
import tr from "../../i18n/locales/tr/inbox.json";
import type { AppNotification } from "../../types";

vi.mock("../../hooks/useNotificationNavigation", () => ({ notificationActorName: () => "Ada" }));
vi.mock("../shared/Avatar", () => ({ default: () => null }));

const notification: AppNotification = {
  id: "anniversary", user_id: "me", kind: "system", actor_id: "friend", actor: null,
  server_id: null, channel_id: null, message_id: null, dm_channel_id: null,
  payload: { action: "friend_anniversary", years: 1 }, read_at: null, created_at: "2026-10-24T00:00:00Z",
};

it.each([
  ["en", 1, "You and Ada have been friends for 1 year!"],
  ["en", 3, "You and Ada have been friends for 3 years!"],
  ["tr", 2, "Ada ile arkadaşlığınızın 2. yıl dönümü!"],
] as const)("renders %s anniversary with count %i and preserves open behavior", async (language, years, headline) => {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: { en: { inbox: en }, tr: { inbox: tr } }, interpolation: { escapeValue: false } });
  const onOpen = vi.fn();
  const item = { ...notification, payload: { action: "friend_anniversary", years } };
  render(<I18nextProvider i18n={i18n}><NotificationItem notification={item} onOpen={onOpen} /></I18nextProvider>);
  fireEvent.click(screen.getByRole("button", { name: new RegExp(headline.replace(/[.!]/g, "\\$&")) }));
  expect(screen.getByText(headline)).toBeInTheDocument();
  expect(onOpen).toHaveBeenCalledWith(item);
});

it.each([["en", "Ada started streaming"], ["tr", "Ada yayın yapmaya başladı"]] as const)("renders a %s stream notice without private room context", async (language, headline) => {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: { en: { inbox: en }, tr: { inbox: tr } }, interpolation: { escapeValue: false } });
  render(<I18nextProvider i18n={i18n}><NotificationItem notification={{ ...notification, payload: { action: "stream_start" } }} onOpen={vi.fn()} /></I18nextProvider>);
  expect(screen.getByText(headline)).toBeInTheDocument();
});

it.each([["en","Ada sent you a direct message"],["tr","Ada sana bir özel mesaj gönderdi"]] as const)("renders generic %s DM metadata without any payload preview",async(language,headline)=>{
  const i18n=createInstance();await i18n.init({lng:language,resources:{en:{inbox:en},tr:{inbox:tr}},interpolation:{escapeValue:false}});
  render(<I18nextProvider i18n={i18n}><NotificationItem notification={{...notification,dm_channel_id:"dm",message_id:"source",payload:{action:"incoming_message",source:"dm",body:"private body",preview:"private preview"}}} onOpen={vi.fn()} /></I18nextProvider>);
  expect(screen.getByText(headline)).toBeInTheDocument();expect(screen.queryByText("private body")).not.toBeInTheDocument();expect(screen.queryByText("private preview")).not.toBeInTheDocument();
});

it.each([["en","Ada sent a group message"],["tr","Ada bir grup mesajı gönderdi"]] as const)("renders generic %s group metadata without a conversation/body copy",async(language,headline)=>{
 const i18n=createInstance();await i18n.init({lng:language,resources:{en:{inbox:en},tr:{inbox:tr}},interpolation:{escapeValue:false}});
 render(<I18nextProvider i18n={i18n}><NotificationItem notification={{...notification,group_dm_channel_id:"group",message_id:"source",payload:{action:"incoming_message",source:"group"}}} onOpen={vi.fn()}/></I18nextProvider>);
 expect(screen.getByText(headline)).toBeInTheDocument();
});
it("never displays malformed incoming group plaintext payloads",async()=>{
 const i18n=createInstance();await i18n.init({lng:"en",resources:{en:{inbox:en}},interpolation:{escapeValue:false}});
 render(<I18nextProvider i18n={i18n}><NotificationItem notification={{...notification,group_dm_channel_id:"group",message_id:"source",payload:{action:"incoming_message",source:"group",body:"private body",title:"private title"}}} onOpen={vi.fn()}/></I18nextProvider>);
 expect(screen.queryByText("private body")).not.toBeInTheDocument();expect(screen.queryByText("private title")).not.toBeInTheDocument();
});
