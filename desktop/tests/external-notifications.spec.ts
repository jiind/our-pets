import { expect, test } from '@playwright/test';

test('말풍선은 내용만큼 늘어나고 화면을 넘는 본문만 스크롤 없이 나눈다', async ({ page, request }) => {
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
    mockIPC((cmd: string) => {
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
      const notification = { schemaVersion: 1, eventId: eventID, sourceKind: 'docker', connectionId: 'fixture-docker', occurredAt: now, title: 'Docker · example-background-worker-container', body };
      (window as unknown as { pendingBubbleNotifications: unknown[] }).pendingBubbleNotifications.push({ id: eventID, type: 'notification', kind: 'external', body: '', local: true, createdAt: now, expiresAt: now + 15000, notification });
    }, { id, body });
    return body;
  }

  try {
    const bubble = page.getByRole('article', { name: '현재 도착한 소식', exact: true });
    await sendNotification('짧은 알림', 0);
    await expect(bubble).toContainText('짧은 알림');
    await expect(bubble.locator('.bubble-pages')).toBeHidden();
    const shortHeight = await bubble.evaluate((element: HTMLElement) => element.offsetHeight);
    await bubble.getByRole('button', { name: '알림 닫기', exact: true }).click();
    await sendNotification('조금 긴 알림', 3);
    await expect(bubble).toContainText('조금 긴 알림');
    expect(await bubble.evaluate((element: HTMLElement) => element.offsetHeight)).toBeGreaterThan(shortHeight);
    await expect(bubble.locator('.bubble-pages')).toBeHidden();
    await bubble.screenshot({ path: '/tmp/our-pets-bubble-natural-height.png' });
    await bubble.getByRole('button', { name: '알림 닫기', exact: true }).click();

    const fullText = await sendNotification('bubble-first');
    await expect(bubble).toContainText('bubble-first');
    const layout = await bubble.evaluate(element => ({
      overflow: getComputedStyle(element).overflowY,
      corners: [getComputedStyle(element).borderTopLeftRadius, getComputedStyle(element).borderTopRightRadius, getComputedStyle(element).borderBottomRightRadius, getComputedStyle(element).borderBottomLeftRadius],
      tail: getComputedStyle(element, '::after').content,
      hasContent: !!element.querySelector('.pet-bubble-content'),
    }));
    await bubble.screenshot({ path: '/tmp/our-pets-bubble-pages.png' });
    expect(layout.overflow).toBe('visible');
    expect(layout.corners).toEqual(['12px', '12px', '12px', '12px']);
    expect(layout.tail).toBe('""');
    expect(layout.hasContent).toBe(true);

    // 2. 스크롤 없이 화면 높이에 들어가며 제목·닫기·페이지 버튼을 유지한다.
    const content = bubble.locator('.pet-bubble-content');
    const header = bubble.locator('.bubble-heading');
    const headerTop = await header.evaluate((element: HTMLElement) => element.offsetTop);
    await expect(bubble.locator('img,canvas')).toHaveCount(0);
    expect(await content.evaluate(element => getComputedStyle(element).overflowY)).toBe('visible');
    await expect(bubble.getByRole('button', { name: '이전 내용', exact: true })).toBeDisabled();
    const next = bubble.getByRole('button', { name: '다음 내용', exact: true });
    await expect(next).toBeEnabled();
    const paragraph = content.locator('p:not(.bubble-state)');
    const firstPage = await paragraph.textContent();
    await content.hover();
    await page.mouse.wheel(0, 1800);
    expect(await content.evaluate(element => element.scrollTop)).toBe(0);
    expect(await bubble.evaluate(element => element.scrollTop)).toBe(0);
    expect(await header.evaluate((element: HTMLElement) => element.offsetTop)).toBe(headerTop);
    await expect(bubble.getByRole('button', { name: '알림 닫기', exact: true })).toBeInViewport();
    let combined = firstPage || '';
    for (let index = 0; index < 20 && await next.isEnabled(); index += 1) {
      await next.click();
      combined += await paragraph.textContent();
      const size = await bubble.evaluate(element => ({ height: (element as HTMLElement).offsetHeight, available: parseFloat((element.parentElement as HTMLElement).style.getPropertyValue('--pet-overlay-space')) }));
      expect(size.height).toBeLessThanOrEqual(size.available);
      await expect(bubble).toBeInViewport({ ratio: 1 });
    }
    expect(combined).toBe(fullText);
    await expect(next).toBeDisabled();
    await bubble.getByRole('button', { name: '이전 내용', exact: true }).click();
    await expect(next).toBeEnabled();

    // 3. 다음 외부 알림은 이전 페이지를 이어받지 않고 처음부터 표시한다.
    await bubble.getByRole('button', { name: '알림 닫기', exact: true }).click();
    await expect(bubble).toBeHidden();
    await sendNotification('bubble-second');
    await expect(bubble).toContainText('bubble-second');
    await expect(bubble.getByRole('button', { name: '이전 내용', exact: true })).toBeDisabled();
    expect(await content.evaluate(element => element.scrollTop)).toBe(0);
    await page.locator('#external-bubble-fixture').evaluate(element => element.style.height = '400px');
    await expect.poll(() => bubble.evaluate(element => (element as HTMLElement).offsetHeight <= parseFloat((element.parentElement as HTMLElement).style.getPropertyValue('--pet-overlay-space')))).toBe(true);
    await expect(bubble).toBeInViewport({ ratio: 1 });
    await expect(bubble).toContainText('bubble-second');
  } finally {
    await page.evaluate(() => (window as unknown as { disposeBubbleFixture(): void }).disposeBubbleFixture());
  }
});

test('작은 머리 위 공간·화면 크기 변경·구형 분할기에서도 긴 말풍선의 위치와 결합 이모지를 보존한다', async ({ page }) => {
  // 1. 실제 말풍선 컴포넌트를 긴 제목·답장 버튼과 함께 배치하고 호환 분할 경로를 사용한다.
  await page.goto('/');
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 제공하는 실제 말풍선 모듈이다.
    const { mountBubblePages } = await import('/src/pet-bubble.ts');
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    const stage = document.createElement('section');
    stage.style.cssText = 'position:relative;width:360px;height:400px';
    stage.innerHTML = '<article id="boundary-bubble" class="pet-bubble" data-hit><div class="bubble-heading"><div class="bubble-sender"><span class="bubble-sender-name"></span></div></div><div class="pet-bubble-content"><p data-body></p><p class="bubble-state"></p><div class="bubble-actions"><button>답장하기</button></div></div></article>';
    document.body.replaceChildren(stage);
    const bubble = stage.querySelector<HTMLElement>('article')!;
    bubble.querySelector('.bubble-sender-name')!.textContent = '긴 제목 '.repeat(40);
    const pager = mountBubblePages(bubble);
    pager.setText('A👩‍💻B👍🏽C🇰🇷 '.repeat(250));
    bubble.style.bottom = '52px';
    pager.fit(340, 380);
    Object.assign(window, { boundaryPager: pager });
  });
  const bubble = page.locator('#boundary-bubble');
  const body = bubble.locator('[data-body]');
  await bubble.getByRole('button', { name: '다음 내용', exact: true }).click();
  const reading = (await body.textContent())!.slice(0, 10);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#boundary-bubble')!.style.bottom = '72px';
    (window as unknown as { boundaryPager: { fit(available: number, maximum: number): void } }).boundaryPager.fit(320, 380);
  });
  expect((await body.textContent())!.startsWith(reading)).toBe(true);
  await expect(bubble.getByRole('button', { name: '이전 내용', exact: true })).toBeEnabled();
  const remainder = (await body.textContent())!.replaceAll('👩‍💻', '').replaceAll('👍🏽', '').replaceAll('🇰🇷', '');
  expect(remainder).not.toMatch(/[👩💻👍🏽🇰🇷\u200d]/u);

  // 2. 위 공간이 0 또는 음수여도 필요한 만큼 아래로 이동해 화면 안에 머문다.
  for (const available of [0, -20]) {
    await page.evaluate(value => {
      document.querySelector<HTMLElement>('#boundary-bubble')!.style.bottom = `${392 - value}px`;
      (window as unknown as { boundaryPager: { fit(available: number, maximum: number): void } }).boundaryPager.fit(value, 380);
    }, available);
    await expect(bubble).toBeInViewport({ ratio: 1 });
    expect((await body.textContent())!.startsWith(reading)).toBe(true);
  }

  // 3. 조작 영역조차 못 담는 화면은 클릭을 가로채지 않고 공간이 돌아오면 다시 표시한다.
  await page.evaluate(() => (window as unknown as { boundaryPager: { fit(available: number, maximum: number): void } }).boundaryPager.fit(0, 80));
  await expect(bubble).toBeHidden();
  expect(await bubble.getAttribute('data-hit')).toBeNull();
  await page.evaluate(() => (window as unknown as { boundaryPager: { fit(available: number, maximum: number): void } }).boundaryPager.fit(-20, 380));
  await expect(bubble).toBeVisible();
  await expect(bubble).toBeInViewport({ ratio: 1 });
});
