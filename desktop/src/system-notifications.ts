import { invoke, isTauri } from '@tauri-apps/api/core';
import { serverURL, session } from './api';
import { recruitmentOptions, type GatheringActivity, type PetEvent } from './types';
import { connectedAlertsMuted } from './notification-preferences';

interface Settings {
  enabled: boolean;
}

// 현재 기기의 수신 이벤트만 OS에 전달하고 실패해도 펫 말풍선·실시간 처리는 유지한다.
function notify(id: string, title: string, body: string, expiresAt: number): void {
  if (!isTauri() || expiresAt <= Date.now()) {
    return;
  }
  const current = session();
  const key = `${serverURL()}/${current?.principal.userId || 'local'}/${current?.principal.deviceId || 'local'}/${id}`;
  void invoke('show_system_notification', { id: key, title, body, expiresAt: Math.min(expiresAt, Date.now() + 15000) }).catch(() => {
    console.warn('OS 알림 요청을 전달하지 못했어요.');
  });
}

// 받은 메시지·연결 알림을 알리고 발신 확인·몸짓에는 OS 알림을 만들지 않는다.
export function notifyReceivedMessage(event: PetEvent): void {
  if (event.outgoing || event.kind === 'interaction' || (event.sender && event.sender.petId === session()?.principal.petId)) {
    return;
  }
  if (event.type === 'notification' && connectedAlertsMuted()) {
    return;
  }
  const source = event.notification?.sourceKind;
  const provider = source === 'docker' ? 'Docker' : source === 'slack' ? 'Slack' : source === 'codex' ? 'Codex' : source === 'claude' ? 'Claude' : source || '알림';
  const title = event.sender ? event.sender.userName || event.sender.petName : `${provider} · ${event.notification?.title || '새 소식'}`;
  notify(`message/${event.id}`, title, event.body || event.notification?.body || '', event.expiresAt);
}

// 서버가 확정한 모집 생성·참여·완료를 해당 수신자에게만 OS 알림으로 표시한다.
export function notifyGatheringActivity(event: GatheringActivity): void {
  // 1. 내 이벤트·다른 모집의 참여·비참가자 완료 알림을 클라이언트에서도 제외한다.
  const ownID = session()?.principal.petId;
  const group = event.gathering;
  const option = recruitmentOptions[group?.kind];
  if (!ownID || !option || event.actor.petId === ownID || group.origin !== 'recruitment') {
    return;
  }
  if (event.action === 'joined' && group.hostPetId !== ownID) {
    return;
  }
  if (event.action === 'completed' && !group.members.some(member => member.petId === ownID)) {
    return;
  }

  // 2. 공개 이름과 종류만 사용하고 재접속 스냅샷에서는 이 함수를 호출하지 않는다.
  const actor = event.actor.userName || event.actor.petName || '친구';
  if (event.action === 'started') {
    notify(`gathering/${event.id}`, `${actor}님이 ${option.label} 함께할 사람을 모집해요`, '펫의 모집 메뉴에서 참여할 수 있어요.', event.expiresAt);
  } else if (event.action === 'joined') {
    notify(`gathering/${event.id}`, `${option.label} 모집에 참여했어요`, `${actor}님이 참여했어요.`, event.expiresAt);
  } else if (event.action === 'completed') {
    notify(`gathering/${event.id}`, `${option.label} 모집 완료`, `${actor}님이 모집을 완료했어요.`, event.expiresAt);
  }
}

// 알림 화면의 제목 오른쪽에서 이 PC의 OS 알림을 켜고 끈다.
export function mountSystemNotificationToggle(root: HTMLElement, onError: (message: string) => void): void {
  // 1. 설정이 도착하기 전에는 중복 조작을 막고 앱 설정 원본을 조회한다.
  if (!isTauri()) {
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  button.textContent = 'OS 알림';
  button.title = '메시지·모집·연결된 알람의 OS 알림을 이 PC에서 켜거나 꺼요. 펫 말풍선은 유지돼요.';
  root.append(button);
  let settings: Settings = { enabled: true };

  // 확인한 설정만 다음 동작 문구와 눌림 상태에 반영한다.
  function render(): void {
    button.textContent = settings.enabled ? 'OS 알림 끄기' : 'OS 알림 켜기';
    button.setAttribute('aria-pressed', String(settings.enabled));
  }

  // 현재 창의 버튼이 살아 있을 때만 초기 설정과 조작 가능 상태를 반영한다.
  async function load(): Promise<void> {
    try {
      settings = await invoke<Settings>('system_notification_settings');
      if (button.isConnected) {
        render();
      }
    } catch {
      if (button.isConnected) {
        onError('OS 알림 설정을 읽지 못했어요. 알림 화면을 다시 열어 주세요.');
      }
    } finally {
      button.disabled = false;
    }
  }
  button.onclick = () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    void invoke<Settings>('set_system_notifications', { enabled: !settings.enabled }).then(value => {
      settings = value;
      render();
    }).catch(() => {
      if (button.isConnected) {
        onError('OS 알림 설정을 변경하지 못했어요. OS 알림 설정을 확인해 주세요.');
      }
    }).finally(() => {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    });
  };
  void load();
}
