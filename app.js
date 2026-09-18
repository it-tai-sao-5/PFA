(() => {
"use strict";

const canvas = document.getElementById("roll");
const ctx = canvas.getContext("2d");
const fileInput = document.getElementById("midiFile");
const playBtn = document.getElementById("play");
const stopBtn = document.getElementById("stop");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const info = document.getElementById("info");
const empty = document.getElementById("empty");
const keyboard = document.getElementById("keyboard");

const FIRST = 21, LAST = 108, COUNT = LAST - FIRST + 1;
const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const black = new Set([1,3,6,8,10]);
const computerMap = {
  a:60,w:61,s:62,e:63,d:64,f:65,t:66,g:67,y:68,h:69,u:70,j:71,k:72
};

let audioCtx = null;
let midi = null;
let playing = false;
let position = 0;
let lastTime = performance.now();
let raf = 0;
let activeVoices = new Map();

function noteName(n) { return names[n % 12] + (Math.floor(n / 12) - 1); }

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener("resize", resize);
resize();

for (let n=FIRST;n<=LAST;n++) {
  const b=document.createElement("button");
  b.type="button"; b.className="key" + (black.has(n%12) ? " black":"");
  b.textContent=noteName(n); b.dataset.note=n; b.setAttribute("aria-label",noteName(n));
  b.addEventListener("pointerdown",()=>startNote(n));
  b.addEventListener("pointerup",()=>stopNote(n));
  b.addEventListener("pointerleave",()=>stopNote(n));
  keyboard.appendChild(b);
}

function ensureAudio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function startNote(n, velocity=.7) {
  const ac=ensureAudio();
  stopNote(n);
  const o=ac.createOscillator(), g=ac.createGain();
  o.type="triangle"; o.frequency.value=440*Math.pow(2,(n-69)/12);
  g.gain.setValueAtTime(.0001,ac.currentTime);
  g.gain.exponentialRampToValueAtTime(Math.max(.02,velocity*.16),ac.currentTime+.012);
  o.connect(g).connect(ac.destination); o.start();
  activeVoices.set(n,{o,g});
  const el=keyboard.querySelector(`[data-note="${n}"]`);
  if(el) el.classList.add("active");
}
function stopNote(n) {
  const v=activeVoices.get(n); if(!v) return;
  const ac=ensureAudio();
  v.g.gain.cancelScheduledValues(ac.currentTime);
  v.g.gain.setTargetAtTime(.0001,ac.currentTime,.035);
  v.o.stop(ac.currentTime+.16);
  activeVoices.delete(n);
  const el=keyboard.querySelector(`[data-note="${n}"]`);
  if(el) el.classList.remove("active");
}

addEventListener("keydown",e=>{
  if(e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const n=computerMap[e.key.toLowerCase()];
  if(n !== undefined) startNote(n);
});
addEventListener("keyup",e=>{
  const n=computerMap[e.key.toLowerCase()];
  if(n !== undefined) stopNote(n);
});

function readVar(data, state) {
  let value=0, byte;
  do {
    byte=data[state.i++];
    if(byte===undefined) throw new Error("Unexpected end of MIDI");
    value=(value<<7)|(byte&127);
  } while(byte&128);
  return value;
}
function u16(d,i){return (d[i]<<8)|d[i+1]}
function u32(d,i){return d[i]*16777216+d[i+1]*65536+d[i+2]*256+d[i+3]}
function ascii(d,i,n){return String.fromCharCode(...d.slice(i,i+n));}

function parseMIDI(buffer) {
  const d=new Uint8Array(buffer), h={i:0};
  if(ascii(d,0,4)!=="MThd") throw new Error("Not a MIDI file");
  const headerLen=u32(d,4), format=u16(d,8), tracks=u16(d,10), division=u16(d,12);
  if(division & 0x8000) throw new Error("SMPTE MIDI timing is not supported yet");
  let p=8+headerLen, all=[], tempo=500000, maxTick=0;
  for(let tr=0;tr<tr<tracks;tr++){
    if(ascii(d,p,4)!=="MTrk") throw new Error("Invalid MIDI track");
    const len=u32(d,p+4), end=p+8+len, state={i:p+8}, events=[], running=0, tick=0;
    while(state.i<end){
      tick += readVar(d,state);
      let status=d[state.i++];
      if(status<0x80){state.i--; status=running;} else running=status;
      if(status===0xFF){
        const type=d[state.i++], l=readVar(d,state), start=state.i;
        if(type===0x51 && l===3) tempo=(d[start]*65536+d[start+1]*256+d[start+2]);
        state.i=start+l;
        if(type===0x2F) break;
      } else if(status===0xF0 || status===0xF7){
        state.i += readVar(d,state);
      } else {
        const cmd=status&0xF0, ch=status&15;
        const a=d[state.i++], b=(cmd===0xC0||cmd===0xD0)?0:d[state.i++];
        if(cmd===0x90 && b>0) events.push({tick,type:"on",note:a,vel:b/127,ch});
        else if(cmd===0x80 || (cmd===0x90 && b===0)) events.push({tick,type:"off",note:a,ch});
      }
    }
    all.push(events); maxTick=Math.max(maxTick,tick); p=end;
  }

  // Convert ticks to seconds, honoring tempo changes in a second pass.
  // This intentionally supports common tempo maps while keeping the parser small.
  const merged=[];
  for(const tr of all) for(const e of tr) merged.push(e);
  merged.sort((a,b)=>a.tick-b.tick);
  const secPerTick=tempo/(division*1e6);
  const open=new Map(), notes=[];
  for(const e of merged){
    const t=e.tick*secPerTick;
    if(e.type==="on"){
      const key=e.ch+":"+e.note;
      if(open.has(key)) open.delete(key);
      open.set(key,{start:t,n:e.note,vel:e.vel});
    } else {
      const key=e.ch+":"+e.note, q=open.get(key);
      if(q){ notes.push({n:q.n,start:q.start,dur:Math.max(.025,t-q.start),vel:q.vel}); open.delete(key); }
    }
  }
  for(const q of open.values()) notes.push({n:q.n,start:q.start,dur:.12,vel:q.vel});
  notes.sort((a,b)=>a.start-b.start);
  const duration=Math.max(0,maxTick*secPerTick);
  return {format,tracks,division,notes,duration};
}

fileInput.addEventListener("change",async()=>{
  const file=fileInput.files?.[0]; if(!file) return;
  try {
    midi=parseMIDI(await file.arrayBuffer());
    position=0; playing=false; playBtn.disabled=false; stopBtn.disabled=false;
    playBtn.textContent="▶ Play"; empty.style.display="none";
    info.textContent=`${file.name} · ${midi.notes.length.toLocaleString()} notes · ${formatTime(midi.duration)}`;
  } catch(err) {
    midi=null; playBtn.disabled=true; stopBtn.disabled=true; empty.style.display="";
    info.textContent="Error: "+err.message;
  }
});
function formatTime(s){return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;}

playBtn.addEventListener("click",()=>{ if(!midi)return; ensureAudio(); playing=!playing; playBtn.textContent=playing?"⏸ Pause":"▶ Play"; lastTime=performance.now(); });
stopBtn.addEventListener("click",()=>{playing=false;position=0;playBtn.textContent="▶ Play";});
speedInput.addEventListener("input",()=>speedValue.textContent=Number(speedInput.value).toFixed(2)+"×");

function draw(now) {
  const w=canvas.clientWidth,h=canvas.clientHeight;
  const dt=Math.min(.1,(now-lastTime)/1000); lastTime=now;
  if(playing && midi){
    position+=dt*Number(speedInput.value);
    if(position>=midi.duration){position=midi.duration;playing=false;playBtn.textContent="▶ Play";}
  }
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="#0b0e14";ctx.fillRect(0,0,w,h);
  const lane=w/COUNT;
  for(let i=0;i<=COUNT;i++){
    ctx.strokeStyle=i%12===0?"#303542":"#1b1f28";
    ctx.beginPath();ctx.moveTo(i*lane,0);ctx.lineTo(i*lane,h);ctx.stroke();
  }
  if(midi){
    const pxPerSec=Math.max(70,h/4);
    const hit=h*.82;
    for(const q of midi.notes){
      if(q.n<FIRST||q.n>LAST)continue;
      const x=(q.n-FIRST)*lane+1;
      const y=hit-(q.start-position)*pxPerSec-q.dur*pxPerSec;
      const hh=q.dur*pxPerSec;
      if(y>h||y+hh<0)continue;
      ctx.fillStyle=q.n%12===1||q.n%12===3||q.n%12===6||q.n%12===8||q.n%12===10?"#756be0":"#9a90ff";
      ctx.fillRect(x,y,Math.max(3,lane-2),Math.max(4,hh));
    }
    ctx.strokeStyle="#ffffff";ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(0,hit);ctx.lineTo(w,hit);ctx.stroke();
  }
  raf=requestAnimationFrame(draw);
}
raf=requestAnimationFrame(draw);
})();
