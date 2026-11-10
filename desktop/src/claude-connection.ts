import { invoke } from '@tauri-apps/api/core';
import type { CodexUsage } from './codex-connection';

export interface ClaudeConfig {
  kind: 'claude';
  sessionKey: string;
  mode: 'interval' | 'once';
  usagePercent: number;
  notifyExhausted: boolean;
  notifyRecovered: boolean;
  notifyOnRefresh: boolean;
}

interface BridgeInfo {
  installed: boolean;
  settingsPath: string;
  sessions: { sessionKey: string; usage: CodexUsage }[];
}

// 공식 상태줄 연결과 사용자가 선택한 세션의 알림 기준을 기존 모달에 구성한다.
export function mountClaudeForm(editor: HTMLElement): { sync: () => void; load: (preferred?: string) => Promise<void>; setBusy: (busy: boolean) => void } {
  // 1. 다른 공급자와 같은 컨트롤로 상태줄 설치·해제 및 알림 규칙을 제공한다.
  const choice = document.createElement('button');
  choice.type = 'button';
  choice.dataset.provider = 'claude';
  choice.setAttribute('aria-pressed', 'false');
  choice.setAttribute('aria-controls', 'claude-editor');
  choice.textContent = 'Claude';
  editor.querySelector('.provider-picker')!.append(choice);
  const section = document.createElement('section');
  section.id = 'claude-editor';
  section.hidden = true;
  section.innerHTML = `<p>Claude Code의 상태줄에서 이 PC로 사용량을 받아요. 인증 토큰이나 대화는 저장하지 않아요.</p><div class="claude-bridge-setup"><div class="connector-form-actions"><button type="button" data-claude-bridge="install">상태줄 연결 적용</button><button type="button" data-claude-bridge="remove" class="quiet" disabled>상태줄 연결 해제</button><button type="button" data-claude-bridge="refresh" class="quiet">세션 새로고침</button></div><p class="fine" data-claude-bridge-status role="status"></p><p class="fine">적용하면 Claude Code 사용자 설정의 상태줄을 연결해요. 기존 상태줄 표시는 보존하고 해제할 때 복원해요. 연결 후 Claude Code를 사용하고 세션을 새로고침하세요.</p></div><form id="local-claude-form"><input type="hidden" name="id"><label>표시 이름<input name="name" value="내 Claude" maxlength="80" required></label><label>수신할 Claude Code 세션<select name="sessionKey" required><option value="">상태줄 연결 후 세션을 선택하세요</option></select></label><p class="fine">여러 계정의 사용량을 섞지 않도록 선택한 세션만 받아요. 새 세션으로 바꾸려면 이 연결을 수정하세요.</p><label>사용량 알림<select name="mode"><option value="interval">일정 사용량마다 알림</option><option value="once">1회 알림</option></select></label><label><span data-usage-label>알림 간격 (%)</span><input name="usagePercent" type="number" min="1" max="100" step="1" value="10" required></label><p class="fine" data-usage-hint></p><fieldset class="local-event-types"><legend>추가 알림</legend><label><input type="checkbox" name="notifyExhausted" checked>한도 소진</label><label><input type="checkbox" name="notifyRecovered" checked>한도 여유 확인</label><label><input type="checkbox" name="notifyOnRefresh" checked>최신 값 확인 결과</label></fieldset><p class="fine">Claude Code가 전달한 값만 확인해요. 앱에서 원격 재조회하지 않으며, 리셋 예상 시각만으로 복구 알림을 보내지 않아요.</p><p class="local-form-notice" role="status" aria-live="polite"></p><div class="connector-form-actions"><button type="submit" class="primary">Claude 연결 저장</button><button type="button" data-reset="local-claude-form" class="quiet">새 연결로 입력</button></div></form>`;
  editor.querySelector('.connector-create')!.append(section);
  const form = section.querySelector('form')!;
  const select = form.querySelector<HTMLSelectElement>('[name=sessionKey]')!;
  const feedback = section.querySelector<HTMLElement>('[data-claude-bridge-status]')!;
  const buttons = section.querySelectorAll<HTMLButtonElement>('[data-claude-bridge]');
  let operation = false;
  let installed = false;
  let saving = false;

  // 상태줄 변경과 연결 저장이 겹치지 않게 같은 잠금 상태를 반영한다.
  function setBusy(value: boolean): void {
    saving = value;
    buttons.forEach(button => {
      button.disabled = saving || operation || (button.dataset.claudeBridge === 'remove' && !installed);
    });
    form.querySelector<HTMLButtonElement>('[type=submit]')!.disabled = saving || operation;
  }

  // 모드 변경 후 1회·반복 알림의 주기와 최초 기준을 설명한다.
  function sync(): void {
    const mode = form.querySelector<HTMLSelectElement>('[name=mode]')!.value;
    const percent = form.querySelector<HTMLInputElement>('[name=usagePercent]')!.value;
    section.querySelector('[data-usage-label]')!.textContent = mode === 'once' ? '알림 받을 사용량 (%)' : '알림 간격 (%)';
    section.querySelector('[data-usage-hint]')!.textContent = mode === 'once' ? '선택한 세션의 각 한도 주기에서 한 번 알려요.' : `${percent || 10}%씩 새 구간을 넘을 때 알려요. 처음 연결할 때 지난 구간을 몰아서 알리지 않아요.`;
  }

  // 공개 세션만 DOM으로 추가하고 편집 중인 기존 선택은 유실하지 않는다.
  function show(info: BridgeInfo, preferred?: string): void {
    installed = info.installed;
    // 1. 기존 선택을 보존하고 식별 가능한 세션 지문·수신 시각만 표시한다.
    const selected = preferred || select.value;
    select.replaceChildren(new Option('상태줄에서 받은 세션 선택', ''));
    info.sessions.forEach(session => {
      const date = new Date(session.usage.checkedAt).toLocaleString('ko-KR');
      select.add(new Option(`세션 ${session.sessionKey.slice(0, 8)} · 수신 ${date}`, session.sessionKey));
    });
    if (selected && !info.sessions.some(session => session.sessionKey === selected)) {
      select.add(new Option(`세션 ${selected.slice(0, 8)} · 새 수신 대기`, selected));
    }
    select.value = selected || info.sessions[0]?.sessionKey || '';

    // 2. 원본 명령을 노출하지 않고 설치 경로와 상태만 제공한다.
    feedback.className = 'fine';
    feedback.textContent = `${info.installed ? '상태줄 연결 적용됨' : '상태줄 연결 미적용'} · ${info.settingsPath}`;
    setBusy(saving);
  }

  // 인증 파일을 읽지 않고 설치 여부와 사용 가능한 세션만 다시 받는다.
  async function load(preferred?: string): Promise<void> {
    try {
      show(await invoke<BridgeInfo>('local_claude_bridge_info'), preferred);
    } catch {
      feedback.className = 'fine error';
      feedback.textContent = 'Claude 상태줄 연결 정보를 확인하지 못했어요. 세션 새로고침으로 다시 시도하세요.';
    }
  }

  // 사용자가 누른 적용·해제에서만 로컬 상태줄 설정을 변경한다.
  async function configure(enabled: boolean): Promise<void> {
    // 1. 설치 변경 중 같은 버튼의 중복 요청을 막는다.
    if (operation || saving) {
      return;
    }
    operation = true;
    setBusy(saving);

    // 2. 실패하면 정제된 네이티브 안내를 표시하고 연결 폼은 유지한다.
    try {
      show(await invoke<BridgeInfo>('local_configure_claude_bridge', { enabled }));
    } catch (error) {
      const message = String(error);
      feedback.textContent = message.length < 400 && /Claude|상태줄|설정|연결/.test(message) ? message : 'Claude 상태줄 연결을 변경하지 못했어요.';
      feedback.className = 'fine error';
    } finally {
      operation = false;
      setBusy(saving);
    }
  }
  buttons.forEach(button => {
    button.onclick = () => {
      if (button.dataset.claudeBridge === 'refresh') {
        void load();
      } else {
        void configure(button.dataset.claudeBridge === 'install');
      }
    };
  });
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('reset', () => queueMicrotask(sync));
  sync();
  return { sync, load, setBusy };
}

// 인증·대화 내용을 제외하고 선택 세션과 알림 규칙만 저장용 값으로 만든다.
export function readClaudeConfig(data: FormData): ClaudeConfig {
  return {
    kind: 'claude', sessionKey: String(data.get('sessionKey') || ''),
    mode: data.get('mode') === 'once' ? 'once' : 'interval', usagePercent: Number(data.get('usagePercent')),
    notifyExhausted: data.has('notifyExhausted'), notifyRecovered: data.has('notifyRecovered'), notifyOnRefresh: data.has('notifyOnRefresh'),
  };
}
