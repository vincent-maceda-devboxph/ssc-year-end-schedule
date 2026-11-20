import { expect, test, type APIRequestContext } from '@playwright/test';

const SCORING = { gamesToWin: 2, pointsToWin: 21, winBy: 2, cap: 30, intervalAt: 11, changeEndsInDecider: true };
const post = async (api: APIRequestContext, url: string, data: object = {}) => {
  const r = await api.post(`/api${url}`, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
};

test('admin sets up a tournament, spectators follow it live, a knockout bracket shows TBD', async ({ page, browser }) => {
  // ---- admin signs in through the real login form ----
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('e2e-admin-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);

  // ---- set up through the API using the same signed-in session ----
  const api = page.request;
  const t = await post(api, '/tournaments', { name: 'E2E Open', status: 'active' });
  const tid = t.id as string;
  for (const name of ['Court 1', 'Court 2']) await post(api, '/courts', { tournamentId: tid, name });
  const rows = [
    ...['Ana|Bea', 'Cy|Di'].map((p) => ({ team: 'Red', category: "Men's Doubles", player1: p.split('|')[0], player2: p.split('|')[1] })),
    ...['Eve|Fay', 'Gus|Hal'].map((p) => ({ team: 'Blue', category: "Men's Doubles", player1: p.split('|')[0], player2: p.split('|')[1] })),
  ];
  const imp = await post(api, `/tournaments/${tid}/lineup/import`, { rows });
  expect(imp.problems ?? []).toEqual([]);
  expect((await post(api, `/tournaments/${tid}/matches/generate`, {})).created).toBe(2);
  await api.put(`/api/tournaments/${tid}/schedule/settings`, { data: { startAt: new Date(Date.now() + 3600_000).toISOString(), matchMinutes: 30, minRestSlots: 1, seed: 1 } });
  const draft = await post(api, `/tournaments/${tid}/schedules`, {});
  await post(api, `/tournaments/${tid}/schedules/publish`, { versionId: draft.id });

  // ---- admin schedule tab: list layout shows the pairs ----
  await page.goto(`/admin/t/${tid}`);
  await page.getByRole('tab', { name: 'Schedule' }).click();
  await page.locator('mat-button-toggle', { hasText: 'List' }).click();
  await expect(page.getByRole('cell', { name: /Ana & Bea|Ana \/ Bea|Ana/ }).first()).toBeVisible();

  // ---- a spectator (no login) sees the matches, then a result, without reloading ----
  const spectator = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' });
  const sp = await spectator.newPage();
  await sp.goto(`/live/${tid}`);
  await sp.getByText(/Upcoming/).click();
  await expect(sp.locator('bt-match-card')).toHaveCount(2);
  const matches = (await (await api.get(`/api/matches?tournamentId=${tid}`)).json()) as { id: string }[];
  await post(api, `/matches/${matches[0]!.id}/walkover`, { winner: 'A' });
  await sp.getByText(/Results/).click();
  await expect(sp.locator('table.simple tbody tr')).toHaveCount(1);

  // ---- a standalone knockout: the spectator gets a Brackets tab with undecided sides shown as TBD ----
  const ko = await post(api, '/categories', { tournamentId: tid, name: 'Singles KO', discipline: 'singles', format: 'knockout', scoring: SCORING });
  for (let i = 1; i <= 4; i++) {
    const p = await post(api, '/players', { tournamentId: tid, firstName: `K${i}` });
    await post(api, '/entries', { categoryId: ko.id, playerIds: [p.id], seed: i });
  }
  await post(api, `/categories/${ko.id}/bracket/generate`, {});
  await sp.reload();
  await sp.getByText('Brackets').click();
  await expect(sp.getByText('Semifinal').first()).toBeVisible();
  await expect(sp.getByText('TBD').first()).toBeVisible();
  await spectator.close();
});

test('wrong admin password is refused', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('nope-nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/login/);
});
