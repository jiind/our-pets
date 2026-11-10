import { test, expect } from '@playwright/test';

test('미리보기의 우클릭·키보드 메뉴와 왼쪽 클릭 쓰다듬기', async ({ page }) => {
  // 1. 실제 미리보기 메뉴 모듈을 독립 Canvas에 연결해 LAN·OS 알림과 분리한다.
  await page.goto('/');
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 제공하는 소스 모듈 URL이다.
    const { mountPetPreviewMenu } = await import('/src/pet-preview-menu.ts');
    const stage = document.createElement('section');
    stage.id = 'interaction-fixture';
    stage.innerHTML = '<canvas width="160" height="160" aria-label="동작 확인용 펫"></canvas><button type="button" data-outside>바깥 영역</button>';
    document.body.replaceChildren(stage);
    const menu = mountPetPreviewMenu(stage.querySelector('canvas')!, stage, (action: string) => stage.dataset.action = action);
    Object.assign(window, { disposePreview: menu.dispose });
  });
  const stage = page.locator('#interaction-fixture');
  const pet = stage.getByRole('button', { name: '동작 확인용 펫' });
  const menu = stage.getByRole('menu', { name: '펫 동작 미리보기' });

  // 2. 왼쪽 클릭은 쓰다듬고 우클릭은 메뉴를 열어 동작을 선택한다.
  await pet.click();
  await expect(stage).toHaveAttribute('data-action', 'pat');
  await expect(menu).toBeHidden();
  await pet.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '👋 인사하기' }).click();
  await expect(stage).toHaveAttribute('data-action', 'wave');
  await expect(menu).toBeHidden();
  await expect(pet).toBeFocused();

  // 3. 키보드 열기·Escape·배경 클릭과 해제 시 이벤트 정리를 확인한다.
  await pet.press('Enter');
  await expect(menu.getByRole('menuitem', { name: '대기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await pet.click({ button: 'right' });
  await stage.getByRole('button', { name: '바깥 영역' }).click();
  await expect(menu).toBeHidden();
  await page.evaluate(() => (window as unknown as { disposePreview(): void }).disposePreview());
  await expect(menu).toHaveCount(0);
});
