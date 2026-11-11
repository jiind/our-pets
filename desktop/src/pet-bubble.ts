import { icon } from './icons';

// 기본 분할기가 없는 WebView에서도 결합 부호·피부색·ZWJ·국기 이모지를 함께 보존한다.
function characters(value: string): string[] {
  // 1. 지원되는 환경은 표준 grapheme 분할 결과를 그대로 사용한다.
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment);
  }
  const result: string[] = [];
  let regional = false;
  // 2. 호환 경로는 결합 부호와 이모지 연결 문자를 직전 글자에 붙인다.
  for (const character of Array.from(value)) {
    const last = result.length - 1;
    if (last >= 0 && (character === '\u200d' || result[last].endsWith('\u200d') || /[\p{Mark}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]/u.test(character) || (character === '\n' && result[last] === '\r'))) {
      result[last] += character;
    } else if (regional && /\p{Regional_Indicator}/u.test(character)) {
      result[last] += character;
      regional = false;
    } else {
      result.push(character);
      regional = /\p{Regional_Indicator}/u.test(character);
    }
  }
  return result;
}

// 말풍선을 내용 높이에 맞추고 화면을 넘는 본문만 스크롤 없이 나누어 표시한다.
export function mountBubblePages(bubble: HTMLElement): { setText: (value: string) => void; fit: (available: number, maximum?: number) => void } {
  // 1. 제목·답장 동작과 별개로 본문과 짧은 페이지 조작 영역을 준비한다.
  const body = bubble.querySelector<HTMLElement>('p:not(.bubble-state)')!;
  const heading = bubble.querySelector<HTMLElement>('.bubble-heading')!;
  const state = bubble.querySelector<HTMLElement>('.bubble-state')!;
  const actions = bubble.querySelector<HTMLElement>('.bubble-actions')!;
  const controls = document.createElement('div');
  controls.className = 'bubble-pages';
  controls.hidden = true;
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '긴 메시지 넘기기');
  controls.innerHTML = `<button type="button" class="icon-button icon-button-compact" aria-label="이전 내용">${icon('chevron-left')}</button><span role="status" aria-live="polite"></span><button type="button" class="icon-button icon-button-compact" aria-label="다음 내용">${icon('chevron-right')}</button>`;
  bubble.append(controls);
  const [previous, next] = Array.from(controls.querySelectorAll<HTMLButtonElement>('button'));
  const counter = controls.querySelector('span')!;
  let text: string[] = [];
  let starts = [0];
  let page = 0;
  let end = 0;
  let availableHeight = 0;
  let maximumHeight = 0;
  let dimensions = '';
  let dirty = true;

  // 새 소식은 첫 내용부터 시작하고 이모지의 결합 문자를 페이지 사이에서 자르지 않는다.
  function setText(value: string): void {
    text = characters(value);
    starts = [0];
    page = 0;
    dirty = true;
  }

  // 외곽·제목·동작 높이를 포함해 실제 화면에 들어가는 최대 본문 길이를 찾는다.
  function fit(available: number, maximum = available): void {
    // 1. 숨긴 카드나 바뀌지 않은 크기는 다시 측정하지 않아 유휴 레이아웃 계산을 줄인다.
    availableHeight = Number.isFinite(available) ? Math.floor(available) : 0;
    maximumHeight = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 0;
    if (bubble.hidden) {
      return;
    }
    const size = `${availableHeight}/${maximumHeight}/${bubble.clientWidth}/${heading.offsetHeight}/${state.offsetHeight}/${actions.offsetHeight}`;
    if (!dirty && dimensions === size) {
      return;
    }
    starts.length = page + 1;
    dirty = false;
    bubble.dataset.bubbleCompact = 'false';
    bubble.dataset.bubbleFit = 'true';
    bubble.setAttribute('data-hit', '');
    bubble.removeAttribute('aria-hidden');
    bubble.style.translate = '0 0';

    // 2. 첫 내용이 모두 들어가면 자연 높이 그대로 표시하고 페이지 버튼도 만들지 않는다.
    const start = starts[page];
    body.textContent = text.slice(start).join('');
    controls.hidden = page === 0;
    if (page === 0 && bubble.offsetHeight <= availableHeight) {
      end = text.length;
      dimensions = size;
      return;
    }

    // 3. 넘치는 본문만 실제 줄바꿈 결과로 나누며 읽지 않은 내용은 다음 페이지에 보존한다.
    controls.hidden = false;
    body.textContent = text.slice(start, start + 1).join('');
    if (bubble.offsetHeight > maximumHeight) {
      bubble.dataset.bubbleCompact = 'true';
    }
    // 조작 영역조차 담을 수 없는 화면은 입력을 가로채지 않고 공간 회복을 기다린다.
    if (bubble.offsetHeight > maximumHeight) {
      bubble.dataset.bubbleFit = 'false';
      bubble.removeAttribute('data-hit');
      bubble.setAttribute('aria-hidden', 'true');
      dimensions = `${availableHeight}/${maximumHeight}/${bubble.clientWidth}/${heading.offsetHeight}/${state.offsetHeight}/${actions.offsetHeight}`;
      return;
    }
    // 머리 위 공간이 부족하면 최소 조작 높이만큼 아래로 옮겨 작업영역 안에 남긴다.
    const limit = Math.max(availableHeight, Math.min(maximumHeight, bubble.offsetHeight));
    bubble.style.translate = `0 ${Math.max(0, limit - availableHeight)}px`;
    let low = Math.min(start + 1, text.length);
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      body.textContent = text.slice(start, middle).join('');
      if (bubble.offsetHeight <= limit) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    end = low;
    body.textContent = text.slice(start, end).join('');
    counter.textContent = `${page + 1}쪽`;
    previous.disabled = page === 0;
    next.disabled = end >= text.length;
    dimensions = `${availableHeight}/${maximumHeight}/${bubble.clientWidth}/${heading.offsetHeight}/${state.offsetHeight}/${actions.offsetHeight}`;
  }

  previous.onclick = () => {
    if (page > 0) {
      page -= 1;
      dirty = true;
      fit(availableHeight, maximumHeight);
    }
  };
  next.onclick = () => {
    if (end < text.length) {
      starts[++page] = end;
      dirty = true;
      fit(availableHeight, maximumHeight);
    }
  };
  return { setText, fit };
}
