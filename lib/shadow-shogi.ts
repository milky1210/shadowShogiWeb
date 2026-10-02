export type Side = 1 | 2;
export type BasePieceName = '歩' | '香' | '桂' | '銀' | '金' | '飛' | '角' | '王';
export type HandPieceName = Exclude<BasePieceName, '王'>;
export type PromotedPieceName = 'と' | '杏' | '圭' | '全' | '龍' | '馬';
export type PieceName = BasePieceName | PromotedPieceName;
export type GuessName = PieceName | '?' | `${PieceName}?`;
export type Position = [row: number, column: number];

export interface Piece {
  id: number;
  name: PieceName;
  side: Side;
}

export type Board = Array<Array<Piece | null>>;
export type Hand = Record<HandPieceName, number>;
export type TakenLog = Record<HandPieceName, number>;

export interface MoveRecord {
  from: Position | null;
  to: Position;
  side: Side;
  pieceId: number;
  pieceName: PieceName;
  captured: PieceName | null;
  promoted: boolean;
  dropped: boolean;
}

export interface GameState {
  board: Board;
  turn: Side;
  winner: Side | null;
  latestId: number;
  hands: Record<Side, Hand>;
  guesses: Record<number, GuessName>;
  moveLogs: Record<number, Position[]>;
  takenLogs: Record<Side, TakenLog>;
  lastMove: MoveRecord | null;
  moveHistory: MoveRecord[];
}

export const HAND_NAMES: HandPieceName[] = ['歩', '香', '桂', '銀', '金', '飛', '角'];
export const GUESS_NAMES: PieceName[] = ['歩', '香', '桂', '銀', '金', '飛', '角', 'と', '杏', '圭', '全', '王', '龍', '馬'];
export const PROMOTION_MAP: Partial<Record<PieceName, PromotedPieceName>> = {
  歩: 'と', 香: '杏', 桂: '圭', 銀: '全', 飛: '龍', 角: '馬',
};
export const UNPROMOTION_MAP: Partial<Record<PieceName, HandPieceName>> = {
  と: '歩', 杏: '香', 圭: '桂', 全: '銀', 馬: '角', 龍: '飛',
};

const GOLD_STEPS: Position[] = [[-1, 0], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0]];
const KING_STEPS: Position[] = [[-1, 0], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [1, 1], [1, -1]];

export function otherSide(side: Side): Side {
  return side === 1 ? 2 : 1;
}

export function randomSide(random: () => number = Math.random): Side {
  return random() < 0.5 ? 1 : 2;
}

export function sideLabel(side: Side): string {
  return side === 2 ? '先手' : '後手';
}

function emptyHand(): Hand {
  return { 歩: 0, 香: 0, 桂: 0, 銀: 0, 金: 0, 飛: 0, 角: 0 };
}

function emptyTakenLog(): TakenLog {
  return { 歩: 0, 香: 0, 桂: 0, 銀: 0, 金: 0, 飛: 0, 角: 0 };
}

function emptyBoard(): Board {
  return Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
}

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function placePiece(board: Board, row: number, column: number, name: PieceName, side: Side) {
  board[row][column] = { id: -1, name, side };
}

/** Swift版 GameInfo.rand() と同じ列ごとの配置手順。 */
function placeRandomArmy(board: Board, side: Side, random: () => number) {
  const backRow = side === 1 ? 0 : 8;
  const middleRow = side === 1 ? 1 : 7;
  const frontRow = side === 1 ? 2 : 6;
  const pieces = shuffled<PieceName>(['香', '香', '桂', '桂', '銀', '銀', '金', '金', '角', '飛'], random);
  const kingColumn = randomIndex(9, random);
  placePiece(board, backRow, kingColumn, '王', side);

  for (let column = 0; column < 9; column += 1) {
    const specialColumn = column === 1 || column === 7;
    const kingColumnHere = column === kingColumn;

    if (specialColumn) {
      if (kingColumnHere) {
        const nonPawn = pieces.pop()!;
        const rows = random() < 0.5 ? [middleRow, frontRow] : [frontRow, middleRow];
        placePiece(board, rows[0], column, '歩', side);
        placePiece(board, rows[1], column, nonPawn, side);
      } else {
        const nonPawnA = pieces.pop()!;
        const nonPawnB = pieces.pop()!;
        const roll = random();
        const names: PieceName[] = roll < 1 / 3
          ? ['歩', nonPawnA, nonPawnB]
          : roll < 2 / 3
            ? [nonPawnA, '歩', nonPawnB]
            : [nonPawnA, nonPawnB, '歩'];
        [backRow, middleRow, frontRow].forEach((row, index) => placePiece(board, row, column, names[index], side));
      }
    } else if (kingColumnHere) {
      placePiece(board, frontRow, column, '歩', side);
    } else {
      const nonPawn = pieces.pop()!;
      if (random() < 0.5) {
        placePiece(board, backRow, column, '歩', side);
        placePiece(board, frontRow, column, nonPawn, side);
      } else {
        placePiece(board, backRow, column, nonPawn, side);
        placePiece(board, frontRow, column, '歩', side);
      }
    }
  }
}

export function createInitialGame(random: () => number = Math.random): GameState {
  const board = emptyBoard();
  placeRandomArmy(board, 1, random);
  placeRandomArmy(board, 2, random);
  let latestId = 0;
  for (const row of board) {
    for (const piece of row) {
      if (piece) piece.id = ++latestId;
    }
  }
  return {
    board,
    turn: 2,
    winner: null,
    latestId,
    hands: { 1: emptyHand(), 2: emptyHand() },
    guesses: {},
    moveLogs: {},
    takenLogs: { 1: emptyTakenLog(), 2: emptyTakenLog() },
    lastMove: null,
    moveHistory: [],
  };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function inBounds(row: number, column: number): boolean {
  return row >= 0 && row < 9 && column >= 0 && column < 9;
}

function addSteps(board: Board, piece: Piece, from: Position, steps: Position[], moves: Position[]) {
  for (const [rowDelta, columnDelta] of steps) {
    const row = from[0] + rowDelta;
    const column = from[1] + columnDelta;
    if (inBounds(row, column) && board[row][column]?.side !== piece.side) moves.push([row, column]);
  }
}

function addRays(board: Board, piece: Piece, from: Position, directions: Position[], moves: Position[]) {
  for (const [rowStep, columnStep] of directions) {
    let row = from[0] + rowStep;
    let column = from[1] + columnStep;
    while (inBounds(row, column)) {
      const target = board[row][column];
      if (!target) {
        moves.push([row, column]);
      } else {
        if (target.side !== piece.side) moves.push([row, column]);
        break;
      }
      row += rowStep;
      column += columnStep;
    }
  }
}

export function getLegalMoves(state: GameState, from: Position): Position[] {
  const piece = state.board[from[0]]?.[from[1]];
  if (!piece) return [];
  const moves: Position[] = [];
  const forward = piece.side === 1 ? 1 : -1;
  switch (piece.name) {
    case '歩': addSteps(state.board, piece, from, [[forward, 0]], moves); break;
    case '香': addRays(state.board, piece, from, [[forward, 0]], moves); break;
    case '桂': addSteps(state.board, piece, from, [[forward * 2, 1], [forward * 2, -1]], moves); break;
    case '銀': addSteps(state.board, piece, from, [[forward, 0], [forward, 1], [forward, -1], [-forward, 1], [-forward, -1]], moves); break;
    case '金':
    case 'と':
    case '杏':
    case '圭':
    case '全': addSteps(state.board, piece, from, GOLD_STEPS.map(([row, column]) => [row * -forward, column] as Position), moves); break;
    case '王': addSteps(state.board, piece, from, KING_STEPS, moves); break;
    case '飛': addRays(state.board, piece, from, [[1, 0], [-1, 0], [0, 1], [0, -1]], moves); break;
    case '角': addRays(state.board, piece, from, [[1, 1], [1, -1], [-1, 1], [-1, -1]], moves); break;
    case '龍':
      addRays(state.board, piece, from, [[1, 0], [-1, 0], [0, 1], [0, -1]], moves);
      addSteps(state.board, piece, from, [[1, 1], [1, -1], [-1, 1], [-1, -1]], moves);
      break;
    case '馬':
      addRays(state.board, piece, from, [[1, 1], [1, -1], [-1, 1], [-1, -1]], moves);
      addSteps(state.board, piece, from, [[1, 0], [-1, 0], [0, 1], [0, -1]], moves);
      break;
  }
  return moves;
}

export function getDropTargets(state: GameState, name: HandPieceName, side: Side): Position[] {
  const forbiddenColumns = new Set<number>();
  if (name === '歩') {
    for (let column = 0; column < 9; column += 1) {
      if (state.board.some((row) => row[column]?.side === side && row[column]?.name === '歩')) forbiddenColumns.add(column);
    }
  }
  const lastRow = side === 2 ? 0 : 8;
  const knightRows = side === 2 ? new Set([0, 1]) : new Set([7, 8]);
  const targets: Position[] = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      if (state.board[row][column]) continue;
      if (forbiddenColumns.has(column)) continue;
      if ((name === '歩' || name === '香') && row === lastRow) continue;
      if (name === '桂' && knightRows.has(row)) continue;
      targets.push([row, column]);
    }
  }
  return targets;
}

export function canPromote(name: PieceName, side: Side, from: Position, to: Position): boolean {
  if (!(name in PROMOTION_MAP)) return false;
  const inZone = (row: number) => side === 2 ? row < 3 : row > 5;
  return inZone(from[0]) || inZone(to[0]);
}

export function mustPromote(name: PieceName, side: Side, to: Position): boolean {
  const lastRow = side === 2 ? 0 : 8;
  if ((name === '歩' || name === '香') && to[0] === lastRow) return true;
  if (name === '桂') return side === 2 ? to[0] < 2 : to[0] > 6;
  return false;
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map((row) => row.map((piece) => piece ? { ...piece } : null)),
    hands: { 1: { ...state.hands[1] }, 2: { ...state.hands[2] } },
    guesses: { ...state.guesses },
    moveLogs: Object.fromEntries(Object.entries(state.moveLogs).map(([id, moves]) => [id, moves.map((move) => [...move] as Position)])),
    takenLogs: { 1: { ...state.takenLogs[1] }, 2: { ...state.takenLogs[2] } },
    moveHistory: [...state.moveHistory],
    lastMove: state.lastMove ? { ...state.lastMove, from: state.lastMove.from ? [...state.lastMove.from] as Position : null, to: [...state.lastMove.to] as Position } : null,
  };
}

export function applyBoardMove(state: GameState, from: Position, to: Position, promote: boolean): GameState {
  const next = cloneState(state);
  const piece = next.board[from[0]][from[1]];
  if (!piece || piece.side !== state.turn || !getLegalMoves(state, from).some(([row, column]) => row === to[0] && column === to[1])) {
    throw new Error('その場所へは動かせません');
  }
  const originalName = piece.name;
  if (promote && canPromote(piece.name, piece.side, from, to)) piece.name = PROMOTION_MAP[piece.name] ?? piece.name;
  const captured = next.board[to[0]][to[1]];
  if (captured) {
    if (captured.name === '王') {
      next.winner = piece.side;
    } else {
      const handName = (UNPROMOTION_MAP[captured.name] ?? captured.name) as HandPieceName;
      next.hands[piece.side][handName] += 1;
      next.takenLogs[captured.side][handName] += 1;
    }
  }
  next.board[to[0]][to[1]] = piece;
  next.board[from[0]][from[1]] = null;
  const rowDelta = Math.max(-2, Math.min(2, to[0] - from[0]));
  const columnDelta = Math.max(-2, Math.min(2, to[1] - from[1]));
  const observed: Position = piece.side === 1 ? [-rowDelta, -columnDelta] : [rowDelta, columnDelta];
  next.moveLogs[piece.id] = [...(next.moveLogs[piece.id] ?? []), observed];
  const record: MoveRecord = {
    from: [...from] as Position,
    to: [...to] as Position,
    side: piece.side,
    pieceId: piece.id,
    pieceName: originalName,
    captured: captured?.name ?? null,
    promoted: originalName !== piece.name,
    dropped: false,
  };
  next.lastMove = record;
  next.moveHistory.push(record);
  if (!next.winner) next.turn = otherSide(next.turn);
  return next;
}

export function applyDrop(state: GameState, name: HandPieceName, to: Position): GameState {
  if (state.hands[state.turn][name] < 1 || !getDropTargets(state, name, state.turn).some(([row, column]) => row === to[0] && column === to[1])) {
    throw new Error('その場所には打てません');
  }
  const next = cloneState(state);
  const piece: Piece = { id: ++next.latestId, name, side: next.turn };
  next.board[to[0]][to[1]] = piece;
  next.hands[next.turn][name] -= 1;
  const record: MoveRecord = { from: null, to: [...to] as Position, side: next.turn, pieceId: piece.id, pieceName: name, captured: null, promoted: false, dropped: true };
  next.lastMove = record;
  next.moveHistory.push(record);
  next.turn = otherSide(next.turn);
  return next;
}

export function withGuess(state: GameState, pieceId: number, guess: GuessName): GameState {
  return { ...state, guesses: { ...state.guesses, [pieceId]: guess } };
}

export function isSamePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function handTotal(hand: Hand): number {
  return HAND_NAMES.reduce((total, name) => total + hand[name], 0);
}

export function boardCoordinates(position: Position): string {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  return `${9 - position[1]}${numerals[position[0]]}`;
}
