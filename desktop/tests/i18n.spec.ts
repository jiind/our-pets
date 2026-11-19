import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { test } from './isolated-server';
import { testInvitation } from './test-invitation';

test.use({ locale: 'en-US' });

const languageNames = { ko: '한국어', en: 'English' };

test('미국 국기로 영어를 바로 적용하고 네이티브 저장을 다시 시도한다', async ({ page }) => {
  await page.route(/\/src\/main\.ts(?:\?.*)?$/u, async route => {
    const response = await route.fetch();
    const mock = `
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      window.isTauri = true;
      mockIPC((command, args) => {
        if (command === 'get_locale') return { locale: localStorage.getItem('test.nativeLocale') || 'ko' };
        if (command === 'set_locale') {
          if (!localStorage.getItem('test.allowLocaleSync')) throw new Error('Temporary save failure');
          localStorage.setItem('test.nativeLocale', args.locale);
          return { locale: args.locale };
        }
      }, { shouldMockEvents: true });
    `;
    await route.fulfill({ response, body: mock + await response.text() });
  });
  await page.goto('/');
  await expectSelectedLanguage(page, 'ko');
  await languageToggle(page).click();
  const english = page.getByRole('button', { name: 'English', exact: true });
  await english.evaluate(button => {
    button.addEventListener('pointerdown', () => (document.activeElement as HTMLElement)?.blur(), { once: true });
  });
  await english.click();
  await expect(languageToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
  await expect(page.locator('[data-language-error]')).toContainText('Could not sync');
  expect(await page.evaluate(() => localStorage.getItem('ourpets.locale'))).toBe('en');
  await page.evaluate(() => localStorage.setItem('test.allowLocaleSync', 'true'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test.nativeLocale'))).toBe('en');
});

function languageToggle(page: Page) {
  return page.getByRole('button', { name: /^(앱 언어|App language)$/u });
}

// 오른쪽 위 국기 버튼에서 앱 언어를 바꾼다.
async function selectLanguage(page: Page, choice: keyof typeof languageNames): Promise<void> {
  const toggle = languageToggle(page);
  await toggle.click();
  await page.getByRole('button', { name: languageNames[choice], exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
}

// 목록을 열었을 때 두 언어와 현재 선택을 확인하고 포커스를 돌아오게 한다.
async function expectSelectedLanguage(page: Page, current: keyof typeof languageNames): Promise<void> {
  const toggle = languageToggle(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'English', exact: true })).toHaveCount(0);
  await toggle.press('Space');
  const options = page.getByRole('group', { name: /^(앱 언어|App language)$/u }).getByRole('button');
  await expect(options).toHaveCount(2);
  const selected = page.getByRole('button', { name: languageNames[current], exact: true });
  const other = page.getByRole('button', { name: languageNames[current === 'ko' ? 'en' : 'ko'], exact: true });
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(selected).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(other).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
}

// 격리 서버에서 실제 가입·펫 등록을 마치고 계정 화면으로 이동한다.
async function register(page: Page, server: string): Promise<void> {
  // 1. 한국어를 명시적으로 선택한 뒤 실제 사용자 입력으로 가입한다.
  await page.goto('/');
  await selectLanguage(page, 'ko');
  await page.getByRole('button', { name: '초대 링크로 참여하기', exact: true }).click();
  await page.getByLabel('초대 링크', { exact: true }).fill(testInvitation(server));
  await page.getByRole('button', { name: '방 참여', exact: true }).click();
  await page.getByLabel('닉네임', { exact: true }).fill('고양이');
  await page.getByRole('button', { name: '참여하기', exact: true }).click();

  // 2. 등록 완료 상태를 확인한 뒤 계정의 PC 언어 설정을 사용한다.
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 펫 등록', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '계정 정보', exact: true })).toBeVisible();
}

test('첫 실행의 OS 언어와 이후 선택을 저장하고 입력을 보존한다', async ({ page, isolatedServer }) => {
  // 1. 처음에는 OS 영어를 저장하고 다음 실행에서 시스템 언어가 달라져도 저장 값을 사용한다.
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
  await expectSelectedLanguage(page, 'en');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { value: ['ko-KR'] });
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await selectLanguage(page, 'ko');
  await page.getByRole('button', { name: '초대 링크로 참여하기', exact: true }).click();
  const link = testInvitation(isolatedServer);
  await page.getByLabel('초대 링크', { exact: true }).fill(link);

  // 2. 언어를 바꿔도 입력한 초대 링크와 닉네임을 유지한다.
  await selectLanguage(page, 'en');
  await expect(page.getByRole('heading', { name: 'Join with an invite link', exact: true })).toBeVisible();
  await expect(page.getByLabel('Invite link', { exact: true })).toHaveValue(link);
  await expect(page).toHaveTitle('Our Pets');
  await page.getByRole('button', { name: 'Join room', exact: true }).click();
  await page.getByLabel('Nickname', { exact: true }).fill('고양이');
  await selectLanguage(page, 'ko');
  await expect(page.getByRole('heading', { name: '친구의 방에 참여하기', exact: true })).toBeVisible();
  await expect(page.getByLabel('닉네임', { exact: true })).toHaveValue('고양이');

  // 3. 명시적 선택은 새로고침 뒤에도 유지한다.
  await selectLanguage(page, 'en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
  await selectLanguage(page, 'ko');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expectSelectedLanguage(page, 'ko');
  expect(failures).toEqual([]);
});

test('계정·펫·알림 화면과 원문 안내를 영어로 표시하고 입력값을 보존한다', async ({ page, isolatedServer }) => {
  await register(page, isolatedServer);
  await page.getByLabel('닉네임', { exact: true }).fill('메시지');
  await selectLanguage(page, 'en');
  await expect(page.getByRole('heading', { name: 'Account information', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('메시지');
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
  await selectLanguage(page, 'en');
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
      await expectSelectedLanguage(page, expected);
      await expect(page.getByRole('heading', { name: expected === 'ko' ? '우리 펫 시작하기' : 'Get started with Our Pets', exact: true })).toBeVisible();
    });
  });
}
