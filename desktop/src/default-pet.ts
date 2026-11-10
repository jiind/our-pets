import type { CharacterState } from './character';

type Frame = { x: number; y: number; width: number; inset: number; left: number; top: number; right: number; bottom: number };
export type PetAnchors = { height: number; width: number; headHeight: number; handReach: number; handHeight: number };
type Track = { time: number; distance?: number; phase: number; blend: number; direction: number; previousDirection: number; turnedAt: number; wokeAt: number; mode: string; changedAt: number; idleAt: number };

// 동일한 16자세 규격의 원화를 각자 독립적인 시계·발 기준으로 렌더링한다.
export function createPaintedPet(url: string, allowHandOverflow = false): { draw: (canvas: HTMLCanvasElement, now: number, state: CharacterState) => number | undefined; anchors: (canvas: HTMLCanvasElement) => PetAnchors | undefined } {
  const tracks = new WeakMap<HTMLCanvasElement, Track>();
  const lastAnchors = new WeakMap<HTMLCanvasElement, PetAnchors>();
  const waiting = new Map<HTMLCanvasElement, { time: number; state: CharacterState }>();
  let sheet: HTMLCanvasElement | undefined;
  let frames: Frame[] = [];
  let cell = 0;
  let modelSpan = 1;
  let contactX = 0;
  let contactY = 0;
  const image = new Image();
  let requested = false;

  // 생성 원화의 낮은 알파 잔여를 정리하고 셀별 실제 몸과 발 기준을 한 번만 측정한다.
  function prepareSheet(): void {
    // 1. 원본 PNG는 보존하고 렌더링 메모리에서만 투명 픽셀을 정리한다.
    const surface = document.createElement('canvas');
    surface.width = image.naturalWidth;
    surface.height = image.naturalHeight;
    const context = surface.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, surface.width, surface.height);
    for (let index = 3; index < pixels.data.length; index += 4) {
      if (pixels.data[index] < 12) {
        pixels.data[index] = 0;
      }
    }
    context.putImageData(pixels, 0, 0);
    cell = surface.width / 4;

    // 2. 프레임마다 발밑을 맞추되 자세별 크기를 다시 확대하지 않는다.
    frames = [];
    for (let index = 0; index < 16; index++) {
      const x = (index % 4) * cell;
      const y = Math.floor(index / 4) * cell;
      const width = cell + (allowHandOverflow && index === 10 ? 8 : 0);
      const inset = allowHandOverflow && index === 11 ? 10 : 0;
      let left = width, top = cell, right = 0, bottom = 0;
      for (let py = 0; py < Math.floor(cell); py++) {
        for (let px = inset; px < Math.floor(width); px++) {
          const offset = (Math.floor(y + py) * surface.width + Math.floor(x + px)) * 4 + 3;
          if (pixels.data[offset] > 48) {
            left = Math.min(left, px);
            top = Math.min(top, py);
            right = Math.max(right, px + 1);
            bottom = Math.max(bottom, py + 1);
          }
        }
      }
      frames.push({ x, y, width, inset, left, top, right, bottom });
    }
    modelSpan = Math.max(...frames.map(frame => Math.max((cell / 2 - frame.left) * 2, (frame.right - cell / 2) * 2, frame.bottom - frame.top))) + 6;
    const hand = frames[10];
    contactX = hand.right - 4;
    let handTop = cell, handBottom = 0;
    for (let y = 0; y < Math.floor(cell); y++) {
      for (let x = Math.floor(contactX - 6); x <= contactX; x++) {
        const offset = (Math.floor(hand.y + y) * surface.width + Math.floor(hand.x + x)) * 4 + 3;
        if (pixels.data[offset] > 48) {
          handTop = Math.min(handTop, y);
          handBottom = Math.max(handBottom, y);
        }
      }
    }
    contactY = (handTop + handBottom) / 2;
    sheet = surface;
    waiting.forEach((request, canvas) => {
      canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
      draw(canvas, request.time, request.state);
    });
    waiting.clear();
  }
  image.onload = prepareSheet;
  image.onerror = () => waiting.clear();

  // 해당 Canvas의 독립적인 걸음·방향 전환·휴식 상태를 만든다.
  function trackFor(canvas: HTMLCanvasElement, now: number, direction: number): Track {
    let track = tracks.get(canvas);
    if (!track) {
      track = { time: now, phase: 0, blend: 0, direction, previousDirection: direction, turnedAt: -Infinity, wokeAt: -Infinity, mode: 'idle', changedAt: now, idleAt: now };
      tracks.set(canvas, track);
    }
    return track;
  }

  // 실제 이동 거리로 보행을 진행하고 동작의 시작·종료는 별도 짧은 자세로 연결한다.
  function chooseFrame(track: Track, now: number, size: number, state: CharacterState): { frame: number; direction: number } {
    // 1. 드래그·크기 변경·긴 중단은 걸음으로 세지 않고 실제 이동만 누적한다.
    const dt = Math.max(0, Math.min(.1, (now - track.time) / 1000));
    if (track.time === 0 && now > 0) {
      track.changedAt = now;
      track.idleAt = now;
    }
    track.time = now;
    const actionTime = state.elapsed || 0;
    const pairMoving = !!state.paired && !!state.walking && (actionTime < 800 || actionTime >= 2200);
    const walking = !!state.walking && !state.resting && (!state.gesture || pairMoving) && !state.reduced;
    if (state.distance !== undefined) {
      if (track.distance !== undefined) {
        const distance = state.distance - track.distance;
        if (Number.isFinite(distance) && distance >= 0) {
          track.phase += distance / Math.max(12, size * .2);
        } else if (distance < 0) {
          track.phase = 0;
        }
      }
      track.distance = state.distance;
    } else if (walking) {
      track.phase += dt * 1.1;
    }
    track.blend += ((walking ? 1 : 0) - track.blend) * Math.min(1, dt * 12);
    const nextDirection = state.gesture && state.paired && !pairMoving ? (state.mirrored ? -1 : 1) : (state.direction || 1);
    if (nextDirection !== track.direction) {
      track.previousDirection = track.direction;
      track.direction = nextDirection;
      track.turnedAt = now;
    }
    const mode = pairMoving ? 'walk' : state.gesture || (state.resting ? 'rest' : walking ? 'walk' : 'idle');
    if (mode !== track.mode) {
      if (track.mode === 'rest') {
        track.wokeAt = now;
      }
      track.mode = mode;
      track.changedAt = now;
      if (mode === 'idle') {
        track.idleAt = now;
      }
    }

    // 2. 반응은 같은 쌍동작 시계로 준비·접촉·복귀를 나눠 발을 바닥에 둔다.
    if (state.carried || state.elevation) {
      return { frame: 7, direction: track.direction };
    }
    const elapsed = (state.elapsed || 0) + (state.paired ? 0 : 800);
    if (!walking && !state.reduced && now - track.turnedAt < 240) {
      return { frame: 6, direction: now - track.turnedAt < 120 ? track.previousDirection : track.direction };
    }
    if (pairMoving && !state.reduced) {
      return { frame: Math.floor(track.phase * 4) % 4, direction: track.direction };
    }
    if (state.gesture === 'highfive') {
      return { frame: state.reduced ? 10 : elapsed < 800 ? 7 : elapsed < 1040 ? 8 : elapsed < 2200 ? 10 : elapsed < 2460 ? 11 : 4, direction: track.direction };
    }
    if (state.gesture === 'wave') {
      return { frame: state.reduced ? 9 : elapsed < 800 ? 7 : elapsed < 1040 ? 8 : elapsed < 2020 ? (Math.floor((elapsed - 1040) / 200) % 2 ? 8 : 9) : elapsed < 2400 ? 11 : 4, direction: track.direction };
    }
    if (state.gesture === 'pat') {
      return { frame: state.reduced ? 5 : elapsed < 300 ? 12 : elapsed < 2200 ? (Math.floor(elapsed / 700) % 2 ? 5 : 6) : 4, direction: track.direction };
    }

    // 3. 방향을 바꿀 때 잠깐 돌아보고 서기·앉기·깨어나기를 거쳐 다음 자세로 간다.
    if (state.resting) {
      const restTime = now - track.changedAt;
      return { frame: state.reduced ? 13 : restTime < 300 ? 12 : restTime < 7000 ? 13 : 14, direction: track.direction };
    }
    if (!state.reduced && now - track.wokeAt < 220) {
      return { frame: 15, direction: track.direction };
    }
    if (walking && !state.reduced) {
      return { frame: Math.floor(track.phase * 4) % 4, direction: track.direction };
    }
    const idleTime = now - track.idleAt;
    const moment = idleTime % 7400;
    return { frame: state.reduced ? 4 : track.blend > .12 ? 7 : moment > 5100 && moment < 5340 ? 5 : moment > 6200 && moment < 6900 ? 6 : 4, direction: track.direction };
  }

  // 기본 원화를 같은 모델 크기와 발 기준으로 그리고 머리·손의 조작 기준점을 보관한다.
  function draw(canvas: HTMLCanvasElement, now: number, state: CharacterState): number | undefined {
    // 선택한 캐릭터만 디코딩해 각 펫 창에서 모든 원화를 메모리에 올리지 않는다.
    if (!requested) {
      requested = true;
      image.src = url;
    }
    if (!sheet || frames.length !== 16) {
      if (!image.complete || image.naturalWidth) {
        waiting.set(canvas, { time: now, state });
      }
      return undefined;
    }
    // 1. 그림 전체의 배율은 고정하고 현재 자세의 발밑만 Canvas 바닥에 맞춘다.
    const size = canvas.width;
    const track = trackFor(canvas, now, state.direction || 1);
    const selected = chooseFrame(track, now, size, state);
    const frame = frames[selected.frame];
    const ratio = size / modelSpan;
    const context = canvas.getContext('2d')!;
    context.save();
    if (selected.direction < 0) {
      context.translate(size, 0);
      context.scale(-1, 1);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(sheet, frame.x + frame.inset, frame.y, frame.width - frame.inset, cell, size / 2 + (frame.inset - cell / 2) * ratio, size - frame.bottom * ratio, (frame.width - frame.inset) * ratio, cell * ratio);
    context.restore();

    // 2. 말풍선은 머리 위, 하이파이브는 고정 손 포즈의 실제 끝점에 연결한다.
    const hand = frames[10];
    const height = (frame.bottom - frame.top) * ratio;
    const head = selected.frame >= 12 ? frame : frames[4];
    lastAnchors.set(canvas, { height, width: (frame.right - frame.left) * ratio, headHeight: (head.bottom - head.top) * ratio, handReach: (contactX - cell / 2) * ratio, handHeight: (hand.bottom - contactY) * ratio });
    return height;
  }

  // 직전 프레임의 그림·머리·손 기준점을 현재 창의 배치 계산에 제공한다.
  function anchors(canvas: HTMLCanvasElement): PetAnchors | undefined {
    return lastAnchors.get(canvas);
  }
  return { draw, anchors };
}

const defaultPet = createPaintedPet(new URL('./assets/builtin/cat/cel-v4.png', import.meta.url).href);

// 기존 기본 고양이 호출 경계를 동일한 원화 렌더러로 유지한다.
export const drawDefaultPet = defaultPet.draw;

// 직전 고양이의 실제 머리·손·발 기준점을 제공한다.
export const defaultPetAnchors = defaultPet.anchors;
