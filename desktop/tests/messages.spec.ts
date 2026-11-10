import { test, expect, type Page } from '@playwright/test';

const server = 'http://127.0.0.1:19377';

// 준비한 계정에 실제 서버 연결·로그인 UI로 접속한 뒤 WebSocket 펫 화면을 연다.
async function openPet(page: Page, username: string): Promise<void> {
  // 1. 세션을 주입하지 않고 로그인 폼을 통해 인증한다.
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill(server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: /접속하기/ }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();

  // 2. 실제 WebSocket 준비를 기다리며 네이티브의 창별 라우팅과는 구분한다.
  await page.goto('/?pet');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.connection') || 'null')?.state)).toBe('연결됨');
}

test('실제 메시지·이모지·답장 대상과 마릿수 없는 전송 확인', async ({ browser, request }) => {
  // 1. 계정 생성만 API로 준비하고 두 브라우저의 로그인·전송·답장은 UI로 수행한다.
  const suffix = Date.now();
  const fixtures: { username: string; petId: string }[] = [];
  for (const role of ['a', 'b']) {
    const username = `msg-${role}-${suffix}`;
    const registered = await request.post(`${server}/api/v1/register`, { data: { username, password: 'test-password-123', displayName: `메시지 ${role.toUpperCase()}`, invite: 'test-only-invite' } });
    expect(registered.ok()).toBe(true);
    const login = await registered.json();
    const pet = await request.post(`${server}/api/v1/me/pet/registration`, { headers: { Authorization: `Bearer ${login.token}` }, data: { designId: 'default' } });
    expect(pet.ok()).toBe(true);
    fixtures.push({ username, petId: login.principal.petId });
  }
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await openPet(a, fixtures[0].username);
    await openPet(b, fixtures[1].username);

    // 2. 내 펫의 하단 입력은 접속한 친구 모두에게 이모지를 포함한 텍스트를 보낸다.
    await a.getByRole('button', { name: '메시지 A 동작 메뉴 · 오른쪽 클릭 또는 Enter' }).click({ button: 'right' });
    await expect(a.getByRole('button', { name: '👋 인사하기', exact: true })).toBeHidden();
    await a.getByRole('textbox', { name: '전체 펫에게 보낼 메시지' }).fill('같이 이야기해요 👋');
    await a.getByRole('button', { name: '전송', exact: true }).click();
    const sent = a.getByRole('article', { name: '현재 도착한 소식' });
    await expect(sent.locator('.bubble-sender')).toHaveText('모두에게 보낸 메시지');
    await expect(sent).not.toContainText(/\d+마리/);
    const received = b.getByRole('article', { name: '현재 도착한 소식' });
    await expect(received).toContainText('같이 이야기해요 👋');
    await expect(received.locator('.bubble-sender')).toHaveText('메시지 A');
    const originalId = await received.getAttribute('data-event-id');
    await sent.getByRole('button', { name: '알림 닫기', exact: true }).click();

    // 3. 답장은 원본 발신자에게만 보내며 제목도 상대 닉네임과 답장 문맥을 유지한다.
    await received.getByRole('button', { name: '답장하기', exact: true }).click();
    const composer = b.getByRole('form', { name: '펫에게 보내기' });
    await expect(composer.locator('.pet-compose-target')).toHaveText('메시지 A에게');
    await composer.getByRole('textbox', { name: '메시지 내용' }).fill('좋아요 ☕');
    const replyResponse = b.waitForResponse(response => response.url().endsWith('/api/v1/messages') && response.request().method() === 'POST');
    await composer.getByRole('button', { name: '메시지 보내기', exact: true }).click();
    const response = await replyResponse;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({ mode: 'selected', petIds: [fixtures[0].petId], replyToMessageId: originalId, body: '좋아요 ☕' });
    await expect(received.locator('.bubble-sender')).toHaveText('메시지 A에게 보낸 답장');
    await expect(received).not.toContainText(/\d+마리/);
    await expect(sent).toContainText('좋아요 ☕');
    await expect(sent.locator('.bubble-sender')).toHaveText('메시지 B');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
