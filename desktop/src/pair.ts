import { invoke, isTauri } from '@tauri-apps/api/core';
import { session } from './api';

export interface PairReaction {
  fromID: string;
  toID: string;
  body: 'wave' | 'highfive';
  leftID?: string;
  startedAtUnixMs?: number;
  approachMs?: number;
  holdMs?: number;
  returnMs?: number;
}

// 양쪽 펫의 표현과 네이티브 접근·복귀 이동을 같은 로컬 이벤트로 시작한다.
export async function playPair(pair: PairReaction): Promise<void> {
  // 1. 네이티브가 양쪽 위치와 입력 상태를 확인한 다음 공통 시작 시각을 발행한다.
  if (isTauri()) {
    await invoke('animate_pair', { localPetId: session()?.principal.petId, fromId: pair.fromID, toId: pair.toID, action: pair.body, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  } else {
    // 2. 브라우저 미리보기에서도 같은 시간 규약으로 두 펫의 포즈를 시작한다.
    window.dispatchEvent(new CustomEvent('pair-reaction', { detail: { ...pair, startedAtUnixMs: Date.now(), approachMs: 800, holdMs: 1400, returnMs: 1000 } }));
  }
}
