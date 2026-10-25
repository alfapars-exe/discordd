import { randomUUID } from "node:crypto";
import { parseOverlayMediaEnvelope, parseOverlayVideoSDP, type OverlayMediaEnvelope, type OverlayVideoKind } from "./overlay-media-contract";
export type OverlayMediaTile = {
    tileId: string;
    kind: OverlayVideoKind;
    label?: string;
};
export type OverlayMediaLease = {
    session: string;
    revision: number;
    tiles: OverlayMediaTile[];
};
export type OverlayMediaViewport = {
    session: string;
    revision: number;
    tileId: string;
    visible: boolean;
    width: number;
    height: number;
    fps: number;
};
export type OverlayMediaWindow = {
    isDestroyed(): boolean;
    isVisible(): boolean;
    webContents: {
        mainFrame: unknown;
        isDestroyed?(): boolean;
        send(channel: string, value: unknown): void;
    };
};
type Sender = {
    sender: unknown;
    senderFrame: unknown;
};
type Policy = {
    enabled: boolean;
    voiceOverlayVideo?: boolean;
    voiceOverlayStreams?: boolean;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
function parseLease(raw: unknown): OverlayMediaLease | null {
    if (!record(raw) || !only(raw, ["session", "revision", "tiles"]) || !parseOverlayMediaEnvelope({ protocol: 1, session: raw.session, revision: raw.revision, kind: "end", reason: "closed" }) || !Array.isArray(raw.tiles) || !raw.tiles.length || raw.tiles.length > 4)
        return null;
    const tiles: OverlayMediaTile[] = [];
    for (const tile of raw.tiles) {
        if (!record(tile) || !only(tile, ["tileId", "kind", "label"]) || !token(tile.tileId) || !["camera", "screen"].includes(tile.kind as string) || tiles.some(t => t.tileId === tile.tileId) || tile.label !== undefined && (typeof tile.label !== "string" || !tile.label.length || tile.label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(tile.label)))
            return null;
        tiles.push({ tileId: tile.tileId, kind: tile.kind as OverlayVideoKind, ...(typeof tile.label === "string" ? { label: tile.label } : {}) });
    }
    return tiles.filter(t => t.kind === "camera").length <= 2 && tiles.filter(t => t.kind === "screen").length <= 2 ? { session: raw.session as string, revision: raw.revision as number, tiles } : null;
}
export function parseOverlayMediaViewport(raw: unknown): OverlayMediaViewport | null {
    if (!record(raw) || !only(raw, ["session", "revision", "tileId", "visible", "width", "height", "fps"]) || !parseOverlayMediaEnvelope({ protocol: 1, session: raw.session, revision: raw.revision, kind: "end", reason: "closed" }) || !token(raw.tileId) || typeof raw.visible !== "boolean")
        return null;
    for (const [key, max] of [["width", 1920], ["height", 1080], ["fps", 60]] as const)
        if (!Number.isInteger(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > max)
            return null;
    if (raw.visible ? ((raw.width as number) < 1 || (raw.height as number) < 1 || (raw.fps as number) < 1) : raw.width !== 0 || raw.height !== 0 || raw.fps !== 0)
        return null;
    return { session: raw.session as string, revision: raw.revision as number, tileId: raw.tileId, visible: raw.visible, width: raw.width as number, height: raw.height as number, fps: raw.fps as number };
}
/** Same-process relay only: no Room, network, credentials, SDP or ICE logging. */
export function createOverlayMediaBroker(options: {
    main: () => OverlayMediaWindow | null;
    overlay: () => OverlayMediaWindow | null;
    policy: () => Policy | null;
    now?: () => number;
}) {
    type Lease = {
        scope: OverlayMediaLease;
        main: OverlayMediaWindow;
        overlay: OverlayMediaWindow;
        mainFrame: unknown;
        overlayFrame: unknown;
        mainContents: OverlayMediaWindow["webContents"];
        overlayContents: OverlayMediaWindow["webContents"];
        offer: Extract<OverlayMediaEnvelope, {
            kind: "offer";
        }> | null;
        answer: Extract<OverlayMediaEnvelope, {
            kind: "answer";
        }> | null;
        pending: Extract<OverlayMediaEnvelope, {
            kind: "candidate";
        }>[];
        counts: [
            number,
            number
        ];
        viewports: number;
        started: number;
        generation: string;
    };
    let readyWindow: OverlayMediaWindow | null = null, readyFrame: unknown = null, generationWindow: OverlayMediaWindow | null = null, generationFrame: unknown = null, generation = "", lastAvailability = "";
    let lease: Lease | null = null;
    const revisions = new Map<string, number>();
    let starts: number[] = [];
    const now = options.now ?? Date.now;
    type Endpoint = {window:OverlayMediaWindow;contents:OverlayMediaWindow["webContents"];frame:unknown};
    // Electron can destroy WebContents before its BrowserWindow closed callback.
    // Neither webContents nor mainFrame is safe to read after that boundary.
    const endpoint = (win:OverlayMediaWindow|null):Endpoint|null => {
        try {
            if (!win || win.isDestroyed()) return null;
            const contents=win.webContents;
            if (contents.isDestroyed?.()) return null;
            const frame=contents.mainFrame;
            return frame ? {window:win,contents,frame} : null;
        } catch { return null; }
    };
    const mainEndpoint=()=>{try{return endpoint(options.main());}catch{return null;}};
    const overlayEndpoint=()=>{try{return endpoint(options.overlay());}catch{return null;}};
    const trusted=(event:Sender,target:Endpoint|null)=>{try{return !!target&&event.sender===target.contents&&event.senderFrame===target.frame;}catch{return false;}};
    const emit = (win:OverlayMediaWindow,channel:string,value:unknown):boolean => {
        try {
            const target=endpoint(win);
            if(!target)return false;
            target.contents.send(channel,value);
            return true;
        } catch {return false;}
    };
    const retire = (reason: "closed" | "scope" | "source" | "error" = "scope") => {
        const old = lease;
        if (!old) return;
        lease = null;
        old.pending = [];
        const end = {protocol:1,session:old.scope.session,revision:old.scope.revision,kind:"end",reason};
        emit(old.main,"overlay-media",end);
        emit(old.overlay,"overlay-media",end);
    };
    const permitted = (scope: OverlayMediaLease) => {
        const policy = options.policy();
        return !!policy?.enabled && scope.tiles.every(tile => tile.kind === "camera"
            ? policy.voiceOverlayVideo === true : policy.voiceOverlayStreams === true);
    };
    const availability = () => {
        const target = overlayEndpoint(), overlay = target?.window ?? null, frame = target?.frame, policy = options.policy();
        if (overlay !== generationWindow || frame !== generationFrame) {
            generationWindow = overlay;
            generationFrame = frame;
            generation = randomUUID();
            readyWindow = null;
            readyFrame = null;
        }
        let visible=false;
        try {visible=!!mainEndpoint()&&!!target&&target.window.isVisible()&&policy?.enabled===true;} catch { /* Visibility teardown is unavailable. */ }
        return {
            ready: visible && overlay === readyWindow && frame === readyFrame,
            visible,
            allowedKinds: !policy?.enabled ? [] : [
                ...(policy.voiceOverlayVideo ? ["camera" as const] : []),
                ...(policy.voiceOverlayStreams ? ["screen" as const] : []),
            ],
            windowGeneration:generation,
        };
    };
    const publishAvailability = () => {
        const value = availability(), serialized = JSON.stringify(value);
        if (serialized !== lastAvailability) {
            lastAvailability = serialized;
            const main = mainEndpoint();
            if (main) emit(main.window,"overlay-media-availability",value);
        }
        return value;
    };
    const refresh = () => {
        const status = publishAvailability(), current = lease;
        if (!current) return;
        const main = mainEndpoint(), overlay = overlayEndpoint();
        if (!main || !overlay || main.window !== current.main || overlay.window !== current.overlay
            || main.frame !== current.mainFrame || overlay.frame !== current.overlayFrame
            || !status.ready || current.generation !== status.windowGeneration || !permitted(current.scope)) retire("scope");
    };
    const current = (event: Sender) => {
        refresh();
        const active = lease;
        if (!active) return null;
        return trusted(event,endpoint(active.main)) ? {l:active,side:0 as const}
            : trusted(event,endpoint(active.overlay)) ? {l:active,side:1 as const} : null;
    };
    return {
        getAvailability(event: Sender) {
            refresh();
            return trusted(event,mainEndpoint()) ? availability() : null;
        },
        setReady(event: Sender,value: unknown): boolean {
            if (typeof value !== "boolean" || !trusted(event,overlayEndpoint())) return false;
            availability();
            const target=overlayEndpoint();
            if(!target)return false;
            readyWindow = value ? target.window : null;
            readyFrame = value ? target.frame : null;
            if (!value) { generation = randomUUID(); retire("scope"); }
            refresh();
            return true;
        },
        open(event: Sender, raw: unknown): boolean {
            refresh();
            const scope = parseLease(raw), main = mainEndpoint(), overlay = overlayEndpoint();
            if (!scope || !trusted(event, main) || !main || !overlay || !availability().ready || !permitted(scope))
                return false;
            if ((revisions.get(scope.session) ?? 0) >= scope.revision)
                return false;
            starts = starts.filter(t => now() - t < 10000);
            if (starts.length >= 10)
                return false;
            starts.push(now());
            retire("source");
            revisions.set(scope.session, scope.revision);
            if (revisions.size > 256)
                revisions.delete(revisions.keys().next().value!);
            lease = { scope, main: main.window, overlay: overlay.window, mainContents:main.contents,overlayContents:overlay.contents,mainFrame:main.frame,overlayFrame:overlay.frame, offer: null, answer: null, pending: [], counts: [0, 0], viewports: 0, started: now(), generation };
            if (!emit(overlay.window, "overlay-media-lease", scope)) {
                retire("error");
                return false;
            }
            return true;
        },
        send(event: Sender, raw: unknown): boolean {
            const state = current(event), value = parseOverlayMediaEnvelope(raw);
            if (!state || !value)
                return false;
            const { l, side } = state;
            if (value.session !== l.scope.session || value.revision !== l.scope.revision)
                return false;
            if (value.kind === "end") {
                retire(value.reason);
                return true;
            }
            if (value.kind === "offer") {
                if (side !== 0 || l.offer || value.sources.length !== l.scope.tiles.length || !value.sources.every(s => l.scope.tiles.some(t => t.tileId === s.tileId && t.kind === s.kind)))
                    return false;
                l.offer = value;
                if (!emit(l.overlay, "overlay-media", value)) {
                    retire("error");
                    return false;
                }
                return true;
            }
            if (value.kind === "answer") {
                if (side !== 1 || !l.offer || l.answer || value.replyTo !== l.offer.descriptionId)
                    return false;
                const sections = parseOverlayVideoSDP(value.sdp, "recvonly");
                if (!sections || sections.length !== l.offer.sources.length || !sections.every(s => l.offer!.sources.some(source => source.mid === s.mid)))
                    return false;
                l.answer = value;
                if (!emit(l.main, "overlay-media", value)) {
                    retire("error");
                    return false;
                }
                for (const candidate of l.pending)
                    if (candidate.descriptionId === value.descriptionId && !emit(l.main, "overlay-media", candidate)) {
                        retire("error");
                        return false;
                    }
                l.pending = [];
                return true;
            }
            if (!l.offer || value.offerId !== l.offer.descriptionId || ++l.counts[side] > 128)
                return false;
            const candidate = value.candidate, index = candidate.sdpMLineIndex, mid = candidate.sdpMid;
            const sectionMids = parseOverlayVideoSDP(l.offer.sdp, "sendonly")!.map(section => section.mid);
            if (mid !== null && !l.offer.sources.some(s => s.mid === mid) || index !== null && (index >= sectionMids.length || mid !== null && sectionMids[index] !== mid) || candidate.candidate !== "" && mid === null && index === null)
                return false;
            if (side === 0) {
                if (value.descriptionId !== l.offer.descriptionId)
                    return false;
                if (!emit(l.overlay, "overlay-media", value)) {
                    retire("error");
                    return false;
                }
                return true;
            }
            if (l.answer) {
                if (value.descriptionId !== l.answer.descriptionId)
                    return false;
                if (!emit(l.main, "overlay-media", value)) {
                    retire("error");
                    return false;
                }
                return true;
            }
            if (l.pending.length >= 64)
                return false;
            l.pending.push(value);
            return true;
        },
        viewport(event: Sender,raw: unknown): boolean {
            const state = current(event), value = parseOverlayMediaViewport(raw);
            if (!state || state.side !== 1 || !value) return false;
            const active = state.l;
            if (value.session !== active.scope.session || value.revision !== active.scope.revision
                || !active.scope.tiles.some(tile => tile.tileId === value.tileId)) return false;
            if (now() - active.started >= 1000) { active.started = now(); active.viewports = 0; }
            if (++active.viewports > 120) return false;
            if (!emit(active.main,"overlay-media-viewport",value)) { retire("error"); return false; }
            return true;
        },
        refresh,retire,
        retireForContents(contents: unknown) {
            if (lease && (lease.mainContents === contents || lease.overlayContents === contents)) {
                readyWindow = null;
                readyFrame = null;
                retire("scope");
            }
            refresh();
        },
        revoke() {
            generation = randomUUID();
            readyWindow = null;
            readyFrame = null;
            retire("scope");
            refresh();
        },
    };
}
