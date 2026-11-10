import { icon } from './icons';
import { api, session } from './api';
import { setPetInput } from './pet-input';
import { recruitmentOptions, type Gathering, type Pet, type RecruitmentKind } from './types';

// 모집을 메시지와 분리해 종류 선택·참여·완료 동작으로 구성한다.
export function mountRecruitment(root: HTMLElement, preview: boolean, targetID: string | undefined, getPets: () => Pet[], getGroups: () => Gathering[], changed: (groups: Gathering[]) => Promise<void>, onOpen: () => void, onClose: () => void) {
  // 1. 항상 찾을 수 있는 모집 표시와 필요할 때 여는 조작 패널을 준비한다.
  const badge = document.createElement('span');
  badge.className = 'pill recruitment-badge';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  badge.hidden = true;
  const panel = document.createElement('section');
  panel.className = 'recruitment-panel';
  panel.tabIndex = -1;
  panel.dataset.hit = '';
  panel.hidden = true;
  panel.setAttribute('aria-label', '모집');
  root.append(badge, panel);
  let selectedID: string | undefined;
  let busy = false;
  let disposed = false;
  let requestKey = crypto.randomUUID();
  let feedback = '';
  let feedbackError = false;
  let choosing = false;
  let requestKind: RecruitmentKind | undefined;

  // 이 펫이 모집 중이거나 내 펫이 참여 중인 현재 모집을 찾는다.
  function current(): Gathering | undefined {
    const ownID = session()?.principal.petId;
    const displayed = targetID || ownID;
    const groups = getGroups().filter(group => group.origin === 'recruitment' && group.status === 'open');
    return groups.find(group => group.hostPetId === displayed) || (!targetID ? groups.find(group => group.members.some(member => member.petId === ownID)) : undefined);
  }

  // 메시지 보관함을 만들지 않고 현재 열려 있는 모집 패널만 닫는다.
  function close(): void {
    if (!panel.hidden) {
      panel.hidden = true;
      void setPetInput(false, preview).catch(console.error);
      onClose();
    }
  }

  // 모집 패널의 모든 사용자 값은 HTML 대신 텍스트로 넣는다.
  function render(): void {
    // 1. 모집자의 펫이나 현재 참여 관계에만 지속적인 모집 표시를 붙인다.
    const ownID = session()?.principal.petId;
    const group = current();
    badge.hidden = !group;
    const option = group ? recruitmentOptions[group.kind] : undefined;
    badge.textContent = group ? `${option!.icon} ${option!.label} · ${group.hostPetId === (targetID || ownID) ? '모집 중' : '참여 중'} · ${group.members.length}명` : '';
    badge.setAttribute('aria-label', group ? `${option!.label} ${group.hostPetId === (targetID || ownID) ? '모집' : '참여'} 중 · ${group.members.length}명 참여` : '모집 현황');
    if (panel.hidden) {
      return;
    }
    if (choosing) {
      const focusedKind = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.recruitmentKind : undefined;
      panel.innerHTML = `<div class="recruitment-heading"><h2>모집</h2><button type="button" class="menu-close" aria-label="모집 닫기" data-recruitment-action="close">${icon('close')}</button></div><p>함께할 사람을 모아 보세요.</p><div class="recruitment-choices"></div><p class="recruitment-feedback" role="status" aria-live="polite"></p>`;
      for (const kind of Object.keys(recruitmentOptions) as RecruitmentKind[]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.recruitmentKind = kind;
        button.textContent = recruitmentOptions[kind].icon;
        button.title = recruitmentOptions[kind].label;
        button.setAttribute('aria-label', `${recruitmentOptions[kind].label} 모집`);
        button.disabled = busy;
        panel.querySelector('.recruitment-choices')!.append(button);
      }
      panel.querySelector<HTMLElement>('.recruitment-feedback')!.textContent = feedback;
      panel.querySelector('.recruitment-feedback')!.classList.toggle('error', feedbackError);
      if (focusedKind && !busy) {
        panel.querySelector<HTMLButtonElement>(`[data-recruitment-kind="${focusedKind}"]`)?.focus();
      }
      return;
    }
    const selected = getGroups().find(item => item.id === selectedID && item.origin === 'recruitment' && item.status === 'open');
    if (!selected) {
      close();
      return;
    }

    // 2. 모집 내용·참여자·현재 사용자에게 허용된 동작을 같은 자리에서 보여 준다.
    const previousAction = (panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.recruitmentAction : undefined);
    const host = selected.hostPetId === ownID;
    const joined = selected.members.some(member => member.petId === ownID);
    const owner = selected.host?.userName || getPets().find(pet => pet.id === selected.hostPetId)?.ownerName || '친구';
    panel.innerHTML = `<div class="recruitment-heading"><h2></h2><button type="button" class="menu-close" aria-label="모집 현황 닫기" data-recruitment-action="close">${icon('close')}</button></div><p class="recruitment-owner"></p><p class="recruitment-help"></p><ul class="recruitment-members"></ul><p class="recruitment-feedback" role="status" aria-live="polite"></p><div class="recruitment-actions"></div>`;
    panel.querySelector('h2')!.textContent = `${recruitmentOptions[selected.kind].icon} ${recruitmentOptions[selected.kind].invitation}`;
    panel.querySelector<HTMLElement>('.recruitment-owner')!.textContent = `${owner}님의 모집 · ${selected.members.length}명 참여`;
    panel.querySelector<HTMLElement>('.recruitment-help')!.textContent = host ? '참여한 친구들은 내 펫 옆에서 기다려요. 함께하기를 마치면 완료를 눌러 주세요.' : joined ? '✓ 참여했어요. 내 펫이 모집자 곁에서 함께해요. 모집자가 완료하면 모임이 끝나요.' : '참여하면 내 펫이 모집자 곁으로 가서 함께 기다려요.';
    const list = panel.querySelector<HTMLUListElement>('ul')!;
    for (const member of selected.members) {
      const item = document.createElement('li');
      item.textContent = `✓ ${member.userName || member.petName}`;
      list.append(item);
    }
    panel.querySelector<HTMLElement>('.recruitment-feedback')!.textContent = feedback;
    panel.querySelector('.recruitment-feedback')!.classList.toggle('error', feedbackError);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = host || !joined ? 'primary' : 'quiet';
    action.dataset.recruitmentAction = host ? 'complete' : joined ? 'leave' : 'accept';
    action.textContent = busy ? '처리 중…' : host ? '완료' : joined ? '참여 취소' : '참여하기';
    action.disabled = busy;
    panel.querySelector('.recruitment-actions')!.append(action);
    if (previousAction) {
      panel.querySelector<HTMLElement>(`[data-recruitment-action="${previousAction}"]`)?.focus();
    }
  }

  // 현재 모집을 펫 곁에서 열며 클릭하지 않은 과거 소식은 복구하지 않는다.
  function open(): void {
    const group = current();
    if (!group || disposed) {
      return;
    }
    selectedID = group.id;
    choosing = false;
    feedback = '';
    feedbackError = false;
    panel.hidden = false;
    onOpen();
    render();
  }

  // 모집 메뉴에서 종류만 고르고 활성 모임이 있으면 현재 현황을 연다.
  function choose(): void {
    // 1. 이미 참여 중인 모집은 중복 생성 대신 현재 현황을 연다.
    if (current()) {
      open();
      return;
    }

    // 2. 본문·수신자 입력 없이 다섯 종류의 선택지만 표시한다.
    choosing = true;
    selectedID = undefined;
    feedback = '';
    feedbackError = false;
    panel.hidden = false;
    onOpen();
    render();
  }

  // 종류 버튼은 본문과 수신자 없이 로그인한 내 펫의 모집만 연다.
  async function start(kind: RecruitmentKind): Promise<void> {
    // 1. 재클릭은 이미 열린 내 모집을 보여 주고 중복 생성은 막는다.
    if (busy || disposed) {
      return;
    }
    const ownID = session()?.principal.petId;
    if (!ownID) {
      throw new Error('먼저 로그인해 주세요.');
    }
    const existing = getGroups().find(group => group.origin === 'recruitment' && group.hostPetId === ownID && group.status === 'open');
    if (existing) {
      open();
      return;
    }
    busy = true;
    feedback = '';
    feedbackError = false;
    if (requestKind !== kind) {
      requestKey = crypto.randomUUID();
      requestKind = kind;
    }
    render();
    try {
      const created = await api<Gathering>('/gatherings', { method: 'POST', body: JSON.stringify({ kind, idempotencyKey: requestKey }) });
      if (disposed || session()?.principal.petId !== ownID) {
        return;
      }
      if (created.status !== 'open') {
        requestKey = crypto.randomUUID();
        throw new Error('이미 완료한 모집이에요. 다시 누르면 새로 모집할 수 있어요.');
      }

      // 2. 서버의 현재 모집 상태를 공유하고 같은 자리에서 참여 현황을 연다.
      const live = getGroups();
      await changed(live.some(group => group.id === created.id) ? live : [...live, created]);
      requestKey = crypto.randomUUID();
      open();
    } finally {
      busy = false;
      render();
    }
  }

  // 참여·자발적 취소·모집자 완료를 서버 권한 확인 뒤 현재 상태로 반영한다.
  async function perform(action: 'accept' | 'leave' | 'complete'): Promise<void> {
    if (busy || !selectedID) {
      return;
    }
    const id = selectedID;
    const ownID = session()?.principal.petId;
    const hadFocus = panel.contains(document.activeElement);
    busy = true;
    feedback = '';
    feedbackError = false;
    render();
    if (hadFocus) {
      panel.focus();
    }
    let accepted = false;
    try {
      await api(`/gatherings/${id}/${action}`, { method: 'POST' });
      accepted = true;
      const latest = await api<Gathering[]>('/gatherings');
      if (!disposed && ownID === session()?.principal.petId) {
        await changed(latest);
      }
    } catch (error) {
      feedbackError = !accepted;
      feedback = accepted ? '요청은 접수했어요. 새 상태를 기다리고 있어요. 연결을 확인해 주세요.' : error instanceof Error ? error.message : '처리하지 못했어요. 다시 눌러 주세요.';
    } finally {
      busy = false;
      render();
      if (hadFocus && !panel.hidden) {
        panel.querySelector<HTMLButtonElement>('.recruitment-actions button')?.focus();
      }
    }
  }
  panel.onclick = event => {
    const kind = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-recruitment-kind]')?.dataset.recruitmentKind;
    if (kind && Object.hasOwn(recruitmentOptions, kind)) {
      void start(kind as RecruitmentKind).catch(error => {
        feedbackError = true;
        feedback = error instanceof Error ? error.message : '모집을 열지 못했어요. 다시 눌러 주세요.';
        render();
      });
      return;
    }
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-recruitment-action]')?.dataset.recruitmentAction;
    if (action === 'close') {
      close();
    } else if (action === 'accept' || action === 'leave' || action === 'complete') {
      void perform(action);
    }
  };

  // 트레이에서 현재 모집의 참여·완료 버튼으로 키보드 포커스를 옮긴다.
  async function focus(): Promise<void> {
    if (panel.hidden) {
      open();
    }
    if (!panel.hidden) {
      await setPetInput(true, preview);
      panel.querySelector<HTMLButtonElement>('.recruitment-actions button, .recruitment-choices button')?.focus();
    }
  }

  // 현재 모집 스냅샷만 받아 열린 패널과 지속 표시를 갱신한다.
  function update(): void {
    render();
  }

  // 다른 펫 위 UI와 겹치지 않게 열린 상태를 알려 준다.
  function visible(): boolean {
    return !panel.hidden;
  }

  // 펫 창이 정리될 때 모집 UI와 입력 허용 상태도 정리한다.
  function dispose(): void {
    close();
    disposed = true;
    badge.remove();
    panel.remove();
  }
  return { start, choose, open, close, focus, update, visible, current, dispose };
}
