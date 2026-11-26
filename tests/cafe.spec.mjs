import { test, expect, open } from './office.mjs';

const cwd = '/tmp/e2e-cafe', ids = ['s1', 's2', 's3', 's4'];

test('idle agents sit together at the café counter and chat; one called back sprints to its desk, the rest keep chatting', async ({ page, office }) => {
  for (const id of ids) {
    await office.hook({ hook_event_name: 'SessionStart', session_id: id, cwd });
    await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt: 'Warm up' });
    await office.hook({ hook_event_name: 'Stop', session_id: id, cwd });
  }
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.filter(x => x.kind === 'main').length)).toBe(4);

  // Each takes a break in turn. The first one's break is at the counter (Math.random pinned low); the others join it.
  const seats = await page.evaluate(async () => {
    const mains = agents.filter(x => x.kind === 'main'); goToFloor(mains[0].floor.i);
    for (const a of mains) a.pref = 'desk';
    const random = Math.random; Math.random = () => .1;
    try { for (const a of mains) { const sp = chooseIdle(a.floor, a); a.cafe = sp.type === 'stool' ? sp : null; place(a, sp, true); } }
    finally { Math.random = random; }
    for (let i = 0; i < 80 && mains.some(a => a.path.length); i++) await agentOffice.advance(.25);
    return mains.map(a => ({ type: a.spot.type, x: a.spot.x, by: a.spot.by === a.id }));
  });
  const stools = seats.filter(s => s.type === 'stool');
  expect(stools.length).toBe(3);                                  // three stools, three at the counter
  expect(new Set(stools.map(s => s.x)).size).toBe(3);             // each on a stool of its own
  expect(seats[3].type).not.toBe('stool');                        // the fourth went somewhere else
  expect(seats.every(s => s.by)).toBe(true);

  const chat = await page.evaluate(async () => {
    const at = agents.filter(x => x.kind === 'main' && atCafe(x)).sort((p, q) => p.spot.x - q.spot.x);
    let bubble = false;
    for (let i = 0; i < 40 && !bubble; i++) { await agentOffice.advance(.25); bubble = at.some(a => a.bubKind === 'chat' && a.bub.visible); }
    await agentOffice.advance(.5);
    return { bubble, activity: at.map(a => a.activity), laptops: at.some(a => a.laptop.visible),
      left: Math.sin(at[0].yaw), right: Math.sin(at[2].yaw), speakers: at.filter(a => a.chat === 'talk').length };
  });
  expect(chat.bubble).toBe(true);
  expect(chat.activity).toEqual(Array(3).fill('Chatting at the café counter'));
  expect(chat.laptops).toBe(false);
  expect(chat.left).toBeGreaterThan(.5);                           // the end stools turn in, toward each other
  expect(chat.right).toBeLessThan(-.5);
  expect(chat.speakers).toBeLessThanOrEqual(1);                   // one talks at a time

  // Prompt the one in the middle: it sprints back to its desk; the two either side keep talking.
  const mid = await page.evaluate(() => { const at = agents.filter(x => x.kind === 'main' && atCafe(x)).sort((p, q) => p.spot.x - q.spot.x); return at[1].sessionId; });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: mid, cwd, prompt: 'Back to work' });
  await expect.poll(() => page.evaluate(id => !!agents.find(x => x.sessionId === id).sprint, mid)).toBe(true);
  const after = await page.evaluate(async id => {
    const a = agents.find(x => x.sessionId === id);
    for (let i = 0; i < 80 && a.path.length; i++) await agentOffice.advance(.25);
    const rest = agents.filter(x => x.kind === 'main' && atCafe(x));
    return { atDesk: a.spot === a.home, cafe: a.cafe, chatting: rest.map(x => x.chat !== null && x.activity === 'Chatting at the café counter') };
  }, mid);
  expect(after).toEqual({ atDesk: true, cafe: null, chatting: [true, true] });

  // One more leaves: the last one has a coffee on its own, facing the counter.
  const solo = await page.evaluate(async () => {
    const [a, b] = agents.filter(x => x.kind === 'main' && atCafe(x));
    a.cafe = null; place(a, a.home, true);
    for (let i = 0; i < 80 && a.path.length; i++) await agentOffice.advance(.25);
    await agentOffice.advance(1);
    return { chat: b.chat, activity: b.activity, facing: Math.abs(Math.cos(b.yaw) + 1) < .05 };
  });
  expect(solo).toEqual({ chat: null, activity: 'Having a coffee at the counter', facing: true });
});
