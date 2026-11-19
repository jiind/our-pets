import { test, expect } from '@playwright/test';
import { testInvitation } from './test-invitation';

test('서버 확인 실패·주소 거부·이전 화면 복귀가 저장 서버를 바꾸지 않는다', async ({ page }) => {
  // 1. 다른 서비스가 정상 HTTP를 반환해도 최초 서버로 저장하지 않는다.
  await page.route('http://127.0.0.1:19379/healthz', route => route.fulfill({ json: { status: 'ok', service: 'another-service' } }));
  await page.goto('/');
  const openInvite = page.getByRole('button', { name: '초대 링크로 참여하기', exact: true });
  await openInvite.press('Space');
  const link = page.getByLabel('초대 링크', { exact: true });
  const submit = page.getByRole('button', { name: '방 참여', exact: true });
  await expect(link).toBeFocused();
  await link.fill(testInvitation('http://127.0.0.1:19379'));
  await submit.click();
  await expect(page.locator('#notice')).toContainText('서버에 연결할 수 없어요');
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBeNull();
  await link.fill(testInvitation('http://127.0.0.1:19377'));
  await submit.click();
  await expect(page.getByRole('textbox', { name: '닉네임', exact: true })).toBeFocused();

  // 2. 자격증명이 포함된 주소는 요청 전에 거부하고 기존 서버를 보존한다.
  await page.getByRole('link', { name: '돌아가기', exact: true }).click();
  await link.fill(testInvitation('http://user:password@127.0.0.1:19379'));
  await submit.click();
  await expect(page.locator('#notice')).toHaveText('우리 펫 초대 링크를 확인해 주세요.');
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBe('http://127.0.0.1:19377');

  // 3. 응답을 기다리는 중 돌아가면 늦은 성공 응답도 새 서버로 적용하지 않는다.
  let respond: (() => Promise<void>) | undefined;
  await page.unroute('http://127.0.0.1:19379/healthz');
  await page.route('http://127.0.0.1:19379/healthz', route => {
    respond = () => route.fulfill({ json: { status: 'ok', service: 'our-pets' } }).catch(() => undefined);
  });
  await link.fill(testInvitation('http://127.0.0.1:19379'));
  await submit.click();
  await expect.poll(() => Boolean(respond)).toBe(true);
  await page.getByRole('link', { name: '돌아가기', exact: true }).click();
  await respond!();
  await expect(openInvite).toBeVisible();
  await expect(link).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ourpets.server'))).toBe('http://127.0.0.1:19377');
});
