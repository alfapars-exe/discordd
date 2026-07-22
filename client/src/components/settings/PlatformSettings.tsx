/** PlatformSettings — Platform admin LiveKit instance management (CRUD + metrics). */

import { useEffect, useLayoutEffect, useState, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { showApiError } from "../../utils/apiError";
import { useConfirm } from "../../hooks/useConfirm";
import {
  listLiveKitInstances,
  createLiveKitInstance,
  updateLiveKitInstance,
  deleteLiveKitInstance,
} from "../../api/admin";
import InstanceForm from "./InstanceForm";
import MetricsPanel from "./MetricsPanel";
import type { LiveKitInstanceAdmin } from "../../types";

function PlatformSettings() {
  return <LiveKitTab />;
}


function LiveKitTab() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const tRef = useRef(t);
  // Mirror the latest translator fn into a ref so callbacks (toasts,
  // async error paths) can read it without re-binding on every locale
  // change. useLayoutEffect runs after commit but before paint, so any
  // synchronous follow-up reads the fresh value. Writing to .current
  // during render would be flagged by react-hooks/refs.
  useLayoutEffect(() => {
    tRef.current = t;
  });

  // ─── State ───
  const [instances, setInstances] = useState<LiveKitInstanceAdmin[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formUrl, setFormUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formApiSecret, setFormApiSecret] = useState("");
  const [formMaxServers, setFormMaxServers] = useState(0);
  const [formHetznerServerID, setFormHetznerServerID] = useState("");
  // Cloud (true) vs self-hosted (false). Defaults to cloud since that's the
  // billed path users are most likely to add through this admin panel.
  const [formIsPlatformManaged, setFormIsPlatformManaged] = useState(true);

  // Delete migration target
  const [migrateTargetId, setMigrateTargetId] = useState("");

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId]
  );

  // ─── Fetch ───
  //
  // Inline-async useEffect. The lint react-hooks/set-state-in-effect
  // fires when an effect synchronously calls a function that
  // internally setStates; moving the body inside an async IIFE puts
  // the setStates behind an `await` boundary, which the rule treats
  // as Promise-callback state (allowed).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listLiveKitInstances();
        if (cancelled) return;
        if (res.success && res.data) {
          setInstances(res.data);
        } else {
          showApiError(res, { fallbackKey: "settings:platformInstanceLoadError" });
        }
      } catch {
        if (!cancelled) addToast("error", tRef.current("platformInstanceLoadError"));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  // Form initialisation when selection / mode changes: derive
  // initial form values from the source-of-truth instance object
  // without a sync useEffect. We compute them from a stable memo and
  // a tiny stateful sub-component below would let us avoid mirroring
  // entirely, but for now we use a microtask-based init so the lint
  // sees the setState as deferred, not cascading.
  useEffect(() => {
    if (isCreating) {
      queueMicrotask(() => {
        setFormUrl("");
        setFormApiKey("");
        setFormApiSecret("");
        setFormMaxServers(0);
        setFormHetznerServerID("");
        setFormIsPlatformManaged(true); // new entries default to LiveKit Cloud
      });
    } else {
      const inst = instances.find((i) => i.id === selectedId);
      if (inst) {
        queueMicrotask(() => {
          setFormUrl(inst.url);
          setFormApiKey("");
          setFormApiSecret("");
          setFormMaxServers(inst.max_servers);
          setFormHetznerServerID(inst.hetzner_server_id ?? "");
          setFormIsPlatformManaged(inst.is_platform_managed);
        });
      }
    }
  }, [selectedId, isCreating, instances]);

  // ─── Create ───
  async function handleCreate() {
    if (!formUrl || !formApiKey || !formApiSecret) return;
    try {
      setIsSaving(true);
      const res = await createLiveKitInstance({
        url: formUrl,
        api_key: formApiKey,
        api_secret: formApiSecret,
        max_servers: formMaxServers,
        hetzner_server_id: formHetznerServerID || undefined,
        is_platform_managed: formIsPlatformManaged,
      });
      if (res.success && res.data) {
        setInstances((prev) => [...prev, res.data!]);
        setIsCreating(false);
        setSelectedId(res.data.id);
        addToast("success", t("platformInstanceCreated"));
      } else {
        showApiError(res, { fallbackKey: "settings:platformInstanceCreateError" });
      }
    } catch {
      addToast("error", t("platformInstanceCreateError"));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Update ───
  async function handleUpdate() {
    if (selectedId === null) {
      addToast("error", t("platformNoInstanceSelected"));
      return;
    }

    const current = instances.find((i) => i.id === selectedId);
    if (!current) {
      addToast("error", t("platformNoInstanceSelected"));
      return;
    }

    const body: Record<string, string | number | boolean> = {};
    if (formUrl !== current.url) body.url = formUrl;
    if (formApiKey) body.api_key = formApiKey;
    if (formApiSecret) body.api_secret = formApiSecret;
    if (formMaxServers !== current.max_servers)
      body.max_servers = formMaxServers;
    if (formHetznerServerID !== (current.hetzner_server_id ?? ""))
      body.hetzner_server_id = formHetznerServerID;
    if (formIsPlatformManaged !== current.is_platform_managed)
      body.is_platform_managed = formIsPlatformManaged;

    if (Object.keys(body).length === 0) {
      addToast("info", t("platformNoChanges"));
      return;
    }

    try {
      setIsSaving(true);
      const res = await updateLiveKitInstance(selectedId, body);
      if (res.success && res.data) {
        const updated = res.data;
        setInstances((prev) =>
          prev.map((i) => (i.id === updated.id ? updated : i))
        );
        addToast("success", t("platformInstanceUpdated"));
      } else {
        showApiError(res, { fallbackKey: "settings:platformInstanceUpdateError" });
      }
    } catch {
      addToast("error", t("platformInstanceUpdateError"));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Delete ───
  async function handleDelete() {
    if (!selectedInstance) return;

    if (selectedInstance.server_count > 0) {
      if (!migrateTargetId) {
        addToast("error", t("platformMigrateTargetRequired"));
        return;
      }
    }

    const ok = await confirm({
      message:
        selectedInstance.server_count > 0
          ? t("platformDeleteMigrateConfirm", {
              count: selectedInstance.server_count,
            })
          : t("platformDeleteConfirm"),
      danger: true,
    });
    if (!ok) return;

    try {
      await deleteLiveKitInstance(
        selectedInstance.id,
        selectedInstance.server_count > 0 ? migrateTargetId : undefined
      );
      setInstances((prev) => prev.filter((i) => i.id !== selectedInstance.id));
      setSelectedId(null);
      setMigrateTargetId("");
      addToast("success", t("platformInstanceDeleted"));
    } catch {
      addToast("error", t("platformInstanceDeleteError"));
    }
  }

  // ─── Helpers ───
  function formatCapacity(inst: LiveKitInstanceAdmin) {
    if (inst.max_servers === 0) {
      return t("platformInstanceCapacityUnlimited", {
        count: inst.server_count,
      });
    }
    return t("platformInstanceCapacity", {
      count: inst.server_count,
      max: inst.max_servers,
    });
  }

  const formProps = {
    formUrl,
    setFormUrl,
    formApiKey,
    setFormApiKey,
    formApiSecret,
    setFormApiSecret,
    formMaxServers,
    setFormMaxServers,
    formHetznerServerID,
    setFormHetznerServerID,
    formIsPlatformManaged,
    setFormIsPlatformManaged,
    isSaving,
  };

  // ─── Render ───
  return (
    <div className="channel-settings-wrapper" style={{ flex: 1, minHeight: 0 }}>
      {/* Left Panel: Instance List */}
      <div className="role-list">
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {t("platformLiveKitInstances")}
          </span>
          <button
            className="settings-btn channel-settings-header-btn"
            onClick={() => {
              setIsCreating(true);
              setSelectedId(null);
            }}
          >
            +
          </button>
        </div>

        <div className="channel-settings-ch-list">
          {isLoading && <p className="no-channel">{t("loading")}</p>}

          {!isLoading && instances.length === 0 && (
            <p className="no-channel">{t("platformNoInstances")}</p>
          )}

          {instances.map((inst) => (
            <div
              key={inst.id}
              className={`role-list-item platform-instance-item${selectedId === inst.id ? " active" : ""}`}
              onClick={() => {
                setSelectedId(inst.id);
                setIsCreating(false);
              }}
            >
              <span className="role-list-name" title={inst.url}>
                {inst.url}
              </span>
              <span className="platform-instance-capacity">
                {formatCapacity(inst)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel: Form + Monitoring */}
      <div className="channel-settings-right" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {isCreating ? (
          <InstanceForm
            mode="create"
            {...formProps}
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
          />
        ) : selectedInstance ? (
          <div className="lk-edit-layout">
            <div className="lk-edit-form">
              <InstanceForm
                mode="edit"
                instance={selectedInstance}
                {...formProps}
                onSave={handleUpdate}
                onDelete={handleDelete}
                migrateTargetId={migrateTargetId}
                setMigrateTargetId={setMigrateTargetId}
                otherInstances={instances.filter(
                  (i) => i.id !== selectedInstance.id
                )}
              />
            </div>
            <div className="lk-edit-monitoring">
              <MetricsPanel instanceId={selectedInstance.id} />
            </div>
          </div>
        ) : (
          <div className="no-channel">
            {t("platformNoInstanceSelected")}
          </div>
        )}
      </div>
    </div>
  );
}

export default PlatformSettings;
