import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBoardMove,
  applyDrop,
  canPromote,
  createInitialGame,
  getDropTargets,
  getLegalMoves,
  seededRandom,
  type GameState,
  type Piece,
} from './shadow-shogi.ts';

test('Swift版と同じ初期配置制約をすべてのseedで満たす', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const game = createInitialGame(seededRandom(seed));
    for (const side of [1, 2] as const) {
      const pieces = game.board.flat().filter((piece) => piece?.side === side);
      assert.equal(pieces.length, 20);
      assert.equal(pieces.filter((piece) => piece?.name === '王').length, 1);
      assert.equal(pieces.filter((piece) => piece?.name === '歩').length, 9);
      const kingRow = side === 1 ? 0 : 8;
      assert.equal(game.board[kingRow].some((piece) => piece?.side === side && piece.name === '王'), true);
      for (let column = 0; column < 9; column += 1) {
        assert.equal(game.board.filter((row) => row[column]?.side === side && row[column]?.name === '歩').length, 1);
      }
    }
    assert.equal(new Set(game.board.flat().filter(Boolean).map((piece) => piece!.id)).size, 40);
  }
});

function sparseGame(...pieces: Array<[number, number, Piece]>): GameState {
  const game = createInitialGame(seededRandom(1));
  game.board = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
  game.turn = 2;
  game.winner = null;
  for (const [row, column, piece] of pieces) game.board[row][column] = piece;
  return game;
}

test('駒の移動と遮蔽を判定する', () => {
  const game = sparseGame(
    [4, 4, { id: 1, name: '飛', side: 2 }],
    [4, 6, { id: 2, name: '歩', side: 2 }],
    [2, 4, { id: 3, name: '銀', side: 1 }],
  );
  const moves = getLegalMoves(game, [4, 4]).map((position) => position.join(','));
  assert.equal(moves.includes('2,4'), true);
  assert.equal(moves.includes('1,4'), false);
  assert.equal(moves.includes('4,5'), true);
  assert.equal(moves.includes('4,6'), false);
});

test('成り条件と王の捕獲で勝敗を決める', () => {
  const game = sparseGame(
    [3, 4, { id: 1, name: '歩', side: 2 }],
    [2, 4, { id: 2, name: '王', side: 1 }],
  );
  assert.equal(canPromote('歩', 2, [3, 4], [2, 4]), true);
  const next = applyBoardMove(game, [3, 4], [2, 4], true);
  assert.equal(next.board[2][4]?.name, 'と');
  assert.equal(next.winner, 2);
  assert.deepEqual(next.moveLogs[1], [[-1, 0]]);
});

test('持ち駒は二歩と行き所のない升へ打てない', () => {
  const game = sparseGame([5, 4, { id: 1, name: '歩', side: 2 }]);
  game.hands[2].歩 = 1;
  const targets = getDropTargets(game, '歩', 2);
  assert.equal(targets.some(([row, column]) => row === 4 && column === 4), false);
  assert.equal(targets.some(([row]) => row === 0), false);
  assert.equal(targets.some(([row, column]) => row === 4 && column === 3), true);
  const next = applyDrop(game, '歩', [4, 3]);
  assert.equal(next.board[4][3]?.side, 2);
  assert.equal(next.hands[2].歩, 0);
  assert.equal(next.turn, 1);
});
