import { expect, type Page } from '@playwright/test';
import { test } from './isolated-server';
import type { Design } from '../src/types';
import { testInvitation } from './test-invitation';

// 실제 가입·등록 화면을 거쳐 펫 추가 작업을 시작한다.
async function workspace(page: Page, server: string): Promise<void> {
  // 1. 화면에서 선택한 서버에 새 계정으로 가입한다.
  await page.goto('/');
  await page.getByRole('button', { name: '초대 링크로 참여하기', exact: true }).click();
  await page.getByLabel('초대 링크', { exact: true }).fill(testInvitation(server));
  await page.getByRole('button', { name: '방 참여', exact: true }).click();
  await page.getByRole('textbox', { name: '닉네임', exact: true }).fill('펫 추가 검사');
  await page.getByRole('button', { name: '참여하기' }).click();

  // 2. 대표 펫 등록 이후 실제 추가 모달을 사용할 수 있게 한다.
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: '펫 추가', exact: true })).toBeEnabled();
}

// 예시 프롬프트와 같은 4×4 RGBA 시트를 만들고 각 동작을 다른 색으로 구분한다.
async function sprite(page: Page, size: number, emptyFrame?: number): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  // 1. 각 칸의 중앙에 불투명 색을 넣고 나머지는 실제 투명 배경으로 둔다.
  const url = await page.evaluate(({ pixels, empty }) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = pixels;
    const context = canvas.getContext('2d')!;
    const cell = pixels / 4;
    for (let frame = 0; frame < 16; frame += 1) {
      if (frame === empty) {
        continue;
      }
      context.fillStyle = frame < 4 ? '#e24b3b' : frame < 12 ? '#3eaa65' : '#3e6ac4';
      context.fillRect((frame % 4) * cell + cell / 4, Math.floor(frame / 4) * cell + cell / 4, cell / 2, cell / 2);
    }
    return canvas.toDataURL('image/png');
  }, { pixels: size, empty: emptyFrame });
  // 2. 파일 선택 UI가 받는 실제 PNG 바이트를 반환한다.
  return { name: `example-${size}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
}

test('서버 멤버가 미적용 PNG를 공유 목록에서 선택하고 소유자만 수정할 수 있다', async ({ page, isolatedServer }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await workspace(page, isolatedServer);
  const uploader = await page.request.post(`${isolatedServer}/api/v1/register`, {
    data: { username: 'png-uploader', displayName: '올린 사람', password: 'test-password-123', invite: 'test-only-invite' },
  });
  expect(uploader.status()).toBe(201);
  const { token } = await uploader.json();
  const uploaded = await page.request.post(`${isolatedServer}/api/v1/designs`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { name: '함께 쓰는 펫', image: await sprite(page, 64), draft: 'true', manifest: '{"displaySize":160}' },
  });
  expect(uploaded.status()).toBe(201);
  const design: Design = await uploaded.json();

  await page.getByRole('button', { name: '등록된 펫 목록 새로고침', exact: true }).click();
  const choice = page.getByRole('radio', { name: '함께 쓰는 펫', exact: true });
  await expect(choice).toBeVisible();
  await expect(page.getByRole('button', { name: '함께 쓰는 펫 수정' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '함께 쓰는 펫 삭제' })).toHaveCount(0);
  const saved = page.waitForResponse(response => response.url() === `${isolatedServer}/api/v1/me/pet/registration` && response.request().method() === 'POST');
  await choice.check();
  const result = await saved;
  expect(result.status()).toBe(200);
  expect((await result.json()).design.id).toBe(design.id);
  await page.reload();
  await expect(choice).toBeChecked();
  expect(errors).toEqual([]);
});

test('펫 선택 목록은 기본 펫 다음에 등록한 순서로 쌓이고 새로고침 후에도 유지된다', async ({ page, isolatedServer }) => {
  // 1. 실제 추가 모달에서 세 PNG를 순서대로 등록한다.
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      failures.push(message.text());
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  await workspace(page, isolatedServer);
  const original = await page.locator('[data-characters] label').allTextContents();
  const names = ['추가 1', '추가 2', '추가 3'];
  const file = await sprite(page, 1024);
  for (const name of names) {
    await page.getByRole('button', { name: '펫 추가', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill(name);
    await dialog.locator('input[type=file]').setInputFiles(file);
    await expect(dialog.locator('canvas')).toBeVisible();
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: '펫 추가', exact: true })).toBeEnabled();
    await expect(page.locator('[data-characters] label')).toHaveText([...original, ...names.slice(0, names.indexOf(name) + 1)]);
  }

  // 2. 서버 목록 재조회와 전체 화면 재진입에서도 기본·추가 순서를 보존한다.
  await page.getByRole('button', { name: '등록된 펫 목록 새로고침', exact: true }).click();
  await expect(page.getByRole('button', { name: '등록된 펫 목록 새로고침', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-characters] label')).toHaveText([...original, ...names]);
  await page.reload();
  await expect(page.locator('[data-characters] label')).toHaveText([...original, ...names]);
  await expect(page.getByRole('radio', { name: '추가 3', exact: true })).toBeChecked();
  await page.screenshot({ path: '/tmp/our-pets-catalogue-addition-order.png', fullPage: true });
  expect(failures).toEqual([]);
});

test('펫 추가 취소·Escape는 파일과 입력을 비우고 새 시트는 올바른 기본값과 그림으로 시작한다', async ({ page, isolatedServer }) => {
  // 1. 처음 선택한 시트와 사용자 동작·크기를 변경한 뒤 취소한다.
  await workspace(page, isolatedServer);
  const small = await sprite(page, 1024);
  const large = await sprite(page, 2048);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('버릴 초안');
  await dialog.locator('input[type=file]').setInputFiles(small);
  await dialog.locator('[data-animation-settings] > summary').click();
  await dialog.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true }).check();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('256');
  await dialog.locator('[name=frameWidth]').fill('128');
  await dialog.locator('[name=frameHeight]').fill('128');
  await dialog.locator('[name=idleFPS]').fill('12');
  await dialog.getByRole('button', { name: '애니메이션 추가', exact: true }).click();
  await dialog.locator('[data-action]').selectOption('walk');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();

  // 2. 닫힌 즉시 초안 자원이 사라지고 새 추가는 기본 입력만 남긴다.
  const retained = page.locator('.pet-upload-dialog');
  await expect(retained.locator('[name=name]')).toHaveValue('');
  expect(await retained.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
  await expect(retained.locator('[name=frameWidth]')).toHaveValue('');
  await expect(retained.locator('[name=frameHeight]')).toHaveValue('');
  await expect(retained.locator('[data-animation-row]')).toHaveCount(0);
  await expect(retained.locator('[data-action]')).toHaveValue('idle');
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  await expect(dialog.locator('[data-animation-settings]')).not.toHaveAttribute('open');
  await expect(dialog.locator('canvas')).toBeHidden();

  // 3. 다른 크기의 정상 시트는 기본 분할과 각 동작의 실제 픽셀을 미리 보여 준다.
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('새 시트');
  await dialog.locator('input[type=file]').setInputFiles(large);
  await expect(dialog.locator('canvas')).toBeVisible();
  await dialog.locator('[data-animation-settings] > summary').click();
  await dialog.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true }).check();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('512');
  await expect(dialog.locator('[name=frameHeight]')).toHaveValue('512');
  await expect(dialog.locator('[data-frame-grid] .pet-upload-frame-cell')).toHaveCount(16);
  await expect(dialog.locator('[name=idleFPS]')).toHaveValue('4');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const canvas = dialog.getByRole('img', { name: '추가할 펫의 모습', exact: true });
  for (const [action, expected] of [['idle', [226, 75, 59]], ['walk', [62, 170, 101]], ['react', [62, 106, 196]]] as const) {
    await dialog.locator('[data-action]').selectOption(action);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data))).toEqual([...expected, 255]);
  }
  await dialog.screenshot({ path: '/tmp/our-pets-upload-fresh-sprite.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(retained.locator('[name=name]')).toHaveValue('');
  expect(await retained.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('바깥 클릭으로 취소');
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(retained.locator('[name=name]')).toHaveValue('');
});

test('애니메이션 설정 오류와 투명 칸은 원인을 안내하고 마지막 정상 그림을 유지한다', async ({ page, isolatedServer }) => {
  // 1. 일부 투명 프레임이 있는 실제 PNG를 정상 예시 설정으로 미리 본다.
  await workspace(page, isolatedServer);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const file = await sprite(page, 1024, 12);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('그림 확인');
  await dialog.locator('input[type=file]').setInputFiles(file);
  await expect(dialog.locator('canvas')).toBeVisible();
  await dialog.locator('[data-animation-settings] > summary').click();
  await dialog.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true }).check();
  const canvas = dialog.getByRole('img', { name: '추가할 펫의 모습', exact: true });
  const note = dialog.locator('[data-preview-note]');
  const center = () => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data));
  await expect.poll(center).toEqual([226, 75, 59, 255]);

  // 2. 잘못된 분할과 그림 없는 칸으로 바꿔도 마지막 그림은 남고 잘못된 저장은 막는다.
  await dialog.locator('[name=frameWidth]').fill('300');
  await expect(note).toContainText('나누어떨어지게');
  await expect.poll(center).toEqual([226, 75, 59, 255]);
  await dialog.locator('[name=frameHeight]').fill('64');
  await dialog.locator('[name=frameWidth]').fill('64');
  await expect(note).toContainText('모두 투명');
  await expect(note).toContainText('마지막 정상 설정');
  await expect(canvas).toBeVisible();
  await expect.poll(center).toEqual([226, 75, 59, 255]);
  let uploads = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/designs')) {
      uploads += 1;
    }
  });
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog.locator('[data-status]')).toContainText('모두 투명');
  expect(uploads).toBe(0);

  // 3. 크기를 바로잡은 뒤 빈 동작을 선택해도 정상 대기를 보존하고 일부 빈 프레임은 허용한다.
  await dialog.locator('[name=frameWidth]').fill('256');
  await dialog.locator('[name=frameHeight]').fill('256');
  await expect(note).not.toHaveClass(/error/);
  await dialog.locator('[name=reactFrames]').fill('12');
  await dialog.locator('[data-action]').selectOption('react');
  await expect(note).toContainText('모두 투명');
  await expect.poll(center).toEqual([226, 75, 59, 255]);
  await dialog.locator('[name=reactFrames]').fill('12,13');
  await expect(note).not.toHaveClass(/error/);
  await dialog.locator('[name=reactFrames]').fill('13');
  await expect.poll(center).toEqual([62, 106, 196, 255]);
  await expect(canvas).toBeInViewport();
  await dialog.screenshot({ path: '/tmp/our-pets-upload-preview-recovered.png' });
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('radio', { name: '그림 확인', exact: true })).toBeChecked();
  expect(uploads).toBe(1);
});

test('추가 요청 중 취소·재진입하면 늦은 업로드가 이전 펫을 적용하거나 새 초안을 덮지 않는다', async ({ page, isolatedServer }) => {
  // 1. 실제 서버가 접수한 첫 업로드의 응답만 지연한다.
  await workspace(page, isolatedServer);
  const file = await sprite(page, 1024);
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  let uploadStatus: number | undefined;
  let uploads = 0;
  const applied: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') {
      return;
    }
    if (request.url().endsWith('/api/v1/designs')) {
      uploads += 1;
    }
    if (request.url().endsWith('/me/pet/registration')) {
      applied.push(request.postDataJSON().designId);
    }
  });
  await page.exposeFunction('holdFirstUploadResponse', async (status: number) => {
    uploadStatus = status;
    await delay;
  });
  await page.evaluate(() => {
    const fetchOriginal = window.fetch.bind(window);
    let firstUpload = true;
    window.fetch = async (input, init) => {
      const response = await fetchOriginal(input, init);
      if (firstUpload && init?.method === 'POST' && response.url.endsWith('/api/v1/designs')) {
        firstUpload = false;
        await (window as unknown as { holdFirstUploadResponse(status: number): Promise<void> }).holdFirstUploadResponse(response.status);
      }
      return response;
    };
  });
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('취소한 업로드');
  await dialog.locator('input[type=file]').setInputFiles(file);
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect.poll(() => uploadStatus).toBe(201);

  // 2. 요청 완료를 기다리지 않고 새 초안을 입력하고 이전 응답을 돌려준다.
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('새 업로드');
  await dialog.locator('input[type=file]').setInputFiles(file);
  release();
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('새 업로드');
  expect(applied).toHaveLength(0);

  // 3. 현재 초안만 정상 추가하고 취소한 요청의 외형은 대표 펫에 적용하지 않는다.
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('radio', { name: '새 업로드', exact: true })).toBeChecked();
  expect(uploads).toBe(2);
  expect(applied).toHaveLength(1);
});

for (const [width, height] of [[512, 512], [510, 333]]) {
  test(`일반 PNG ${width}×${height}는 애니메이션 설정을 펼치고 접어도 전체 그림으로 저장된다`, async ({ page, isolatedServer, browserName }) => {
    // 1. 이미지 전체에 다른 색을 넣어 한 칸으로 잘리는 문제를 실제 미리보기 픽셀로 검출한다.
    const failures: string[] = [];
    let reloading = false;
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') {
        failures.push(message.text());
      }
    });
    page.on('requestfailed', request => {
      // 명시적 새로고침이 취소한 이전 화면 요청만 제외하고 나머지 실패는 URL과 함께 남긴다.
      const error = request.failure()?.errorText || 'request failed';
      const reloadCancellation = browserName === 'webkit' ? 'cancelled' : 'net::ERR_ABORTED';
      if (!reloading || error !== reloadCancellation) {
        failures.push(`${error} ${request.url()}`);
      }
    });
    page.on('response', response => {
      if (response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });
    await workspace(page, isolatedServer);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const png = await page.evaluate(({ width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#e24b3b';
      context.fillRect(0, 0, width / 2, height);
      context.fillStyle = '#3e6ac4';
      context.fillRect(width / 2, 0, width / 2, height);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { width, height });
    await page.getByRole('button', { name: '펫 추가', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('전체 그림 PNG');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'static.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const preview = dialog.getByRole('img', { name: '추가할 펫의 모습', exact: true });
    await expect(preview).toBeVisible();
    const pixels = await preview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

    // 2. 설정 설명을 열어 보고 접어도 기본 분할·애니메이션을 생성하거나 적용하지 않는다.
    await dialog.locator('[data-animation-settings] > summary').click();
    await expect(dialog.locator('[name=frameWidth]')).toHaveValue('');
    await expect(dialog.locator('[data-animation-row]')).toHaveCount(0);
    await dialog.locator('[data-animation-settings] > summary').click();
    await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(pixels);
    await expect(dialog.locator('[data-preview-note]')).not.toHaveClass(/error/);
    await dialog.screenshot({ path: `/tmp/our-pets-static-png-${width}-${height}.png` });

    // 3. 실제 서버가 저장한 규격과 재진입한 수정 미리보기도 원본 전체 그림을 유지한다.
    const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/designs'));
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    const saved = await response;
    expect(saved.ok()).toBe(true);
    const design: Design = await saved.json();
    expect(design.manifest).toMatchObject({ schemaVersion: 1, frameWidth: width, frameHeight: height });
    expect(design.manifest.animations || {}).toEqual({});
    await expect(dialog).toBeHidden();
    reloading = true;
    await page.reload();
    await expect(page.getByRole('radio', { name: '전체 그림 PNG', exact: true })).toBeChecked();
    reloading = false;
    await page.getByRole('button', { name: '전체 그림 PNG 수정', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '펫 수정', exact: true });
    await expect(edit.getByRole('img', { name: '추가할 펫의 모습', exact: true })).toBeVisible();
    await edit.locator('[data-animation-settings] > summary').click();
    await expect(edit.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true })).not.toBeChecked();
    await expect.poll(() => edit.getByRole('img', { name: '추가할 펫의 모습', exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(pixels);
    await edit.getByRole('button', { name: '취소', exact: true }).click();
    expect(failures).toEqual([]);
  });
}

test('스프라이트 사용을 명시해야 기본값을 적용하고 사용 해제는 잘린 기존 펫을 전체 PNG로 복원한다', async ({ page, isolatedServer }) => {
  // 1. 파일을 고르기 전에 키보드로 설정을 열어도 정적 PNG 기본 상태를 유지한다.
  await workspace(page, isolatedServer);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const file = await sprite(page, 1024);
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.locator('[data-animation-settings] > summary').press('Enter');
  const enabled = dialog.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(dialog.locator('[data-animation-row]')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('분할 복원 확인');
  await dialog.locator('input[type=file]').setInputFiles(file);
  const preview = dialog.getByRole('img', { name: '추가할 펫의 모습', exact: true });
  await expect(preview).toBeVisible();
  const original = await preview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

  // 2. 명시적 사용만 예시 기본값을 채우고 끄기·다시 켜기·접기는 편집한 값을 지우지 않는다.
  await enabled.check();
  await expect(dialog.locator('[name=frameWidth]')).toHaveValue('256');
  await dialog.locator('[name=walkFrames]').fill('4,5');
  await dialog.locator('[name=walkFPS]').fill('6');
  await enabled.uncheck();
  await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(original);
  await enabled.check();
  await expect(dialog.locator('[name=walkFrames]')).toHaveValue('4,5');
  await expect(dialog.locator('[name=walkFPS]')).toHaveValue('6');
  await dialog.locator('[data-animation-settings] > summary').click();
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/designs'));
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  const animated: Design = await (await createdResponse).json();
  expect(animated.manifest).toMatchObject({ schemaVersion: 2, frameWidth: 256, frameHeight: 256, animations: { walk: { frames: [4, 5], fps: 6 } } });
  await expect(dialog).toBeHidden();

  // 3. 저장된 스프라이트를 다시 열어 사용을 끄면 잘못된 초안도 저장을 막거나 원본을 자르지 않는다.
  await page.getByRole('button', { name: '분할 복원 확인 수정', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '펫 수정', exact: true });
  await expect(edit.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true })).toBeChecked();
  await expect(edit.locator('[name=walkFPS]')).toHaveValue('6');
  await edit.locator('[name=frameWidth]').fill('300');
  await edit.locator('[name=walkFPS]').fill('99');
  await edit.getByRole('checkbox', { name: '스프라이트 시트 사용', exact: true }).uncheck();
  await expect(edit.locator('[name=walkFPS]')).toBeDisabled();
  await expect.poll(() => edit.getByRole('img', { name: '추가할 펫의 모습', exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(original);
  await edit.locator('[data-animation-settings] > summary').click();
  const updateResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/api/v1/designs/${animated.id}`));
  await edit.getByRole('button', { name: '저장', exact: true }).click();
  const saved = await updateResponse;
  expect(saved.ok()).toBe(true);
  const restored: Design = await saved.json();
  expect(restored.imageHash).toBe(animated.imageHash);
  expect(restored.manifest).toMatchObject({ schemaVersion: 1, frameWidth: 1024, frameHeight: 1024 });
  expect(restored.manifest.animations || {}).toEqual({});
  await expect(edit).toBeHidden();
});
