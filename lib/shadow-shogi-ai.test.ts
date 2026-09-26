import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCpuAction, chooseCpuAction, getCpuActions } from './shadow-shogi-ai.ts';
import { createInitialGame, seededRandom, type GameState, type Piece } from './shadow-shogi.ts';

function cpuGame(...pieces: Array<[number, number, Piece]>): GameState {
  const game = createInitialGame(seededRandom(4));
  game.board = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
  game.turn = 1;
  game.winner = null;
  game.hands = {
    1: { 歩: 0, 香: 0, 桂: 0, 銀: 0, 金: 0, 飛: 0, 角: 0 },
    2: { 歩: 0, 香: 0, 桂: 0, 銀: 0, 金: 0, 飛: 0, 角: 0 },
  };
  for (const [row, column, piece] of pieces) game.board[row][column] = piece;
  return game;
}

test('CPUが生成する全候補手をゲームエンジンで適用できる', () => {
  const game = createInitialGame(seededRandom(18));
  game.turn = 1;
  const actions = getCpuActions(game, 1);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.doesNotThrow(() => applyCpuAction(game, action));
});

test('初級CPUは取れる影があれば捕獲を選ぶ', () => {
  const game = cpuGame(
    [4, 4, { id: 1, name: '飛', side: 1 }],
    [4, 6, { id: 2, name: '歩', side: 2 }],
  );
  const decision = chooseCpuAction(game, 1, 1, () => 0);
  assert.equal(decision.action?.kind, 'move');
  assert.deepEqual(decision.action?.to, [4, 6]);
});

test('最強CPUは完全情報から王を捕獲する手を逃さない', () => {
  const game = cpuGame(
    [3, 4, { id: 1, name: '歩', side: 1 }],
    [4, 4, { id: 2, name: '王', side: 2 }],
  );
  const decision = chooseCpuAction(game, 3, 1, () => 0, 50);
  assert.ok(decision.action);
  const next = applyCpuAction(game, decision.action!);
  assert.equal(next.winner, 1);
});
