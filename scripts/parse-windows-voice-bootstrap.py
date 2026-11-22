"""Extract named constructor spans from Chromium Perfetto protobuf, without args,
device identities, process IDs or command lines. Standard-library dependencies only.
Handles sequence-local interned names and Perfetto incremental microsecond clocks.
"""
import json,sys,collections
from pathlib import Path
def varint(data,pos):
    value=0; shift=0
    while True:
        b=data[pos];pos+=1;value|=(b&127)<<shift
        if b<128:return value,pos
        shift+=7
def wire(data):
    result=collections.defaultdict(list);pos=0
    while pos<len(data):
        tag,pos=varint(data,pos);field,typ=tag>>3,tag&7
        if typ==0:value,pos=varint(data,pos)
        elif typ==2:
            size,pos=varint(data,pos);value=data[pos:pos+size];pos+=size
        elif typ in (1,5):size=8 if typ==1 else 4;value=int.from_bytes(data[pos:pos+size],'little');pos+=size
        else:raise ValueError((field,typ,pos))
        result[field].append(value)
    return result
def one(msg,key,default=None):return msg.get(key,[default])[0]
def string(value):return value.decode('utf8',errors='replace') if isinstance(value,bytes) else value
filename=Path(sys.argv[1]); trace=wire(filename.read_bytes()); names={};categories={};defaults={};defaultclocks={};clocks={};tracks={};stacks=collections.defaultdict(list);slices=[];unknown=collections.Counter();markers=[]
for raw in trace[1]:
    packet=wire(raw);seq=one(packet,10,0);ts=one(packet,8)
    if 6 in packet:
        snapshot=wire(packet[6][0]); values=[wire(x) for x in snapshot.get(1,[])]; reference=next((one(c,2) for c in values if one(c,1)==3),None)
        for c in values:
            clockid=one(c,1); multiplier=one(c,4,1); value=one(c,2); clocks[(seq,clockid)]={'value':value,'multiplier':multiplier,'incremental':one(c,3,0),'offset':0 if reference is None else reference-value*multiplier}
    if one(packet,13,0)&1:names[seq]={};categories[seq]={}
    if 60 in packet:
        d=wire(packet[60][0]);tracks[one(d,1)]={'name':string(one(d,2,one(d,10,b'')))}
        if 4 in d:
            t=wire(d[4][0]);tracks[one(d,1)].update(pid=one(t,1),tid=one(t,2),thread=string(one(t,5,b'')))
    if 59 in packet:
        d=wire(packet[59][0]);defaults[seq]=one(wire(d[11][0]),11) if 11 in d else defaults.get(seq);defaultclocks[seq]=one(d,58,defaultclocks.get(seq,6))
    if ts is not None:
        cid=one(packet,58,defaultclocks.get(seq,6));clock=clocks.get((seq,cid))
        if clock:
            if clock['incremental']:clock['value']+=ts;ts=clock['value']
            ts=ts*clock['multiplier']+clock['offset']
    if 12 in packet:
        intern=wire(packet[12][0]); ns=names.setdefault(seq,{}); cs=categories.setdefault(seq,{})
        for entry in intern.get(2,[]):
            e=wire(entry);ns[one(e,1)]=string(one(e,2,b''))
        for entry in intern.get(1,[]):
            e=wire(entry);cs[one(e,1)]=string(one(e,2,b''))
    if 11 not in packet:continue
    event=wire(packet[11][0]);kind=one(event,9);track=one(event,11,defaults.get(seq,seq));name=string(one(event,23)) or names.get(seq,{}).get(one(event,10),'?')
    if name=='?':unknown.update([str(list(event.keys()))])
    if ts is None:continue
    if name.startswith('qa-'):markers.append({'name':name,'ts':ts,'track':track})
    if kind==1:stacks[track].append((name,ts))
    elif kind==2 and stacks[track]:
        name,start=stacks[track].pop();slices.append({'name':name,'start':start,'end':ts,'durationMs':(ts-start)/1e6,'track':track})
start=next((m['ts'] for m in markers if m['name']=='qa-pc-constructor-start'),None)
end=next((m['ts'] for m in markers if m['name']=='qa-pc-constructor-end'),None)
if start is None or end is None or end<=start:raise ValueError('Missing constructor timing markers')
allowed=('PeerConnectionDependencyFactory::CreatePeerConnectionFactory - Wait for start signaling',
         'MediaFoundationVideoEncodeAccelerator::GetSupportedProfiles','PeerConnection::Create',
         'ScopedBlockingCallWithBaseSyncPrimitives','InitializeSignalingThread','InitializeNetworkThread',
         'IsCodecSupportKnown','PeerConnectionFactoryProxy::CreatePeerConnectionOrError')
selected=[s for s in slices if s['name'] in allowed and s['start']>=start and s['end']<=end]
result={'constructorMarkerDurationMs':(end-start)/1e6,
        'clockHandling':'Packet clock defaults and sequence-local incremental clock snapshots converted to nanoseconds before matching begin/end spans.',
        'spans':[{'name':s['name'],'startAfterConstructorMs':(s['start']-start)/1e6,'durationMs':s['durationMs'],
                  'thread':tracks.get(s['track'],{}).get('thread','')} for s in sorted(selected,key=lambda e:e['durationMs'],reverse=True)]}
print(json.dumps(result,indent=2))
