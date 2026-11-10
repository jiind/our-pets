import { describe, expect, it } from 'vitest';
import { animationKey, clickAnimations, randomClickAnimation } from './pet-animations';
import type { Manifest } from './types';

// 표시 이름과 자동 동작 ID가 서로 다른 사용자 애니메이션 목록을 만든다.
function customManifest(): Manifest {
  return { schemaVersion: 2, displaySize: 160, frameWidth: 32, frameHeight: 32, idleAnimation: 'rest', walkAnimation: 'stride', animations: {
    rest: { name: '쉬기', frames: [0], fps: 4 },
    stride: { name: '걸어가기', frames: [1], fps: 8 },
    dance: { name: '춤추기', frames: [2,3], fps: 6 },
    jump: { name: '점프', frames: [3,2], fps: 8 },
  } };
}

describe('사용자 애니메이션 역할과 클릭 재생', () => {
  it('사용자 이름과 무관하게 지정한 대기·걷기만 랜덤 대상에서 제외한다', () => {
    const manifest = customManifest();
    expect(clickAnimations(manifest).map(item => item.id)).toEqual(['dance', 'jump']);
    expect(randomClickAnimation(manifest, () => 0)?.id).toBe('dance');
    expect(randomClickAnimation(manifest, () => .999)?.id).toBe('jump');
    manifest.walkAnimation = 'dance';
    expect(clickAnimations(manifest).map(item => item.id)).toEqual(['stride', 'jump']);
  });
  it('자동 대기·보행과 직접 지정한 미리보기 항목을 구분한다', () => {
    const manifest = customManifest();
    expect(animationKey(manifest, 'idle')).toBe('rest');
    expect(animationKey(manifest, 'walk')).toBe('stride');
    expect(animationKey(manifest, 'react', 'jump')).toBe('jump');
    expect(animationKey(manifest, 'react', 'rest')).toBe('rest');
    expect(animationKey(manifest, 'react')).toBe('dance');
  });
  it('기존 세 동작은 호환하고 클릭용 동작이 없으면 랜덤 선택을 만들지 않는다', () => {
    const manifest = customManifest();
    manifest.animations = { idle: { frames: [0], fps: 4 }, walk: { frames: [1], fps: 8 }, react: { frames: [2], fps: 6 } };
    delete manifest.idleAnimation;
    delete manifest.walkAnimation;
    expect(randomClickAnimation(manifest)?.id).toBe('react');
    delete manifest.animations.react;
    expect(randomClickAnimation(manifest)).toBeUndefined();
    manifest.animations = {};
    expect(animationKey(manifest, 'walk')).toBeUndefined();
    expect(randomClickAnimation(manifest)).toBeUndefined();
  });
});
