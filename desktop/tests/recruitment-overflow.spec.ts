import { expect, test } from '@playwright/test';

test('모집 미표시 인원 갱신은 동일 상태의 포커스를 보존하고 초기화·종료를 반영한다 · 컴포넌트 계약', async ({ page }) => {
  // 1. 네트워크 요청 없이 실제 모집 컴포넌트에 명시적인 모집 스냅샷을 제공한다.
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(request.failure()?.errorText || 'request failed'));
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 제공하는 실제 모집 모듈이다.
    const { mountRecruitment } = await import('/src/recruitment.ts');
    localStorage.setItem('ourpets.session', JSON.stringify({ token: 'fixture-only', principal: { petId: 'host', deviceId: 'fixture' } }));
    const root = document.createElement('div');
    root.className = 'pet-stage';
    document.body.append(root);
    let groups = [{ id: 'fixture-coffee', hostPetId: 'host', kind: 'coffee', origin: 'recruitment', status: 'open', members: [1, 2, 3].map(index => ({ petId: `friend-${index}`, userName: `친구 ${index}` })), expiresAt: Date.now() + 60000 }];
    const recruitment = mountRecruitment(root, true, undefined, () => [], () => groups, async (next: typeof groups) => {
      groups = next;
    }, () => undefined, () => undefined);
    recruitment.update();
    recruitment.open();

    // 2. 동일 수신값은 열린 패널의 버튼과 사용자 포커스를 다시 만들지 않는다.
    recruitment.setOverflow(2);
    const panel = root.querySelector<HTMLElement>('.recruitment-panel')!;
    const button = panel.querySelector<HTMLButtonElement>('[data-recruitment-action=complete]')!;
    button.focus();
    recruitment.setOverflow(2);
    const stable = panel.querySelector('[data-recruitment-action=complete]') === button && document.activeElement === button;
    const badge = root.querySelector<HTMLElement>('.recruitment-badge')!;
    const announced = badge.getAttribute('aria-label');
    const explained = panel.textContent;

    // 3. 잘못된 수치와 모집 종료는 오래된 미표시 안내를 남기지 않는다.
    recruitment.setOverflow(Number.NaN);
    const reset = !badge.textContent!.includes('미표시');
    recruitment.setOverflow(Number.POSITIVE_INFINITY);
    const finite = !badge.textContent!.includes('Infinity') && !badge.textContent!.includes('NaN');
    groups = [];
    recruitment.update();
    const closed = badge.hidden && panel.hidden;
    recruitment.dispose();
    recruitment.setOverflow(3);
    const disposed = root.querySelector('.recruitment-badge') === null;
    root.remove();
    localStorage.removeItem('ourpets.session');
    return { stable, announced, explained, reset, finite, closed, disposed };
  });

  // 4. 안내 내용과 입력 안정성은 네이티브 배치 검증과 별도 계약으로 확인한다.
  expect(result.stable).toBe(true);
  expect(result.announced).toContain('2명은 화면에 표시되지 않지만 참여 중');
  expect(result.explained).toContain('2명은 표시되지 않지만 계속 참여 중');
  expect(result.reset).toBe(true);
  expect(result.finite).toBe(true);
  expect(result.closed).toBe(true);
  expect(result.disposed).toBe(true);
  expect(errors).toEqual([]);
});
