import { test, expect } from '@playwright/test';

test('실제 drawPet 캔버스 색상으로 sprite frame·보행 거리·누락 대체를 확인한다', async ({ page }) => {
  await page.goto('/');
  const frames = await page.evaluate(async () => {
    // 네 가지 단색 칸으로 테스트용 투명 sprite PNG를 만들고 실제 renderer 모듈에 넘긴다.
    const source = document.createElement('canvas');
    source.width = source.height = 32;
    const sourceContext = source.getContext('2d')!;
    const colors = ['#e02020', '#20c040', '#2040e0', '#e0c020'];
    colors.forEach((color, index) => {
      sourceContext.fillStyle = color;
      sourceContext.fillRect(index % 2 * 16, Math.floor(index / 2) * 16, 16, 16);
    });
    const image = new Image();
    image.src = source.toDataURL('image/png');
    await image.decode();

    // @ts-expect-error Vite가 브라우저에 제공하는 실제 렌더러 소스 모듈이다.
    const { drawPet } = await import('/src/render.ts');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const design = {
      id: 'synthetic-grid', version: 1, ownerId: 'fixture', name: 'synthetic', imageHash: 'fixture',
      manifest: {
        schemaVersion: 1, displaySize: 64, frameWidth: 16, frameHeight: 16,
        animations: {
          idle: { frames: [0, 1], fps: 1 },
          walk: { frames: [1, 2], fps: 1 },
          react: { frames: [2, 3], fps: 1 },
        },
      },
    };
    const pixel = (): string => [...canvas.getContext('2d')!.getImageData(32, 32, 1, 1).data].join(',');
    const result: Record<string, string> = {};
    drawPet(canvas, image, design, 'idle', 1000);
    result.idleFirst = pixel();
    drawPet(canvas, image, design, 'idle', 2000);
    result.idleNext = pixel();
    drawPet(canvas, image, design, 'walk', 1000, { distance: 0 });
    result.walkStart = pixel();
    drawPet(canvas, image, design, 'walk', 2000, { distance: 0 });
    result.walkNoMotion = pixel();
    drawPet(canvas, image, design, 'walk', 3000, { distance: 18 });
    result.walkMoved = pixel();
    drawPet(canvas, image, design, 'react', 1000, { elapsed: 0 });
    result.reactFirst = pixel();
    drawPet(canvas, image, design, 'react', 2000, { elapsed: 1000 });
    result.reactNext = pixel();

    const fallback = { ...design, id: 'synthetic-fallback', manifest: { ...design.manifest, animations: { idle: { frames: [2, 3], fps: 1 } } } };
    drawPet(canvas, image, fallback, 'walk', 1000);
    drawPet(canvas, image, fallback, 'walk', 2000);
    result.missingWalkUsesIdle = pixel();
    const still = { ...fallback, id: 'synthetic-still', manifest: { ...fallback.manifest, animations: {} } };
    drawPet(canvas, image, still, 'idle', 1000);
    result.missingAnimationUsesFirstFrame = pixel();
    const named = { ...design, id: 'synthetic-named', manifest: { ...design.manifest, schemaVersion: 2, idleAnimation: 'rest', walkAnimation: 'stride', animations: {
      rest: { name: '쉬기', frames: [1], fps: 4 },
      stride: { name: '이동하기', frames: [2], fps: 8 },
      dance: { name: '춤추기', frames: [3], fps: 6 },
    } } };
    drawPet(canvas, image, named, 'idle', 1000);
    result.namedIdle = pixel();
    drawPet(canvas, image, named, 'walk', 1000, { distance: 0 });
    result.namedWalk = pixel();
    drawPet(canvas, image, named, 'react', 1000, { animationId: 'dance', gesture: 'pat', elapsed: 0 });
    result.namedClick = pixel();
    return result;
  });

  // 계산된 프레임 번호 대신 renderer가 실제 그린 중심 픽셀의 색 결과를 비교한다.
  expect(frames.idleFirst).not.toBe(frames.idleNext);
  expect(frames.walkNoMotion).toBe(frames.walkStart);
  expect(frames.walkMoved).not.toBe(frames.walkNoMotion);
  expect(frames.reactFirst).not.toBe(frames.reactNext);
  expect(frames.missingWalkUsesIdle).toBe(frames.reactNext);
  expect(frames.missingAnimationUsesFirstFrame).toBe(frames.idleFirst);
  expect(frames.namedIdle).toBe(frames.walkStart);
  expect(frames.namedWalk).toBe(frames.reactFirst);
  expect(frames.namedClick).toBe(frames.reactNext);
});

test('등록 PNG와 스프라이트는 이동·상호작용 방향으로 반전하고 다음 그리기에 영향을 주지 않는다', async ({ page }) => {
  await page.goto('/');
  const samples = await page.evaluate(async () => {
    // 1. 각 칸의 좌우 색이 다른 PNG로 실제 그림 방향과 선택된 프레임을 구분한다.
    const source = document.createElement('canvas');
    source.width = 32;
    source.height = 16;
    const context = source.getContext('2d')!;
    ['#e02020', '#20c040', '#2040e0', '#e0c020'].forEach((color, index) => {
      context.fillStyle = color;
      context.fillRect(index * 8, 0, 8, 16);
    });
    const image = new Image();
    image.src = source.toDataURL('image/png');
    await image.decode();
    // @ts-expect-error Vite가 브라우저에 제공하는 실제 렌더러 소스 모듈이다.
    const { drawPet } = await import('/src/render.ts');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const design = {
      id: 'direction-sheet', version: 1, ownerId: 'fixture', name: 'direction', imageHash: 'fixture',
      manifest: { schemaVersion: 1, displaySize: 64, frameWidth: 16, frameHeight: 16,
        animations: { idle: { frames: [0], fps: 4 }, walk: { frames: [1], fps: 8 }, react: { frames: [0], fps: 6 } } },
    };
    const result: Record<string, string[]> = {};
    const cases = [
      { name: 'right', action: 'walk', state: { direction: 1 } },
      { name: 'left', action: 'walk', state: { direction: -1 } },
      { name: 'rightAgain', action: 'walk', state: { direction: 1 } },
      { name: 'idleLeft', action: 'idle', state: { direction: -1 } },
      { name: 'greetLeft', action: 'react', state: { direction: 1, gesture: 'wave', paired: true, mirrored: true } },
      { name: 'greetRight', action: 'react', state: { direction: -1, gesture: 'highfive', paired: true, mirrored: false } },
      { name: 'approachLeft', action: 'react', state: { direction: -1, gesture: 'wave', paired: true, mirrored: false, walking: true, elapsed: 0 } },
      { name: 'singleLeft', action: 'walk', state: { direction: -1 } },
    ] as const;

    // 2. 이동·대기·인사·접근과 애니메이션 없는 PNG의 실제 좌우 픽셀을 읽는다.
    for (const sample of cases) {
      const current = sample.name === 'singleLeft' ? { ...design, id: 'direction-single', manifest: { ...design.manifest, animations: {} } } : design;
      drawPet(canvas, image, current, sample.action, 1000, sample.state);
      result[sample.name] = [16, 48].map(x => [...canvas.getContext('2d')!.getImageData(x, 32, 1, 1).data].join(','));
    }
    return result;
  });

  // 3. 프레임과 방향을 색으로 검증하고 좌우 전환 뒤 변환이 누적되지 않는지 확인한다.
  const red = '224,32,32,255', green = '32,192,64,255';
  const blue = '32,64,224,255', yellow = '224,192,32,255';
  expect(samples.right).toEqual([blue, yellow]);
  expect(samples.left).toEqual([yellow, blue]);
  expect(samples.rightAgain).toEqual(samples.right);
  expect(samples.idleLeft).toEqual([green, red]);
  expect(samples.greetLeft).toEqual([green, red]);
  expect(samples.greetRight).toEqual([red, green]);
  expect(samples.approachLeft).toEqual([yellow, blue]);
  expect(samples.singleLeft).toEqual([green, red]);
});
