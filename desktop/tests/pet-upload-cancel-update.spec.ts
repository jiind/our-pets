import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import { test } from './isolated-server';

// 실제 가입과 대표 펫 등록을 마친다.
async function createWorkspace(page: Page, server: string): Promise<void> {
  // 1. 서버를 선택하고 새 계정으로 가입한다.
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill(server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
  await page.getByRole('textbox', { name: '닉네임', exact: true }).fill('수정 취소 검사');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(`cancel-update-${Date.now()}`);
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByLabel('서버 가입 코드', { exact: true }).fill('test-only-invite');
  await page.getByRole('button', { name: /계정 만들고 펫 등록하기/ }).click();

  // 2. 기본 펫을 등록해 실제 인증 상태를 준비한다.
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: '펫 추가', exact: true })).toBeEnabled();
}

test('수정 취소 후 늦은 대표 펫 조회는 새 선택과 등록 콜백을 덮지 않는다', async ({ page, isolatedServer }) => {
  // 1. 실제 로그인 상태에서 독립 등록 화면을 만들고 전달된 펫을 기록한다.
  await createWorkspace(page, isolatedServer);
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 실제 등록 모듈을 제공한다.
    const { mountPetRegistration } = await import('/src/pet-registration.ts');
    const root = document.createElement('div');
    root.id = 'cancel-update-fixture';
    document.querySelector('main')?.setAttribute('hidden', '');
    document.body.append(root);
    const calls: unknown[] = [];
    const cleanup = await mountPetRegistration(root, { onRegistered: (pet: unknown) => calls.push(structuredClone(pet)) });
    Object.assign(window, { cancelUpdateFixture: { calls, cleanup } });
  });
  const root = page.locator('#cancel-update-fixture');
  await expect(root.getByRole('button', { name: '펫 추가', exact: true })).toBeEnabled();
  await root.getByRole('button', { name: '펫 추가', exact: true }).click();
  const add = root.getByRole('dialog', { name: '펫 추가', exact: true });
  await add.getByRole('textbox', { name: '이름', exact: true }).fill('수정 대상');
  await add.locator('input[type=file]').setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await add.getByRole('button', { name: '추가', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(root.getByRole('radio', { name: '수정 대상', exact: true })).toBeChecked();
  const calls = () => page.evaluate(() => (window as unknown as { cancelUpdateFixture: { calls: { builtinId?: string; design: { id: string } | null }[] } }).cancelUpdateFixture.calls);
  await expect.poll(async () => (await calls()).at(-1)?.design?.id).toBeTruthy();

  // 2. 실제 수정 성공 직후 서버의 대표 펫 응답을 받아 보관하고 전달만 지연한다.
  let updated = false;
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/designs/*', async route => {
    if (route.request().method() === 'PUT') {
      const response = await route.fetch();
      updated = response.ok();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/v1/me/pet', async route => {
    if (updated && route.request().method() === 'GET' && !release) {
      const response = await route.fetch();
      release = () => route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await root.getByRole('button', { name: '수정 대상 수정', exact: true }).click();
  const edit = root.getByRole('dialog', { name: '펫 수정', exact: true });
  await edit.getByRole('textbox', { name: '이름', exact: true }).fill('수정된 대상');
  await edit.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);

  // 3. 수정을 취소하고 다른 기본 펫이 실제 저장된 후 오래된 응답을 반환한다.
  await edit.getByRole('button', { name: '취소', exact: true }).click();
  await root.getByRole('radio', { name: '강아지', exact: true }).check();
  await expect.poll(async () => (await calls()).at(-1)?.builtinId).toBe('dog');
  const savedCalls = await calls();
  expect(savedCalls.at(-1)?.design).toBeNull();
  const staleResponse = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/v1/me/pet'));
  await release!();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await expect(root.getByRole('radio', { name: '강아지', exact: true })).toBeChecked();
  await expect.poll(calls).toEqual(savedCalls);
  await root.getByRole('button', { name: '수정된 대상 수정', exact: true }).click();
  await expect(edit).toBeVisible();
  await edit.getByRole('button', { name: '취소', exact: true }).click();
});
