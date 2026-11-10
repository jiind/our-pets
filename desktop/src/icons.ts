// 화면 제어 아이콘을 동일한 크기와 선 굵기의 로컬 SVG로 표시한다.
export function icon(name: 'mail' | 'brush' | 'inbox' | 'link' | 'bell' | 'move' | 'settings' | 'paw' | 'coffee' | 'meal' | 'refresh' | 'plus' | 'close' | 'chevron-left' | 'chevron-right' | 'logout' | 'eye' | 'eye-off'): string {
  const paths = {
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path d="m3 3 18 18"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    paw: '<ellipse cx="5" cy="9" rx="2" ry="2.5"/><ellipse cx="10" cy="5" rx="2" ry="2.5"/><ellipse cx="15.5" cy="5.5" rx="2" ry="2.5"/><ellipse cx="20" cy="10" rx="2" ry="2.5"/><path d="M7 15c1-2 2.5-4 5-4s4 2 5 4c1.5 1.5 1.5 4-.5 5-1.5.8-3-.5-4.5-.5s-3 1.3-4.5.5c-2-1-2-3.5-.5-5z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h10"/>',
    coffee: '<path d="M4 9h12v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM16 9h2a3 3 0 0 1 0 6h-2M3 22h15M7 2v3M12 2v3"/>',
    meal: '<path d="M5 3v7M9 3v7M5 7h4M7 10v12M17 22V3c-4 3-4 9 0 10"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    brush: '<path d="m14 4 6 6-8 8-6-6zM6 12l-3 9 9-3M15 5l4 4"/>',
    inbox: '<path d="m5 4-3 12v4h20v-4L19 4zM2 16h6l2 3h4l2-3h6"/>',
    link: '<path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8"/>',
    move: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    settings: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/><circle cx="12" cy="12" r="5"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
