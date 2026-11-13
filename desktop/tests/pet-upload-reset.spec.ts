import { expect, type Page } from '@playwright/test';
import { test } from './isolated-server';

// 실제 가입·등록 화면을 거쳐 펫 추가 작업을 시작한다.
async function workspace(page: Page, server: string): Promise<void> {
  // 1. 화면에서 선택한 서버에 새 계정으로 가입한다.
  await page.goto('/');
  await page.getByRole('textbox', { name: '서버 주소' }).fill(server);
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
  await page.getByRole('textbox', { name: '닉네임', exact: true }).fill('펫 추가 검사');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(`upload-${Date.now()}`);
  await page.getByLabel('비밀번호', { exact: true }).fill('test-password-123');
  await page.getByLabel('서버 가입 코드', { exact: true }).fill('test-only-invite');
  await page.getByRole('button', { name: /계정 만들고 펫 등록하기/ }).click();

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
  let release: (() => Promise<void>) | undefined;
  let uploads = 0;
  const applied: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/me/pet/registration')) {
      applied.push(request.postDataJSON().designId);
    }
  });
  await page.route('**/api/v1/designs', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    uploads += 1;
    const response = await route.fetch();
    if (uploads === 1) {
      release = () => route.fulfill({ response });
      return;
    }
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('취소한 업로드');
  await dialog.locator('input[type=file]').setInputFiles(file);
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);

  // 2. 요청 완료를 기다리지 않고 새 초안을 입력하고 이전 응답을 돌려준다.
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('새 업로드');
  await dialog.locator('input[type=file]').setInputFiles(file);
  await release!();
  await expect(dialog.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('새 업로드');
  expect(applied).toHaveLength(0);

  // 3. 현재 초안만 정상 추가하고 취소한 요청의 외형은 대표 펫에 적용하지 않는다.
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('radio', { name: '새 업로드', exact: true })).toBeChecked();
  expect(uploads).toBe(2);
  expect(applied).toHaveLength(1);
});
