import { expect } from '@playwright/test';
import { createServer, type AddressInfo } from 'node:net';
import { test } from './isolated-server';
import { testInvitation } from './test-invitation';

test('초대 링크와 닉네임으로 참여하고 저장한 기기로 같은 펫에 다시 접속한다', async ({ page, isolatedServer }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '서버 주소' })).toHaveCount(0);
  await page.getByRole('button', { name: '초대 링크로 참여하기' }).click();
  const link = page.getByLabel('초대 링크', { exact: true });
  await expect(page.locator('#auth input')).toHaveCount(1);
  await expect(page.locator('#auth button')).toHaveCount(1);
  await link.fill('https://example.com/');
  await page.getByRole('button', { name: '방 참여' }).click();
  await expect(page.locator('#notice')).toHaveText('우리 펫 초대 링크를 확인해 주세요.');
  await link.fill(testInvitation(isolatedServer));
  await page.getByRole('button', { name: '방 참여' }).click();
  await expect(page.getByRole('heading', { name: '친구의 방에 참여하기' })).toBeVisible();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  await expect(page.locator('#auth input')).toHaveCount(1);
  await page.getByLabel('닉네임').fill('초대받은 친구');
  await page.getByRole('button', { name: '참여하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '등록 완료' }).click();
  await expect(page.getByRole('button', { name: '등록 완료' })).toBeHidden();
  await page.getByRole('radio', { name: '강아지', exact: true }).check();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.startPet') || 'null')?.builtinId)).toBe('dog');
  const principal = () => page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.session')!).principal);
  const first = await principal();
  await page.evaluate(() => localStorage.removeItem('ourpets.session'));
  await page.reload();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  expect(await principal()).toMatchObject({ userId: first.userId, petId: first.petId, deviceId: first.deviceId });
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '오늘도 만나서 반가워요' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  await expect.poll(() => page.locator('#login-pet canvas').evaluate(async canvas => {
    // @ts-expect-error Vite가 브라우저에 실제 렌더러를 제공한다.
    const { drawPet } = await import('/src/render.ts');
    const actual = canvas as HTMLCanvasElement;
    const expected = document.createElement('canvas');
    expected.width = expected.height = actual.width;
    drawPet(expected, null, null, 'idle', 0, { builtin: 'dog', reduced: true });
    const pixels = expected.getContext('2d')!.getImageData(0, 0, expected.width, expected.height).data;
    return pixels.some(value => value !== 0) && actual.toDataURL() === expected.toDataURL();
  })).toBe(true);
  await page.getByRole('button', { name: '다시 접속' }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  expect(await principal()).toMatchObject({ userId: first.userId, petId: first.petId, deviceId: first.deviceId });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-only-invite');
});

test('기존 계정의 기기 등록 응답을 잃어도 같은 계정에 다시 접속한다', async ({ page, isolatedServer }) => {
  const registration = await page.request.post(`${isolatedServer}/api/v1/register`, {
    data: { username: 'legacy-member', password: 'test-password-123', displayName: '기존 친구', invite: 'test-only-invite' },
  });
  expect(registration.ok()).toBe(true);
  const login = await registration.json();
  await page.addInitScript(({ origin, login }) => {
    if (!localStorage.getItem('ourpets.server')) {
      localStorage.setItem('ourpets.server', origin);
      localStorage.setItem('ourpets.session', JSON.stringify(login));
    }
  }, { origin: isolatedServer, login });

  const keys: string[] = [];
  await page.route(`${isolatedServer}/api/v1/me/device-key`, async route => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    keys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (keys.length === 1) {
      await route.abort();
    } else {
      await route.fulfill({ response });
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.evaluate(() => localStorage.removeItem('ourpets.session'));
  await page.reload();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  const principal = await page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.session')!).principal);
  const { userId, petId, deviceId } = login.principal;
  expect(principal).toMatchObject({ userId, petId, deviceId });
});

test('서버가 닫혀도 첫 화면에서 선택한 PNG 펫을 표시한다', async ({ page, isolatedServer }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '초대 링크로 참여하기' }).click();
  await page.getByLabel('초대 링크', { exact: true }).fill(testInvitation(isolatedServer));
  await page.getByRole('button', { name: '방 참여' }).click();
  await page.getByLabel('닉네임').fill('PNG 첫 화면');
  await page.getByRole('button', { name: '참여하기', exact: true }).click();
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가' });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('분홍 펫');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const graphics = canvas.getContext('2d')!;
    graphics.fillStyle = '#ed219d';
    graphics.fillRect(0, 0, 64, 64);
    return canvas.toDataURL().split(',')[1];
  });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'pink.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('radio', { name: '분홍 펫', exact: true })).toBeChecked();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.startPet') || 'null')?.design?.name)).toBe('분홍 펫');
  const sampleCenter = (canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data);
  const portrait = page.locator('.pet-registration-preview canvas');
  await expect.poll(async () => {
    const [red, green, blue, alpha] = await portrait.evaluate(sampleCenter);
    return red > 180 && green < 80 && blue > 100 && alpha === 255;
  }).toBe(true);
  const onlinePixel = await portrait.evaluate(sampleCenter);
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '다시 접속' })).toBeVisible();
  await page.route(`${isolatedServer}/**`, route => route.abort());
  await page.reload();
  await expect.poll(() => page.locator('#login-pet canvas').evaluate(sampleCenter)).toEqual(onlinePixel);
});

test('초대 링크로 앱을 열면 참여를 확인한 뒤에만 서버에 연결한다', async ({ page, isolatedServer }) => {
  const link = testInvitation(isolatedServer);
  await page.route(/\/src\/main\.ts(?:\?.*)?$/u, async route => {
    const response = await route.fetch();
    const mock = `
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      window.isTauri = true;
      mockIPC(cmd => {
        if (cmd === 'get_locale') return { preference: 'ko', locale: 'ko' };
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

test('설정에서만 외부 접속을 켜고 링크를 복사하며 다시 차단할 수 있다', async ({ page, context, isolatedServer, browserName }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.grantPermissions(browserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write']);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, new URL(isolatedServer).hostname, resolve));
  const { address, port } = reservation.address() as AddressInfo;
  const shareAddress = `http://${address}:${port}`;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const registration = await page.request.post(`${isolatedServer}/api/v1/register`, {
    data: { username: 'local-pet-owner', displayName: '내 펫', password: 'test-password-123', invite: 'test-only-invite' },
  });
  expect(registration.ok()).toBe(true);
  const session = await registration.json();
  const pet = await page.request.post(`${isolatedServer}/api/v1/me/pet/registration`, {
    headers: { Authorization: `Bearer ${session.token}` }, data: { designId: 'default' },
  });
  expect(pet.ok()).toBe(true);
  session.principal.petRegistered = true;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '초대 링크 복사' })).toHaveCount(0);
  await page.evaluate(async ({ localUrl, shareAddress, session }) => {
    // @ts-expect-error Vite가 공식 Tauri 테스트 모듈을 제공한다.
    const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js');
    const commands: string[] = [];
    Object.assign(window, { isTauri: true, hostTestCommands: commands });
    mockIPC((cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'start_local') {
        commands.push(cmd);
        return { localUrl, session };
      }
      if (cmd === 'start_host') {
        commands.push(cmd);
        return { url: shareAddress, localUrl, invite: 'test-only-invite' };
      }
      if (cmd === 'stop_host') {
        commands.push(cmd);
        return;
      }
      if (cmd === 'desktop_state') {
        return { visible: true, showOthers: true, petSize: 160 };
      }
      if (cmd === 'plugin:event|listen') {
        return args.handler;
      }
      return undefined;
    });
  }, { localUrl: isolatedServer, shareAddress, session });

  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '등록 완료', exact: true })).toBeHidden();
  await expect(page.getByLabel('서버 가입 코드')).toHaveCount(0);
  const connectedAddress = page.locator('nav .sidebar-server-address');
  await expect(connectedAddress).toHaveText(isolatedServer);
  await expect(connectedAddress).toHaveAttribute('title', isolatedServer);
  const commands = () => page.evaluate(() => (window as typeof window & { hostTestCommands: string[] }).hostTestCommands);
  expect(await commands()).toEqual(['start_local']);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
  await expect(page.locator('.account-settings h2:visible')).toHaveText(['계정 정보', '서버 정보', '정보 및 고지']);
  const server = page.getByRole('region', { name: '서버 정보' });
  const copy = server.getByRole('button', { name: '초대 링크 복사' });
  await expect(server).toContainText(isolatedServer);
  await expect(copy).toBeDisabled();
  await server.getByRole('button', { name: '외부 접속 허용' }).click();
  await expect(server).toContainText(shareAddress);
  await expect(connectedAddress).toHaveText(shareAddress);
  await expect(connectedAddress).toHaveAttribute('title', shareAddress);
  await expect(server.getByRole('button')).toHaveText(['외부 접속 차단', '초대 링크 복사']);
  await copy.click();
  await expect(server.getByRole('status')).toHaveText('초대 링크를 복사했어요.');
  expect(await commands()).toEqual(['start_local', 'start_host']);
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.protocol).toBe('ourpets:');
  expect(copied.searchParams.get('server')).toBe(shareAddress);
  expect(copied.searchParams.get('invite')).toBe('test-only-invite');
  await server.getByRole('button', { name: '외부 접속 차단' }).click();
  await expect(copy).toBeDisabled();
  await expect(server).toContainText(isolatedServer);
  await expect(connectedAddress).toHaveText(isolatedServer);
  await expect(connectedAddress).toHaveAttribute('title', isolatedServer);
  await expect(server.getByRole('button', { name: '외부 접속 허용' })).toBeEnabled();
  expect(await commands()).toEqual(['start_local', 'start_host', 'stop_host']);
  expect(await page.evaluate(() => localStorage.getItem('ourpets.sharingPaused'))).toBe('true');
  await page.getByRole('button', { name: '펫', exact: true }).click();
  await expect(page.locator('.pet-registration-preview [data-preview-name]')).toHaveText('내 펫');
  expect(errors).toEqual([]);
});
