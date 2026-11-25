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
