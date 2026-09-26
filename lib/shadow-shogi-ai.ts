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

function observedDanger(state: GameState, position: Position, cpuSide: Side): number {
  const enemy = cpuSide === 1 ? 2 : 1;
  let danger = 0;
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const piece = state.board[row][column];
      if (!piece || piece.side !== enemy) continue;
      const distance = Math.abs(position[0] - row) + Math.abs(position[1] - column);
      if (distance <= 1) danger += 1;
      const observedMoves = state.moveLogs[piece.id] ?? [];
      if (observedMoves.some(([rowDelta, columnDelta]) => samePosition([row + rowDelta, column + columnDelta], position))) danger += 2;
    }
  }
  return danger;
}

function mediumScore(state: GameState, action: CpuAction, cpuSide: Side): number {
  const destination = action.to;
  const capturedShadow = actionCapture(state, action) !== null;
  const movingName = action.kind === 'move'
    ? state.board[action.from[0]][action.from[1]]?.name ?? '歩'
    : action.name;
  const forwardProgress = cpuSide === 1 ? destination[0] : 8 - destination[0];
  const center = 4 - Math.abs(4 - destination[1]);
  const danger = observedDanger(state, destination, cpuSide);
  return (capturedShadow ? 420 : 0)
    + (action.kind === 'move' && action.promote ? 210 : 0)
    + forwardProgress * 8
    + center * 5
    - danger * PIECE_VALUE[movingName] * 0.28;
}

interface SearchContext {
  deadline: number;
  maxNodes: number;
  nodes: number;
  timedOut: boolean;
  perspective: Side;
}

function orderedActions(state: GameState, context: SearchContext, depth: number, root = false): CpuAction[] {
  const limit = root ? 72 : depth > 1 ? 30 : 48;
  return getCpuActions(state)
    .sort((a, b) => actionOrderScore(state, b, context.perspective) - actionOrderScore(state, a, context.perspective))
    .slice(0, limit);
}

function alphaBeta(state: GameState, depth: number, alpha: number, beta: number, context: SearchContext): number {
  context.nodes += 1;
  if (context.nodes >= context.maxNodes || Date.now() >= context.deadline) {
    context.timedOut = true;
    return evaluateState(state, context.perspective);
  }
  if (depth === 0 || state.winner) return evaluateState(state, context.perspective);

  const actions = orderedActions(state, context, depth);
  if (actions.length === 0) return evaluateState(state, context.perspective);
  const maximizing = state.turn === context.perspective;
  let best = maximizing ? -Infinity : Infinity;

  for (const action of actions) {
    const value = alphaBeta(applyCpuAction(state, action), depth - 1, alpha, beta, context);
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

function strongestDecision(state: GameState, cpuSide: Side, timeBudgetMs: number): CpuDecision {
  const initialActions = getCpuActions(state, cpuSide);
  if (initialActions.length === 0) return { action: null, depth: 0, nodes: 0 };

  const immediateWin = initialActions.find((action) => actionCapture(state, action) === '王');
  if (immediateWin) return { action: immediateWin, depth: 1, nodes: 1 };

  const context: SearchContext = {
    deadline: Date.now() + timeBudgetMs,
    maxNodes: 28_000,
    nodes: 0,
    timedOut: false,
    perspective: cpuSide,
  };
  let chosen = initialActions[0];
  let completedDepth = 0;

  for (let depth = 1; depth <= 3; depth += 1) {
    context.timedOut = false;
    const actions = orderedActions(state, context, depth, true);
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
    completedDepth = depth;
  }

  return { action: chosen, depth: Math.max(1, completedDepth), nodes: context.nodes };
}

export function chooseCpuAction(
  state: GameState,
  level: CpuLevel,
  cpuSide: Side = state.turn,
  random: () => number = Math.random,
  timeBudgetMs = 360,
): CpuDecision {
  const actions = getCpuActions(state, cpuSide);
  if (actions.length === 0) return { action: null, depth: 0, nodes: 0 };

  if (level === 1) {
    const captures = actions.filter((action) => actionCapture(state, action) !== null);
    return { action: randomItem(captures.length > 0 ? captures : actions, random), depth: 0, nodes: actions.length };
  }

  if (level === 2) {
    const scored = actions
      .map((action) => ({ action, score: mediumScore(state, action, cpuSide) }))
      .sort((a, b) => b.score - a.score);
    const bestScore = scored[0].score;
    const candidates = scored.filter(({ score }) => score >= bestScore - 24).slice(0, 4);
    return { action: randomItem(candidates, random)?.action ?? scored[0].action, depth: 1, nodes: actions.length };
  }

  return strongestDecision(state, cpuSide, timeBudgetMs);
}
