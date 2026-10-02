import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBoardMove,
  createInitialGame,
  getLegalMoves,
  seededRandom,
  type Position,
} from './shadow-shogi.ts';
import {
  decodeOnlineRoom,
  encodeOnlineRoom,
  encodeOnlineRoomV3,
  type OnlineRoom,
  type StoredOnlineMoveV3,
} from './shadow-shogi-online.ts';

test('online room v2 stores one initial state and one current state', () => {
  const initial = createInitialGame(seededRandom(42));
  let from: Position | undefined;
  let to: Position | undefined;
  for (let row = 0; row < 9 && !from; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const candidate: Position = [row, column];
      const targets = getLegalMoves(initial, candidate);
      if (initial.board[row][column]?.side === initial.turn && targets[0]) {
        from = candidate;
        to = targets[0];
        break;
      }
    }
  }
  assert.ok(from && to);
  const moved = applyBoardMove(initial, from, to, false);
  moved.guesses[1] = '王?';
  const room: OnlineRoom = {
    version: 2,
    status: 'playing',
    hostUid: 'host',
    guestUid: 'guest',
    hostSide: 1,
    guestSide: 2,
    createdAt: 1,
    updatedAt: 2,
    revision: 1,
    initialGame: initial,
    game: moved,
    timeline: [initial, moved],
  };

  const stored = encodeOnlineRoom(room);
  assert.equal('timelineJson' in stored, false);
  assert.deepEqual(JSON.parse(stored.gameJson).guesses, {});

  const decoded = decodeOnlineRoom(stored);
  assert.ok(decoded);
  assert.equal(decoded.timeline.length, 2);
  assert.equal(decoded.game.moveHistory.length, 1);
  assert.deepEqual(decoded.game.guesses, {});
});

test('online room v3 rebuilds the game from incremental moves', () => {
  const initial = createInitialGame(seededRandom(84));
  let from: Position | undefined;
  let to: Position | undefined;
  for (let row = 0; row < 9 && !from; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const candidate: Position = [row, column];
      const targets = getLegalMoves(initial, candidate);
      if (initial.board[row][column]?.side === initial.turn && targets[0]) {
        from = candidate;
        to = targets[0];
        break;
      }
    }
  }
  assert.ok(from && to);
  const moved = applyBoardMove(initial, from, to, false);
  assert.ok(moved.lastMove);

  const waitingRoom: OnlineRoom = {
    version: 3,
    status: 'waiting',
    hostUid: 'host',
    hostSide: 1,
    guestSide: 2,
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    initialGame: initial,
    game: initial,
    timeline: [initial],
  };
  const stored = encodeOnlineRoomV3(waitingRoom);
  const incrementalMove: StoredOnlineMoveV3 = {
    ...moved.lastMove,
    revision: 1,
    uid: 'host',
    createdAt: 2,
  };
  stored.meta = {
    ...stored.meta,
    status: 'playing',
    guestUid: 'guest',
    revision: 1,
    turn: moved.turn,
    updatedAt: 2,
  };
  stored.moves = { move1: incrementalMove };

  const decoded = decodeOnlineRoom(stored);
  assert.ok(decoded);
  assert.equal(decoded.version, 3);
  assert.equal(decoded.revision, 1);
  assert.equal(decoded.timeline.length, 2);
  assert.deepEqual(decoded.game.board, moved.board);
  assert.deepEqual(decoded.game.guesses, {});

  const fullStateBytes = Buffer.byteLength(JSON.stringify(moved));
  const incrementalBytes = Buffer.byteLength(JSON.stringify(incrementalMove));
  assert.ok(incrementalBytes < fullStateBytes / 4);
});
