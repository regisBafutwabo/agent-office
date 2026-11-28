import { test, expect, open } from './office.mjs';

const cwd = '/tmp/e2e-sprint';
// Steps the office until the agent has stopped walking (or the time runs out).
const settle = page => page.evaluate(async () => {
  const a = agents.find(x => x.kind === 'main');
  for (let i = 0; i < 60 && a.path.length; i++) await agentOffice.advance(.25);
});

test('an agent on a break sprints back to its desk when you send a prompt, and skids into the chair', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Warm up' });
  await office.hook({ hook_event_name: 'Stop', session_id: 's1', cwd });
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(x => x.kind === 'main'))).toBe(true);

  // On a break across the room. A plain walk there is no sprint.
  const walked = await page.evaluate(async () => {
    agentOffice.held = true;
    const a = agents.find(x => x.kind === 'main'); a.pref = 'desk'; goToFloor(a.floor.i);
    for (let i = 0; i < 60 && a.path.length; i++) await agentOffice.advance(.25);
    const far = freeSpots(['hoops', 'arcade', 'coffee'], a.floor).sort((p, q) => Math.hypot(q.x - a.home.x, q.z - a.home.z) - Math.hypot(p.x - a.home.x, p.z - a.home.z))[0];
    place(a, far, true); await agentOffice.advance(.1);
    return { sprint: !!a.sprint, walking: a.path.length > 0 };
  });
  expect(walked).toEqual({ sprint: false, walking: true });
  await settle(page);
  expect(await page.evaluate(() => agents.find(x => x.kind === 'main').spot.type)).toMatch(/hoops|arcade|coffee/);

  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Back to work' });
  await expect.poll(() => page.evaluate(() => !!agents.find(x => x.kind === 'main').sprint)).toBe(true);
  const run = await page.evaluate(async () => {
    const a = agents.find(x => x.kind === 'main'), heard = a.bubKind;
    await agentOffice.advance(.35);                               // past the crouch before the dash
    const p = a.g.position.clone(); await agentOffice.advance(.4);
    return { heard, moved: Math.hypot(a.g.position.x - p.x, a.g.position.z - p.z), puffs: dust.length, lean: a.lean };
  });
  expect(run.heard).toBe('heard');
  expect(run.moved).toBeGreaterThan(2.5 * .4 * 1.5);              // well past a walk
  expect(run.puffs).toBeGreaterThan(0);
  expect(run.lean).toBeGreaterThan(.1);                           // leaning into it

  const after = await page.evaluate(async () => {
    const a = agents.find(x => x.kind === 'main'); let skidded = false;
    for (let i = 0; i < 400 && a.path.length; i++) { await agentOffice.advance(.02); skidded ||= !!a.sprint?.skid; }
    await agentOffice.advance(1.5);                               // let the last puffs fade
    return { skidded, atDesk: a.spot === a.home, sprint: a.sprint, path: a.path.length, puffs: dust.length,
      inScene: scene.children.filter(o => o.geometry === DUST_GEO).length, seated: a.legs.l < -1 };
  });
  expect(after).toEqual({ skidded: true, atDesk: true, sprint: null, path: 0, puffs: 0, inScene: 0, seated: true });
});

test('an agent on the roof sprints to the lift when you send a prompt, rides down, and sprints on to its desk', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Warm up' });
  await office.hook({ hook_event_name: 'Stop', session_id: 's1', cwd });
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(x => x.kind === 'main'))).toBe(true);

  // Up to the terrace, at the spot farthest from the lift, with the roof on show. Going up is a plain walk.
  const up = await page.evaluate(async () => {
    agentOffice.held = true;
    const a = agents.find(x => x.kind === 'main'); a.pref = 'desk'; goToFloor(a.floor.i);
    for (let i = 0; i < 60 && a.path.length; i++) await agentOffice.advance(.25);
    goRoof(a); let sprinted = false;
    for (let i = 0; i < 200 && !(a.onRoof && !a.path.length && a.spot && a.spot !== ROOF_LIFT); i++) { await agentOffice.advance(.1); sprinted ||= !!a.sprint; }
    const far = roofFree().sort((p, q) => Math.hypot(q.x - ROOF_LIFT.x, q.z - ROOF_LIFT.z) - Math.hypot(p.x - ROOF_LIFT.x, p.z - ROOF_LIFT.z))[0];
    roofWalkTo(a, far); goRoofView();
    for (let i = 0; i < 200 && a.path.length; i++) await agentOffice.advance(.1);
    await agentOffice.advance(.3);
    return { onRoof: a.onRoof, at: a.spot === far, sprinted, roofShown: roofGroup.visible };
  });
  expect(up).toEqual({ onRoof: true, at: true, sprinted: false, roofShown: true });

  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Back to work' });
  await expect.poll(() => page.evaluate(() => !!agents.find(x => x.kind === 'main').sprint)).toBe(true);
  const run = await page.evaluate(async () => {
    const a = agents.find(x => x.kind === 'main'), heard = a.bubKind, shown = a.bub.visible;
    await agentOffice.advance(.35);                               // past the crouch before the dash
    const p = a.g.position.clone(); await agentOffice.advance(.4);
    const puffs = roofGroup.children.filter(o => o.geometry === DUST_GEO);
    return { heard, shown, onRoof: a.onRoof, moved: Math.hypot(a.g.position.x - p.x, a.g.position.z - p.z), lean: a.lean,
      roofPuffs: puffs.length, onDeck: puffs.every(m => m.position.y > ROOF_Y), floorPuffs: scene.children.filter(o => o.geometry === DUST_GEO).length };
  });
  expect(run).toMatchObject({ heard: 'heard', shown: true, onRoof: true, onDeck: true, floorPuffs: 0 });
  expect(run.moved).toBeGreaterThan(2.5 * .4 * 1.5);              // well past a walk
  expect(run.roofPuffs).toBeGreaterThan(0);
  expect(run.lean).toBeGreaterThan(.1);

  const after = await page.evaluate(async () => {
    const a = agents.find(x => x.kind === 'main'); let skidOnRoof = false, downSprinting = null, skidded = false;
    for (let i = 0; i < 1000 && (a.onRoof || a.comingDown || a.path.length); i++) {
      const was = a.onRoof; await agentOffice.advance(.02);
      if (a.onRoof) skidOnRoof ||= !!a.sprint?.skid;
      if (was && !a.onRoof) downSprinting = !!a.sprint;           // out of the lift, still running
      skidded ||= !a.onRoof && !!a.sprint?.skid;
    }
    await agentOffice.advance(1.5);                               // let the last puffs fade
    const count = g => g.children.filter(o => o.geometry === DUST_GEO).length;
    return { skidOnRoof, downSprinting, skidded, atDesk: a.spot === a.home, sprint: a.sprint, puffs: dust.length,
      inScene: count(scene) + count(roofGroup), seated: a.legs.l < -1 };
  });
  expect(after).toEqual({ skidOnRoof: false, downSprinting: true, skidded: true, atDesk: true, sprint: null, puffs: 0, inScene: 0, seated: true });
});

test('a chat known only from its log sprints back too when it starts working again', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 's3', cwd });
  await office.hook({ hook_event_name: 'Stop', session_id: 's3', cwd });
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(x => x.kind === 'main'))).toBe(true);
  const sprinted = await page.evaluate(async () => {
    agentOffice.held = true;
    const a = agents.find(x => x.kind === 'main'); a.pref = 'desk'; goToFloor(a.floor.i);
    for (let i = 0; i < 60 && a.path.length; i++) await agentOffice.advance(.25);
    const far = freeSpots(['hoops', 'arcade', 'coffee'], a.floor).sort((p, q) => Math.hypot(q.x - a.home.x, q.z - a.home.z) - Math.hypot(p.x - a.home.x, p.z - a.home.z))[0];
    place(a, far, true);
    for (let i = 0; i < 60 && a.path.length; i++) await agentOffice.advance(.25);
    applyStatus(a, 'done', 'Finished');
    // What a log scan reports when the chat picks up again without a hook (see discover.js).
    onLiveEvent({ type: 'SessionFound', sessionId: a.sessionId, at: Date.now(), message: null, session: { id: a.sessionId, project: a.project.key, cwd: a.cwd, status: 'thinking', activity: 'Thinking' } }, false);
    return { sprint: !!a.sprint, heading: a.dest === a.ws || a.path.length > 0, state: a.state };
  });
  expect(sprinted).toEqual({ sprint: true, heading: true, state: 'thinking' });
});
