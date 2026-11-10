export interface CodexConfig {
  kind: 'codex';
  executable: string;
  mode: 'interval' | 'once';
  usagePercent: number;
  pollSeconds: number;
  notifyExhausted: boolean;
  notifyRecovered: boolean;
  notifyOnRefresh: boolean;
}

export interface CodexUsage {
  checkedAt: number;
  ordinaryUsageAllowed: boolean | null;
  windows: { key: string; label: string; usedPercent: number; resetsAt: number | null; windowDurationMins: number | null }[];
}

// 기존 연결 모달에 사용자 PC의 Codex 로그인과 알림 규칙 입력만 추가한다.
export function mountCodexForm(editor: HTMLElement): () => void {
  // 1. 다른 공급자와 같은 버튼·입력 스타일로 조회 전용 연결을 구성한다.
  const choice = document.createElement('button');
  choice.type = 'button';
  choice.dataset.provider = 'codex';
  choice.setAttribute('aria-pressed', 'false');
  choice.setAttribute('aria-controls', 'codex-editor');
  choice.textContent = 'Codex';
  editor.querySelector('.provider-picker')!.append(choice);
  const section = document.createElement('section');
  section.id = 'codex-editor';
  section.hidden = true;
  section.innerHTML = `<p>이 PC의 Codex에 로그인한 ChatGPT 계정의 사용량을 확인해요.</p><form id="local-codex-form"><input type="hidden" name="id"><label>표시 이름<input name="name" value="내 Codex" maxlength="80" required></label><label>사용량 알림<select name="mode"><option value="interval">일정 사용량마다 알림</option><option value="once">1회 알림</option></select></label><label><span data-usage-label>알림 간격 (%)</span><input name="usagePercent" type="number" min="1" max="100" step="1" value="10" required></label><p class="fine" data-usage-hint></p><fieldset class="local-event-types"><legend>추가 알림</legend><label><input type="checkbox" name="notifyExhausted" checked>한도 소진</label><label><input type="checkbox" name="notifyRecovered" checked>사용 가능 복구</label><label><input type="checkbox" name="notifyOnRefresh" checked>재조회 결과</label></fieldset><details><summary>조회 설정</summary><label>조회 간격 (초)<input name="pollSeconds" type="number" min="30" max="3600" step="1" value="60" required></label><label>Codex 실행 파일<input name="executable" value="codex" placeholder="codex 또는 실행 파일의 절대 경로" maxlength="1024" required></label><p class="fine">이 PC에서 codex login으로 로그인한 계정을 사용해요. 모델 작업을 실행하지 않고 한도만 조회해요.</p></details><p class="local-form-notice" role="status" aria-live="polite"></p><div class="connector-form-actions"><button type="submit" class="primary">Codex 연결 저장</button><button type="button" data-reset="local-codex-form" class="quiet">새 연결로 입력</button></div></form>`;
  editor.querySelector('.connector-create')!.append(section);
  const form = section.querySelector('form')!;

  // 2. 1회와 반복의 의미를 현재 설정 값과 함께 표시한다.
  function sync(): void {
    const mode = form.querySelector<HTMLSelectElement>('[name=mode]')!.value;
    const percent = form.querySelector<HTMLInputElement>('[name=usagePercent]')!.value;
    section.querySelector('[data-usage-label]')!.textContent = mode === 'once' ? '알림 받을 사용량 (%)' : '알림 간격 (%)';
    section.querySelector('[data-usage-hint]')!.textContent = mode === 'once' ? '각 한도 주기에서 지정 사용량에 도달하면 한 번 알려요.' : `${percent || 10}%씩 새 구간을 넘을 때 알려요. 처음 연결할 때 지난 구간을 몰아서 알리지 않아요.`;
  }
  form.addEventListener('change', sync);
  form.addEventListener('input', sync);
  form.addEventListener('reset', () => queueMicrotask(sync));
  sync();
  return sync;
}

// 비밀값이나 임의 명령 인자 없이 Codex 알림 설정을 만든다.
export function readCodexConfig(data: FormData): CodexConfig {
  return {
    kind: 'codex', executable: String(data.get('executable') || 'codex').trim(),
    mode: data.get('mode') === 'once' ? 'once' : 'interval',
    usagePercent: Number(data.get('usagePercent')), pollSeconds: Number(data.get('pollSeconds')),
    notifyExhausted: data.has('notifyExhausted'), notifyRecovered: data.has('notifyRecovered'), notifyOnRefresh: data.has('notifyOnRefresh'),
  };
}

// 마지막으로 받은 공개 사용률·조회 시각만 표시하며 리셋 예상으로 사용 가능을 추정하지 않는다.
export function renderCodexUsage(usage: CodexUsage | undefined, escape: (value: string) => string, provider: 'Codex' | 'Claude' = 'Codex'): string {
  if (!usage) {
    return '<p class="fine">첫 사용량 조회를 기다리고 있어요.</p>';
  }
  const time = new Date(usage.checkedAt);
  const checked = Number.isFinite(time.getTime()) ? time.toLocaleString('ko-KR') : '확인 불가';
  const windows = usage.windows.map(window => {
    const percent = 100 - Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
    const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
    const label = reset && Number.isFinite(reset.getTime()) ? reset.toLocaleString('ko-KR') : '미제공';
    return `<div class="codex-quota"><div><span>${escape(window.label)}</span><strong>${percent}% 남음</strong></div><progress max="100" value="${percent}" aria-label="${escape(window.label)} 잔여량 ${percent}%"></progress><p class="fine">다음 초기화: ${escape(label)}</p></div>`;
  }).join('');
  const allowed = provider === 'Claude' ? Date.now() - usage.checkedAt > 60000 ? '새 상태줄 전달 대기 · 마지막 전달값' : 'Claude 상태줄 전달값' : usage.ordinaryUsageAllowed === true ? 'Codex에서 사용 가능 확인' : usage.ordinaryUsageAllowed === false ? '현재 사용 불가' : '사용 가능 여부 미제공';
  return `<div class="codex-usage">${windows || '<p class="fine">사용률 정보가 제공되지 않았어요.</p>'}<p class="fine">${allowed} · ${provider === 'Claude' ? '수신' : '조회'} ${escape(checked)}</p></div>`;
}
