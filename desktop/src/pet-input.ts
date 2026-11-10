import { invoke, isTauri } from '@tauri-apps/api/core';

let pending = Promise.resolve();

// 메뉴와 작성창이 요청하는 포커스 변경을 순서대로 적용한다.
export function setPetInput(active: boolean, preview = false): Promise<void> {
  if (!isTauri() || preview) {
    return Promise.resolve();
  }
  pending = pending.catch(() => {}).then(async () => {
    await invoke('set_pet_input', { active });
  });
  return pending;
}
