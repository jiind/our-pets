import type { Animation, Manifest } from './types';

// 기존 세 동작과 자유 목록에서 자동 대기·이동에 연결된 항목을 같은 방식으로 찾는다.
export function animationKey(manifest: Manifest, action: 'idle' | 'walk' | 'react', selected?: string): string | undefined {
  // 1. 직접 미리보거나 클릭한 항목은 자동 이동 역할보다 우선한다.
  if (selected && manifest.animations[selected]?.frames.length) {
    return selected;
  }
  const idle = manifest.idleAnimation || 'idle';
  const walk = manifest.walkAnimation || 'walk';
  if (action === 'react') {
    const reaction = clickAnimations(manifest);
    return reaction.find(item => item.id === 'react')?.id || reaction[0]?.id || (manifest.animations[idle] ? idle : undefined);
  }

  // 2. 누락된 이동은 대기로 대체하고 완전히 비어 있으면 첫 이미지로 돌아간다.
  const key = action === 'walk' ? walk : idle;
  return manifest.animations[key] ? key : manifest.animations[idle] ? idle : undefined;
}

// 자동 대기·걷기에 지정된 항목을 빼고 클릭으로 재생할 등록 동작만 반환한다.
export function clickAnimations(manifest: Manifest): { id: string; animation: Animation }[] {
  const idle = manifest.idleAnimation || 'idle';
  const walk = manifest.walkAnimation || 'walk';
  return Object.entries(manifest.animations).flatMap(([id, animation]) => id !== idle && id !== walk && animation?.frames.length ? [{ id, animation }] : []);
}

// 클릭 시 한 번만 뽑아 프레임마다 재생 대상이 바뀌지 않게 한다.
export function randomClickAnimation(manifest: Manifest, random = Math.random): { id: string; animation: Animation } | undefined {
  const choices = clickAnimations(manifest);
  return choices.length ? choices[Math.min(choices.length - 1, Math.floor(Math.max(0, random()) * choices.length))] : undefined;
}
