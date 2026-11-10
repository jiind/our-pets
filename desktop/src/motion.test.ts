import { describe, expect, it } from 'vitest';
import { reactionTimeline } from './motion';

describe('상호작용 타임라인', () => {
  it('인사와 하이파이브는 같은 시점에 서로 다른 자세를 사용하고 원위치로 복귀한다', () => {
    const wave = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
    const highfive = { ...wave };
    const waving = reactionTimeline(wave, 'wave', true);
    const jumping = reactionTimeline(highfive, 'highfive', true);
    try {
      waving.seek(1.4);
      jumping.seek(1.4);
      expect(Math.abs(wave.rotation)).toBeGreaterThan(1);
      expect(highfive.y).toBeCloseTo(-22);
      expect(highfive.rotation).toBe(0);
      waving.seek(3.3);
      jumping.seek(3.3);
      expect(wave.x).toBe(0);
      expect(wave.rotation).toBe(0);
      expect(highfive.y).toBe(0);
      expect(highfive.scaleY).toBe(1);
    } finally {
      waving.kill();
      jumping.kill();
    }
  });
});
