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
  await expect(dialog.locator('[data-empty]')).toBeHidden();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('');
  await expect(dialog.locator('[name=idleFrames]')).toHaveCount(0);
  await dialog.locator('[data-animation-settings] > summary').click();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('128');
  await expect(dialog.locator('[name=frameHeight]')).toHaveValue('128');
  await expect(dialog.locator('[name=idleFrames]')).toHaveValue('0,1,2,3');
  await expect(dialog.locator('[name=idleFPS]')).toHaveValue('4');
  await expect(dialog.locator('[name=walkFrames]')).toHaveValue('4,5,6,7,8,9,10,11');
  await expect(dialog.locator('[name=walkFPS]')).toHaveValue('8');
  await expect(dialog.locator('[name=reactFrames]')).toHaveValue('12,13,14,15');
  await expect(dialog.locator('[name=reactFPS]')).toHaveValue('6');
  const firstAnimation = dialog.locator('[data-animation-row]').first();
  await expect(firstAnimation.getByRole('button', { name: '미리보기', exact: true })).toHaveCount(0);
  const nameBounds = await firstAnimation.locator('[data-animation-name]').boundingBox();
  const trashBounds = await firstAnimation.locator('[data-animation-remove]').boundingBox();
  expect(Math.abs(nameBounds!.y - trashBounds!.y)).toBeLessThan(1);
  expect(Math.abs(nameBounds!.height - trashBounds!.height)).toBeLessThan(1);
  await firstAnimation.screenshot({ path: '/tmp/our-pets-animation-row.png' });
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
  await dialog.locator('[data-animation-settings] > summary').click();
  await dialog.locator('[data-animation-settings] > summary').click();
  await expect(dialog.locator('[name=walkFrames]')).toHaveValue('4,5,6,7');
  await expect(dialog.locator('[name=walkFPS]')).toHaveValue('6');
  await dialog.locator('[data-action]').selectOption('walk');
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
  const manifestPart = requestBody.match(/name="manifest"\r\n\r\n([^\r]+)/);
  expect(manifestPart).not.toBeNull();
  expect(JSON.parse(manifestPart![1])).toMatchObject({ schemaVersion: 2, idleAnimation: 'idle', walkAnimation: 'walk', animations: { walk: { name: '걷기', frames: [4,5,6,7], fps: 6 } } });
});

test('펫 추가 모달은 네 모서리를 유지하고 헤더 아래 내용만 스크롤한다', async ({ page }) => {
  // 1. 작은 창에서 예시 설정을 펼쳐 내용이 모달 높이를 넘도록 한다.
  await page.setViewportSize({ width: 900, height: 650 });
  await createWorkspace(page);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.locator('[data-animation-settings] > summary').click();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('256');
  await dialog.locator('input[type=file]').setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('128');
  await expect(dialog.locator('[name=walkFrames]')).toHaveValue('4,5,6,7,8,9,10,11');
  const heading = dialog.locator('.pet-upload-heading');
  const headingBefore = await heading.boundingBox();
  const form = dialog.locator('form');
  const layout = await dialog.evaluate(element => {
    const style = getComputedStyle(element);
    const content = element.querySelector('form')!;
    return {
      corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      overflow: style.overflow,
      contentScrollable: content.scrollHeight > content.clientHeight,
      scrollbarColor: getComputedStyle(content).scrollbarColor,
    };
  });
  expect(layout.corners).toEqual(['16px', '16px', '16px', '16px']);
  expect(layout.overflow).toBe('hidden');
  expect(layout.contentScrollable).toBe(true);
  expect(layout.scrollbarColor).not.toBe('auto');

  // 2. 휠을 내려도 모달 제목과 취소·추가 버튼은 같은 화면 위치에 남는다.
  await form.hover();
  await page.mouse.wheel(0, 1400);
  await expect.poll(() => form.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await heading.boundingBox()).toEqual(headingBefore);
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '추가', exact: true })).toBeInViewport();
  await dialog.screenshot({ path: '/tmp/our-pets-upload-modal-scroll.png' });
});

test('직접 등록한 펫은 원본 PNG를 고정한 채 수정·삭제하고 기본 펫은 보호한다', async ({ page }) => {
  // 1. 실제 등록 폼으로 PNG와 애니메이션을 저장하고 기본 펫의 관리 아이콘은 숨긴다.
  await createWorkspace(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: '고양이 삭제', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '강아지 수정', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const add = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await add.getByRole('textbox', { name: '이름', exact: true }).fill('수정할 펫');
  await add.locator('input[type=file]').setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await add.locator('[data-animation-settings] > summary').click();
  await add.locator('[name=walkFPS]').fill('6');
  await add.getByRole('button', { name: '애니메이션 추가', exact: true }).click();
  const custom = add.locator('[data-animation-row]').last();
  await custom.getByRole('textbox', { name: '애니메이션 이름', exact: true }).fill('춤추기');
  await custom.locator('[data-animation-frames]').fill('5,6');
  await custom.locator('[data-animation-fps]').fill('1');
  const customID = await custom.getAttribute('data-animation-row') || '';
  await add.locator('[data-action]').selectOption(customID);
  await expect(add.locator('[data-action]')).toHaveValue(customID);
  const customImage = await add.locator('canvas[aria-label="추가할 펫의 모습"]').evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await add.getByRole('button', { name: '추가', exact: true }).click();
  await expect(add).toBeHidden();
  const editButton = page.getByRole('button', { name: '수정할 펫 수정', exact: true });
  await expect(editButton).toBeEnabled();
  await expect(page.getByRole('radio', { name: '수정할 펫', exact: true })).toBeChecked();
  // 서버가 ID순으로 반환한 목록의 첫 추가 동작을 고정 난수로 골라 실제 클릭 그림을 비교한다.
  const livePreview = page.locator('.pet-registration-preview canvas');
  await expect(livePreview).toBeVisible();
  expect(await livePreview.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(customImage);
  await page.evaluate(() => {
    Object.assign(window, { animationTestRandom: Math.random });
    Math.random = () => 0;
  });
  await livePreview.click();
  await expect.poll(() => livePreview.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(customImage);
  await page.evaluate(() => {
    Math.random = (window as unknown as { animationTestRandom: typeof Math.random }).animationTestRandom;
  });

  // 2. 수정 폼은 저장된 설정으로 열리고 PNG 교체 없이 실패 후에도 입력을 유지한다.
  await editButton.click();
  const edit = page.getByRole('dialog', { name: '펫 수정', exact: true });
  await expect(edit.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('수정할 펫');
  await expect(edit.locator('[name=frameWidth]')).toHaveValue('128');
  await expect(edit.locator('[name=walkFrames]')).toHaveValue('4,5,6,7,8,9,10,11');
  await expect(edit.locator('[name=walkFPS]')).toHaveValue('6');
  await expect(edit.locator('[data-animation-row]')).toHaveCount(4);
  await expect(edit.locator('[data-animation-name]').filter({ visible: true })).toHaveCount(4);
  await expect(edit.locator(`[data-animation-row="${customID}"] [data-animation-name]`)).toHaveValue('춤추기');
  await edit.getByRole('combobox', { name: '걷기 애니메이션', exact: true }).selectOption(customID);
  await expect(edit.locator('input[type=file]')).toBeDisabled();
  await expect(edit.locator('input[type=file]')).toBeHidden();
  await expect(edit.locator('[data-empty]')).toBeHidden();
  await edit.getByRole('textbox', { name: '이름', exact: true }).fill('수정한 펫');
  await edit.locator('[name=walkFPS]').fill('10');
  let updates = 0;
  let updateBody: Record<string, unknown> = {};
  await page.route('**/api/v1/designs/*', async route => {
    if (route.request().method() === 'PUT') {
      updates += 1;
      updateBody = route.request().postDataJSON();
      if (updates === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '수정 재시도 테스트' }) });
        return;
      }
    }
    await route.continue();
  });
  await edit.getByRole('button', { name: '저장', exact: true }).click();
  await expect(edit.locator('[data-status]')).toContainText('수정 재시도 테스트');
  await expect(edit.locator('[name=walkFPS]')).toHaveValue('10');
  await edit.getByRole('button', { name: '저장', exact: true }).click();
  await expect(edit).toBeHidden();
  expect(Object.keys(updateBody).sort()).toEqual(['manifest', 'name']);
  await expect(page.getByRole('radio', { name: '수정할 펫', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '수정한 펫', exact: true })).toBeChecked();

  // 3. 새로고침 후에도 변경값이 유지되고 현재 외형 삭제 시 고양이로 돌아간다.
  await page.reload();
  const savedEdit = page.getByRole('button', { name: '수정한 펫 수정', exact: true });
  await expect(savedEdit).toBeEnabled();
  await savedEdit.click();
  await expect(page.getByRole('dialog', { name: '펫 수정', exact: true }).locator('[name=walkFPS]')).toHaveValue('10');
  const reopened = page.getByRole('dialog', { name: '펫 수정', exact: true });
  await expect(reopened.getByRole('combobox', { name: '걷기 애니메이션', exact: true })).toHaveValue(customID);
  await reopened.getByRole('button', { name: '춤추기 애니메이션 삭제', exact: true }).click();
  await reopened.getByRole('combobox', { name: '걷기 애니메이션', exact: true }).selectOption('walk');
  await reopened.getByRole('button', { name: '저장', exact: true }).click();
  await expect(reopened).toBeHidden();
  await savedEdit.click();
  await expect(reopened.locator('[data-animation-row]')).toHaveCount(3);
  await reopened.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '수정한 펫 삭제', exact: true }).click();
  await expect(page.getByRole('radio', { name: '수정한 펫', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '고양이', exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('radio', { name: '수정한 펫', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '고양이', exact: true })).toBeChecked();
});

test('계정 메뉴에서 아이디는 고정하고 닉네임·비밀번호를 저장해 다시 로그인한다', async ({ page }) => {
  // 1. 계정 정보는 저장된 값으로 열리고 닉네임 변경은 펫 이름에도 반영된다.
  await createWorkspace(page);
  await page.getByRole('button', { name: '계정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
  const profile = page.locator('[data-profile]');
  const password = page.locator('[data-password]');
  const username = profile.getByRole('textbox', { name: '아이디', exact: true });
  await expect(username).toHaveAttribute('readonly', '');
  await expect(profile.getByRole('button', { name: '닉네임 저장', exact: true })).toBeEnabled();
  const originalUsername = await username.inputValue();
  await profile.getByRole('textbox', { name: '닉네임', exact: true }).fill('변경한 닉네임');
  await profile.getByRole('button', { name: '닉네임 저장', exact: true }).click();
  await expect(profile.getByRole('status')).toContainText('닉네임을 저장했어요');
  await page.getByRole('button', { name: '펫', exact: true }).click();
  await expect(page.locator('.pet-registration-preview [data-preview-name]')).toHaveText('변경한 닉네임');
  await page.getByRole('button', { name: '계정', exact: true }).click();
  await expect(username).toHaveValue(originalUsername);
  await expect(profile.getByRole('textbox', { name: '닉네임', exact: true })).toHaveValue('변경한 닉네임');

  // 2. 보기 버튼·새 비밀번호 일치·현재 비밀번호 검증을 거쳐 저장 후 입력을 지운다.
  await password.getByLabel('현재 비밀번호', { exact: true }).fill('wrong-password-123');
  await password.getByLabel('새 비밀번호', { exact: true }).fill('changed-password-456');
  await password.getByLabel('새 비밀번호 확인', { exact: true }).fill('different-password-456');
  await password.getByRole('button', { name: '새 비밀번호 보기', exact: true }).click();
  await expect(password.getByLabel('새 비밀번호', { exact: true })).toHaveAttribute('type', 'text');
  await password.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
  await expect(password.getByRole('status')).toContainText('서로 일치하지');
  await password.getByLabel('새 비밀번호 확인', { exact: true }).fill('changed-password-456');
  await password.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
  await expect(password.getByRole('status')).toContainText('현재 비밀번호가 올바르지');
  await password.getByLabel('현재 비밀번호', { exact: true }).fill('test-password-123');
  await password.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
  await expect(password.getByRole('status')).toContainText('비밀번호를 변경했어요');
  for (const name of ['현재 비밀번호', '새 비밀번호', '새 비밀번호 확인']) {
    await expect(password.getByLabel(name, { exact: true })).toHaveValue('');
    await expect(password.getByLabel(name, { exact: true })).toHaveAttribute('type', 'password');
  }
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('changed-password-456');
  await page.locator('.account-settings').screenshot({ path: '/tmp/our-pets-account-settings.png' });

  // 3. 기존 비밀번호는 거부되고 같은 아이디와 새 비밀번호로 접속한다.
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(originalUsername);
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: /접속하기/ }).click();
  await expect(page.locator('#notice')).toContainText('로그인 정보를 확인');
  await page.getByLabel('비밀번호', { exact: true }).fill('changed-password-456');
  await page.getByRole('button', { name: /접속하기/ }).click();
  await expect(page.getByRole('button', { name: '계정', exact: true })).toBeVisible();
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
