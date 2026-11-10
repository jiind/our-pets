import { expect, test } from '@playwright/test';

test('외부 알림 말풍선은 본문만 스크롤하고 테두리·제목·닫기를 유지한다', async ({ page, request }) => {
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
  async function sendNotification(id: string): Promise<void> {
    await page.evaluate(eventID => {
      const now = Date.now();
      const notification = { schemaVersion: 1, eventId: eventID, sourceKind: 'docker', connectionId: 'fixture-docker', occurredAt: now, title: 'Docker · example-background-worker-container', body: `${eventID}\n${Array.from({ length: 40 }, (_, index) => `상태 변경 ${index + 1}: 컨테이너 종료 이벤트 상세 내용입니다.`).join('\n')}` };
      (window as unknown as { pendingBubbleNotifications: unknown[] }).pendingBubbleNotifications.push({ id: eventID, type: 'notification', kind: 'external', body: '', local: true, createdAt: now, expiresAt: now + 15000, notification });
    }, id);
  }

  try {
    await sendNotification('bubble-first');
    const bubble = page.getByRole('article', { name: '현재 도착한 소식', exact: true });
    await expect(bubble).toContainText('bubble-first');
    const layout = await bubble.evaluate(element => ({
      overflow: getComputedStyle(element).overflowY,
      corners: [getComputedStyle(element).borderTopLeftRadius, getComputedStyle(element).borderTopRightRadius, getComputedStyle(element).borderBottomRightRadius, getComputedStyle(element).borderBottomLeftRadius],
      tail: getComputedStyle(element, '::after').content,
      hasContent: !!element.querySelector('.pet-bubble-content'),
    }));
    await bubble.screenshot({ path: `/tmp/our-pets-external-bubble-${layout.hasContent ? 'after' : 'before'}.png` });
    expect(layout.overflow).toBe('visible');
    expect(layout.corners).toEqual(['12px', '12px', '12px', '12px']);
    expect(layout.tail).toBe('""');
    expect(layout.hasContent).toBe(true);

    // 2. 스크롤바는 바깥 모서리 안쪽에 있고 제목·닫기 버튼은 함께 밀리지 않는다.
    const content = bubble.locator('.pet-bubble-content');
    const header = bubble.locator('.bubble-heading');
    const headerTop = await header.evaluate((element: HTMLElement) => element.offsetTop);
    await expect(bubble.locator('img,canvas')).toHaveCount(0);
    const bubbleBounds = await bubble.boundingBox();
    const contentBounds = await content.boundingBox();
    expect(bubbleBounds!.x + bubbleBounds!.width - contentBounds!.x - contentBounds!.width).toBeGreaterThanOrEqual(12);
    expect(await content.evaluate(element => getComputedStyle(element).scrollbarColor)).not.toBe('auto');
    await content.hover();
    await page.mouse.wheel(0, 1800);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await bubble.evaluate(element => element.scrollTop)).toBe(0);
    expect(await header.evaluate((element: HTMLElement) => element.offsetTop)).toBe(headerTop);
    await expect(bubble.getByRole('button', { name: '알림 닫기', exact: true })).toBeInViewport();
    await bubble.screenshot({ path: '/tmp/our-pets-external-bubble-scrolled.png' });

    // 3. 다음 외부 알림은 이전의 스크롤 위치를 이어받지 않고 처음부터 표시한다.
    await bubble.getByRole('button', { name: '알림 닫기', exact: true }).click();
    await expect(bubble).toBeHidden();
    await sendNotification('bubble-second');
    await expect(bubble).toContainText('bubble-second');
    expect(await content.evaluate(element => element.scrollTop)).toBe(0);
  } finally {
    await page.evaluate(() => (window as unknown as { disposeBubbleFixture(): void }).disposeBubbleFixture());
  }
});
