import test from "node:test";
import assert from "node:assert/strict";
import { createOverlayMediaBroker, parseOverlayMediaViewport, type OverlayMediaWindow } from "./overlay-media-broker";
const session = "11111111-1111-4111-8111-111111111111", offerId = "22222222-2222-4222-8222-222222222222", answerId = "33333333-3333-4333-8333-333333333333";
const sdp = (direction = "sendonly", mids = ["0"]) => ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", ...mids.flatMap(mid => ["m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", `a=mid:${mid}`, `a=${direction}`, `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`])].join("\r\n");
function fixture() {
    const make = () => { const sent: Array<{
        channel: string;
        value: unknown;
    }> = []; const state = { visible: true, destroyed: false }; const win: OverlayMediaWindow = { isDestroyed: () => state.destroyed, isVisible: () => state.visible, webContents: { mainFrame: {}, send: (channel, value) => sent.push({ channel, value }) } }; return { win, state, sent, event: () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame }) }; };
    const main = make(), overlay = make();
    let activeOverlay: OverlayMediaWindow | null = overlay.win;
    const policy = { enabled: true, voiceOverlayVideo: true, voiceOverlayStreams: true };
    let time = 0;
    const broker = createOverlayMediaBroker({ main: () => main.win, overlay: () => activeOverlay, policy: () => policy, now: () => time });
    const scope = { session, revision: 1, tiles: [{ tileId: "camera-a", kind: "camera" as const, label: "Camera" }] };
    const offer = () => ({ protocol: 1, session, revision: 1, kind: "offer", descriptionId: offerId, sdp: sdp(), sources: [{ mid: "0", tileId: "camera-a", kind: "camera" }] });
    const answer = () => ({ protocol: 1, session, revision: 1, kind: "answer", descriptionId: answerId, replyTo: offerId, sdp: sdp("recvonly") });
    const candidate = (side: "main" | "overlay") => ({ protocol: 1, session, revision: 1, kind: "candidate", offerId, descriptionId: side === "main" ? offerId : answerId, candidate: { candidate: "candidate:1 1 udp 100 127.0.0.1 1234 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    const open = () => { assert.equal(broker.setReady(overlay.event(), true), true); assert.equal(broker.open(main.event(), scope), true); };
    return { main, overlay, policy, broker, scope, offer, answer, candidate, open, setOverlay: (value: OverlayMediaWindow | null) => { activeOverlay = value; }, advance: (ms: number) => { time += ms; } };
}
test("open requires actual HUD readiness, visibility, prefs and exact main frame", () => { const f = fixture(); assert.equal(f.broker.open(f.main.event(), f.scope), false); assert.equal(f.broker.setReady(f.main.event(), true), false); assert.equal(f.broker.setReady({ ...f.overlay.event(), senderFrame: {} }, true), false); assert.equal(f.broker.setReady(f.overlay.event(), true), true); assert.equal(f.broker.open(f.overlay.event(), f.scope), false); assert.equal(f.broker.open({ ...f.main.event(), senderFrame: {} }, f.scope), false); f.overlay.state.visible = false; assert.equal(f.broker.open(f.main.event(), f.scope), false); f.overlay.state.visible = true; f.policy.voiceOverlayVideo = false; assert.equal(f.broker.open(f.main.event(), f.scope), false); f.policy.voiceOverlayVideo = true; assert.equal(f.broker.open(f.main.event(), f.scope), true); assert.equal(f.overlay.sent[f.overlay.sent.length - 1]?.channel, "overlay-media-lease"); });
test("lease parser denies extras, unbounded labels, duplicate tiles and kind overflow", () => { for (const patch of [{ token: "secret" }, { tiles: [{ tileId: "x", kind: "audio" }] }, { tiles: [{ tileId: "x", kind: "camera", label: "x".repeat(81) }] }, { tiles: [{ tileId: "x", kind: "camera" }, { tileId: "x", kind: "screen" }] }, { tiles: [1, 2, 3].map(i => ({ tileId: `x${i}`, kind: "camera" })) }]) {
    const f = fixture();
    f.broker.setReady(f.overlay.event(), true);
    assert.equal(f.broker.open(f.main.event(), { ...f.scope, ...patch }), false);
} });
test("offer/answer direction and immutable source mapping are enforced before relay", () => { const f = fixture(); f.open(); assert.equal(f.broker.send(f.overlay.event(), f.offer()), false); assert.equal(f.broker.send(f.main.event(), { ...f.offer(), sources: [{ mid: "0", tileId: "other", kind: "camera" }] }), false); assert.equal(f.broker.send(f.main.event(), f.offer()), true); assert.equal(f.broker.send(f.main.event(), f.offer()), false); assert.equal(f.broker.send(f.main.event(), f.answer()), false); assert.equal(f.broker.send(f.overlay.event(), { ...f.answer(), replyTo: session }), false); assert.equal(f.broker.send(f.overlay.event(), { ...f.answer(), sdp: sdp("recvonly", ["1"]) }), false); assert.equal(f.broker.send(f.overlay.event(), f.answer()), true); assert.equal(f.main.sent[f.main.sent.length - 1]?.channel, "overlay-media"); });
test("candidate relation queues only bounded HUD candidates until its actual answer", () => { const f = fixture(); f.open(); assert.equal(f.broker.send(f.main.event(), f.candidate("main")), false); assert.equal(f.broker.send(f.main.event(), f.offer()), true); for (let i = 0; i < 64; i++)
    assert.equal(f.broker.send(f.overlay.event(), f.candidate("overlay")), true); assert.equal(f.broker.send(f.overlay.event(), f.candidate("overlay")), false); const before = f.main.sent.length; assert.equal(f.broker.send(f.overlay.event(), f.answer()), true); assert.equal(f.main.sent.length - before, 65); assert.equal(f.broker.send(f.overlay.event(), { ...f.candidate("overlay"), descriptionId: session }), false); assert.equal(f.broker.send(f.main.event(), { ...f.candidate("main"), candidate: { ...f.candidate("main").candidate, sdpMid: "1" } }), false); });
test("candidate budget and external ICE payload are rejected without forwarding", () => { const f = fixture(); f.open(); f.broker.send(f.main.event(), f.offer()); for (let i = 0; i < 128; i++)
    assert.equal(f.broker.send(f.main.event(), f.candidate("main")), true); assert.equal(f.broker.send(f.main.event(), f.candidate("main")), false); assert.equal(f.broker.send(f.main.event(), { ...f.candidate("main"), candidate: { ...f.candidate("main").candidate, candidate: "candidate:1 1 udp 100 8.8.8.8 1234 typ host" } }), false); });
test("hide, preference revocation, receiver teardown and destroyed sender end both endpoints", () => { for (const revoke of [(f: ReturnType<typeof fixture>) => { f.overlay.state.visible = false; f.broker.refresh(); }, (f: ReturnType<typeof fixture>) => { f.policy.voiceOverlayVideo = false; f.broker.refresh(); }, (f: ReturnType<typeof fixture>) => { f.broker.setReady(f.overlay.event(), false); }, (f: ReturnType<typeof fixture>) => { f.main.state.destroyed = true; f.broker.retireForContents(f.main.win.webContents); }]) {
    const f = fixture();
    f.open();
    revoke(f);
    assert.equal(f.broker.send(f.main.event(), f.offer()), false);
    assert.ok(f.overlay.sent.some(e => e.channel === "overlay-media" && (e.value as {
        kind: string;
    }).kind === "end"));
    if (!f.main.state.destroyed)
        assert.ok(f.main.sent.some(e => e.channel === "overlay-media" && (e.value as {
            kind: string;
        }).kind === "end"));
} });
test("replacement HUD/frame loses readiness, fences old senders and rotates opaque generation", () => { const f = fixture(); f.open(); const first = f.broker.getAvailability(f.main.event()); const old = f.overlay.event(); f.overlay.win.webContents.mainFrame = {}; f.broker.refresh(); assert.equal(f.broker.send(old, f.answer()), false); assert.equal(f.broker.open(f.main.event(), { ...f.scope, revision: 2 }), false); const next = f.broker.getAvailability(f.main.event()); assert.notEqual(first?.windowGeneration, next?.windowGeneration); assert.equal(next?.ready, false); assert.equal(f.broker.getAvailability(f.overlay.event()), null); assert.equal(f.broker.setReady(f.overlay.event(), true), true); assert.equal(f.broker.open(f.main.event(), { ...f.scope, revision: 2 }), true); });
test("revision replay and old lease messages are denied while replacement ends old scope", () => { const f = fixture(); f.open(); assert.equal(f.broker.open(f.main.event(), f.scope), false); assert.equal(f.broker.open(f.main.event(), { ...f.scope, revision: 2 }), true); assert.equal(f.broker.send(f.main.event(), f.offer()), false); assert.ok(f.main.sent.some(e => (e.value as {
    kind: string;
}).kind === "end")); });
test("viewport is HUD-only, exact source and bounded geometry; hidden means all zero", () => { const f = fixture(); f.open(); const viewport = { session, revision: 1, tileId: "camera-a", visible: true, width: 1920, height: 1080, fps: 60 }; assert.equal(f.broker.viewport(f.main.event(), viewport), false); assert.equal(f.broker.viewport(f.overlay.event(), viewport), true); for (const patch of [{ tileId: "other" }, { revision: 2 }, { width: 1921 }, { height: 1081 }, { fps: 61 }, { visible: false }, { width: 0 }])
    assert.equal(f.broker.viewport(f.overlay.event(), { ...viewport, ...patch }), false); assert.ok(parseOverlayMediaViewport({ ...viewport, visible: false, width: 0, height: 0, fps: 0 })); assert.equal(f.broker.viewport(f.overlay.event(), { ...viewport, visible: false, width: 0, height: 0, fps: 0 }), true); assert.equal(f.main.sent[f.main.sent.length - 1]?.channel, "overlay-media-viewport"); });
test("availability hydration matches emitted readiness and stale native revoke never auto-resumes", () => { const f = fixture(); const first = f.broker.getAvailability(f.main.event()); assert.equal(first?.ready, false); f.open(); assert.equal(f.broker.getAvailability(f.main.event())?.ready, true); f.broker.revoke(); assert.equal(f.broker.getAvailability(f.main.event())?.ready, false); assert.equal(f.broker.send(f.main.event(), f.offer()), false); assert.equal(f.broker.open(f.main.event(), { ...f.scope, revision: 2 }), false); assert.ok(f.main.sent.some(e => e.channel === "overlay-media-availability")); });
test("same-frame hide keeps listeners but denies late payloads; show requires a fresh lease", () => {
    const f = fixture();
    f.open();
    f.overlay.state.visible = false;
    f.broker.refresh();
    assert.equal(f.broker.getAvailability(f.main.event())?.ready, false);
    assert.equal(f.broker.send(f.main.event(), f.offer()), false);
    assert.equal(f.broker.viewport(f.overlay.event(), { session, revision: 1, tileId: "camera-a", visible: false, width: 0, height: 0, fps: 0 }), false);
    f.overlay.state.visible = true;
    f.broker.refresh();
    assert.equal(f.broker.getAvailability(f.main.event())?.ready, true);
    assert.equal(f.broker.open(f.main.event(), { ...f.scope, revision: 2 }), true);
});

test("native delivery failure is not acknowledged as a usable lease or offer",()=>{
 const f=fixture();f.broker.setReady(f.overlay.event(),true);
 f.overlay.win.webContents.send=()=>{throw new Error("renderer closing");};
 assert.equal(f.broker.open(f.main.event(),f.scope),false);
 assert.equal(f.broker.send(f.main.event(),f.offer()),false);
 const g=fixture();g.open();g.overlay.win.webContents.send=()=>{throw new Error("renderer closing");};
 assert.equal(g.broker.send(g.main.event(),g.offer()),false);
 assert.ok(g.main.sent.some(e=>e.channel==="overlay-media"&&(e.value as {kind:string}).kind==="end"));
});
test("readiness is idempotent and viewport/open rate limits are bounded",()=>{
 const f=fixture();f.open();const initial=f.broker.getAvailability(f.main.event());
 const events=f.main.sent.length;assert.equal(f.broker.setReady(f.overlay.event(),true),true);
 assert.equal(f.main.sent.length,events);assert.equal(f.broker.getAvailability(f.main.event())?.windowGeneration,initial?.windowGeneration);
 const viewport={session,revision:1,tileId:"camera-a",visible:true,width:100,height:100,fps:30};
 for(let i=0;i<120;i++)assert.equal(f.broker.viewport(f.overlay.event(),viewport),true);
 assert.equal(f.broker.viewport(f.overlay.event(),viewport),false);f.advance(1000);assert.equal(f.broker.viewport(f.overlay.event(),viewport),true);
 for(let revision=2;revision<=10;revision++)assert.equal(f.broker.open(f.main.event(),{...f.scope,revision}),true);
 assert.equal(f.broker.open(f.main.event(),{...f.scope,revision:11}),false);f.advance(10000);assert.equal(f.broker.open(f.main.event(),{...f.scope,revision:11}),true);
});

test("all public broker paths fail closed after actual-style destroyed window getters",()=>{
 for(const side of ["main","overlay"] as const){
  const f=fixture();f.open();const target=f[side],savedEvent=target.event(),savedContents=target.win.webContents;
  Object.defineProperty(target.win,"webContents",{get(){if(target.state.destroyed)throw new TypeError("Object has been destroyed");return savedContents;}});
  target.state.destroyed=true;
  assert.doesNotThrow(()=>f.broker.refresh());
  assert.doesNotThrow(()=>f.broker.revoke());
  assert.doesNotThrow(()=>f.broker.retireForContents(savedContents));
  assert.doesNotThrow(()=>f.broker.getAvailability(savedEvent));
  assert.equal(f.broker.setReady(savedEvent,true),false);
  assert.equal(f.broker.open(savedEvent,f.scope),false);
  assert.equal(f.broker.send(savedEvent,f.offer()),false);
  assert.equal(f.broker.viewport(savedEvent,{session,revision:1,tileId:"camera-a",visible:false,width:0,height:0,fps:0}),false);
  const survivor=side==="main"?f.overlay:f.main;
  assert.ok(survivor.sent.some(event=>event.channel==="overlay-media"&&(event.value as {kind:string}).kind==="end"));
 }
});
test("WebContents can die or throw mainFrame while its BrowserWindow still reports live",()=>{
 for(const side of ["main","overlay"] as const)for(const exposesDestroyed of [true,false]){
  const f=fixture();f.open();const target=f[side],savedEvent=target.event(),mainEvent=f.main.event(),contents=target.win.webContents;let contentsDead=false;
  contents.isDestroyed=()=>exposesDestroyed&&contentsDead;
  const frame=contents.mainFrame;
  Object.defineProperty(contents,"mainFrame",{get(){if(contentsDead)throw new TypeError("Object has been destroyed");return frame;}});
  contentsDead=true;assert.equal(target.win.isDestroyed(),false);
  assert.doesNotThrow(()=>f.broker.refresh());
  assert.doesNotThrow(()=>f.broker.retireForContents(contents));
  assert.doesNotThrow(()=>f.broker.revoke());
  assert.equal(f.broker.setReady(savedEvent,true),false);
  assert.equal(f.broker.open(savedEvent,f.scope),false);
  assert.equal(f.broker.send(savedEvent,f.offer()),false);
  assert.equal(f.broker.viewport(savedEvent,{session,revision:1,tileId:"camera-a",visible:true,width:10,height:10,fps:1}),false);
  const status=f.broker.getAvailability(mainEvent);
  assert.ok(status===null||status.ready===false);
 }
});
