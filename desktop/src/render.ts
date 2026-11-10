import type { Design } from './types';
import type { CharacterState } from './character';
import { defaultPetAnchors, drawDefaultPet } from './default-pet';
import { builtinID, builtinAnchors, drawBuiltinPet, type BuiltinPetID } from './builtin-pets';

const renderedBuiltin = new WeakMap<HTMLCanvasElement, BuiltinPetID>();

const animationClocks = new WeakMap<HTMLCanvasElement, { key: string; started: number }>();
const walkClocks = new WeakMap<HTMLCanvasElement, { design: string; distance: number; progress: number }>();

// 사용자 스프라이트도 동작 시작 시각과 실제 이동 거리로 프레임을 선택한다.
function animationFrame(canvas: HTMLCanvasElement, design: Design, action: 'idle' | 'walk' | 'react', time: number, state: CharacterState): number {
  // 1. 디자인·동작이 바뀌면 별도의 재생 시계를 처음부터 시작한다.
  const animation = design.manifest.animations[action] || design.manifest.animations.idle;
  let walk = walkClocks.get(canvas);
  if (state.distance !== undefined) {
    if (!walk || walk.design !== design.id) {
      walk = { design: design.id, distance: state.distance, progress: 0 };
      walkClocks.set(canvas, walk);
    }
    const delta = state.distance - walk.distance;
    if (Number.isFinite(delta) && delta >= 0 && action === 'walk') {
      walk.progress += delta / Math.max(18, canvas.width * .22) * (animation?.fps || 1);
    } else if (delta < 0) {
      walk.progress = 0;
    }
    walk.distance = state.distance;
  }
  if (!animation?.frames.length) {
    return 0;
  }
  const key = `${design.id}/${action}/${state.gesture || ''}`;
  let clock = animationClocks.get(canvas);
  if (!clock || clock.key !== key || time < clock.started || (clock.started === 0 && time > 0)) {
    clock = { key, started: time };
    animationClocks.set(canvas, clock);
  }

  // 2. 보행은 실제 거리로 진행하고 다른 동작은 해당 동작의 경과 시간만 사용한다.
  if (action === 'walk' && state.distance !== undefined) {
    return animation.frames[Math.floor(walk?.progress || 0) % animation.frames.length];
  }
  const elapsed = action === 'react' && state.elapsed !== undefined ? state.elapsed : time - clock.started;
  return animation.frames[Math.floor(Math.max(0, elapsed) * animation.fps / 1000) % animation.frames.length];
}

// 요청한 동작의 프레임을 그리고 누락된 동작은 대기 또는 첫 이미지로 대체한다.
export function drawPet(canvas: HTMLCanvasElement, image: HTMLImageElement | null, design: Design | null, action: 'idle' | 'walk' | 'react', time: number, state: CharacterState = {}): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  if (!image || !design) {
    const builtin = builtinID(state.builtin);
    renderedBuiltin.set(canvas, builtin);
    if (builtin !== 'cat') {
      return drawBuiltinPet(canvas, builtin, time, state);
    }
    const height = drawDefaultPet(canvas, time, { ...state, walking: state.walking ?? action === 'walk' });
    if (height !== undefined) {
      return height;
    }
    // 2D 원화가 준비되면 같은 렌더러의 대기 요청이 실제 캐릭터를 표시한다.
    return size;
  }
  const m = design.manifest;
  const pairMoving = action === 'react' && state.paired && state.walking && ((state.elapsed || 0) < 800 || (state.elapsed || 0) >= 2200);
  const frame = animationFrame(canvas, design, pairMoving ? 'walk' : action, time, state);
  const columns = image.naturalWidth / m.frameWidth;
  const crop = imageBounds(image, design);
  const ratio = Math.min(size / crop.width, size / crop.height);
  const w = crop.width * ratio;
  const h = crop.height * ratio;
  ctx.drawImage(image, (frame % columns) * m.frameWidth + crop.x, Math.floor(frame / columns) * m.frameHeight + crop.y, crop.width, crop.height, (size - w) / 2, size - h, w, h);
  return h;
}

// 이미지 외곽과 별도로 펫 머리·손의 기준점을 네이티브 배치에 제공한다.
export function petAnchors(canvas: HTMLCanvasElement, image: HTMLImageElement | null, design: Design | null): { headHeight: number; handReach?: number; handHeight?: number; width?: number } {
  if (!image || !design) {
    const anchors = renderedBuiltin.get(canvas) && renderedBuiltin.get(canvas) !== 'cat' ? builtinAnchors(canvas) : defaultPetAnchors(canvas);
    if (anchors) {
      return anchors;
    }
  }
  const crop = image && design ? imageBounds(image, design) : undefined;
  return { headHeight: crop ? crop.height * Math.min(canvas.width / crop.width, canvas.height / crop.height) : canvas.height * .98 };
}

// 이미지 로딩을 기다려 Canvas에서 실제 픽셀을 사용할 수 있게 한다.
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 표시할 수 없습니다.'));
    image.src = url;
  });
}

// 네이티브 간격 계산에 사용할 실제 그림 폭을 투명 여백을 제외해 구한다.
export function petVisualWidth(size: number, image: HTMLImageElement | null, design: Design | null, canvas?: HTMLCanvasElement): number {
  if (!image || !design) {
    return (canvas && (renderedBuiltin.get(canvas) && renderedBuiltin.get(canvas) !== 'cat' ? builtinAnchors(canvas)?.width : defaultPetAnchors(canvas)?.width)) || size * .8;
  }
  const crop = imageBounds(image, design);
  return crop.width * Math.min(size / crop.width, size / crop.height);
}

const boundsCache = new WeakMap<HTMLImageElement, { manifest: Design['manifest']; bounds: { x: number; y: number; width: number; height: number } }>();

// 사용 중인 모든 프레임의 불투명 범위를 합쳐 프레임 사이 크기·발 높이가 바뀌지 않게 한다.
function imageBounds(image: HTMLImageElement, design: Design): { x: number; y: number; width: number; height: number } {
  const cached = boundsCache.get(image);
  if (cached?.manifest === design.manifest) {
    return cached.bounds;
  }
  const scratch = document.createElement('canvas');
  scratch.width = image.naturalWidth;
  scratch.height = image.naturalHeight;
  const context = scratch.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
  const { frameWidth: fw, frameHeight: fh, animations } = design.manifest;
  const frames = new Set([0, ...Object.values(animations).flatMap(animation => animation?.frames || [])]);
  let left = fw, top = fh, right = -1, bottom = -1;
  for (const frame of frames) {
    const ox = frame % (image.naturalWidth / fw) * fw;
    const oy = Math.floor(frame / (image.naturalWidth / fw)) * fh;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (pixels[((oy + y) * scratch.width + ox + x) * 4 + 3] > 20) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
  }
  const bounds = right < 0 ? { x: 0, y: 0, width: fw, height: fh } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  boundsCache.set(image, { manifest: design.manifest, bounds });
  return bounds;
}
