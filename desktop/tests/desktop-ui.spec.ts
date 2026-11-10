import { test, expect } from '@playwright/test';
import path from 'node:path';

test('계정과 펫 등록·즉시 선택·PNG 추가·설정 탐색', async ({ page }) => {
  // 1. 격리 서버에 새 계정을 만들고 펫 등록을 별도 단계로 완료한다.
  const username = `ui-${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('button', { name: /내 PC의 Docker/ })).toHaveCount(0);
  await expect(page.getByText('데스크톱 앱은 트레이에서 계속 실행됩니다.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '함께할 서버에 연결하기' })).toBeVisible();
  await page.getByRole('textbox', { name: '서버 주소' }).fill('http://127.0.0.1:19377');
  await page.getByRole('button', { name: '서버 연결', exact: true }).click();
  await page.getByRole('link', { name: '계정 만들기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '서버 주소' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '닉네임' })).toBeFocused();
  await page.getByRole('textbox', { name: '닉네임' }).fill('설정 테스트');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill(username);
  const password = page.getByLabel('비밀번호', { exact: true });
  await password.fill('test-password-123');
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '비밀번호 보기', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('test-password-123');
  await page.getByRole('button', { name: '비밀번호 숨기기', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByLabel('서버 가입 코드', { exact: true }).fill('test-only-invite');
  await page.getByRole('button', { name: /계정 만들고 펫 등록하기/ }).click();
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '펫 이름', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '등록 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: '등록 완료', exact: true })).toBeHidden();
  const login = await page.evaluate(() => JSON.parse(localStorage.getItem('ourpets.session')!));
  const headers = { Authorization: `Bearer ${login.token}` };
  const before = await page.request.get('http://127.0.0.1:19377/api/v1/me/pet', { headers });
  const original = await before.json();
  expect(original.registered).toBe(true);
  expect(original.name).toBe('설정 테스트');
  expect(original.ownerName).toBe('설정 테스트');

  // 발밑 이름표는 미리보기 메뉴를 열어도 펫·메뉴에 덮이지 않는다.
  const preview = page.locator('.pet-registration-preview-stage canvas');
  const nameplate = page.locator('.pet-registration-preview-stage .pet-nameplate');
  await preview.hover();
  await expect(nameplate).toBeVisible();
  const petBox = (await preview.boundingBox())!;
  const nameBox = (await nameplate.boundingBox())!;
  expect(nameBox.y).toBeGreaterThanOrEqual(petBox.y + petBox.height);
  await preview.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '펫 동작 미리보기' })).toBeVisible();
  await expect(nameplate).toBeVisible();
  const stageBox = (await page.locator('.pet-registration-preview-stage').boundingBox())!;
  expect(nameBox.y + nameBox.height).toBeLessThan(stageBox.y + stageBox.height);
  await page.keyboard.press('Escape');

  // 2. 저장 버튼 없이 외형을 바꾸고 안정적인 펫 ID가 유지되는지 확인한다.
  const applied = page.waitForResponse(response => response.url().endsWith('/api/v1/me/pet/registration') && response.request().method() === 'POST');
  await page.getByRole('radio', { name: '강아지', exact: true }).check();
  expect((await applied).ok()).toBe(true);
  await expect(page.getByRole('radio', { name: '강아지', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '변경 저장', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '받은 소식', exact: true })).toHaveCount(0);

  // 크기 양 끝과 네 가지 기본 펫을 실제 선택하고 페이지 재접속 후에도 적용을 보존한다.
  const size = page.getByRole('slider', { name: /펫 크기/ });
  await size.focus();
  await size.press('Home');
  await expect(size).toHaveValue('80');
  await expect.poll(() => preview.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(80);
  await size.press('End');
  await expect(size).toHaveValue('240');
  await expect.poll(() => preview.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(240);
  for (const name of ['고퍼', '페리스', '고양이']) {
    const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/me/pet/registration') && response.request().method() === 'POST');
    await page.getByRole('radio', { name, exact: true }).check();
    expect((await saved).ok()).toBe(true);
  }
  await page.reload();
  await expect(page.getByRole('radio', { name: '고양이', exact: true })).toBeChecked();
  await expect(page.getByRole('slider', { name: /펫 크기/ })).toHaveValue('240');

  // 3. 생성 프롬프트는 파일 설명 아래에만 두고 실제 PNG를 선택 목록에 추가한다.
  await expect(page.locator('.character-prompts')).toBeHidden();
  await page.getByRole('button', { name: '펫 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '펫 추가', exact: true });
  await dialog.locator('.character-prompts > summary').click();
  await expect(dialog.locator('[data-character-prompt-text]')).toHaveValue(/가는|가늘/);
  expect(await dialog.evaluate(element => {
    const guide = element.querySelector('.pet-upload-png-guide')!;
    const prompt = element.querySelector('.character-prompts')!;
    const animation = element.querySelector('[data-animation-settings]')!;
    return Boolean(guide.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(prompt.compareDocumentPosition(animation) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('테스트 PNG');
  await dialog.locator('input[type=file]').setInputFiles(path.resolve('src-tauri/icons/icon.png'));
  await expect(dialog.getByRole('img', { name: '추가할 펫의 모습' })).toBeVisible();
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('radio', { name: '테스트 PNG', exact: true })).toBeVisible();
  const after = await page.request.get('http://127.0.0.1:19377/api/v1/me/pet', { headers });
  expect((await after.json()).id).toBe(original.id);

  // 4. 탐색은 펫·알림만 제공하고 좁은 창에서도 가로로 넘치지 않는다.
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.getByRole('heading', { name: '알림', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '친구에게 보내기', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '펫', exact: true }).click();
  await page.setViewportSize({ width: 768, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // 탐색 폭은 마우스로 조절하고 접기·화면 이동·다시 읽기 후에도 선택을 유지한다.
  const handle = page.getByRole('separator', { name: '탐색 메뉴 너비' });
  const beforeWidth = Number(await handle.getAttribute('aria-valuenow'));
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(beforeWidth);
  await page.getByRole('button', { name: '탐색 메뉴 접기', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-collapsed', 'true');
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.getByRole('button', { name: '탐색 메뉴 펼치기', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '탐색 메뉴 펼치기', exact: true })).toBeVisible();
  expect(await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(760);
});
