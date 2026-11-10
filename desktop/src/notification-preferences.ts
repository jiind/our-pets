// 이전 전체 일시 중지 값을 이어받아 연결한 외부 알림의 표시 설정으로 읽는다.
export function connectedAlertsMuted(): boolean {
  return (localStorage.getItem('ourpets.connected-alerts-muted') ?? localStorage.getItem('ourpets.paused')) === 'true';
}

// 연결 알림의 표시만 전환하고 과거 전체 일시 중지 키는 정리한다.
export function setConnectedAlertsMuted(muted: boolean): void {
  localStorage.setItem('ourpets.connected-alerts-muted', String(muted));
  localStorage.removeItem('ourpets.paused');
}
