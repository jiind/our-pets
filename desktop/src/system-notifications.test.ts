import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatheringActivity, PetEvent } from './types';

const runtime = vi.hoisted(() => ({ native: true, muted: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke, isTauri: () => runtime.native }));
vi.mock('./api', () => ({ serverURL: () => 'http://127.0.0.1:9377', session: () => ({ token: 'not-for-notifications', principal: { userId: 'me', petId: 'self', deviceId: 'this-device' } }) }));
vi.mock('./notification-preferences', () => ({ connectedAlertsMuted: () => runtime.muted }));
import { notifyGatheringActivity, notifyReceivedMessage } from './system-notifications';

// 실제 계정과 OS를 사용하지 않고 알림 요청만 수집한다.
beforeEach(() => {
  runtime.native = true;
  runtime.muted = false;
  runtime.invoke.mockReset().mockResolvedValue(undefined);
});

// 현재 수신한 다른 사용자의 텍스트 이벤트를 만든다.
function message(id = 'message'): PetEvent {
  return { id, type: 'message', kind: 'text', body: '함께해요', sender: { userId: 'friend', userName: '친구 닉네임', petId: 'friend-pet', petName: '이전 이름' }, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
}

// 서버가 확정한 모집 활동과 참여자 스냅샷을 만든다.
function activity(action: GatheringActivity['action']): GatheringActivity {
  return { id: `activity-${action}`, type: 'gathering_activity', action, actor: { userId: 'friend', userName: '친구', petId: 'friend-pet', petName: '친구' }, gathering: { id: 'gathering', hostPetId: 'friend-pet', kind: 'coffee', origin: 'recruitment', status: 'open', expiresAt: 0, members: [] }, createdAt: Date.now(), expiresAt: Date.now() + 15000 };
}

describe('메시지·개인 알림의 OS 전달 경계', () => {
  it('닉네임과 내용을 전송하고 토큰 없이 같은 기기 중복 방지 ID를 유지한다', () => {
    notifyReceivedMessage(message());
    notifyReceivedMessage(message());
    const first = runtime.invoke.mock.calls[0];
    expect(first[0]).toBe('show_system_notification');
    expect(first[1]).toMatchObject({ title: '친구 닉네임', body: '함께해요' });
    expect(runtime.invoke.mock.calls[1][1].id).toBe(first[1].id);
    expect(JSON.stringify(runtime.invoke.mock.calls)).not.toContain('not-for-notifications');
    expect(first[1].expiresAt).toBeLessThanOrEqual(Date.now() + 15000);
  });
  it('발신 확인·내 메시지·몸짓·만료 알림을 OS에 전송하지 않는다', () => {
    notifyReceivedMessage({ ...message(), outgoing: { mode: 'all', recipientCount: 3 } });
    notifyReceivedMessage({ ...message(), sender: { ...message().sender!, petId: 'self' } });
    notifyReceivedMessage({ ...message(), kind: 'interaction' });
    notifyReceivedMessage({ ...message(), expiresAt: Date.now() - 1 });
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
  it('연결된 알람을 꺼도 사용자 메시지와 모집은 계속 전달한다', () => {
    runtime.muted = true;
    notifyReceivedMessage({ ...message(), type: 'notification', sender: undefined, kind: 'external', notification: { schemaVersion: 1, sourceKind: 'docker', connectionId: 'local-docker', eventId: 'docker-event', occurredAt: Date.now(), title: '컨테이너', body: '상태 변경' } });
    expect(runtime.invoke).not.toHaveBeenCalled();
    notifyReceivedMessage(message());
    notifyGatheringActivity(activity('started'));
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
  });
  it('브라우저 검증 화면에서는 실제 OS 알림을 요청하지 않는다', () => {
    runtime.native = false;
    notifyReceivedMessage(message());
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ['docker', 'Docker · 컨테이너', 'Docker · 컨테이너'],
    ['slack', 'Slack · 멘션', 'Slack · 멘션'],
    ['codex', 'Codex 한도 소진', 'Codex 한도 소진'],
    ['claude', 'Claude 사용량 알림', 'Claude 사용량 알림'],
    ['docker', '컨테이너', 'Docker · 컨테이너'],
    ['docker', 'Dockerfile 변경', 'Docker · Dockerfile 변경'],
  ])('외부 알림 출처 %s의 제목 %s를 한 번만 표시한다', (sourceKind, title, expected) => {
    const event: PetEvent = { ...message(), type: 'notification', sender: undefined, kind: 'external', body: '', notification: { schemaVersion: 1, sourceKind, connectionId: 'local-source', eventId: 'external-event', occurredAt: Date.now(), title, body: '상태 변경' } };
    notifyReceivedMessage(event);
    expect(runtime.invoke).toHaveBeenCalledWith('show_system_notification', expect.objectContaining({ title: expected, body: '상태 변경' }));
  });
});

describe('모집 OS 알림의 수신자', () => {
  it('참여 알림은 모집자에게만 전달한다', () => {
    const event = activity('joined');
    notifyGatheringActivity(event);
    expect(runtime.invoke).not.toHaveBeenCalled();
    event.gathering.hostPetId = 'self';
    notifyGatheringActivity(event);
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });
  it('완료 알림은 실제 참여자에게만 전달한다', () => {
    const event = activity('completed');
    notifyGatheringActivity(event);
    expect(runtime.invoke).not.toHaveBeenCalled();
    event.gathering.members.push({ petId: 'self', petName: '내 닉네임', userName: '내 닉네임' });
    notifyGatheringActivity(event);
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });
  it('자기 활동과 이전 메시지 제안에는 모집 배너를 만들지 않는다', () => {
    const own = activity('started');
    own.actor.petId = 'self';
    notifyGatheringActivity(own);
    const legacy = activity('started');
    legacy.gathering.origin = 'message';
    notifyGatheringActivity(legacy);
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
});
