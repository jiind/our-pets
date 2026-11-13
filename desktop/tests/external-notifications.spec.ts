import { expect, test } from '@playwright/test';

test('말풍선은 고정 폭·최대 높이와 본문 스크롤·자동 닫힘·등퇴장 효과를 제공한다', async ({ page, request }) => {
  await page.clock.install();
  // 1. 격리 서버에 등록하고 실제 펫 화면에 Docker 수신 IPC 경계만 모의한다.
  const response = await request.post('http://127.0.0.1:19377/api/v1/register', { data: { username: `bubble-${Date.now()}`, password: 'test-password-123', displayName: '말풍선 테스트', invite: 'test-only-invite' } });
  expect(response.ok()).toBe(true);
  const login = await response.json();
  const registration = await request.post('http://127.0.0.1:19377/api/v1/me/pet/registration', { headers: { Authorization: `Bearer ${login.token}` }, data: { designId: 'default' } });
  expect(registration.ok()).toBe(true);
  await page.goto('/');
  await page.evaluate(async value => {
    localStorage.setItem('ourpets.server', 'http://127.0.0.1:19377');
    localStorage.setItem('ourpets.session', JSON.stringify({ ...value, principal: { ...value.principal, petRegistered: true } }));
    // @ts-expect-error Vite가 제공하는 공식 Tauri IPC 모의 모듈이다.
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js');
    // @ts-expect-error Vite가 제공하는 실제 데스크톱 펫 모듈이다.
    const { mountPet } = await import('/src/pet.ts');
    const pending: Record<string, unknown>[] = [];
    const root = document.createElement('div');
    root.id = 'external-bubble-fixture';
    root.style.height = '560px';
    document.body.replaceChildren(root);
    mockWindows('pet');
    Object.assign(window, { isTauri: true });
    let listener = 0;
    const systemCalls: Record<string, unknown>[] = [];
    Object.assign(window, { bubbleSystemCalls: systemCalls });
    mockIPC((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'plugin:event|listen') {
        return ++listener;
      }
      if (cmd === 'desktop_state') {
        return { visible: true, showOthers: true, petSize: 160 };
      }
      if (cmd === 'pet_work_area') {
        return { width: 360, height: 560, overlayTop: 0 };
      }
      if (cmd === 'local_notifications') {
        return root.hidden ? [] : pending.splice(0);
      }
      if (cmd === 'show_system_notification') {
        systemCalls.push(args);
        return true;
      }
      return undefined;
    });
    Object.assign(window, { pendingBubbleNotifications: pending, disposeBubbleFixture: await mountPet(root) });
  }, login);

  // 로컬 큐를 통해 실제 수신·본문 구성·표시 경로로 긴 외부 알림을 전달한다.
  async function sendNotification(id: string, lines = 40): Promise<string> {
    const body = `${id}${lines ? '\n' : ''}${Array.from({ length: lines }, (_, index) => `상태 변경 ${index + 1}: 컨테이너 종료 이벤트 상세 내용입니다. 👩‍💻`).join('\n')}`;
    await page.evaluate(({ id: eventID, body }) => {
      const now = Date.now();
      const notification = { schemaVersion: 1, eventId: eventID, sourceKind: 'docker', connectionId: 'fixture-docker', connectionName: '개발 엔진', occurredAt: now, title: 'Docker · example-background-worker-container', body };
      (window as unknown as { pendingBubbleNotifications: unknown[] }).pendingBubbleNotifications.push({ id: eventID, type: 'notification', kind: 'external', body: '', local: true, createdAt: now, expiresAt: now + 15000, notification });
    }, { id, body });
    return body;
  }

  try {
    // 1. 짧은 알림은 자연 높이를 쓰며 공통 제목과 빨간 X를 표시한다.
    const bubble = page.getByRole('article', { name: '현재 도착한 소식', exact: true });
    const body = bubble.getByRole('region', { name: '알림 내용', exact: true });
    await sendNotification('짧은 알림', 0);
    await expect(bubble).toContainText('짧은 알림');
    await expect(bubble.locator('.bubble-sender')).toHaveText('Docker · 개발 엔진 · example-background-worker-container');
    const close = bubble.getByRole('button', { name: '알림 닫기', exact: true });
    expect(await close.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderStyle, color: style.color, width: element.getBoundingClientRect().width };
    })).toEqual({ background: 'rgba(0, 0, 0, 0)', border: 'none', color: 'rgb(156, 52, 44)', width: 32 });
    expect(await bubble.evaluate(element => element.getBoundingClientRect().width)).toBe(320);
    const shortHeight = await bubble.evaluate(element => element.getBoundingClientRect().height);
    expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { bubbleSystemCalls: Record<string, unknown>[] }).bubbleSystemCalls)).toContainEqual(expect.objectContaining({ title: 'Docker · 개발 엔진 · example-background-worker-container', body: '짧은 알림' }));
    await bubble.screenshot({ path: '/tmp/our-pets-external-notification-title-close.png' });
    await close.click();
    await sendNotification('조금 긴 알림', 3);
    await expect(bubble).toContainText('조금 긴 알림');
    expect(await bubble.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(shortHeight);
    expect(await bubble.evaluate(element => element.getBoundingClientRect().width)).toBe(320);
    await close.click();

    // 2. 최대 높이를 넘으면 본문만 실제 휠로 스크롤하고 제목·닫기 위치와 테두리를 보존한다.
    const fullText = await sendNotification('bubble-first');
    await expect(body).toHaveText(fullText);
    await expect.poll(() => body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await bubble.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320);
    await expect(bubble.locator('.bubble-pages')).toHaveCount(0);
    const header = bubble.locator('.bubble-heading');
    const headerTop = (await header.boundingBox())!.y;
    const closeTop = (await close.boundingBox())!.y;
    await body.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    expect((await close.boundingBox())!.y).toBeCloseTo(closeTop, 0);
    expect(await bubble.evaluate(element => element.scrollTop)).toBe(0);
    expect(await bubble.evaluate(element => [getComputedStyle(element).borderTopLeftRadius, getComputedStyle(element).borderTopRightRadius, getComputedStyle(element).borderBottomRightRadius, getComputedStyle(element).borderBottomLeftRadius])).toEqual(['12px', '12px', '12px', '12px']);
    await bubble.screenshot({ path: '/tmp/our-pets-bubble-bounded-scroll.png' });
    await body.focus();
    await page.keyboard.press('End');
    await expect.poll(() => body.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
    await expect(body).toHaveText(fullText);

    // 3. 다음 알림은 맨 위에서 시작하고 좁은 화면에서도 모든 문자를 보존한다.
    await close.click();
    const secondText = await sendNotification('bubble-second');
    await expect(body).toHaveText(secondText);
    expect(await body.evaluate(element => element.scrollTop)).toBe(0);
    await page.locator('#external-bubble-fixture').evaluate(element => element.style.height = '400px');
    await expect(bubble).toBeInViewport({ ratio: 1 });
    expect(await bubble.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320);
    await expect(body).toHaveText(secondText);

    // 4. 실제 시간 제어로 hover 중 자동 만료와 짧은 퇴장 효과·모션 줄이기를 검증한다.
    await close.click();
    await expect(bubble).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await sendNotification('자동으로 닫힐 알림', 0);
    await page.clock.runFor(2500);
    await expect(bubble).toBeVisible();
    await bubble.hover();
    await page.clock.runFor(9500);
    await expect(bubble).toBeVisible();
    await page.clock.runFor(3500);
    await expect(bubble).toBeHidden();
    await sendNotification('닫기 애니메이션', 0);
    await page.clock.runFor(2500);
    await expect(bubble).toBeVisible();
    await close.evaluate(element => (element as HTMLButtonElement).click());
    await expect(bubble).toBeVisible();
    await page.clock.runFor(80);
    const opacity = await bubble.evaluate(element => parseFloat(getComputedStyle(element).opacity));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    await page.clock.runFor(160);
    await expect(bubble).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sendNotification('모션 줄이기', 0);
    await page.clock.runFor(2500);
    await expect(bubble).toBeVisible();
    await close.evaluate(element => (element as HTMLButtonElement).click());
    await expect(bubble).toBeHidden();
  } finally {
    await page.evaluate(() => (window as unknown as { disposeBubbleFixture(): void }).disposeBubbleFixture());
  }
});

test('작은 머리 위 공간과 화면 변경에서 스크롤·조작 영역·이모지 원문을 보존한다', async ({ page }) => {
  // 1. 실제 말풍선에 긴 제목과 답장 버튼을 넣고 전체 원문을 스크롤한다.
  await page.goto('/');
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 제공하는 실제 말풍선 모듈이다.
    const { mountBubbleLayout } = await import('/src/pet-bubble.ts');
    const stage = document.createElement('section');
    stage.style.cssText = 'position:relative;width:360px;height:400px';
    stage.innerHTML = '<article id="boundary-bubble" class="pet-bubble" data-hit><div class="bubble-heading"><div class="bubble-sender"><span class="bubble-sender-name"></span></div></div><div class="pet-bubble-content"><p data-body></p><p class="bubble-state"></p><div class="bubble-actions"><button>답장하기</button></div></div></article>';
    document.body.replaceChildren(stage);
    const bubble = stage.querySelector<HTMLElement>('article')!;
    bubble.querySelector('.bubble-sender-name')!.textContent = '긴 제목 '.repeat(40);
    const layout = mountBubbleLayout(bubble);
    layout.setText('A👩‍💻B👍🏽C🇰🇷 '.repeat(250));
    bubble.style.bottom = '52px';
    layout.fit(340, 380);
    Object.assign(window, { boundaryLayout: layout });
  });
  const bubble = page.locator('#boundary-bubble');
  const body = bubble.getByRole('region', { name: '알림 내용', exact: true });
  const original = 'A👩‍💻B👍🏽C🇰🇷 '.repeat(250);
  await expect(body).toHaveText(original);
  await body.hover();
  await page.mouse.wheel(0, 180);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const scrollTop = await body.evaluate(element => element.scrollTop);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#boundary-bubble')!.style.bottom = '72px';
    (window as unknown as { boundaryLayout: { fit(available: number, maximum: number): void } }).boundaryLayout.fit(320, 380);
  });
  expect(await body.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);

  // 2. 머리 위 공간이 없어도 화면 안으로 옮기고 원문·답장 버튼을 유지한다.
  for (const available of [0, -20]) {
    await page.evaluate(value => {
      document.querySelector<HTMLElement>('#boundary-bubble')!.style.bottom = `${392 - value}px`;
      (window as unknown as { boundaryLayout: { fit(available: number, maximum: number): void } }).boundaryLayout.fit(value, 380);
    }, available);
    await expect(bubble).toBeInViewport({ ratio: 1 });
    await expect(bubble.getByRole('button', { name: '답장하기', exact: true })).toBeInViewport();
    await expect(body).toHaveText(original);
  }

  // 3. 조작 영역조차 담을 수 없으면 입력을 통과시키고 공간 회복 시 다시 표시한다.
  await page.evaluate(() => (window as unknown as { boundaryLayout: { fit(available: number, maximum: number): void } }).boundaryLayout.fit(0, 80));
  await expect(bubble).toBeHidden();
  expect(await bubble.getAttribute('data-hit')).toBeNull();
  await page.evaluate(() => (window as unknown as { boundaryLayout: { fit(available: number, maximum: number): void } }).boundaryLayout.fit(-20, 380));
  await expect(bubble).toBeVisible();
  await expect(bubble).toBeInViewport({ ratio: 1 });
  await expect(body).toHaveText(original);
});
