import { gsap } from 'gsap';
import type { CharacterPose } from './character';

export type Gesture = 'wave' | 'highfive' | 'pat';

// 접근·반응·복귀 시점에 맞춰 서로 다른 펫 동작을 하나의 취소 가능한 타임라인으로 구성한다.
export function reactionTimeline(target: gsap.TweenTarget, action: Gesture, paused = false): gsap.core.Timeline {
  // 1. 이전 변형을 지우고 공통 시점과 easing을 선언한다.
  const timeline = gsap.timeline({ paused, defaults: { ease: 'power2.inOut' } });
  timeline.set(target, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, 0);
  timeline.addLabel('approach', 0).addLabel('greet', .8).addLabel('settle', 2.2);

  // 2. 인사는 반복 기울임, 하이파이브는 준비·점프·착지, 쓰다듬기는 작은 흔들림을 사용한다.
  if (action === 'wave') {
    timeline.to(target, { x: -6, rotation: -7, duration: .2 }, 'greet');
    timeline.to(target, { x: 6, rotation: 7, duration: .22, repeat: 3, yoyo: true }, 1);
    timeline.to(target, { x: 0, rotation: 0, duration: .22 }, 1.88);
  } else if (action === 'highfive') {
    timeline.to(target, { scaleX: 1.06, scaleY: .9, duration: .18 }, 'greet');
    timeline.to(target, { y: -22, scaleX: .97, scaleY: 1.06, duration: .42, ease: 'power2.out' }, .98);
    timeline.to(target, { y: -22, duration: .15 }, 1.4);
    timeline.to(target, { y: 0, scaleX: 1.06, scaleY: .94, duration: .35, ease: 'power2.in' }, 1.55);
    timeline.to(target, { scaleX: 1, scaleY: 1, duration: .2 }, 1.9);
  } else {
    timeline.to(target, { rotation: -3, duration: .15 }, .1);
    timeline.to(target, { rotation: 3, duration: .18, repeat: 5, yoyo: true }, .25);
    timeline.to(target, { rotation: 0, duration: .2 }, 1.33);
  }
  timeline.to(target, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, duration: .3 }, 3);
  return timeline;
}

// 펫과 해당 창의 카드만 관리하고 미디어 설정 변경·재생 중단·화면 해제 시 효과를 정리한다.
export function petMotion(canvas: HTMLCanvasElement, root: HTMLElement): { react: (action: Gesture) => void; reveal: (element: HTMLElement) => void; stop: () => void; dispose: () => void; pose: CharacterPose } {
  // 1. 실제 요소 참조와 창별 미디어 컨텍스트로 다른 펫의 효과를 건드리지 않는다.
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  let reaction: gsap.core.Timeline | undefined;
  const cards = new Map<HTMLElement, gsap.core.Tween>();
  let reduced = true;
  const media = gsap.matchMedia();

  // 현재 창에서 시작한 효과만 중단하고 클릭 영역과 CSS 기본 배치를 복구한다.
  function reset(): void {
    reaction?.kill();
    reaction = undefined;
    cards.forEach(tween => tween.kill());
    cards.forEach((_, element) => gsap.set(element, { clearProps: 'transform,opacity,visibility' }));
    cards.clear();
    Object.assign(pose, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    gsap.set(canvas, { clearProps: 'transform' });
  }
  media.add({ normal: '(prefers-reduced-motion: no-preference)', reduced: '(prefers-reduced-motion: reduce)' }, context => {
    reduced = !!context.conditions?.reduced;
    return reset;
  }, root);

  // 2. 같은 대상의 새 동작은 이전 동작을 취소하고 즉시 시작한다.
  return {
    pose,
    // 새 펫 동작은 이전 타임라인을 교체해 겹치는 변형을 방지한다.
    react: action => {
      reaction?.kill();
      gsap.set(canvas, { clearProps: 'transform' });
      reaction = reduced ? undefined : reactionTimeline(pose, action);
    },
    // 메뉴와 말풍선은 시작 순간부터 포커스·클릭을 허용하며 짧게 등장한다.
    reveal: element => {
      cards.get(element)?.kill();
      if (reduced) {
        gsap.set(element, { clearProps: 'transform,opacity,visibility' });
        return;
      }
      const tween = gsap.fromTo(element, { autoAlpha: .01, y: 7 }, { autoAlpha: 1, y: 0, duration: .18, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform,opacity,visibility' });
      cards.set(element, tween);
    },
    // 드래그·숨김 등 직접 조작은 진행 중인 효과를 즉시 정리한다.
    stop: reset,
    // 창이나 미리보기가 사라질 때 미디어 리스너까지 해제한다.
    dispose: () => {
      reset();
      media.revert();
    },
  };
}


// 기능 전환은 작은 이동으로 관계를 표시하고 다음 전환·설정 변경에서 효과를 해제한다.
export function viewMotion(root: HTMLElement): () => void {
  const media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.fromTo(root, { autoAlpha: .01, y: 6 }, { autoAlpha: 1, y: 0, duration: .18, ease: 'power2.out', clearProps: 'transform,opacity,visibility' });
  }, root);
  return () => media.revert();
}
