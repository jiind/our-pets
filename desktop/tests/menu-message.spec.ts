import { test, expect } from '@playwright/test';

test('메뉴 메시지 모의 콜백 실패·지연·성공에서 재시도와 발송 제한을 유지한다', async ({ page }) => {
  // 1. 실제 메뉴 메시지 모듈을 테스트용 메뉴에 연결하고 전송 응답만 실패·지연·성공으로 모의한다.
  await page.goto('/');
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 제공하는 소스 모듈 URL이다.
    const { mountMenuMessage } = await import('/src/pet-menu-message.ts');
    const menu = document.createElement('section');
    menu.innerHTML = '<form class="pet-menu-message"><input name="body" required><button type="submit">전송</button><p role="status" hidden></p></form>';
    document.body.replaceChildren(menu);
    menu.hidden = false;
    let resolvePending: (() => void) | undefined;
    const calls: { body: string; recipient?: string }[] = [];
    let attempt = 0;
    const mounted = mountMenuMessage(menu, false, 'pet-fixed-42', async (body: string, recipient?: string) => {
      calls.push({ body, recipient });
      attempt += 1;
      if (attempt === 1) {
        throw new Error('일시적인 전송 오류');
      }
      if (attempt === 2) {
        await new Promise<void>(resolve => {
          resolvePending = resolve;
        });
      }
    }, async () => undefined, () => {
      menu.hidden = true;
      menu.dataset.closed = 'true';
    });
    Object.assign(window, {
      menuMessageFixture: { menu, mounted, calls, resolvePending: () => resolvePending?.() },
    });
    const previewMenu = document.createElement('section');
    previewMenu.innerHTML = '<form class="pet-menu-message"><input name="body" required><button type="submit">미리보기 전송</button><p role="status" hidden></p></form>';
    document.body.append(previewMenu);
    const previewMounted = mountMenuMessage(previewMenu, true, undefined, async () => {
      throw new Error('미리보기 전송 callback은 호출되면 안 됩니다.');
    }, async () => undefined, () => {
      previewMenu.hidden = true;
    });
    Object.assign(window, { previewMessageFixture: { menu: previewMenu, mounted: previewMounted } });
  });

  // 2. 실패한 전송은 본문·오류를 남기고 재시도해도 처음 정한 수신자 ID를 유지한다.
  const input = page.locator('section').first().locator('.pet-menu-message input');
  const submit = page.getByRole('button', { name: '전송', exact: true });
  const menu = page.locator('section').first();
  await input.fill('다시 보내야 할 메시지');
  await submit.click();
  await expect(input).toHaveValue('다시 보내야 할 메시지');
  await expect(input).toHaveAttribute('aria-label', '이 친구에게만 보낼 메시지');
  await expect(menu.getByRole('status')).toHaveText('일시적인 전송 오류');

  // 3. 지연 중에는 입력을 읽기 전용·전송 비활성으로 두고 성공 후 비운 뒤 메뉴를 닫는다.
  await submit.click();
  await expect(input).toHaveAttribute('readonly', '');
  await expect(submit).toBeDisabled();
  await page.evaluate(() => (window as unknown as { menuMessageFixture: { resolvePending(): void } }).menuMessageFixture.resolvePending());
  await expect(input).toHaveValue('');
  await expect(menu).toBeHidden();
  const calls = await page.evaluate(() => (window as unknown as { menuMessageFixture: { calls: { body: string; recipient?: string }[] } }).menuMessageFixture.calls);
  expect(calls).toEqual([
    { body: '다시 보내야 할 메시지', recipient: 'pet-fixed-42' },
    { body: '다시 보내야 할 메시지', recipient: 'pet-fixed-42' },
  ]);

  // 4. 오프라인 상대는 입력·제출을 막고, 미리보기는 발송 불가 상태와 안내 문구를 표시한다.
  await page.evaluate(() => {
    const fixture = (window as unknown as { menuMessageFixture: { mounted: { setOffline(value: boolean): void }; menu: HTMLElement } }).menuMessageFixture;
    fixture.menu.hidden = false;
    fixture.menu.dataset.closed = '';
    fixture.mounted.setOffline(true);
  });
  await expect(input).toBeDisabled();
  await expect(submit).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { menuMessageFixture: { calls: unknown[] } }).menuMessageFixture.calls)).toHaveLength(2);
  const previewInput = page.getByRole('textbox', { name: '전체 펫에게 보낼 메시지' });
  const previewSubmit = page.getByRole('button', { name: '미리보기 전송' });
  await expect(previewInput).toBeDisabled();
  await expect(previewSubmit).toBeDisabled();
  await expect(previewSubmit).toHaveAttribute('title', '메시지는 데스크톱 펫에서 보낼 수 있어요.');
});
