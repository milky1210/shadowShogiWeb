import {
  browserLocalPersistence,
  setPersistence,
  signInAnonymously,
  type User,
} from 'firebase/auth';
import {
  get,
  onChildAdded,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  runTransaction,
  startAt,
  update,
  type Unsubscribe,
} from 'firebase/database';
import { firebaseAuth, firebaseDatabase } from './firebase.ts';
import { normalizeRoomCode } from './shadow-shogi-room.ts';
import {
  applyBoardMove,
  applyDrop,
  otherSide,
  randomSide,
  type GameState,
  type HandPieceName,
  type MoveRecord,
  type Side,
} from './shadow-shogi.ts';

export { normalizeRoomCode } from './shadow-shogi-room.ts';

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ONLINE_DISABLED_MESSAGE =
  '現在オンライン対局を一時停止しています。ローカル対局とCPU対局は遊べます。';

export interface OnlineRoom {
  version: 1 | 2 | 3;
  status: 'waiting' | 'playing' | 'finished';
  hostUid: string;
  guestUid?: string;
  hostSide: Side;
  guestSide: Side;
  createdAt: number;
  updatedAt: number;
  revision: number;
  initialGame: GameState;
  game: GameState;
  timeline: GameState[];
}

export class OnlineRoomJoinBlockedError extends Error {
  readonly reason: 'playing' | 'finished';

  constructor(reason: 'playing' | 'finished') {
    super(
      reason === 'finished'
        ? 'この対局は終了しています'
        : 'この対局はすでに対戦中です',
    );
    this.reason = reason;
    this.name = 'OnlineRoomJoinBlockedError';
  }
}

interface StoredOnlineRoomV2
  extends Omit<OnlineRoom, 'version' | 'initialGame' | 'game' | 'timeline'> {
  version: 2;
  initialGameJson: string;
  gameJson: string;
}

interface StoredOnlineRoomV1
  extends Omit<OnlineRoom, 'initialGame' | 'game' | 'timeline'> {
  gameJson?: string;
  timelineJson?: string;
  game?: GameState;
}

interface StoredOnlineMetaV3 {
  status: 'waiting' | 'playing' | 'finished';
  hostUid: string;
  guestUid?: string;
  hostSide: Side;
  guestSide: Side;
  createdAt: number;
  updatedAt: number;
  revision: number;
  turn: Side;
  winner?: Side;
  lastMoveKey?: string;
}

export interface StoredOnlineMoveV3 extends MoveRecord {
  revision: number;
  uid: string;
  createdAt: number;
}

export interface StoredOnlineRoomV3 {
  version: 3;
  meta: StoredOnlineMetaV3;
  initialGameJson: string;
  moves?: Record<string, StoredOnlineMoveV3>;
}

function withoutPrivateGuesses(game: GameState): GameState {
  return { ...game, guesses: {} };
}

export function rebuildTimeline(
  initialGame: GameState,
  latestGame: GameState,
): GameState[] {
  const timeline = [withoutPrivateGuesses(initialGame)];
  let current = timeline[0];
  try {
    for (const move of latestGame.moveHistory) {
      current = applyStoredMove(current, move);
      timeline.push(current);
    }
    return timeline;
  } catch {
    return [withoutPrivateGuesses(latestGame)];
  }
}

export function applyStoredMove(
  game: GameState,
  move: Pick<
    MoveRecord,
    'from' | 'to' | 'side' | 'pieceName' | 'promoted' | 'dropped'
  >,
) {
  if (game.turn !== move.side || game.winner)
    throw new Error('対局の着手順を復元できませんでした');
  const next = move.dropped
    ? applyDrop(game, move.pieceName as HandPieceName, move.to)
    : move.from
      ? applyBoardMove(game, move.from, move.to, move.promoted)
      : null;
  if (!next) throw new Error('対局の着手を復元できませんでした');
  return withoutPrivateGuesses(next);
}

export function encodeOnlineRoom(room: OnlineRoom): StoredOnlineRoomV2 {
  const {
    initialGame,
    game,
    timeline: _timeline,
    version: _version,
    ...roomFields
  } = room;
  return {
    ...roomFields,
    version: 2,
    initialGameJson: JSON.stringify(withoutPrivateGuesses(initialGame)),
    gameJson: JSON.stringify(withoutPrivateGuesses(game)),
  };
}

export function encodeOnlineRoomV3(room: OnlineRoom): StoredOnlineRoomV3 {
  if (room.revision !== 0 || room.game.moveHistory.length !== 0)
    throw new Error('新しい部屋には着手履歴を含められません');
  return {
    version: 3,
    meta: {
      status: room.status,
      hostUid: room.hostUid,
      hostSide: room.hostSide,
      guestSide: room.guestSide,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      revision: 0,
      turn: room.game.turn,
    },
    initialGameJson: JSON.stringify(withoutPrivateGuesses(room.initialGame)),
  };
}

function decodeOnlineRoomV3(stored: StoredOnlineRoomV3): OnlineRoom {
  const initialGame = withoutPrivateGuesses(
    JSON.parse(stored.initialGameJson) as GameState,
  );
  const orderedMoves = Object.values(stored.moves ?? {}).sort(
    (left, right) => left.revision - right.revision,
  );
  const timeline = [initialGame];
  let game = initialGame;
  for (let index = 0; index < orderedMoves.length; index += 1) {
    const move = orderedMoves[index];
    if (move.revision !== index + 1)
      throw new Error('対局の着手履歴が連続していません');
    game = applyStoredMove(game, move);
    timeline.push(game);
  }
  if (
    stored.meta.revision !== orderedMoves.length ||
    stored.meta.turn !== game.turn ||
    (stored.meta.winner ?? null) !== game.winner
  )
    throw new Error('対局データを復元できませんでした');
  return {
    version: 3,
    status: stored.meta.status,
    hostUid: stored.meta.hostUid,
    guestUid: stored.meta.guestUid,
    hostSide: stored.meta.hostSide,
    guestSide: stored.meta.guestSide,
    createdAt: stored.meta.createdAt,
    updatedAt: stored.meta.updatedAt,
    revision: stored.meta.revision,
    initialGame,
    game,
    timeline,
  };
}

export function decodeOnlineRoom(value: unknown): OnlineRoom | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object')
    throw new Error('対局データを復元できませんでした');

  const version = (value as { version?: unknown }).version;
  if (version === 3) {
    const stored = value as Partial<StoredOnlineRoomV3>;
    if (
      !stored.meta ||
      typeof stored.initialGameJson !== 'string' ||
      typeof stored.meta.hostUid !== 'string' ||
      (stored.meta.hostSide !== 1 && stored.meta.hostSide !== 2) ||
      (stored.meta.guestSide !== 1 && stored.meta.guestSide !== 2)
    )
      throw new Error('対局データを復元できませんでした');
    return decodeOnlineRoomV3(stored as StoredOnlineRoomV3);
  }

  const stored = value as Partial<StoredOnlineRoomV2 & StoredOnlineRoomV1>;
  if (
    stored.version === 2 &&
    typeof stored.initialGameJson === 'string' &&
    typeof stored.gameJson === 'string'
  ) {
    const initialGame = JSON.parse(stored.initialGameJson) as GameState;
    const game = JSON.parse(stored.gameJson) as GameState;
    const {
      initialGameJson: _initialGameJson,
      gameJson: _gameJson,
      timelineJson: _timelineJson,
      ...roomFields
    } = stored;
    return {
      ...(roomFields as Omit<OnlineRoom, 'initialGame' | 'game' | 'timeline'>),
      version: 2,
      initialGame,
      game,
      timeline: rebuildTimeline(initialGame, game),
    };
  }

  if (typeof stored.gameJson === 'string') {
    const game = JSON.parse(stored.gameJson) as GameState;
    const legacyTimeline =
      typeof stored.timelineJson === 'string'
        ? (JSON.parse(stored.timelineJson) as GameState[])
        : [game];
    const initialGame = legacyTimeline[0] ?? game;
    const {
      gameJson: _gameJson,
      timelineJson: _timelineJson,
      initialGameJson: _initialGameJson,
      ...roomFields
    } = stored;
    return {
      ...(roomFields as Omit<OnlineRoom, 'initialGame' | 'game' | 'timeline'>),
      version: 1,
      initialGame,
      game,
      timeline: legacyTimeline,
    };
  }

  if (stored.game && Array.isArray(stored.game.moveHistory)) {
    const game = stored.game;
    const { game: _game, ...roomFields } = stored;
    return {
      ...(roomFields as Omit<OnlineRoom, 'initialGame' | 'game' | 'timeline'>),
      version: 1,
      initialGame: game,
      game,
      timeline: [game],
    };
  }
  throw new Error('この対局部屋は旧形式です。新しい部屋を作成してください');
}

let sessionRequest: Promise<User> | null = null;

async function assertOnlineEnabled() {
  const snapshot = await get(ref(firebaseDatabase, 'config/onlineEnabled'));
  if (snapshot.val() === false) throw new Error(ONLINE_DISABLED_MESSAGE);
}

async function getOnlineSession(): Promise<User> {
  if (!sessionRequest) {
    sessionRequest = (async () => {
      await setPersistence(firebaseAuth, browserLocalPersistence);
      if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
      return (await signInAnonymously(firebaseAuth)).user;
    })().finally(() => {
      sessionRequest = null;
    });
  }
  return sessionRequest;
}

function roomPath(roomCode: string) {
  return `rooms/${normalizeRoomCode(roomCode)}`;
}

function makeRoomCode() {
  const values = new Uint32Array(8);
  window.crypto.getRandomValues(values);
  return Array.from(
    values,
    (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length],
  ).join('');
}

async function transactStoredRoom(
  roomCode: string,
  transform: (
    stored: unknown,
    room: OnlineRoom | null,
  ) => unknown,
): Promise<{ committed: boolean; room: OnlineRoom | null }> {
  const result = await runTransaction(
    ref(firebaseDatabase, roomPath(roomCode)),
    (stored) => transform(stored, decodeOnlineRoom(stored)),
    { applyLocally: false },
  );
  return {
    committed: result.committed,
    room: decodeOnlineRoom(result.snapshot.val()),
  };
}

export async function createOnlineRoom(game: GameState) {
  await assertOnlineEnabled();
  const session = await getOnlineSession();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const roomCode = makeRoomCode();
    const now = Date.now();
    const initialGame = withoutPrivateGuesses(game);
    const hostSide = randomSide();
    const room: OnlineRoom = {
      version: 3,
      status: 'waiting',
      hostUid: session.uid,
      hostSide,
      guestSide: otherSide(hostSide),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      initialGame,
      game: initialGame,
      timeline: [initialGame],
    };
    const result = await transactStoredRoom(roomCode, (stored) =>
      stored === null ? encodeOnlineRoomV3(room) : undefined,
    );
    if (result.committed && result.room)
      return {
        roomCode,
        room: result.room,
        uid: session.uid,
        side: result.room.hostSide,
      };
  }
  throw new Error('部屋番号を作成できませんでした');
}

export async function joinOnlineRoom(roomCodeValue: string) {
  const roomCode = normalizeRoomCode(roomCodeValue);
  if (roomCode.length !== 8)
    throw new Error('8文字の部屋番号を入力してください');
  await assertOnlineEnabled();
  const session = await getOnlineSession();
  const roomReference = ref(firebaseDatabase, roomPath(roomCode));
  const existingRoom = decodeOnlineRoom((await get(roomReference)).val());
  if (!existingRoom) throw new Error('対局部屋が見つかりません');
  if (
    existingRoom.hostUid === session.uid ||
    existingRoom.guestUid === session.uid
  ) {
    const side =
      existingRoom.hostUid === session.uid
        ? existingRoom.hostSide
        : existingRoom.guestSide;
    return { roomCode, room: existingRoom, uid: session.uid, side };
  }
  if (existingRoom.guestUid || existingRoom.status !== 'waiting')
    throw new OnlineRoomJoinBlockedError(
      existingRoom.status === 'finished' ? 'finished' : 'playing',
    );

  if (existingRoom.version === 3) {
    try {
      await update(roomReference, {
        'meta/guestUid': session.uid,
        'meta/status': 'playing',
        'meta/updatedAt': Date.now(),
      });
    } catch (error) {
      const latestRoom = decodeOnlineRoom((await get(roomReference)).val());
      if (latestRoom?.guestUid && latestRoom.guestUid !== session.uid)
        throw new OnlineRoomJoinBlockedError(
          latestRoom.status === 'finished' ? 'finished' : 'playing',
        );
      if (
        error instanceof Error &&
        /permission|denied/i.test(`${error.name} ${error.message}`)
      )
        throw new Error('対局部屋に参加できませんでした');
      throw error;
    }

    const joinedRoom = decodeOnlineRoom((await get(roomReference)).val());
    if (!joinedRoom) throw new Error('対局部屋が見つかりません');
    if (joinedRoom.guestUid !== session.uid)
      throw new OnlineRoomJoinBlockedError(
        joinedRoom.status === 'finished' ? 'finished' : 'playing',
      );
    return {
      roomCode,
      room: joinedRoom,
      uid: session.uid,
      side: joinedRoom.guestSide,
    };
  }

  let joinError = '';
  let blockedReason: 'playing' | 'finished' | null = null;
  let alreadyJoined = false;
  const result = await transactStoredRoom(roomCode, (stored, current) => {
    if (!current) {
      joinError = '対局部屋が見つかりません';
      return undefined;
    }
    if (current.hostUid === session.uid || current.guestUid === session.uid) {
      alreadyJoined = true;
      return undefined;
    }
    if (current.guestUid) {
      blockedReason = current.status === 'finished' ? 'finished' : 'playing';
      return undefined;
    }
    const now = Date.now();
    if (current.version === 3) {
      const currentStored = stored as StoredOnlineRoomV3;
      return {
        ...currentStored,
        meta: {
          ...currentStored.meta,
          guestUid: session.uid,
          status: 'playing',
          updatedAt: now,
        },
      } satisfies StoredOnlineRoomV3;
    }
    return encodeOnlineRoom({
      ...current,
      version: 2,
      guestUid: session.uid,
      status: current.game.winner ? 'finished' : 'playing',
      updatedAt: now,
    });
  });
  if (blockedReason) throw new OnlineRoomJoinBlockedError(blockedReason);
  if (joinError) throw new Error(joinError);

  let room = result.room;
  if (alreadyJoined && !room) {
    room = decodeOnlineRoom(
      (await get(ref(firebaseDatabase, roomPath(roomCode)))).val(),
    );
  }
  if (!room) throw new Error('対局部屋に参加できませんでした');
  const side = room.hostUid === session.uid ? room.hostSide : room.guestSide;
  return { roomCode, room, uid: session.uid, side };
}

function participantSide(room: OnlineRoom, uid: string) {
  return room.hostUid === uid
    ? room.hostSide
    : room.guestUid === uid
      ? room.guestSide
      : null;
}

async function commitIncrementalOnlineGame(
  roomCode: string,
  expectedRevision: number,
  side: Side,
  game: GameState,
  room: OnlineRoom,
) {
  const session = await getOnlineSession();
  if (participantSide(room, session.uid) !== side)
    throw new Error('この対局には参加していません');
  if (
    room.revision !== expectedRevision ||
    room.game.turn !== side ||
    room.game.winner ||
    !game.lastMove ||
    game.moveHistory.length !== expectedRevision + 1
  )
    throw new Error('盤面が更新されました。最新の状態を確認してください');

  const now = Date.now();
  const moveKey = push(
    ref(firebaseDatabase, `${roomPath(roomCode)}/moves`),
  ).key;
  if (!moveKey) throw new Error('着手番号を作成できませんでした');
  const move: StoredOnlineMoveV3 = {
    ...game.lastMove,
    revision: expectedRevision + 1,
    uid: session.uid,
    createdAt: now,
  };
  const changes: Record<string, unknown> = {
    [`moves/${moveKey}`]: move,
    'meta/revision': expectedRevision + 1,
    'meta/turn': game.turn,
    'meta/status': game.winner ? 'finished' : 'playing',
    'meta/updatedAt': now,
    'meta/lastMoveKey': moveKey,
  };
  if (game.winner) changes['meta/winner'] = game.winner;
  try {
    await update(ref(firebaseDatabase, roomPath(roomCode)), changes);
  } catch (error) {
    if (
      error instanceof Error &&
      /permission|denied/i.test(`${error.name} ${error.message}`)
    )
      throw new Error(
        '盤面が更新されたか、オンライン対局が一時停止されました。最新の状態を確認してください',
      );
    throw error;
  }

  const sharedGame = withoutPrivateGuesses(game);
  return {
    ...room,
    status: game.winner ? 'finished' : 'playing',
    updatedAt: now,
    revision: expectedRevision + 1,
    game: sharedGame,
    timeline: [...room.timeline, sharedGame],
  } satisfies OnlineRoom;
}

export async function commitOnlineGame(
  roomCode: string,
  expectedRevision: number,
  side: Side,
  game: GameState,
  currentRoom: OnlineRoom | null,
) {
  if (currentRoom?.version === 3)
    return commitIncrementalOnlineGame(
      roomCode,
      expectedRevision,
      side,
      game,
      currentRoom,
    );

  const session = await getOnlineSession();
  let commitError = '';
  const result = await transactStoredRoom(roomCode, (_stored, current) => {
    if (!current) {
      commitError = '対局部屋が見つかりません';
      return undefined;
    }
    if (participantSide(current, session.uid) !== side) {
      commitError = 'この対局には参加していません';
      return undefined;
    }
    if (
      current.revision !== expectedRevision ||
      current.game.turn !== side ||
      current.game.winner
    ) {
      commitError = '盤面が更新されました。最新の状態を確認してください';
      return undefined;
    }
    const sharedGame = withoutPrivateGuesses(game);
    return encodeOnlineRoom({
      ...current,
      version: 2,
      game: sharedGame,
      timeline: [...current.timeline, sharedGame],
      revision: current.revision + 1,
      status: game.winner ? 'finished' : 'playing',
      updatedAt: Date.now(),
    });
  });
  if (commitError) throw new Error(commitError);
  if (!result.committed || !result.room)
    throw new Error('着手を送信できませんでした');
  return result.room;
}

function mergeMetaIntoRoom(room: OnlineRoom, meta: StoredOnlineMetaV3) {
  const canApplyMoveState = meta.revision <= room.revision;
  return {
    ...room,
    hostUid: meta.hostUid,
    guestUid: meta.guestUid,
    hostSide: meta.hostSide,
    guestSide: meta.guestSide,
    status: canApplyMoveState ? meta.status : room.status,
    updatedAt: canApplyMoveState ? meta.updatedAt : room.updatedAt,
  } satisfies OnlineRoom;
}

function subscribeIncrementalRoom(
  roomCode: string,
  initialRoom: OnlineRoom,
  onRoom: (room: OnlineRoom) => void,
  onError: (message: string) => void,
) {
  let currentRoom = initialRoom;
  let latestMeta: StoredOnlineMetaV3 | null = null;
  const reportError = (error: Error) =>
    onError(error.message || '対局の更新を受信できませんでした');

  const metaUnsubscribe = onValue(
    ref(firebaseDatabase, `${roomPath(roomCode)}/meta`),
    (snapshot) => {
      latestMeta = snapshot.val() as StoredOnlineMetaV3;
      if (!latestMeta) return;
      currentRoom = mergeMetaIntoRoom(currentRoom, latestMeta);
      onRoom(currentRoom);
    },
    reportError,
  );
  const newMoves = query(
    ref(firebaseDatabase, `${roomPath(roomCode)}/moves`),
    orderByChild('revision'),
    startAt(initialRoom.revision + 1),
  );
  const movesUnsubscribe = onChildAdded(
    newMoves,
    (snapshot) => {
      try {
        const move = snapshot.val() as StoredOnlineMoveV3;
        if (!move || move.revision <= currentRoom.revision) return;
        if (move.revision !== currentRoom.revision + 1)
          throw new Error('着手の受信順が前後しました。再読み込みしてください');
        const nextGame = applyStoredMove(currentRoom.game, move);
        currentRoom = {
          ...currentRoom,
          status: nextGame.winner ? 'finished' : 'playing',
          revision: move.revision,
          updatedAt: move.createdAt,
          game: nextGame,
          timeline: [...currentRoom.timeline, nextGame],
        };
        if (latestMeta)
          currentRoom = mergeMetaIntoRoom(currentRoom, latestMeta);
        onRoom(currentRoom);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : '対局の更新を復元できませんでした',
        );
      }
    },
    reportError,
  );
  return () => {
    metaUnsubscribe();
    movesUnsubscribe();
  };
}

export function subscribeOnlineRoom(
  roomCode: string,
  onRoom: (room: OnlineRoom) => void,
  onError: (message: string) => void,
) {
  const unsubscribes: Unsubscribe[] = [];
  let stopped = false;
  void getOnlineSession()
    .then(async () => {
      const roomReference = ref(firebaseDatabase, roomPath(roomCode));
      const room = decodeOnlineRoom((await get(roomReference)).val());
      if (stopped || !room) return;
      onRoom(room);
      if (room.version === 3) {
        unsubscribes.push(
          subscribeIncrementalRoom(roomCode, room, onRoom, onError),
        );
        return;
      }
      unsubscribes.push(
        onValue(
          roomReference,
          (snapshot) => {
            const updatedRoom = decodeOnlineRoom(snapshot.val());
            if (updatedRoom) onRoom(updatedRoom);
          },
          (error) =>
            onError(error.message || '対局の更新を受信できませんでした'),
        ),
      );
    })
    .catch((error: unknown) =>
      onError(
        error instanceof Error ? error.message : '対局へ接続できませんでした',
      ),
    );
  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
