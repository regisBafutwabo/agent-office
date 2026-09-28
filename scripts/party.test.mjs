import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const source=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end));
function setup() {
  const context=vm.createContext({nightT:1,performance:{now:()=>1000}});
  vm.runInContext(source('const isParty =','const BPM ='),context);
  vm.runInContext(source('function animationPose','function updateAgent'),context);
  vm.runInContext(source('function poseFor','function applyStatus'),context);
  return {context,run:code=>vm.runInContext(code,context)};
}

test('dancing requires an active rooftop party and a dance-floor spot',()=>{
  const {context,run}=setup();
  context.a={state:'idle',pose:'dance',onRoof:true,spot:{type:'dance'}};
  assert.equal(run('poseFor(a)'),'dance'); assert.equal(run('animationPose(a,false)'),'dance');
  for(const night of [0,.5]) {
    context.nightT=night;
    // A previously assigned pose must stop immediately, even with simulation paused.
    assert.equal(run('poseFor(a)'),'idle'); assert.equal(run('animationPose(a,false)'),'idle');
  }
  context.nightT=1; context.a.onRoof=false;
  assert.equal(run('animationPose(a,false)'),'idle');
  context.a.onRoof=true; context.a.spot={type:'roofchair'};
  assert.equal(run('animationPose(a,false)'),'idle');
  context.a.spot={type:'dance'};
  assert.equal(run('animationPose(a,true)'),'walk');
  assert.equal(run('animationPose(a,false)'),'dance');
  context.a.state='working'; assert.equal(run('poseFor(a)'),'type');
  context.nightT=0; context.a.cheerUntil=2000;
  assert.equal(run('animationPose(a,false)'),'cheer'); // Merge celebrations are distinct from dancing.
});

test('the visible music booth stays still in daylight and resets its night pose',()=>{
  const {context,run}=setup();
  const rotation=()=>({rotation:{x:-2.8,y:2}});
  context.PARTY={group:{},booth:{},fade:[],decks:[rotation()],dj:{
    pivot:{position:{y:.04}},head:rotation(),armL:rotation(),armR:rotation()
  }};
  Object.assign(context,{nightT:0,roofGroup:{visible:true},music:{title:'Playing'},shellT:1,
    partyBeat:()=>2,drawDjScreen(){},nowPlaying:()=>context.music});
  vm.runInContext(source('function updateParty','/* ---------- skyline'),context);
  run('updateParty(.1)');
  assert.equal(context.PARTY.group.visible,false); assert.equal(context.PARTY.booth.visible,true);
  assert.equal(context.PARTY.decks[0].rotation.y,2);
  assert.equal(context.PARTY.dj.pivot.position.y,0);
  assert.equal(context.PARTY.dj.head.rotation.x,0);
  assert.equal(context.PARTY.dj.armL.rotation.x,-1.15);
  assert.equal(context.PARTY.dj.armR.rotation.x,-1.15);
});
