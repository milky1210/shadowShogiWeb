'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, CircleHelp, Eye, Footprints, RotateCcw, ShieldQuestion, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  applyBoardMove,
  applyDrop,
  boardCoordinates,
  canPromote,
  createInitialGame,
  getDropTargets,
  getLegalMoves,
  GUESS_NAMES,
  HAND_NAMES,
  handTotal,
  isSamePosition,
  mustPromote,
  otherSide,
  seededRandom,
  sideLabel,
  withGuess,
  type GameState,
  type GuessName,
  type HandPieceName,
  type Piece,
  type Position,
  type Side,
} from '@/lib/shadow-shogi';

type Phase = 'intro' | 'playing' | 'handoff' | 'finished';
type Selection = { kind: 'board'; from: Position } | { kind: 'hand'; name: HandPieceName } | null;
type PromotionRequest = { from: Position; to: Position } | null;

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

const PREVIEW_GAME = createInitialGame(seededRandom(20260926));

function moveKey([row, column]: Position) {
  return `${row}-${column}`;
}

function displayName(guess: GuessName | undefined) {
  if (!guess) return '?';
  return guess !== '?' && guess.endsWith('?') ? guess.slice(0, -1) : guess;
}

function isUncertain(guess: GuessName | undefined) {
  return Boolean(guess && guess !== '?' && guess.endsWith('?'));
}

function boardPosition(displayRow: number, displayColumn: number, viewer: Side): Position {
  return viewer === 1 ? [8 - displayRow, 8 - displayColumn] : [displayRow, displayColumn];
}

function PieceGlyph({ piece, viewer, guess }: { piece: Piece; viewer: Side; guess?: GuessName }) {
  const own = piece.side === viewer;
  const label = own ? piece.name : displayName(guess);
  return (
    <span className={`shogi-piece ${own ? 'own-piece' : 'enemy-piece'}`}>
      <span>{label}</span>
      {!own && isUncertain(guess) ? <small aria-label="未確定">?</small> : null}
    </span>
  );
}

function MoveTrace({ moves }: { moves: Position[] }) {
  const observed = new Set(moves.map(moveKey));
  return (
    <div className="trace-grid" aria-label="この駒が見せた動き">
      {Array.from({ length: 25 }, (_, index) => {
        const row = Math.floor(index / 5) - 2;
        const column = index % 5 - 2;
        const center = row === 0 && column === 0;
        return <span key={index} className={`${center ? 'trace-center' : ''} ${observed.has(moveKey([row, column])) ? 'trace-observed' : ''}`}>{center ? '影' : ''}</span>;
      })}
    </div>
  );
}

export function GameApp() {
  const [game, setGame] = useState<GameState | null>(null);
  const [viewer, setViewer] = useState<Side>(2);
  const [phase, setPhase] = useState<Phase>('intro');
  const [selection, setSelection] = useState<Selection>(null);
  const [guessTarget, setGuessTarget] = useState<Piece | null>(null);
  const [promotionRequest, setPromotionRequest] = useState<PromotionRequest>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const shownGame = game ?? PREVIEW_GAME;

  const legalTargets = useMemo(() => {
    if (!game || phase !== 'playing' || !selection) return [];
    return selection.kind === 'board'
      ? getLegalMoves(game, selection.from)
      : getDropTargets(game, selection.name, game.turn);
  }, [game, phase, selection]);
  const targetKeys = useMemo(() => new Set(legalTargets.map(moveKey)), [legalTargets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(null);
        setGuessTarget(null);
        setPromotionRequest(null);
      }
      if (event.key === 'Enter' && phase === 'handoff' && game) {
        setViewer(game.turn);
        setPhase('playing');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [game, phase]);

  const startMatch = useCallback(() => {
    setGame(createInitialGame());
    setViewer(2);
    setSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setPhase('playing');
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'start_local_shadow_shogi_match',
      title: '影将棋の二人対局を始める',
      description: 'Swift版と同じ手順で盤面をランダム生成し、この端末で先手から二人対局を開始します。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: Record<string, unknown> = {}) => {
        if (Object.keys(input).length > 0) throw new Error('この操作には入力項目はありません');
        startMatch();
        return { status: 'started', turn: '先手', mode: 'local_two_player' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [startMatch]);

  function resetToIntro() {
    setGame(null);
    setViewer(2);
    setSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setPhase('intro');
  }

  function completeMove(next: GameState) {
    setGame(next);
    setSelection(null);
    setPromotionRequest(null);
    setGuessTarget(null);
    setPhase(next.winner ? 'finished' : 'handoff');
  }

  function commitBoardMove(from: Position, to: Position, promote: boolean) {
    if (!game) return;
    completeMove(applyBoardMove(game, from, to, promote));
  }

  function clickSquare(position: Position) {
    if (!game || phase !== 'playing' || viewer !== game.turn) return;
    const piece = game.board[position[0]][position[1]];
    const legalTarget = targetKeys.has(moveKey(position));

    if (selection && legalTarget) {
      if (selection.kind === 'hand') {
        completeMove(applyDrop(game, selection.name, position));
        return;
      }
      const movingPiece = game.board[selection.from[0]][selection.from[1]];
      if (!movingPiece) return;
      if (mustPromote(movingPiece.name, movingPiece.side, position)) {
        commitBoardMove(selection.from, position, true);
      } else if (canPromote(movingPiece.name, movingPiece.side, selection.from, position)) {
        setPromotionRequest({ from: selection.from, to: position });
      } else {
        commitBoardMove(selection.from, position, false);
      }
      return;
    }

    if (piece?.side === viewer) {
      if (selection?.kind === 'board' && isSamePosition(selection.from, position)) {
        setSelection(null);
      } else {
        setSelection({ kind: 'board', from: position });
      }
      return;
    }
    if (piece && piece.side !== viewer) {
      setGuessTarget(piece);
      return;
    }
    setSelection(null);
  }

  function selectHand(name: HandPieceName) {
    if (!game || phase !== 'playing' || game.turn !== viewer || game.hands[viewer][name] < 1) return;
    if (selection?.kind === 'hand' && selection.name === name) setSelection(null);
    else setSelection({ kind: 'hand', name });
  }

  function saveGuess(guess: GuessName) {
    if (!game || !guessTarget) return;
    setGame(withGuess(game, guessTarget.id, guess));
    setGuessTarget(null);
  }

  const opponent = otherSide(viewer);
  const selectedText = selection?.kind === 'board'
    ? `${shownGame.board[selection.from[0]][selection.from[1]]?.name ?? ''}を選択中`
    : selection?.kind === 'hand' ? `${selection.name}を打つ場所を選択中` : '自分の駒を選んでください';

  return (
    <main className="game-page">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-piece">影</span><div><p className="brand-kicker">SHADOW SHOGI</p><h1>影将棋</h1></div></div>
        <p className="tagline">その一手が、正体を語る。</p>
        <nav className="top-actions" aria-label="ゲーム操作">
          <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)}><BookOpen /> 遊び方</Button>
          <Button variant="outline" size="sm" onClick={resetToIntro}><RotateCcw /> 新しい対局</Button>
        </nav>
      </header>

      <section className="game-stage" aria-hidden={phase === 'handoff'}>
        <aside className="side-panel intro-panel">
          <p className="section-label">SHADOW TACTICS</p>
          <h2>影を読み、<br />王を探せ。</h2>
          <p className="lead">相手の駒はすべて影。動き方を観察し、予想マークを更新しながら、正体の分からない王を捕らえます。</p>
          <div className="rule-card"><Eye /><div><strong>影をタップして予想</strong><span>確定・未確定の2段階で記録</span></div></div>
          <div className="rule-card"><ShieldQuestion /><div><strong>王手・詰み判定なし</strong><span>王を実際に取れば勝利</span></div></div>
          {game ? (
            <div className="history-panel">
              <p className="section-label">MOVE LOG</p>
              {game.moveHistory.length === 0 ? <p className="empty-copy">まだ指し手はありません</p> : game.moveHistory.slice(-6).reverse().map((move, index) => (
                <div className="history-row" key={`${move.pieceId}-${game.moveHistory.length - index}`}>
                  <span>{game.moveHistory.length - index}</span><strong>{sideLabel(move.side)}</strong><span>{move.from ? `${boardCoordinates(move.from)} → ${boardCoordinates(move.to)}` : `${boardCoordinates(move.to)} 打`}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="board-column" aria-label="影将棋の盤面">
          <div className="captured-zone opponent-zone">
            <div className="zone-heading"><div><span className="mini-piece">影</span><p><strong>{sideLabel(opponent)}</strong><small>相手の持ち駒と取られた駒</small></p></div><span className="shadow-count">影 × {handTotal(shownGame.hands[opponent])}</span></div>
            <div className="captured-list">
              {HAND_NAMES.filter((name) => shownGame.takenLogs[viewer][name] > 0).map((name) => <span className="captured-chip" key={name}>{name}<small>×{shownGame.takenLogs[viewer][name]}</small></span>)}
              {HAND_NAMES.every((name) => shownGame.takenLogs[viewer][name] === 0) ? <span className="empty-hand">まだ駒は取られていません</span> : null}
            </div>
          </div>

          <div className="board-frame">
            <div className="file-labels" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index}>{viewer === 2 ? 9 - index : index + 1}</span>)}</div>
            <div className="board-grid">
              {Array.from({ length: 81 }, (_, displayIndex) => {
                const displayRow = Math.floor(displayIndex / 9);
                const displayColumn = displayIndex % 9;
                const position = boardPosition(displayRow, displayColumn, viewer);
                const piece = shownGame.board[position[0]][position[1]];
                const selected = selection?.kind === 'board' && isSamePosition(selection.from, position);
                const target = targetKeys.has(moveKey(position));
                const last = shownGame.lastMove && (isSamePosition(shownGame.lastMove.to, position) || Boolean(shownGame.lastMove.from && isSamePosition(shownGame.lastMove.from, position)));
                const label = piece ? (piece.side === viewer ? piece.name : `${displayName(shownGame.guesses[piece.id])}の予想`) : '空き升';
                return (
                  <button
                    className={`board-square ${selected ? 'selected-square' : ''} ${target ? 'legal-square' : ''} ${last ? 'last-square' : ''}`}
                    type="button"
                    key={displayIndex}
                    onClick={() => clickSquare(position)}
                    aria-label={`${9 - position[1]}筋${position[0] + 1}段 ${label}`}
                  >
                    {piece ? <PieceGlyph piece={piece} viewer={viewer} guess={shownGame.guesses[piece.id]} /> : null}
                    {target ? <span className={`move-dot ${piece ? 'capture-dot' : ''}`} /> : null}
                  </button>
                );
              })}
            </div>
            <span className="rank-labels" aria-hidden="true">一 二 三 四 五 六 七 八 九</span>
          </div>

          <div className="captured-zone own-zone">
            <div className="zone-heading"><div><span className="mini-piece gold">王</span><p><strong>{sideLabel(viewer)}・あなた</strong><small>{phase === 'playing' ? selectedText : '手番を待っています'}</small></p></div><span className="turn-pill">{phase === 'playing' ? '手番' : '待機'}</span></div>
            <div className="hand-list" aria-label="持ち駒">
              {HAND_NAMES.map((name) => {
                const count = shownGame.hands[viewer][name];
                const active = selection?.kind === 'hand' && selection.name === name;
                return <button type="button" key={name} disabled={!game || count < 1 || phase !== 'playing'} className={`hand-piece ${active ? 'active' : ''}`} onClick={() => selectHand(name)}><span>{name}</span><small>×{count}</small></button>;
              })}
            </div>
          </div>
        </section>

        <aside className="side-panel control-panel">
          {phase === 'intro' ? (
            <>
              <p className="section-label">LOCAL MATCH</p><h3>この画面で二人対局</h3>
              <p>Swift版と同じく、毎手ごとに盤面を隠して端末を渡します。先手から開始します。</p>
              <Button className="start-button" onClick={startMatch}><Sparkles /> ランダム盤面で始める</Button>
              <dl className="setup-list"><div><dt>盤面</dt><dd>9 × 9</dd></div><div><dt>初期配置</dt><dd>Swift版準拠</dd></div><div><dt>勝利条件</dt><dd>王を取る</dd></div></dl>
            </>
          ) : (
            <>
              <p className="section-label">CURRENT TURN</p><h3>{sideLabel(game?.turn ?? viewer)}の手番</h3>
              <p>自分の駒を選ぶと移動可能な升が光ります。相手の影を選ぶと予想を記録できます。</p>
              <div className="status-card"><span className="status-number">{(game?.moveHistory.length ?? 0) + 1}</span><div><strong>手目</strong><small>{selection ? selectedText : '盤面を観察中'}</small></div></div>
              <button type="button" className="tip-card" onClick={() => setRulesOpen(true)}><CircleHelp /><span><strong>ルールを確認</strong><small>成り・持ち駒・二歩について</small></span></button>
            </>
          )}
        </aside>
      </section>

      {phase === 'handoff' && game ? (
        <dialog open className="handoff-screen" aria-modal="true" aria-labelledby="handoff-title">
          <span className="handoff-piece">影</span><p className="section-label">PASS THE DEVICE</p>
          <h2 id="handoff-title">{sideLabel(game.turn)}番に<br />渡してください</h2>
          <p>盤面は隠れています。次のプレイヤーだけが画面を見てください。</p>
          <Button className="handoff-button" onClick={() => { setViewer(game.turn); setPhase('playing'); }}>準備できたら盤面を見る</Button>
          <small>Enter キーでも進めます</small>
        </dialog>
      ) : null}

      <Dialog open={Boolean(guessTarget)} onOpenChange={(open) => { if (!open) setGuessTarget(null); }}>
        <DialogContent className="guess-dialog sm:max-w-2xl">
          <DialogHeader><DialogTitle>この影の正体を予想</DialogTitle><DialogDescription>これまでに見せた動きから、駒の種類をマークします。未確定なら「?」付きで残せます。</DialogDescription></DialogHeader>
          <div className="guess-layout">
            <div><p className="dialog-label"><Footprints /> 今までの移動</p><MoveTrace moves={guessTarget && game ? game.moveLogs[guessTarget.id] ?? [] : []} /></div>
            <div className="guess-choices">
              <p className="dialog-label">確定予想</p><div className="guess-grid">{GUESS_NAMES.map((name) => <button type="button" key={name} onClick={() => saveGuess(name)}>{name}</button>)}</div>
              <p className="dialog-label">まだ自信がない</p><div className="guess-grid uncertain-grid">{GUESS_NAMES.map((name) => <button type="button" key={name} onClick={() => saveGuess(`${name}?` as GuessName)}>{name}<small>?</small></button>)}</div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => saveGuess('?')}>予想を消す</Button><Button variant="ghost" onClick={() => setGuessTarget(null)}>戻る</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(promotionRequest)} onOpenChange={(open) => { if (!open) setPromotionRequest(null); }}>
        <DialogContent showCloseButton={false} className="promotion-dialog">
          <DialogHeader><DialogTitle>成りますか？</DialogTitle><DialogDescription>この手は敵陣に入るか、敵陣から出る手です。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => promotionRequest && commitBoardMove(promotionRequest.from, promotionRequest.to, false)}>成らない</Button><Button onClick={() => promotionRequest && commitBoardMove(promotionRequest.from, promotionRequest.to, true)}>成る</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={phase === 'finished' && Boolean(game?.winner)} onOpenChange={() => undefined}>
        <DialogContent showCloseButton={false} className="result-dialog">
          <span className="result-piece">王</span><DialogHeader><DialogTitle>{game?.winner ? `${sideLabel(game.winner)}の勝利` : ''}</DialogTitle><DialogDescription>相手の王を捕らえました。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={resetToIntro}>タイトルへ</Button><Button onClick={startMatch}>もう一局</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="rules-dialog sm:max-w-lg">
          <DialogHeader><DialogTitle>影将棋の遊び方</DialogTitle><DialogDescription>Swift版の二人対局ルールをWeb向けに移植しています。</DialogDescription></DialogHeader>
          <ol className="rules-list">
            <li><span>01</span><div><strong>配置は毎局ランダム</strong><p>各列に歩が1枚、王は最下段。その他の駒はSwift版と同じ手順で入れ替わります。</p></div></li>
            <li><span>02</span><div><strong>相手の駒は影</strong><p>影を押すと予想を記録できます。移動方向の履歴も予想画面で確認できます。</p></div></li>
            <li><span>03</span><div><strong>通常の移動・成り・持ち駒</strong><p>二歩と行き所のない駒打ちは禁止。王手・詰み・打ち歩詰めの判定はしません。</p></div></li>
            <li><span>04</span><div><strong>王を取れば勝ち</strong><p>王の位置は最後まで分かりません。実際に王を捕らえた瞬間に決着します。</p></div></li>
          </ol>
          <DialogFooter><Button onClick={() => setRulesOpen(false)}>わかった</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
