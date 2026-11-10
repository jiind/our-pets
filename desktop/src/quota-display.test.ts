import { describe, expect, it } from 'vitest';
import { renderCodexUsage, type CodexUsage } from './codex-connection';

// 공급자 표시에 들어갈 문자열을 HTML로 해석하지 않도록 이스케이프한다.
function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

describe('사용량 연결의 공개 잔여량 표시', () => {
  it.each([['Codex', 23, 77], ['Claude', 100, 0], ['Codex', 0, 100]] as const)('%s의 사용 %i%%를 남음 %i%%로 표시한다', (provider, usedPercent, remaining) => {
    const usage: CodexUsage = { checkedAt: Date.now(), ordinaryUsageAllowed: null, windows: [{ key: 'weekly', label: '주간', usedPercent, resetsAt: null, windowDurationMins: 10080 }] };
    const html = renderCodexUsage(usage, escape, provider);
    expect(html).toContain(`${remaining}% 남음`);
    expect(html).toContain(`value="${remaining}"`);
    expect(html).toContain(`주간 잔여량 ${remaining}%`);
    expect(html).toContain('초기화: 미제공');
  });
  it('값이 없거나 사용 가능 여부가 없으면 임의의 사용 가능 상태를 만들지 않는다', () => {
    expect(renderCodexUsage(undefined, escape)).toContain('기다리고');
    const html = renderCodexUsage({ checkedAt: Date.now(), ordinaryUsageAllowed: null, windows: [] }, escape);
    expect(html).toContain('사용률 정보가 제공되지 않았어요');
    expect(html).toContain('사용 가능 여부 미제공');
  });
  it('공급자 라벨을 실행 코드로 넣지 않고 명시적인 사용 불가를 유지한다', () => {
    const html = renderCodexUsage({ checkedAt: Date.now(), ordinaryUsageAllowed: false, windows: [{ key: 'weekly', label: '<img onerror=alert(1)>', usedPercent: 100, resetsAt: null, windowDurationMins: null }] }, escape);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('현재 사용 불가');
  });
});
