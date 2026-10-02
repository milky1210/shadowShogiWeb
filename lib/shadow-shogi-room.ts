const ROOM_CODE_PATTERN = /[^2-9A-HJ-NP-Z]/g;

export function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(ROOM_CODE_PATTERN, '').slice(0, 8);
}

export function onlineInviteUrl(roomCode: string) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', normalizeRoomCode(roomCode));
  return url.toString();
}
