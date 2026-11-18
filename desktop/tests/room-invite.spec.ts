import { expect } from '@playwright/test';
import { test } from './isolated-server';

test('초대 링크만 입력해 계정을 만들고 다시 로그인한다', async ({ page, isolatedServer }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '서버 주소' })).toHaveCount(0);
  await page.getByRole('button', { name: '초대 링크로 참여하기' }).click();
  const link = page.getByLabel('초대 링크', { exact: true });
  const params = new URLSearchParams({ server: isolatedServer, invite: 'test-only-invite' });
  await link.fill('https://example.com/');
  await page.getByRole('button', { name: '방 참여' }).click();
  await expect(page.locator('#notice')).toHaveText('우리 펫 초대 링크를 확인해 주세요.');
  await link.fill(`ourpets://join?${params}`);
  await page.getByRole('button', { name: '방 참여' }).click();
  await expect(page.getByRole('heading', { name: '우리 펫에 합류하기' })).toBeVisible();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);

  await page.getByLabel('닉네임').fill('초대받은 친구');
  await page.getByLabel('아이디', { exact: true }).fill('invited-friend');
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: '계정 만들고 펫 등록하기' }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '오늘도 만나서 반가워요' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  await page.getByLabel('아이디', { exact: true }).fill('invited-friend');
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: '접속하기' }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-only-invite');
});

test('초대 링크로 앱을 열면 참여를 확인한 뒤에만 서버에 연결한다', async ({ page, isolatedServer }) => {
  const params = new URLSearchParams({ server: isolatedServer, invite: 'test-only-invite' });
  const link = `ourpets://join?${params}`;
  await page.route('**/src/main.ts', async route => {
    const response = await route.fetch();
    const mock = `
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      window.isTauri = true;
      mockIPC(cmd => {
        if (cmd === 'get_locale') return { preference: 'system', locale: 'ko' };
        if (cmd === 'launch_invitation') return ${JSON.stringify(link)};
      }, { shouldMockEvents: true });
    `;
    await route.fulfill({ response, body: mock + await response.text() });
  });
  let connectionChecks = 0;
  page.on('request', request => {
    if (request.url() === `${isolatedServer}/healthz`) {
      connectionChecks++;
    }
  });

  await page.goto('/');
  const invitation = page.getByRole('dialog', { name: '친구의 방에 참여하기' });
  await expect(invitation).toBeVisible();
  expect(connectionChecks).toBe(0);
  await invitation.getByRole('button', { name: '방 참여' }).click();
  await expect(page.getByLabel('닉네임')).toBeVisible();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  expect(connectionChecks).toBe(1);
});

test('호스트가 앱에서 시작하고 친구에게 보낼 링크를 복사한다', async ({ page, context, isolatedServer }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.evaluate(async localUrl => {
    // @ts-expect-error Vite가 공식 Tauri 테스트 모듈을 제공한다.
    const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js');
    Object.assign(window, { isTauri: true });
    mockIPC((cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'start_host') {
        return { url: 'http://192.168.1.10:19378', localUrl, invite: 'test-only-invite' };
      }
      if (cmd === 'plugin:event|listen') {
        return args.handler;
      }
      return undefined;
    });
  }, isolatedServer);

  await page.getByRole('button', { name: '친구 초대하기' }).click();
  await expect(page.getByRole('heading', { name: '우리 펫에 합류하기' })).toBeVisible();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  await page.getByRole('button', { name: '초대 링크 복사' }).click();
  await expect(page.locator('#notice')).toHaveText('초대 링크를 복사했어요.');
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.protocol).toBe('ourpets:');
  expect(copied.searchParams.get('server')).toBe('http://192.168.1.10:19378');
  expect(copied.searchParams.get('invite')).toBe('test-only-invite');
});
