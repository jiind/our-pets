export function testInvitation(server: string): string {
  return `ourpets://join?${new URLSearchParams({ server, invite: 'test-only-invite' })}`;
}
