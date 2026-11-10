import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface DesktopPreferences {
  visible: boolean;
  showOthers: boolean;
  petSize: number;
}
const key = 'ourpets.desktop-preferences';
let current: DesktopPreferences = { visible: true, showOthers: true, petSize: 160 };
const subscribers = new Set<(preferences: DesktopPreferences) => void>();

// 현재 설정을 적용하고 이 창의 표시 UI와 펫 크기를 함께 갱신한다.
function apply(preferences: DesktopPreferences): void {
  current = preferences;
  localStorage.setItem(key, JSON.stringify(preferences));
  subscribers.forEach(listener => listener(current));
}

// 앱·트레이의 실제 공유 상태를 읽고 브라우저에서는 로컬 설정만 사용한다.
export async function displayPreferences(): Promise<DesktopPreferences> {
  if (isTauri()) {
    apply(await invoke<DesktopPreferences>('desktop_state'));
  } else {
    try {
      apply({ ...current, ...JSON.parse(localStorage.getItem(key) || '{}') });
    } catch {
      apply(current);
    }
  }
  return current;
}

// 표시·다른 펫·크기 변경을 전달하고 연속 크기 입력은 파일 저장 없이 미리 반영한다.
export async function updateDisplay(values: Partial<DesktopPreferences>, persist = true): Promise<void> {
  if (isTauri()) {
    await invoke('set_desktop_preferences', { visible: values.visible ?? null, showOthers: values.showOthers ?? null, petSize: values.petSize ?? null, persist });
  } else {
    apply({ ...current, ...values });
  }
}

// 각 창의 화면 수명에 맞춰 설정 변경 구독을 등록하고 해제한다.
export async function watchDisplay(listener: (preferences: DesktopPreferences) => void): Promise<() => void> {
  // 1. 초기 구독과 조회가 실패하면 이미 만든 구독도 함께 정리한다.
  subscribers.add(listener);
  let unlisten = (): void => {};
  try {
    unlisten = isTauri() ? await listen<DesktopPreferences>('desktop-preferences-changed', event => apply(event.payload)) : (): void => {};
    listener(await displayPreferences());
  } catch (error) {
    subscribers.delete(listener);
    unlisten();
    throw error;
  }

  // 2. 정상 초기화 뒤에는 화면이 끝날 때 공유 구독을 해제한다.
  return () => {
    subscribers.delete(listener);
    unlisten();
  };
}
