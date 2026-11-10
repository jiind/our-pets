import { test, expect } from '@playwright/test';

test('로그인한 알림 설정 · IPC 모의: 비밀값을 일반 저장소와 서버에 남기지 않는다', async ({ page }) => {
  // 1. 실제 브라우저 UI에 Tauri 공식 IPC 모의를 연결하고 서버 전송을 관찰한다.
  const serverRequests: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/')) {
      serverRequests.push(request.url());
    }
  });
  const response = await page.request.post('http://127.0.0.1:19377/api/v1/register', {
    data: { username: `ipc-${Date.now()}`, password: 'test-password-123', displayName: '개인 연결 테스트', invite: 'test-only-invite' },
  });
  expect(response.ok()).toBe(true);
  const login = await response.json();
  await page.addInitScript(value => {
    localStorage.setItem('ourpets.server', 'http://127.0.0.1:19377');
    localStorage.setItem('ourpets.session', JSON.stringify(value));
  }, login);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '펫', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    // @ts-expect-error Vite가 공식 Tauri 테스트 모듈을 제공한다.
    const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js');
    const sources: Record<string, unknown>[] = [];
    let nextSource = 0;
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, { isTauri: true, localTestCalls: calls });
    mockIPC((cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'system_notification_settings') {
        return { enabled: false, permission: 'denied' };
      }
      if (cmd.startsWith('plugin:event|')) {
        return 1;
      }
      if (cmd === 'local_list_sources') {
        return structuredClone(sources);
      }
      if (cmd === 'local_save_source') {
        const draft = args.draft as Record<string, unknown>;
        const id = String(draft.id || `local-${nextSource++}`);
        const source = { id, name: draft.name, config: draft.config, enabled: true, state: 'connected', lastError: '' };
        const previous = sources.findIndex(item => item.id === id);
        if (previous >= 0) {
          sources[previous] = source;
        } else {
          sources.push(source);
        }
        return source;
      }
      if (cmd === 'local_enable_source') {
        const source = sources.find(item => item.id === args.id)!;
        source.enabled = args.enabled;
        source.state = args.enabled ? 'connected' : 'disabled';
        return;
      }
      if (cmd === 'local_remove_source') {
        sources.splice(sources.findIndex(item => item.id === args.id), 1);
        return;
      }
      if (cmd === 'local_notifications') {
        return [{ id: 'local:fixture', type: 'notification', kind: 'external', body: '', local: true, createdAt: Date.now(), expiresAt: Date.now() + 60000, notification: { title: 'Docker · 내 컨테이너', body: '테스트 이벤트', sourceKind: 'docker' } }];
      }
      if (cmd === 'pet_control') {
        return;
      }
      throw new Error(`예상하지 않은 IPC: ${cmd}`);
    });
  });
  await page.getByRole('button', { name: '알림', exact: true }).click();
  await expect(page.locator('#personal-history')).toHaveCount(0);
  await page.getByRole('button', { name: '연결 추가', exact: true }).click();

  // 2. 자기 Docker를 설정하고 중지·재개·수정을 실제 폼과 버튼으로 수행한다.
  const docker = page.locator('#local-docker-form');
  await docker.locator('[name=name]').fill('개인 엔진');
  await docker.locator('summary').click();
  await docker.locator('[name=containers]').fill('my-api,my-worker');
  await docker.getByRole('button', { name: 'Docker 연결 저장' }).click();
  const dockerCard = page.locator('[data-source-id]').filter({ hasText: '개인 엔진' });
  await expect(dockerCard).toContainText('수신 중');
  await dockerCard.getByRole('button', { name: '수신 중지' }).click();
  await expect(dockerCard).toContainText('중지됨');
  await dockerCard.getByRole('button', { name: '다시 연결' }).click();
  await dockerCard.getByRole('button', { name: '수정', exact: true }).click();
  await expect(docker.locator('[name=containers]')).toHaveValue('my-api,my-worker');
  await docker.locator('[name=name]').fill('개인 엔진 수정');
  await docker.getByRole('button', { name: 'Docker 연결 저장' }).click();
  await expect(page.locator('[data-source-id]')).toHaveCount(1);

  // 3. Slack 토큰은 네이티브 비밀 인자로만 보내며 목록·로컬 저장소·서버에 남기지 않는다.
  await page.getByRole('button', { name: '연결 추가', exact: true }).click();
  await page.locator('[data-provider=slack]').click();
  const slack = page.locator('#local-slack-form');
  await slack.locator('[name=name]').fill('개인 워크스페이스');
  await slack.locator('[name=teamId]').fill('T123');
  await slack.locator('[name=channels]').fill('C123,D123');
  await slack.locator('[name=appToken]').fill('xapp-local-ui-test');
  await slack.locator('summary').click();
  await slack.locator('[value=reaction_removed]').uncheck();
  await slack.getByRole('button', { name: 'Slack 연결 저장' }).click();
  await expect(page.locator('[data-source-id]')).toHaveCount(2);
  await expect(page.locator('.connector-dialog')).toBeHidden();
  await expect(slack.locator('[name=appToken]')).toHaveValue('');
  expect(await page.locator('#local-source-list').textContent()).not.toContain('xapp-local-ui-test');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('xapp-local-ui-test');
  expect(serverRequests).toHaveLength(0);
  const drafts = await page.evaluate(() => {
    const calls = (window as unknown as { localTestCalls: { cmd: string; args: { draft?: Record<string, unknown> } }[] }).localTestCalls;
    return calls.filter(call => call.cmd === 'local_save_source').map(call => call.args.draft!);
  });
  expect(drafts[0].config).toMatchObject({ kind: 'docker', endpoint: 'local', containers: ['my-api', 'my-worker'] });
  expect(drafts[2].appToken).toBe('xapp-local-ui-test');
  expect(drafts[2].config).toEqual({ kind: 'slack', teamId: 'T123', channels: ['C123', 'D123'], eventTypes: ['message', 'app_mention', 'reaction_added'] });
  await page.locator('[data-source-id]').filter({ hasText: '개인 워크스페이스' }).getByRole('button', { name: '연결 삭제' }).click();
  await expect(page.locator('[data-source-id]')).toHaveCount(1);
});
