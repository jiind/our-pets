import { expect, type Page } from '@playwright/test';
import { test } from './isolated-server';

// 격리 서버의 전용 계정으로 설정 화면을 연다.
async function accountPage(page: Page, server: string): Promise<void> {
  // 1. 테스트 전용 인증으로 계정을 만들고 실제 대표 펫 등록을 수행한다.
  const response = await page.request.post(`${server}/api/v1/register`, { data: { username: `privacy-${Date.now()}`, password: 'test-password-123', displayName: '개인정보 검사', invite: 'test-only-invite' } });
  expect(response.ok()).toBe(true);
  const login = await response.json();
  const registered = await page.request.post(`${server}/api/v1/me/pet/registration`, { headers: { Authorization: `Bearer ${login.token}` }, data: { designId: 'default' } });
  expect(registered.ok()).toBe(true);

  // 2. 이 테스트의 브라우저에만 세션을 전달하고 계정 화면으로 이동한다.
  await page.addInitScript(({ login, server }) => {
    localStorage.setItem('ourpets.server', server);
    localStorage.setItem('ourpets.session', JSON.stringify(login));
  }, { login, server });
  await page.goto('/');
  await page.getByRole('button', { name: '계정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '계정 정보', exact: true })).toBeVisible();
}

test('계정의 정보 및 고지는 로컬 원문·키보드 닫기·포커스 복원을 제공한다', async ({ page, isolatedServer }) => {
  // 1. 개인정보 안내는 계정의 보조 진입점에서 열고 외부 사이트 없이 원문을 표시한다.
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      failures.push(message.text());
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  await accountPage(page, isolatedServer);
  const open = page.getByRole('button', { name: '개인정보 안내', exact: true });
  await open.click();
  const dialog = page.locator('.legal-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-legal-body]')).toContainText('The collector holds pending notification bodies only in process memory');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // 2. 원문 선택은 HTML로 해석하지 않고 배포한 전체 의존성 고지까지 읽는다.
  await page.getByRole('button', { name: '라이선스·출처', exact: true }).click();
  await expect(dialog.locator('[data-legal-body]')).toContainText('Apache License');
  await dialog.getByRole('combobox', { name: '문서', exact: true }).selectOption('dependencies');
  await expect(dialog.locator('[data-legal-body]')).toContainText('GSAP');
  await expect(dialog.locator('[data-legal-status]')).toBeEmpty();
  await dialog.getByRole('combobox', { name: '문서', exact: true }).selectOption('characters');
  await expect(dialog.locator('[data-legal-body]')).toContainText('Renée French');
  await expect(dialog.locator('[data-legal-body]')).toContainText('CC BY 4.0');
  await page.screenshot({ path: '/tmp/our-pets-legal-dialog.png', fullPage: true });
  await dialog.getByRole('button', { name: '정보 및 고지 닫기', exact: true }).click();
  expect(failures).toEqual([]);
});

test('계정 삭제는 취소·현재 비밀번호 재확인과 삭제 후 로그아웃을 제공한다', async ({ page, isolatedServer }) => {
  // 1. 취소는 계정을 보존하고 비밀번호 입력을 다음 진입까지 남기지 않는다.
  await accountPage(page, isolatedServer);
  await page.getByRole('button', { name: '계정 삭제…', exact: true }).click();
  const dialog = page.locator('.account-delete-dialog');
  await expect(dialog).toContainText('이 PC의 외부 연결과 OS 알림 기록');
  await dialog.getByLabel('현재 비밀번호', { exact: true }).fill('temporary-cancelled-password');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '계정 삭제…', exact: true }).click();
  await expect(dialog.getByLabel('현재 비밀번호', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await page.screenshot({ path: '/tmp/our-pets-account-delete-dialog.png', fullPage: true });

  // 2. 잘못된 비밀번호는 삭제를 거부하고 올바른 비밀번호로만 로그인 상태를 해제한다.
  await dialog.getByLabel('현재 비밀번호', { exact: true }).fill('wrong-password');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '계정 영구 삭제', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('현재 비밀번호가 올바르지 않습니다');
  await expect(dialog.getByLabel('현재 비밀번호', { exact: true })).toHaveValue('');
  await dialog.getByLabel('현재 비밀번호', { exact: true }).fill('test-password-123');
  await dialog.getByRole('button', { name: '계정 영구 삭제', exact: true }).click();
  await expect(page.getByRole('button', { name: '접속하기 ↗', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ourpets.session'))).toBeNull();
});
