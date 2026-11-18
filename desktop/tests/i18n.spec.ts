import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { test } from './isolated-server';

test.use({ locale: 'en-US' });

// 격리 서버에서 실제 가입·펫 등록을 마치고 계정 화면으로 이동한다.
async function register(page: Page, server: string): Promise<void> {
  // 1. 한국어를 명시적으로 선택한 뒤 실제 사용자 입력으로 가입한다.
  await page.goto('/');
  await page.getByRole('combobox', { name: 'App language', exact: true }).selectOption('ko');
  await page.getByLabel('서버 주소', { exact: true }).fill(server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
  await page.getByLabel('닉네임', { exact: true }).fill('고양이');
  await page.getByLabel('아이디', { exact: true }).fill(`locale-${Date.now()}`);
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByLabel('서버 가입 코드', { exact: true }).fill('test-only-invite');
  await page.getByRole('button', { name: '계정 만들고 펫 등록하기 ↗', exact: true }).click();

  // 2. 등록 완료 상태를 확인한 뒤 계정의 PC 언어 설정을 사용한다.
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 펫 등록', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '계정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '계정 정보', exact: true })).toBeVisible();
}

test('OS 영어 기본값·명시적 선택·시스템 복원과 입력 보존을 제공한다', async ({ page, isolatedServer }) => {
  // 1. 저장한 값이 없으면 OS 영어를 따르고 선택 방식은 자동으로 유지한다.
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
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('combobox', { name: 'App language', exact: true })).toHaveValue('system');
  await page.getByRole('combobox', { name: 'App language', exact: true }).selectOption('ko');
  await page.getByLabel('서버 주소', { exact: true }).fill(isolatedServer);

  // 2. 화면을 다시 만들지 않아 서버 주소·가입 입력·비밀번호 표시 상태를 유지한다.
  await page.getByLabel('앱 언어', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Connect to a server', exact: true })).toBeVisible();
  await expect(page.locator('[name=server]')).toHaveValue(isolatedServer);
  await expect(page).toHaveTitle('Our Pets');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Nickname', { exact: true }).fill('고양이');
  await page.getByLabel('Username', { exact: true }).fill('language-draft');
  await page.getByLabel('Password', { exact: true }).fill('draft-password-123');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await page.getByLabel('App language', { exact: true }).selectOption('ko');
  await expect(page.getByRole('heading', { name: '우리 펫에 합류하기', exact: true })).toBeVisible();
  await expect(page.getByLabel('닉네임', { exact: true })).toHaveValue('고양이');
  await expect(page.getByLabel('아이디', { exact: true })).toHaveValue('language-draft');
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('draft-password-123');
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: '비밀번호 숨기기', exact: true })).toBeVisible();

  // 3. 명시적 선택은 새로고침 뒤에도 유지한다.
  await page.getByLabel('앱 언어', { exact: true }).selectOption('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'App language', exact: true }).selectOption('ko');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.getByRole('combobox', { name: '앱 언어', exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('combobox', { name: 'App language', exact: true })).toHaveValue('system');
  expect(failures).toEqual([]);
});

test('계정·펫·알림 화면과 원문 안내를 영어로 표시하고 입력값을 보존한다', async ({ page, isolatedServer }) => {
  await register(page, isolatedServer);
  await page.getByLabel('닉네임', { exact: true }).fill('메시지');
  await page.getByLabel('현재 비밀번호', { exact: true }).filter({ visible: true }).fill('unsaved-password');
  await page.getByLabel('앱 언어', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Account information', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('메시지');
  await expect(page.getByLabel('Current password', { exact: true }).filter({ visible: true })).toHaveValue('unsaved-password');
  await page.getByRole('button', { name: 'GSAP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'GSAP', exact: true });
  await expect(dialog).toContainText('Standard "No Charge" GSAP License');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close information and notices', exact: true }).click();
  await page.getByRole('button', { name: 'Pet', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Cat', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Dog', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add pet', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('PNG file');
  await expect(page.getByRole('dialog').getByPlaceholder('e.g. Cat', { exact: true })).toBeVisible();
  await page.getByRole('dialog').locator('[data-animation-settings] > summary').click();
  await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'Use sprite sheet', exact: true })).not.toBeChecked();
  await expect(page.getByRole('dialog').locator('[data-animation-row]')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Docker · Slack · Codex · Claude on this PC', exact: true })).toBeVisible();
});

test('언어 전환은 펫 실시간 연결·사용자 이름·받은 메시지를 변경하지 않는다', async ({ page, context, isolatedServer }) => {
  await register(page, isolatedServer);
  const pet = await context.newPage();
  const sockets: string[] = [];
  pet.on('websocket', socket => {
    if (socket.url().endsWith('/api/v1/ws')) {
      sockets.push(socket.url());
    }
  });
  await pet.goto('/?pet');
  await expect.poll(() => pet.evaluate(() => JSON.parse(localStorage.getItem('ourpets.connection') || 'null')?.state)).toBe('연결됨');
  await page.getByLabel('앱 언어', { exact: true }).selectOption('en');
  await expect(pet.locator('html')).toHaveAttribute('lang', 'en');
  const canvas = pet.locator('canvas').first();
  await canvas.click({ button: 'right' });
  await expect(pet.getByRole('button', { name: 'Choose a gathering type', exact: true })).toBeVisible();
  expect(sockets).toHaveLength(1);

  // 발신자는 실제 별도 사용자·WebSocket이며 메시지 본문은 번역 사전과 같은 한글이다.
  const response = await page.request.post(`${isolatedServer}/api/v1/register`, { data: { username: `sender-${Date.now()}`, displayName: '알림', password: 'test-password-123', invite: 'test-only-invite' } });
  expect(response.ok()).toBe(true);
  const sender = await response.json();
  await page.request.post(`${isolatedServer}/api/v1/me/pet/registration`, { headers: { Authorization: `Bearer ${sender.token}` }, data: { designId: 'default' } });
  const socket = new WebSocket(`${isolatedServer.replace('http:', 'ws:')}/api/v1/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: sender.token }));
      socket.onmessage = event => {
        if (JSON.parse(String(event.data)).type === 'ready') {
          resolve();
        }
      };
      socket.onerror = reject;
    });
    const own = await page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.session')!).principal.petId);
    const sent = await page.request.post(`${isolatedServer}/api/v1/messages`, { headers: { Authorization: `Bearer ${sender.token}` }, data: { senderPetId: sender.principal.petId, mode: 'selected', petIds: [own], body: '펫', kind: 'text', idempotencyKey: randomUUID() } });
    expect(sent.ok()).toBe(true);
    await pet.keyboard.press('Escape');
    await expect(pet.locator('.bubble-sender')).toContainText('알림');
    await expect(pet.getByRole('region', { name: 'Notification content', exact: true })).toHaveText('펫');
    expect(sockets).toHaveLength(1);
  } finally {
    socket.close();
    await pet.close();
  }
});

for (const [language, expected] of [['ko-KR', 'ko'], ['en-GB', 'en'], ['ja-JP', 'en'], ['fr-FR', 'en']] as const) {
  test.describe(`OS ${language}`, () => {
    test.use({ locale: language });
    test('첫 화면은 OS 지원 언어 또는 영어를 사용한다', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', expected);
      await expect(page.getByRole('combobox')).toHaveValue('system');
      await expect(page.getByRole('heading', { name: expected === 'ko' ? '함께할 서버에 연결하기' : 'Connect to a server', exact: true })).toBeVisible();
    });
  });
}
