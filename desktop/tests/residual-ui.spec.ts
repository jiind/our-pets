import { test, expect } from '@playwright/test';
import path from 'node:path';

const server = 'http://127.0.0.1:19377';

// UI로 격리 계정을 만들고 대표 펫 등록 화면까지 연다.
async function createWorkspace(page: import('@playwright/test').Page): Promise<void> {
  // 1. 서버 연결과 가입을 화면 및 키보드 입력으로 진행한다.
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill(server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
  await page.getByRole('textbox', { name: '닉네임' }).fill('잔여 검사');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(`residual-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  await page.keyboard.press('Tab');
  const password = page.getByLabel('비밀번호', { exact: true });
  await expect(password).toBeFocused();
  await password.fill('test-password-123');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '비밀번호 보기', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: '비밀번호 숨기기', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(password).toHaveAttribute('type', 'password');
  await page.keyboard.press('Tab');
  await page.getByLabel('서버 가입 코드', { exact: true }).fill('test-only-invite');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /계정 만들고 펫 등록하기/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();

  // 2. 가입 후 기본 펫 등록을 마쳐 실제 작업 화면을 연다.
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: '펫 추가', exact: true })).toBeVisible();
}

test('PNG 스프라이트 UI는 잘못된 파일·칸 입력을 거부하고 프롬프트 복사와 실패 재시도를 보존한다', async ({ page }) => {
  // 1. 실제 등록 UI에서 추가 모달을 열고 프롬프트 복사와 reduced-motion 표시를 확인한다.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await createWorkspace(page);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.locator('.character-prompts > summary').click();
  await dialog.locator('[data-character-prompt-kind]').selectOption('animated');
  await dialog.getByRole('button', { name: '프롬프트 복사', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '프롬프트를 복사했어요.' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('4열 × 4행');

  // 2. 확장자만 PNG인 잘못된 파일은 미리보기에서 거부하고 업로드하지 않는다.
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('재시도 스프라이트');
  const file = dialog.locator('input[type=file]');
  await file.setInputFiles({ name: '잘못된.png', mimeType: 'image/png', buffer: Buffer.from('not a png') });
  await expect(dialog.locator('[data-empty]')).toContainText('PNG 파일을 선택하세요');
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[data-status]')).toContainText('PNG 파일을 선택하세요');

  // 3. 스프라이트를 나누어 칸 수·속도·동작 미리보기를 확인하고 잘못된 분할은 저장하지 않는다.
  await file.setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await dialog.locator('[data-animation-settings] > summary').click();
  await dialog.locator('[name=frameWidth]').fill('100');
  await dialog.locator('[name=frameHeight]').fill('128');
  await expect(dialog.locator('[data-frame-guide]')).toContainText('나누어떨어지게');
  await dialog.locator('[name=frameWidth]').fill('128');
  await expect(dialog.locator('[data-frame-grid] .pet-upload-frame-cell')).toHaveCount(16);
  await dialog.locator('[name=walkFrames]').fill('0,1,2,3');
  await dialog.locator('[name=walkFPS]').fill('25');
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[name=walkFPS]')).toBeFocused();
  await expect(dialog.locator('[name=walkFPS]')).toHaveJSProperty('validity.valid', false);
  await dialog.locator('[name=walkFPS]').fill('6');
  await dialog.locator('[name=walkFrames]').fill('0,,1');
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[data-status]')).toContainText('칸 번호는 0부터 시작');
  await dialog.locator('[name=walkFrames]').fill('4,5,6,7');
  await dialog.locator('[data-preview-mode=walk]').click();
  await expect(dialog.locator('[data-preview-note]')).toContainText('선택한 동작을 실제 펫 크기로 미리 보여요');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(dialog.locator('[data-preview-note]')).toContainText('동작 줄이기 설정에 따라 정지 상태');

  // 4. 업로드 요청을 한 번 실패시킨 뒤 같은 입력으로 재시도해 성공 응답과 manifest를 확인한다.
  let uploads = 0;
  let requestBody = '';
  await page.route('**/api/v1/designs', async route => {
    uploads += 1;
    requestBody = route.request().postData() || '';
    if (uploads === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary test failure' }) });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'design-retry-fixture', ownerId: 'fixture-owner', version: 1, name: '재시도 스프라이트', imageHash: 'fixture-hash', manifest: { schemaVersion: 1, displaySize: 160, frameWidth: 128, frameHeight: 128, animations: { walk: { frames: [4, 5, 6, 7], fps: 6 } } } }),
    });
  });
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[data-status]')).toContainText('temporary test failure');
  await expect(file).toHaveValue(/icon\.png/);
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('재시도 스프라이트');
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(uploads).toBe(2);
  expect(requestBody).toContain('"frameWidth":128');
  expect(requestBody).toContain('"walk":{"frames":[4,5,6,7],"fps":6}');
});

test('개인 연결 IPC 모의 저장·삭제 실패는 화면 입력과 연결 상태를 유지한다', async ({ page }) => {
  // 1. 계정과 펫을 화면에서 만들고 네이티브 IPC 경계만 공식 모의로 연결한다.
  await createWorkspace(page);
  await page.evaluate(async () => {
    // @ts-expect-error Tauri가 브라우저에 제공하는 공식 테스트 모듈이다.
    const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js');
    const sources: Record<string, unknown>[] = [];
    let saveAttempts = 0;
    let removeAttempts = 0;
    Object.assign(window, { isTauri: true });
    mockIPC((cmd: string, args: Record<string, unknown>) => {
      if (cmd.startsWith('plugin:event|')) {
        return 1;
      }
      if (cmd === 'local_list_sources') {
        return structuredClone(sources);
      }
      if (cmd === 'local_save_source') {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          throw new Error('temporary save failure');
        }
        const draft = args.draft as Record<string, unknown>;
        sources.push({ id: 'ipc-fixture-1', name: draft.name, config: draft.config, enabled: true, state: 'connected', lastError: '' });
        return sources[0];
      }
      if (cmd === 'local_remove_source') {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error('temporary remove failure');
        }
        sources.splice(0, 1);
        return;
      }
      return undefined;
    });
  });
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await page.getByRole('button', { name: '연결 추가', exact: true }).click();

  // 2. 첫 저장 실패 후 표시 이름·범위가 남는지 보고 두 번째 IPC 저장을 성공시킨다.
  const docker = page.locator('#local-docker-form');
  await docker.locator('[name=name]').fill('재시도 Docker');
  await docker.locator('summary').click();
  await docker.locator('[name=containers]').fill('api,worker');
  await docker.getByRole('button', { name: 'Docker 연결 저장' }).click();
  await expect(docker.locator('.local-form-notice')).toContainText('Docker 실행 상태와 주소를 확인하세요');
  await expect(docker.locator('[name=name]')).toHaveValue('재시도 Docker');
  await expect(docker.locator('[name=containers]')).toHaveValue('api,worker');
  await docker.getByRole('button', { name: 'Docker 연결 저장' }).click();
  const card = page.locator('[data-source-id="ipc-fixture-1"]');
  await expect(card).toContainText('재시도 Docker');

  // 3. 삭제 실패 때 카드를 유지하고 재시도 성공 후에만 목록에서 제거한다.
  await card.getByRole('button', { name: '연결 삭제' }).click();
  await expect(card.locator('.source-action-notice')).toContainText('Docker 실행 상태와 주소를 확인하세요');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '연결 삭제' }).click();
  await expect(card).toHaveCount(0);
});

test('PNG 초안 목록 반영 실패 재시도는 성공한 업로드를 캐시해 POST를 중복하지 않는다', async ({ page }) => {
  // 1. 실제 가입 UI의 로그인 상태에서 업로드 컴포넌트를 독립 fixture로 열고 API 응답만 모의한다.
  await createWorkspace(page);
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 제공하는 실제 업로드 모듈이다.
    const { mountPetUpload } = await import('/src/pet-upload.ts');
    const root = document.createElement('div');
    root.id = 'upload-retry-fixture';
    document.body.append(root);
    let onAddedCalls = 0;
    const mounted = mountPetUpload(root, {
      onAdded: async () => {
        onAddedCalls += 1;
        if (onAddedCalls === 1) {
          throw new Error('fixture list refresh failure');
        }
      },
    });
    Object.assign(window, { uploadRetryFixture: { root, mounted, onAddedCalls: () => onAddedCalls } });
    mounted.open();
  });
  let postCount = 0;
  await page.route('**/api/v1/designs', async route => {
    postCount += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'design-cached-fixture', ownerId: 'fixture-owner', version: 1, name: '목록 재시도', imageHash: 'fixture-hash', manifest: { schemaVersion: 1, displaySize: 160, frameWidth: 512, frameHeight: 512, animations: {} } }),
    });
  });

  // 2. 첫 목록 callback 실패 뒤 같은 파일·이름으로 다시 눌러 캐시 경계를 확인한다.
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('목록 재시도');
  await dialog.locator('input[type=file]').setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[data-status]')).toContainText('펫 추가는 완료했지만 목록에 반영하지 못했어요');
  await expect.poll(() => page.evaluate(() => (window as unknown as { uploadRetryFixture: { onAddedCalls(): number } }).uploadRetryFixture.onAddedCalls())).toBe(1);
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uploadRetryFixture: { onAddedCalls(): number } }).uploadRetryFixture.onAddedCalls())).toBe(2);
  expect(postCount).toBe(1);
});

test('메뉴 Escape와 짧은 창에서 본문 스크롤 중 탐색 메뉴가 유지된다', async ({ page }) => {
  // 1. 실제 가입 UI로 연 대표 펫 미리보기에서 reduced-motion 설정과 Escape를 확인한다.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await createWorkspace(page);
  const preview = page.locator('.pet-registration-preview-stage canvas');
  await preview.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '펫 동작 미리보기' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '대기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(preview).toBeFocused();

  // 2. 짧은 viewport에서 본문을 스크롤해도 탐색 메뉴가 자체 영역에 고정되어 보인다.
  await page.setViewportSize({ width: 900, height: 520 });
  const sidebar = page.locator('.sidebar');
  const initial = await sidebar.boundingBox();
  const content = page.locator('.content');
  const contentSize = await content.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.height);
  await content.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const after = await sidebar.boundingBox();
  expect(initial?.y).toBe(after?.y);
  await expect(page.getByRole('button', { name: '탐색 메뉴 접기' })).toBeVisible();
});
