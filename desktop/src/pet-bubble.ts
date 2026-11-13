// 말풍선의 고정 제목·동작을 보존하고 본문만 제한된 높이 안에서 스크롤하게 한다.
export function mountBubbleLayout(bubble: HTMLElement): { setText: (value: string) => void; fit: (available: number, maximum?: number) => void } {
  // 1. 본문을 키보드로도 스크롤할 수 있는 읽기 영역으로 준비한다.
  const body = bubble.querySelector<HTMLElement>('p:not(.bubble-state)')!;
  const heading = bubble.querySelector<HTMLElement>('.bubble-heading')!;
  const state = bubble.querySelector<HTMLElement>('.bubble-state')!;
  const actions = bubble.querySelector<HTMLElement>('.bubble-actions')!;
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', '알림 내용');
  let dimensions = '';
  let resetScroll = false;

  // 새 알림의 본문은 자르지 않고 그대로 넣으며 읽기 위치는 맨 위에서 시작한다.
  function setText(value: string): void {
    body.textContent = value;
    body.scrollTop = 0;
    dimensions = '';
    resetScroll = true;
  }

  // 실제 표시 중인 요소의 높이와 상하 여백을 합산한다.
  function outerHeight(element: HTMLElement): number {
    const style = getComputedStyle(element);
    if (style.display === 'none') {
      return 0;
    }
    return element.offsetHeight + parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0');
  }

  // 제목·버튼과 테두리·여백을 제외한 본문의 최대 높이를 화면 공간에 맞춘다.
  function fit(available: number, maximum = available): void {
    // 1. 숨긴 카드나 변경 없는 배치는 재측정하지 않고 사용자의 스크롤 위치를 보존한다.
    if (bubble.hidden) {
      return;
    }
    const above = Number.isFinite(available) ? Math.floor(available) : 0;
    const maximumHeight = Number.isFinite(maximum) ? Math.max(0, Math.min(320, Math.floor(maximum))) : 0;
    const key = `${above}/${maximumHeight}/${bubble.clientWidth}/${heading.offsetHeight}/${state.offsetHeight}/${actions.offsetHeight}`;
    if (dimensions === key) {
      return;
    }
    bubble.dataset.bubbleCompact = 'false';
    bubble.dataset.bubbleFit = 'true';
    bubble.setAttribute('data-hit', '');
    bubble.removeAttribute('aria-hidden');
    const style = getComputedStyle(bubble);
    const paragraph = getComputedStyle(body);
    const line = parseFloat(paragraph.lineHeight) || 24;
    const edges = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, property) => sum + (parseFloat(style[property as keyof CSSStyleDeclaration] as string) || 0), 0);
    const margins = parseFloat(paragraph.marginTop || '0') + parseFloat(paragraph.marginBottom || '0');
    let chrome = edges + margins + outerHeight(heading) + outerHeight(state) + outerHeight(actions);

    // 2. 공간이 좁으면 제목만 두 줄로 줄이고 조작 영역조차 못 담으면 입력을 통과시킨다.
    if (chrome + line > maximumHeight) {
      bubble.dataset.bubbleCompact = 'true';
      chrome = edges + margins + outerHeight(heading) + outerHeight(state) + outerHeight(actions);
    }
    if (chrome + line > maximumHeight) {
      bubble.dataset.bubbleFit = 'false';
      bubble.removeAttribute('data-hit');
      bubble.setAttribute('aria-hidden', 'true');
      dimensions = key;
      return;
    }

    // 3. 짧은 본문은 자연 높이를 쓰고 한도를 넘는 본문만 안쪽에서 스크롤한다.
    const limit = above >= chrome + line ? Math.min(maximumHeight, above) : maximumHeight;
    bubble.style.maxHeight = `${limit}px`;
    body.style.maxHeight = `${Math.max(line, limit - chrome)}px`;
    bubble.style.translate = `0 ${Math.max(0, bubble.offsetHeight - above)}px`;
    if (resetScroll) {
      body.scrollTop = 0;
      resetScroll = false;
    }
    dimensions = `${above}/${maximumHeight}/${bubble.clientWidth}/${heading.offsetHeight}/${state.offsetHeight}/${actions.offsetHeight}`;
  }
  return { setText, fit };
}
