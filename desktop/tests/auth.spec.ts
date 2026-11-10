import { test, expect } from '@playwright/test';

test('서버 확인 실패·주소 거부·이전 화면 복귀가 저장 서버를 바꾸지 않는다', async ({ page }) => {
  // 1. 다른 서비스가 정상 HTTP를 반환해도 최초 서버로 저장하지 않는다.
  await page.route('http://127.0.0.1:19379/healthz', route => route.fulfill({ json: { status: 'ok', service: 'another-service' } }));
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill('http://127.0.0.1:19379');
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('서버에 연결할 수 없어요');
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBeNull();
  await page.getByRole('textbox', { name: '서버 주소' }).fill('http://127.0.0.1:19377');
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toBeFocused();

  // 2. 자격증명이 포함된 주소는 요청 전에 거부하고 기존 서버를 보존한다.
  await page.getByRole('link', { name: '서버 변경', exact: true }).click();
  await page.getByRole('textbox', { name: '서버 주소' }).fill('http://user:password@127.0.0.1:19379');
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('형식으로 입력하세요');
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBe('http://127.0.0.1:19377');

  // 3. 응답을 기다리는 중 돌아가면 늦은 성공 응답도 새 서버로 적용하지 않는다.
  let respond: (() => Promise<void>) | undefined;
  await page.unroute('http://127.0.0.1:19379/healthz');
  await page.route('http://127.0.0.1:19379/healthz', route => {
    respond = () => route.fulfill({ json: { status: 'ok', service: 'our-pets' } }).catch(() => undefined);
  });
  await page.getByRole('textbox', { name: '서버 주소' }).fill('http://127.0.0.1:19379');
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await expect.poll(() => Boolean(respond)).toBe(true);
  await page.getByRole('link', { name: '돌아가기', exact: true }).click();
  await respond!();
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '서버 주소' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBe('http://127.0.0.1:19377');
});
