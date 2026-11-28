import { test, expect, open } from './office.mjs';

const cwd = '/tmp/e2e-customize';
test('renaming an agent in Customize keeps its face in the list', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'c1', cwd });
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(x => x.kind === 'main'))).toBe(true);
  await page.getByRole('tab', { name: 'Customize' }).click();
  const row = page.locator('details.cust-agent').first();
  await row.locator('summary').click();
  const face = row.locator('summary .av img.av-face');
  await expect(face).toHaveCount(1);                                  // the face is drawn a moment after the row appears
  await row.getByLabel('Name').fill('Juno');
  await expect(row.locator('.cust-name b')).toHaveText('Juno');
  await expect(face).toHaveCount(1);                                  // it used to turn into the name's first letter
  await expect(row.locator('summary .av')).not.toHaveText('J');
});

test('name tags and the floor grid stay as you left them after a reload', async ({ page, office }) => {
  await open(page, office);
  await page.getByRole('tab', { name: 'Customize' }).click();
  await page.getByLabel('Show name tags').uncheck();
  await page.getByLabel('Show floor grid').check();
  await page.reload();
  await page.getByRole('tab', { name: 'Customize' }).click();
  await expect(page.getByLabel('Show name tags')).not.toBeChecked();
  await expect(page.getByLabel('Show floor grid')).toBeChecked();
  expect(await page.evaluate(() => [showLabels, grid.visible])).toEqual([false, true]);
});

test('Customize starts with your agents, names the colors and explains its limits', async ({ page, office }) => {
  await open(page, office);
  await page.getByRole('tab', { name: 'Customize' }).click();
  await expect(page.locator('#tab-custom h3').first()).toHaveText('Agents');
  await expect(page.locator('#cust-empty')).toBeVisible();
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'c2', cwd });
  await expect(page.locator('details.cust-agent')).toHaveCount(1);
  await expect(page.locator('#cust-empty')).toBeHidden();
  const row = page.locator('details.cust-agent');
  await row.locator('summary').click();
  await expect(row.getByRole('group', { name: 'Color', exact: true }).getByRole('button', { name: 'coral' })).toBeVisible();
  await expect(row.getByText('Takes effect from its next task.')).toBeVisible();
  // <details> passes content-box to its children, which pushed the inputs past the row's edge
  const [inputRight, rowRight] = await row.evaluate(d => [d.querySelector('input').getBoundingClientRect().right, d.querySelector('.cust-body').getBoundingClientRect().right]);
  expect(inputRight).toBeLessThanOrEqual(rowRight);
  await row.getByLabel('Name').fill('A'.repeat(30));
  await expect(row.getByLabel('Name')).toHaveValue('A'.repeat(18));
  await expect(row.getByText('Names can be up to 18 characters.')).toBeVisible();
});

test('your own models: the panel says where packs go, and Look again finds one added while the office is open', async ({ page, office }) => {
  const fs = await import('node:fs'), path = await import('node:path');
  await open(page, office);
  await page.getByRole('tab', { name: 'Customize' }).click();
  await expect(page.getByRole('heading', { name: 'Your own models' })).toBeVisible();
  await expect(page.locator('#pack-dir')).toHaveText(path.join(office.root, 'packs'));   // the folder the office really reads
  await expect(page.getByRole('button', { name: 'Open packs folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy path' })).toBeVisible();
  await expect(page.getByRole('link', { name: /How to make a pack/ })).toHaveAttribute('href', /features\.md#model-packs$/);
  fs.mkdirSync(path.join(office.root, 'packs', 'cozy'), { recursive: true });
  fs.writeFileSync(path.join(office.root, 'packs', 'cozy', 'pack.json'), JSON.stringify({ name: 'Cozy', license: 'CC0', slots: {} }));
  await page.getByRole('button', { name: 'Look again' }).click();
  await expect(page.locator('.toast', { hasText: 'Found Cozy' })).toBeVisible();
  await expect(page.locator('#pack-select option')).toHaveText(['Built-in', 'Cozy (CC0)']);
  await page.getByRole('button', { name: 'Look again' }).click();
  await expect(page.locator('.toast', { hasText: 'No new packs' })).toBeVisible();
});

// Another office tab saves its settings to the same storage. These tests write that save directly instead of opening a
// second office: on CI two WebGL pages share a slow software renderer, and the second one misses its connect deadline.
const saveFromOtherTab = (page, prefs) => page.evaluate(p => {
  const ui = JSON.parse(localStorage.getItem('agent-office:ui')) || {}; localStorage.setItem('agent-office:ui', JSON.stringify({ ...ui, ...p }));
}, prefs);

test('a city picked in one tab stays picked when an older tab changes another setting', async ({ page, office }) => {
  await open(page, office);                                           // the older tab, on Generic city
  await saveFromOtherTab(page, { city: 'gangnam' });                  // Seoul, picked in another tab
  await page.getByRole('tab', { name: 'Customize' }).click();
  await page.getByLabel('Show name tags').uncheck();                 // this used to save the older tab's city too
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-office:ui')))).toMatchObject({ city: 'gangnam', labels: false });
  await page.reload();
  await expect.poll(() => page.evaluate(() => cityKey), { timeout: 20_000 }).toBe('gangnam');
  await expect(page.locator('#city-picker')).not.toBeVisible();
  await page.getByRole('tab', { name: 'Customize' }).click();
  await expect(page.getByLabel('Show name tags')).not.toBeChecked();  // and its own change is kept
});

test('picking the city a tab started with again saves it over another tab’s pick', async ({ page, office }) => {
  await open(page, office);                                           // on Generic city
  await saveFromOtherTab(page, { city: 'gangnam' });
  await page.getByRole('tab', { name: 'Customize' }).click();
  await page.locator('#cities').getByRole('button', { name: 'Generic city' }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-office:ui')).city)).toBe('generic');
  await page.reload();
  expect(await page.evaluate(() => cityKey)).toBe('generic');
});
