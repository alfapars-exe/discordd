import { useEffect } from "react";
import type { StartupSnapshot } from "../../utils/startupCache";

/** Cached names are a read-only preview, never an authenticated application. */
export default function StartupPreview({ snapshot, status }: { snapshot: StartupSnapshot; status: string }) {
  useEffect(() => { performance.mark("startup.preview"); }, []);
  return <div className="startup-preview" aria-busy="true" data-testid="startup-preview">
    <aside className="startup-preview-sidebar">
      <strong>HiChat!</strong>
      <p>{snapshot.user.name}</p>
      {snapshot.servers.map(server => <section key={server.id}>
        <h2>{server.name}</h2>
        <ul>{snapshot.channels[server.id]?.map(channel => <li key={channel.id}>{channel.type === "voice" ? "◖" : "#"} {channel.name}</li>)}</ul>
      </section>)}
    </aside>
    <main className="startup-preview-main"><div className="app-loading-spinner" /><p role="status">{status}</p></main>
  </div>;
}
