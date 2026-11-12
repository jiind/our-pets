import { expect, test } from '@playwright/test';

test('윗행 펫의 메뉴와 입력은 이동 직후 가시 영역 안에 남는다 · IPC 좌표 계약', async ({ page }) => {
  // 1. 실제 펫 모듈에 화면 밖 창 좌표만 공식 IPC 모의로 제공한다.
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('requestfailed', request => errors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`));
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 제공하는 공식 Tauri 테스트 모듈이다.
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js');
    // @ts-expect-error Vite가 제공하는 공식 이벤트 모듈이다.
    const { emit } = await import('/node_modules/@tauri-apps/api/event.js');
    // @ts-expect-error Vite가 제공하는 실제 펫 모듈이다.
    const { mountPet } = await import('/src/pet.ts');
    mockWindows(`peer-${'b'.repeat(32)}`);
    Object.assign(window, { isTauri: true });
    let inset = 0;
    let holdArea = false;
    let releaseArea = (): void => undefined;
    mockIPC((command: string) => {
      if (command === 'desktop_state') {
        return { visible: true, showOthers: true, petSize: 160 };
      }
      if (command === 'pet_work_area') {
        const area = { width: 1440, height: 1000, scaleFactor: 1, workTop: 0, overlayTop: inset };
        if (holdArea) {
          holdArea = false;
          Object.assign(window, { guardPending: true });
          return new Promise(resolve => {
            releaseArea = () => resolve(area);
          });
        }
        return area;
      }
      if (command === 'local_notifications') {
        return [];
      }
      return undefined;
    }, { shouldMockEvents: true });
    const root = document.createElement('div');
    root.id = 'upper-row-fixture';
    root.style.cssText = 'position:fixed;top:0;left:0;width:360px;height:1000px';
    document.body.replaceChildren(root);
    const dispose = await mountPet(root, false, 'b'.repeat(32));
    Object.assign(window, {
      moveRow: async (y: number) => {
        inset = Math.max(0, -y);
        await emit('tauri://move', { x: 0, y });
      },
      disposeRow: dispose,
      holdNextArea: (y: number) => {
        inset = Math.max(0, -y);
        holdArea = true;
        Object.assign(window, { guardPending: false });
      },
      releaseArea: () => releaseArea(),
    });
  });

  // 2. 실제 메뉴를 연 뒤 창 이동 이벤트만으로 잘린 상단을 즉시 보정한다.
  const fixture = page.locator('#upper-row-fixture');
  const menu = fixture.locator('.pet-menu');
  await fixture.locator('canvas.pet-canvas').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.evaluate(() => (window as unknown as { moveRow(y: number): Promise<void> }).moveRow(-800));
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThanOrEqual(807);
  const bounds = (await menu.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(989);
  expect(bounds.height).toBeGreaterThanOrEqual(150);

  // 3. 높이를 되돌려도 작성 중인 내용과 포커스는 보존한다.
  const input = menu.getByRole('textbox', { name: '이 친구에게만 보낼 메시지' });
  await input.fill('윗행에서도 입력 유지');
  await page.evaluate(() => (window as unknown as { moveRow(y: number): Promise<void> }).moveRow(0));
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeLessThan(807);
  await expect(input).toHaveValue('윗행에서도 입력 유지');
  await expect(input).toBeFocused();

  // 4. 이동 이벤트를 놓쳐도 좌표 응답 전에는 잘린 첫 메뉴를 노출하지 않는다.
  await menu.getByRole('button', { name: '펫 메뉴 닫기', exact: true }).click();
  await page.evaluate(() => (window as unknown as { holdNextArea(y: number): void }).holdNextArea(-800));
  await fixture.locator('canvas.pet-canvas').click({ button: 'right' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { guardPending: boolean }).guardPending)).toBe(true);
  await expect(menu).toBeHidden();
  await page.evaluate(() => (window as unknown as { releaseArea(): void }).releaseArea());
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThanOrEqual(807);
  await page.evaluate(() => (window as unknown as { disposeRow(): void }).disposeRow());
  expect(errors).toEqual([]);
});
