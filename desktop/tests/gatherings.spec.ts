import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test } from './isolated-server';

const password = 'test-password-123';

interface FixtureUser {
  server: string;
  username: string;
  name: string;
  petId: string;
}

// 실제 서버에 독립된 계정과 기본 펫을 준비한다.
async function createUser(request: APIRequestContext, server: string, suffix: string, role: string): Promise<FixtureUser> {
  // 1. API로 준비하는 계정마다 서로 다른 안정적인 펫 ID를 받는다.
  const username = `group-${role}-${suffix}`;
  const name = `모집 ${role.toUpperCase()}`;
  const response = await request.post(`${server}/api/v1/register`, { data: { username, password, displayName: name, invite: 'test-only-invite' } });
  expect(response.ok()).toBe(true);
  const login = await response.json();

  // 2. 로그인 UI와 별개인 명시적 펫 등록을 완료한다.
  const registration = await request.post(`${server}/api/v1/me/pet/registration`, { headers: { Authorization: `Bearer ${login.token}` }, data: { designId: 'default' } });
  expect(registration.ok()).toBe(true);
  return { server, username, name, petId: login.principal.petId };
}

// 새 기기 문맥의 실제 로그인 화면을 거쳐 실시간 펫 창을 연다.
async function connectDevice(browser: Browser, user: FixtureUser, contexts: BrowserContext[]): Promise<Page> {
  // 1. 저장된 세션을 주입하지 않고 서버 선택과 로그인을 수행한다.
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill(user.server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(user.username);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: /접속하기/ }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();

  // 2. 각 기기의 실제 WebSocket 준비 상태를 기다린다.
  const connected = page.waitForEvent('websocket', socket => socket.url().endsWith('/api/v1/ws')).then(socket => socket.waitForEvent('framereceived', { predicate: frame => JSON.parse(frame.payload.toString()).type === 'ready' }));
  await page.goto('/?pet');
  await connected;
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.connection') || 'null')?.state)).toBe('연결됨');
  return page;
}

test('다섯 모집의 참여·취소·재참여·완료가 두 수신 기기에 동기화된다', async ({ browser, request, isolatedServer }) => {
  // 1. 모집자와 참여자 두 기기를 실제 로그인으로 연결하고 친구 펫 메뉴를 연다.
  const suffix = String(Date.now());
  const host = await createUser(request, isolatedServer, suffix, 'host');
  const guest = await createUser(request, isolatedServer, suffix, 'guest');
  const contexts: BrowserContext[] = [];
  try {
    const a = await connectDevice(browser, host, contexts);
    const b = await connectDevice(browser, guest, contexts);
    const b2 = await connectDevice(browser, guest, contexts);
    const friend = await b.context().newPage();
    await friend.goto(`/?pet&target=${host.petId}`);
    const panel = friend.getByRole('region', { name: '모집', exact: true });

    // 2. 모든 종류에서 메시지 입력 없이 모집하고 친구 메뉴에서 직접 참여한다.
    for (const label of ['커피', '담배', '밥', '수다', '산책']) {
      await a.getByRole('button', { name: `${host.name} 동작 메뉴 · 오른쪽 클릭 또는 Enter` }).click({ button: 'right' });
      await expect(a.getByRole('button', { name: '👋 인사하기', exact: true })).toBeHidden();
      await a.getByRole('button', { name: '모집 종류 선택', exact: true }).click();
      await a.getByRole('button', { name: `${label} 모집`, exact: true }).click();
      await expect(a.getByRole('button', { name: '완료', exact: true })).toBeVisible();
      // 별도 브라우저 페이지는 네이티브 창 이벤트 버스가 없으므로 현재 모집을 다시 읽는다.
      await friend.reload();
      await friend.getByRole('button', { name: `${host.name} 동작 메뉴 · 오른쪽 클릭 또는 Enter` }).click({ button: 'right' });
      await friend.getByRole('button', { name: `${label} 모집 참여`, exact: true }).click();
      await panel.getByRole('button', { name: '참여하기', exact: true }).click();
      await expect(a.getByRole('listitem')).toHaveText(`✓ ${guest.name}`);
      await expect(b2.getByRole('status', { name: `${label} 참여 중 · 1명 참여`, exact: true })).toBeVisible();

      // 3. 취소와 재참여는 같은 펫을 중복 등록하지 않고 두 기기에 함께 반영된다.
      await panel.getByRole('button', { name: '참여 취소', exact: true }).click();
      await expect(a.getByRole('listitem')).toHaveCount(0);
      await expect(b2.locator('.recruitment-badge')).toBeHidden();
      await panel.getByRole('button', { name: '참여하기', exact: true }).click();
      await expect(a.getByRole('listitem')).toHaveText(`✓ ${guest.name}`);
      await expect(a.getByRole('listitem')).toHaveCount(1);

      // 4. 주최자의 완료로 양쪽 수신 기기의 현재 모집 표시가 실시간으로 사라진다.
      await a.getByRole('button', { name: '완료', exact: true }).click();
      await expect(b.locator('.recruitment-badge')).toBeHidden();
      await expect(b2.locator('.recruitment-badge')).toBeHidden();
      await friend.reload();
      await expect(panel).toBeHidden();
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('네 사용자와 두 수신 기기의 직접·전체 메시지 및 오프라인 미재생을 실제 화면에서 확인한다', async ({ browser, request, isolatedServer }) => {
  // 1. 같은 고양이를 사용하는 네 사용자와 B의 두 기기를 연결한다.
  const suffix = String(Date.now());
  const users: FixtureUser[] = [];
  for (const role of ['a', 'b', 'c', 'd']) {
    users.push(await createUser(request, isolatedServer, suffix, role));
  }
  const contexts: BrowserContext[] = [];
  try {
    const pages: Page[] = [];
    for (const user of [users[0], users[1], users[1], users[2], users[3]]) {
      pages.push(await connectDevice(browser, user, contexts));
    }
    const [a, b, b2, c, d] = pages;
    const target = await a.context().newPage();
    await target.goto(`/?pet&target=${users[1].petId}`);
    const direct = `B에게만 👋 ${suffix}`;
    await target.getByRole('button', { name: `${users[1].name} 동작 메뉴 · 오른쪽 클릭 또는 Enter` }).click({ button: 'right' });
    await target.getByRole('textbox', { name: '이 친구에게만 보낼 메시지' }).fill(direct);
    await target.getByRole('button', { name: '전송', exact: true }).click();
    for (const receiver of [b, b2]) {
      await expect(receiver.getByRole('article', { name: '현재 도착한 소식' })).toContainText(direct);
    }
    await expect(c.getByRole('article', { name: '현재 도착한 소식' })).toBeHidden();
    await expect(d.getByRole('article', { name: '현재 도착한 소식' })).toBeHidden();
    await target.close();
    for (const receiver of [b, b2]) {
      await receiver.getByRole('button', { name: '알림 닫기', exact: true }).click();
    }

    // 2. 발신 펫의 전체 메시지는 접속 중인 세 사용자와 B의 두 기기에 도착한다.
    const broadcast = `모두에게 ☕ ${suffix}`;
    await a.getByRole('button', { name: `${users[0].name} 동작 메뉴 · 오른쪽 클릭 또는 Enter` }).click({ button: 'right' });
    await a.getByRole('textbox', { name: '전체 펫에게 보낼 메시지' }).fill(broadcast);
    await a.getByRole('button', { name: '전송', exact: true }).click();
    for (const receiver of [b, b2, c, d]) {
      const bubble = receiver.getByRole('article', { name: '현재 도착한 소식' });
      await expect(bubble).toBeVisible();
      await expect(bubble).toContainText(broadcast);
    }

    // 3. D가 오프라인일 때의 메시지는 재접속해도 새 말풍선으로 재생하지 않는다.
    await d.goto('about:blank');
    await a.getByRole('button', { name: `${users[0].name} 동작 메뉴 · 오른쪽 클릭 또는 Enter` }).click({ button: 'right' });
    await a.getByRole('textbox', { name: '전체 펫에게 보낼 메시지' }).fill(`오프라인 제외 ${suffix}`);
    await a.getByRole('button', { name: '전송', exact: true }).click();
    await expect(a.getByRole('article', { name: '현재 도착한 소식' })).toContainText(`오프라인 제외 ${suffix}`);
    const reconnected = d.waitForEvent('websocket', socket => socket.url().endsWith('/api/v1/ws')).then(socket => socket.waitForEvent('framereceived', { predicate: frame => JSON.parse(frame.payload.toString()).type === 'ready' }));
    await d.goto('/?pet');
    await reconnected;
    await expect.poll(() => d.evaluate(() => JSON.parse(localStorage.getItem('ourpets.connection') || 'null')?.state)).toBe('연결됨');
    await expect(d.getByRole('article', { name: '현재 도착한 소식' })).toBeHidden();
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
