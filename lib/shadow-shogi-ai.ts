import {
  HAND_NAMES,
  applyBoardMove,
  applyDrop,
  canPromote,
  getDropTargets,
  getLegalMoves,
  mustPromote,
  type GameState,
  type HandPieceName,
  type PieceName,
  type Position,
  type Side,
} from './shadow-shogi.ts';

export type CpuLevel = 1 | 2 | 3;

export type CpuAction =
  | { kind: 'move'; from: Position; to: Position; promote: boolean }
  | { kind: 'drop'; name: HandPieceName; to: Position };

export interface CpuDecision {
  action: CpuAction | null;
  depth: number;
  nodes: number;
}

const PIECE_VALUE: Record<PieceName, number> = {
  歩: 100,
  香: 280,
  桂: 320,
  銀: 440,
  金: 520,
  飛: 900,
  角: 820,
  王: 100_000,
  と: 540,
  杏: 510,
  圭: 510,
  全: 540,
  龍: 1_180,
  馬: 1_080,
};

const WIN_SCORE = 10_000_000;

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function randomItem<T>(items: T[], random: () => number): T | null {
  if (items.length === 0) return null;
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

export function getCpuActions(state: GameState, side: Side = state.turn): CpuAction[] {
  if (state.winner || state.turn !== side) return [];
  const actions: CpuAction[] = [];

  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const piece = state.board[row][column];
      if (!piece || piece.side !== side) continue;
      const from: Position = [row, column];
      for (const to of getLegalMoves(state, from)) {
        if (mustPromote(piece.name, side, to)) {
          actions.push({ kind: 'move', from, to, promote: true });
        } else if (canPromote(piece.name, side, from, to)) {
          actions.push({ kind: 'move', from, to, promote: true });
          actions.push({ kind: 'move', from, to, promote: false });
        } else {
          actions.push({ kind: 'move', from, to, promote: false });
        }
      }
    }
  }

  for (const name of HAND_NAMES) {
    if (state.hands[side][name] < 1) continue;
    for (const to of getDropTargets(state, name, side)) actions.push({ kind: 'drop', name, to });
  }
  return actions;
}

export function applyCpuAction(state: GameState, action: CpuAction): GameState {
  return action.kind === 'move'
    ? applyBoardMove(state, action.from, action.to, action.promote)
    : applyDrop(state, action.name, action.to);
}

function actionCapture(state: GameState, action: CpuAction): PieceName | null {
  if (action.kind === 'drop') return null;
  return state.board[action.to[0]][action.to[1]]?.name ?? null;
}

function actionOrderScore(state: GameState, action: CpuAction, perspective: Side): number {
  if (action.kind === 'drop') {
    const enemyKing = findKing(state, perspective === 1 ? 2 : 1);
    const distance = enemyKing ? Math.abs(enemyKing[0] - action.to[0]) + Math.abs(enemyKing[1] - action.to[1]) : 8;
    return PIECE_VALUE[action.name] / 20 + Math.max(0, 10 - distance);
  }
  const captured = actionCapture(state, action);
  const moving = state.board[action.from[0]][action.from[1]];
  return (captured ? PIECE_VALUE[captured] * 12 : 0)
    + (action.promote ? 700 : 0)
    + (moving?.name === '王' ? -20 : 0);
}

function findKing(state: GameState, side: Side): Position | null {
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const piece = state.board[row][column];
      if (piece?.side === side && piece.name === '王') return [row, column];
    }
  }
  return null;
}

function isKingUnderImmediateThreat(state: GameState, side: Side): boolean {
  const king = findKing(state, side);
  if (!king) return false;
  const enemy = side === 1 ? 2 : 1;

  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const piece = state.board[row][column];
      if (!piece || piece.side !== enemy) continue;
      if (getLegalMoves(state, [row, column]).some((target) => samePosition(target, king))) return true;
    }
  }
  return false;
}

function safeKingResponses(state: GameState, actions: CpuAction[], side: Side): CpuAction[] {
  return actions.filter((action) => !isKingUnderImmediateThreat(applyCpuAction(state, action), side));
}

function evaluateState(state: GameState, perspective: Side): number {
  if (state.winner) return state.winner === perspective ? WIN_SCORE : -WIN_SCORE;
  let score = 0;
  const enemy = perspective === 1 ? 2 : 1;
  const enemyKing = findKing(state, enemy);

  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const piece = state.board[row][column];
      if (!piece) continue;
      const sign = piece.side === perspective ? 1 : -1;
      const progress = piece.side === 2 ? 8 - row : row;
      const center = 4 - Math.abs(4 - column);
      score += sign * (PIECE_VALUE[piece.name] + progress * 3 + center * 2);
      if (piece.side === perspective && enemyKing && piece.name !== '王') {
        const kingDistance = Math.abs(enemyKing[0] - row) + Math.abs(enemyKing[1] - column);
        score += Math.max(0, 13 - kingDistance) * 3;
      }
    }
  }

  for (const name of HAND_NAMES) {
    score += state.hands[perspective][name] * PIECE_VALUE[name] * 0.92;
    score -= state.hands[enemy][name] * PIECE_VALUE[name] * 0.92;
  }
  return score;
}

interface SearchContext {
  deadline: number;
  maxNodes: number;
  nodes: number;
  timedOut: boolean;
  perspective: Side;
  profile: SearchProfile;
  table: Map<string, TranspositionEntry>;
}

interface SearchProfile {
  maxDepth: number;
  maxNodes: number;
  rootLimit: number;
  deepLimit: number;
  shallowLimit: number;
  quiescenceDepth: number;
  advancedEvaluation: boolean;
  useTranspositionTable: boolean;
}

interface TranspositionEntry {
  depth: number;
  value: number;
  flag: 'exact' | 'lower' | 'upper';
  bestActionKey?: string;
}

const GINJI_PROFILE: SearchProfile = {
  maxDepth: 3,
  maxNodes: 28_000,
  rootLimit: 72,
  deepLimit: 30,
  shallowLimit: 48,
  quiescenceDepth: 0,
  advancedEvaluation: false,
  useTranspositionTable: false,
};

const KAGEMARU_PROFILE: SearchProfile = {
  maxDepth: 4,
  maxNodes: 120_000,
  rootLimit: 96,
  deepLimit: 42,
  shallowLimit: 64,
  quiescenceDepth: 2,
  advancedEvaluation: true,
  useTranspositionTable: true,
};

function actionKey(action: CpuAction): string {
  return action.kind === 'move'
    ? `m${action.from[0]}${action.from[1]}${action.to[0]}${action.to[1]}${action.promote ? 1 : 0}`
    : `d${action.name}${action.to[0]}${action.to[1]}`;
}

function stateKey(state: GameState): string {
  const board = state.board
    .map((row) => row.map((piece) => piece ? `${piece.side}${piece.name}` : '_').join(','))
    .join('/');
  const hands = HAND_NAMES
    .map((name) => `${name}${state.hands[1][name]}:${state.hands[2][name]}`)
    .join(',');
  return `${state.turn}|${board}|${hands}`;
}

function advancedEvaluation(state: GameState, perspective: Side): number {
  let score = evaluateState(state, perspective);
  if (state.winner) return score;
  const enemy = perspective === 1 ? 2 : 1;
  if (isKingUnderImmediateThreat(state, perspective)) score -= 7_500;
  if (isKingUnderImmediateThreat(state, enemy)) score += 7_500;

  for (const side of [perspective, enemy] as const) {
    const king = findKing(state, side);
    if (!king) continue;
    let defenders = 0;
    let escapeSquares = 0;
    for (const [rowDelta, columnDelta] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as Position[]) {
      const row = king[0] + rowDelta;
      const column = king[1] + columnDelta;
      if (row < 0 || row > 8 || column < 0 || column > 8) continue;
      const piece = state.board[row][column];
      if (piece?.side === side) defenders += 1;
      if (!piece || piece.side !== side) escapeSquares += 1;
    }
    const sign = side === perspective ? 1 : -1;
    score += sign * (defenders * 24 + escapeSquares * 10);
  }
  return score;
}

function evaluateForSearch(state: GameState, context: SearchContext): number {
  return context.profile.advancedEvaluation
    ? advancedEvaluation(state, context.perspective)
    : evaluateState(state, context.perspective);
}

function orderedActions(
  state: GameState,
  context: SearchContext,
  depth: number,
  root = false,
  preferredActionKey?: string,
): CpuAction[] {
  const limit = root
    ? context.profile.rootLimit
    : depth > 1
      ? context.profile.deepLimit
      : context.profile.shallowLimit;
  const threatened = context.profile.advancedEvaluation && isKingUnderImmediateThreat(state, state.turn);
  return getCpuActions(state)
    .map((action) => {
      let score = actionOrderScore(state, action, context.perspective);
      if (actionKey(action) === preferredActionKey) score += 2_000_000;
      if (threatened && !isKingUnderImmediateThreat(applyCpuAction(state, action), state.turn)) score += 1_000_000;
      return { action, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ action }) => action);
}

function quiescence(
  state: GameState,
  remainingDepth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
): number {
  context.nodes += 1;
  const standPat = evaluateForSearch(state, context);
  if (
    state.winner ||
    remainingDepth === 0 ||
    context.nodes >= context.maxNodes ||
    Date.now() >= context.deadline
  ) {
    if (context.nodes >= context.maxNodes || Date.now() >= context.deadline) context.timedOut = true;
    return standPat;
  }

  const maximizing = state.turn === context.perspective;
  let best = standPat;
  if (maximizing) alpha = Math.max(alpha, best);
  else beta = Math.min(beta, best);
  if (beta <= alpha) return best;

  const inDanger = isKingUnderImmediateThreat(state, state.turn);
  const tacticalActions = orderedActions(state, context, 0)
    .filter((action) => inDanger || actionCapture(state, action) !== null || (action.kind === 'move' && action.promote))
    .slice(0, inDanger ? 20 : 14);

  for (const action of tacticalActions) {
    const value = quiescence(applyCpuAction(state, action), remainingDepth - 1, alpha, beta, context);
    if (maximizing) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha || context.timedOut) break;
  }
  return best;
}

function alphaBeta(state: GameState, depth: number, alpha: number, beta: number, context: SearchContext): number {
  context.nodes += 1;
  if (context.nodes >= context.maxNodes || Date.now() >= context.deadline) {
    context.timedOut = true;
    return evaluateForSearch(state, context);
  }
  if (state.winner) return evaluateForSearch(state, context);
  if (depth === 0) {
    return context.profile.quiescenceDepth > 0
      ? quiescence(state, context.profile.quiescenceDepth, alpha, beta, context)
      : evaluateForSearch(state, context);
  }

  const alphaOriginal = alpha;
  const betaOriginal = beta;
  const key = context.profile.useTranspositionTable ? stateKey(state) : '';
  const cached = key ? context.table.get(key) : undefined;
  if (cached && cached.depth >= depth) {
    if (cached.flag === 'exact') return cached.value;
    if (cached.flag === 'lower') alpha = Math.max(alpha, cached.value);
    if (cached.flag === 'upper') beta = Math.min(beta, cached.value);
    if (alpha >= beta) return cached.value;
  }

  const actions = orderedActions(state, context, depth, false, cached?.bestActionKey);
  if (actions.length === 0) return evaluateForSearch(state, context);
  const maximizing = state.turn === context.perspective;
  let best = maximizing ? -Infinity : Infinity;
  let bestActionKey: string | undefined;

  for (const action of actions) {
    const value = alphaBeta(applyCpuAction(state, action), depth - 1, alpha, beta, context);
    if (maximizing) {
      if (value > best) {
        best = value;
        bestActionKey = actionKey(action);
      }
      alpha = Math.max(alpha, best);
    } else {
      if (value < best) {
        best = value;
        bestActionKey = actionKey(action);
      }
      beta = Math.min(beta, best);
    }
    if (beta <= alpha || context.timedOut) break;
  }
  if (key && !context.timedOut) {
    const flag = best <= alphaOriginal ? 'upper' : best >= betaOriginal ? 'lower' : 'exact';
    context.table.set(key, { depth, value: best, flag, bestActionKey });
  }
  return best;
}

function searchDecision(
  state: GameState,
  cpuSide: Side,
  timeBudgetMs: number,
  profile: SearchProfile,
): CpuDecision {
  const initialActions = getCpuActions(state, cpuSide);
  if (initialActions.length === 0) return { action: null, depth: 0, nodes: 0 };

  const immediateWin = initialActions.find((action) => actionCapture(state, action) === '王');
  if (immediateWin) return { action: immediateWin, depth: 1, nodes: 1 };

  const context: SearchContext = {
    deadline: Date.now() + timeBudgetMs,
    maxNodes: profile.maxNodes,
    nodes: 0,
    timedOut: false,
    perspective: cpuSide,
    profile,
    table: new Map(),
  };
  let chosen = initialActions[0];
  let completedDepth = 0;
  let preferredActionKey: string | undefined;

  for (let depth = 1; depth <= profile.maxDepth; depth += 1) {
    context.timedOut = false;
    const actions = orderedActions(state, context, depth, true, preferredActionKey);
    let roundBest = chosen;
    let roundScore = -Infinity;
    for (const action of actions) {
      const value = alphaBeta(applyCpuAction(state, action), depth - 1, -Infinity, Infinity, context);
      if (context.timedOut) break;
      if (value > roundScore) {
        roundScore = value;
        roundBest = action;
      }
    }
    if (context.timedOut) break;
    chosen = roundBest;
    preferredActionKey = actionKey(chosen);
    completedDepth = depth;
  }

  return { action: chosen, depth: Math.max(1, completedDepth), nodes: context.nodes };
}

export function chooseCpuAction(
  state: GameState,
  level: CpuLevel,
  cpuSide: Side = state.turn,
  random: () => number = Math.random,
  timeBudgetMs?: number,
): CpuDecision {
  const actions = getCpuActions(state, cpuSide);
  if (actions.length === 0) return { action: null, depth: 0, nodes: 0 };

  if (level === 1) {
    let candidates = actions;
    if (isKingUnderImmediateThreat(state, cpuSide)) {
      const defensiveActions = safeKingResponses(state, actions, cpuSide);
      if (defensiveActions.length > 0 && random() < 0.9) candidates = defensiveActions;
    }
    const captures = candidates.filter((action) => actionCapture(state, action) !== null);
    return { action: randomItem(captures.length > 0 ? captures : candidates, random), depth: 0, nodes: actions.length };
  }

  if (level === 2) {
    return searchDecision(state, cpuSide, timeBudgetMs ?? 360, GINJI_PROFILE);
  }

  return searchDecision(state, cpuSide, timeBudgetMs ?? 1_500, KAGEMARU_PROFILE);
}
