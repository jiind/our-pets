import { normalizeServerURL } from './api';
import { t } from './i18n';

export type RoomInvitation = { url: string; invite: string };
export type HostInvitation = RoomInvitation & { localUrl: string };

// 서버 주소와 가입 코드를 채팅에 공유할 링크 하나로 묶는다.
export function invitationLink({ url, invite }: RoomInvitation): string {
  const link = new URL('ourpets://join');
  link.search = new URLSearchParams({ server: url, invite }).toString();
  return link.href;
}

// 링크 형식과 서버 주소를 네트워크 요청 전에 검사한다.
export function parseInvitation(input: string): RoomInvitation {
  try {
    const link = new URL(input.trim());
    if (link.protocol !== 'ourpets:' || link.host !== 'join' || (link.pathname && link.pathname !== '/') ||
        link.username || link.password || link.hash || [...link.searchParams].length !== 2) {
      throw new Error();
    }
    const server = link.searchParams.get('server');
    const invite = link.searchParams.get('invite');
    if (!server || !invite || invite.length < 12 || invite.length > 256) {
      throw new Error();
    }
    return { url: normalizeServerURL(server), invite };
  } catch {
    throw new Error(t('우리 펫 초대 링크를 확인해 주세요.'));
  }
}
