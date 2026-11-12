import { expect } from '@playwright/test';
import { test } from './isolated-server';

for (const initialVisible of [true, false]) {
  test(`로그아웃·재로그인 시 펫 표시 ${initialVisible} 보존 · IPC 계약`, async ({ page, isolatedServer }) => {
    // 1. 실제 가입 및 대표 펫 등록을 마치고 표시 설정만 Tauri 공식 IPC로 모의한다.
    const username = `logout-${initialVisible}-${Date.now()}`;
    await page.goto('/');
    await page.getByLabel('서버 주소').fill(isolatedServer);
    await page.getByRole('button', { name: '서버 연결', exact: true }).click();
    await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
    await page.getByLabel('닉네임').fill('표시 설정 테스트');
    await page.getByLabel('아이디', { exact: true }).fill(username);
    await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
    await page.getByLabel('서버 가입 코드').fill('test-only-invite');
    await page.getByRole('button', { name: '계정 만들고 펫 등록하기' }).click();
    await page.getByRole('button', { name: '등록 완료', exact: true }).click();
    await expect(page.getByRole('button', { name: '펫 숨기기', exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      // @ts-expect-error Vite가 공식 Tauri 테스트 모듈을 제공한다.
      const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js');
      const preferences = { visible: true, showOthers: true, petSize: 160 };
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      Object.assign(window, { isTauri: true, logoutTest: { preferences, calls } });
      mockIPC((cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') {
          return args.handler;
        }
        if (cmd.startsWith('plugin:event|')) {
          return undefined;
        }
        if (cmd === 'desktop_state') {
          return { ...preferences };
        }
        if (cmd === 'set_desktop_preferences') {
          if (typeof args.visible === 'boolean') {
            preferences.visible = args.visible;
          }
          if (typeof args.showOthers === 'boolean') {
            preferences.showOthers = args.showOthers;
          }
          if (typeof args.petSize === 'number') {
            preferences.petSize = args.petSize;
          }
          return undefined;
        }
        if (cmd === 'pet_control') {
          if (args.action === 'hide') {
            preferences.visible = false;
          } else if (args.action === 'show') {
            preferences.visible = true;
          }
          return undefined;
        }
        if (cmd === 'set_pet_registered') {
          return undefined;
        }
        throw new Error(`예상하지 않은 IPC: ${cmd}`);
      });
    });
    if (!initialVisible) {
      await page.getByRole('button', { name: '펫 숨기기', exact: true }).click();
      await expect(page.getByRole('button', { name: '펫 표시', exact: true })).toBeVisible();
    }

    // 2. 사용자 조작으로 로그아웃하고 등록 해제는 요청하되 표시 설정은 유지한다.
    await page.evaluate(() => {
      (window as unknown as { logoutTest: { calls: unknown[] } }).logoutTest.calls.length = 0;
    });
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page.getByRole('button', { name: /접속하기/ })).toBeVisible();
    const afterLogout = await page.evaluate(() => (window as unknown as {
      logoutTest: { preferences: { visible: boolean }; calls: { cmd: string; args: { action?: string; registered?: boolean } }[] };
    }).logoutTest);
    expect(afterLogout.preferences.visible).toBe(initialVisible);
    expect(afterLogout.calls.some(call => call.cmd === 'set_pet_registered' && call.args.registered === false)).toBe(true);
    expect(afterLogout.calls.some(call => call.cmd === 'pet_control' && call.args.action === 'hide')).toBe(false);

    // 3. 실제 로그인 요청 후에도 같은 표시 상태와 버튼을 유지한다.
    await page.getByLabel('아이디', { exact: true }).fill(username);
    await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: /접속하기/ }).click();
    await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: initialVisible ? '펫 숨기기' : '펫 표시', exact: true })).toBeEnabled();
    const afterLogin = await page.evaluate(() => (window as unknown as {
      logoutTest: { preferences: { visible: boolean }; calls: { cmd: string; args: { action?: string } }[] };
    }).logoutTest);
    expect(afterLogin.preferences.visible).toBe(initialVisible);
    expect(afterLogin.calls.some(call => call.cmd === 'pet_control' && call.args.action === 'restore')).toBe(true);
  });
}
