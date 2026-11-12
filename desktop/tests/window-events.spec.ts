import { test, expect } from '@playwright/test';

test('펫별 이동·높이·호버·닫기 이벤트는 자기 창만 구독한다 · IPC 계약', async ({ page }) => {
  // 1. 실제 펫 모듈과 공식 IPC 모의로 친구 창의 이벤트 등록 대상만 수집한다.
  await page.goto('/');
  const listeners = await page.evaluate(async () => {
    // @ts-expect-error Vite가 브라우저에 제공하는 공식 Tauri 테스트 모듈이다.
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js');
    // @ts-expect-error Vite가 브라우저에 제공하는 실제 펫 모듈이다.
    const { mountPet } = await import('/src/pet.ts');
    const calls: { event: string; target: { kind: string; label?: string } }[] = [];
    mockWindows(`peer-${'a'.repeat(32)}`);
    Object.assign(window, { isTauri: true });
    mockIPC((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'plugin:event|listen') {
        calls.push({ event: String(args.event), target: args.target as { kind: string; label?: string } });
        return args.handler;
      }
      if (cmd === 'desktop_state') {
        return { visible: true, showOthers: true, petSize: 160 };
      }
      return undefined;
    });
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = await mountPet(root, false, 'a'.repeat(32));
    dispose();
    root.remove();
    return calls;
  });

  // 2. 개별 상태는 창에 한정하고 두 펫의 공통 반응·계정 변경은 앱 전체 수신을 유지한다.
  const own = { kind: 'Window', label: `peer-${'a'.repeat(32)}` };
  for (const event of ['tauri://move', 'gathering-overflow', 'pet-hover', 'pet-motion', 'pet-elevation', 'dismiss-pet-menu', 'pair-motion-cancelled', 'sender-message-bubble', 'focus-pet-menu', 'focus-live-bubble', 'retry-pet-connection']) {
    expect(listeners.find(listener => listener.event === event)?.target, event).toEqual(own);
  }
  for (const event of ['pair-reaction', 'session-changed', 'gatherings-changed', 'outgoing-message']) {
    expect(listeners.find(listener => listener.event === event)?.target, event).toEqual({ kind: 'Any' });
  }
});
