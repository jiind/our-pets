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
    return result;
  });

  // 계산된 프레임 번호 대신 renderer가 실제 그린 중심 픽셀의 색 결과를 비교한다.
  expect(frames.idleFirst).not.toBe(frames.idleNext);
  expect(frames.walkNoMotion).toBe(frames.walkStart);
  expect(frames.walkMoved).not.toBe(frames.walkNoMotion);
  expect(frames.reactFirst).not.toBe(frames.reactNext);
  expect(frames.missingWalkUsesIdle).toBe(frames.reactNext);
  expect(frames.missingAnimationUsesFirstFrame).toBe(frames.idleFirst);
});
