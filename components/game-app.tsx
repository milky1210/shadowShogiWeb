'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, BookOpen, BrainCircuit, CircleHelp, Eye, EyeOff, Footprints, Gamepad2, Globe2, RotateCcw, ShieldQuestion, Sparkles, Swords, Users } from 'lucide-react';
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
import { applyCpuAction, chooseCpuAction, type CpuLevel } from '@/lib/shadow-shogi-ai';

type Phase = 'intro' | 'playing' | 'handoff' | 'cpu-thinking' | 'finished';
type GameMode = 'local' | 'cpu';
type MatchSelection = 'local' | 'online' | 'cpu-1' | 'cpu-2' | 'cpu-3';
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
const HUMAN_SIDE: Side = 2;
const CPU_SIDE: Side = 1;
const CPU_LEVELS: Array<{ level: CpuLevel; name: string; badge: string; description: string }> = [
  { level: 1, name: 'あゆむくん', badge: 'BEGINNER', description: '取れる影を素直に狙う、親しみやすい棋士。' },
  { level: 2, name: '銀次くん', badge: 'TACTICIAN', description: '見えた動きを読み、危険と前進を評価する。' },
  { level: 3, name: '影丸', badge: 'MASTER', description: '全配置を理解し、完全情報で先を読む。' },
];
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

function actionLogText(move: GameState['moveHistory'][number], viewer: Side) {
  if (move.captured) {
    return move.side === viewer
      ? `相手の${move.captured}を取得！`
      : `${move.captured}を取られた`;
  }

  const destination = boardCoordinates(move.to);
  if (move.dropped) {
    return move.side === viewer
      ? `${destination}へ持ち駒を打った`
      : `相手が${destination}へ持ち駒を打った`;
  }

  return move.side === viewer
    ? `${destination}へ移動した`
    : `相手が${destination}へ移動した`;
}

function ActivityLog({ state, viewer, onOpenHistory }: { state: GameState; viewer: Side; onOpenHistory?: () => void }) {
  const actions = state.moveHistory.slice(-2);
  const firstMoveNumber = state.moveHistory.length - actions.length + 1;

  return (
    <div className="activity-card" aria-live="polite">
      <div className="activity-heading">
        <span><Footprints /><strong>最新の行動</strong></span>
        {onOpenHistory ? <small>タップで全履歴</small> : null}
      </div>
      {actions.length > 0 ? (
        <ol className="activity-list">
          {actions.map((move, index) => {
            const moveNumber = firstMoveNumber + index;
            return (
              <li className={move.captured ? 'capture-activity' : ''} key={`${move.pieceId}-${moveNumber}`}>
                <button type="button" disabled={!onOpenHistory} onClick={onOpenHistory}>
                  <span>{moveNumber}</span>
                  <p>{actionLogText(move, viewer)}</p>
                </button>
              </li>
            );
          })}
        </ol>
      ) : <p className="activity-empty">まだ行動はありません</p>}
    </div>
  );
}

function PieceFace({ label, tone, className = '', uncertain = false }: { label: string; tone: 'light' | 'shadow'; className?: string; uncertain?: boolean }) {
  return (
    <span className={`piece-face piece-face-${tone} ${className}`} aria-hidden="true">
      <span className="piece-face-label">{label}</span>
      {uncertain ? <small className="piece-face-uncertain">?</small> : null}
    </span>
  );
}

function boardPosition(displayRow: number, displayColumn: number, viewer: Side): Position {
  return viewer === 1 ? [8 - displayRow, 8 - displayColumn] : [displayRow, displayColumn];
}

function PieceGlyph({ piece, viewer, guess, revealOpponent = false }: { piece: Piece; viewer: Side; guess?: GuessName; revealOpponent?: boolean }) {
  const own = piece.side === viewer;
  const revealed = !own && revealOpponent;
  return <PieceFace label={own || revealed ? piece.name : displayName(guess)} tone={own || revealed ? 'light' : 'shadow'} className={`shogi-piece ${own ? 'own-piece' : 'enemy-piece'} ${revealed ? 'revealed-piece' : ''}`} uncertain={!own && !revealed && isUncertain(guess)} />;
}

function MoveTrace({ moves }: { moves: Position[] }) {
  const observed = new Set(moves.map(moveKey));
  return (
    <div className="trace-grid" aria-label="この駒が見せた動き">
      {Array.from({ length: 25 }, (_, index) => {
        const row = Math.floor(index / 5) - 2;
        const column = index % 5 - 2;
        const center = row === 0 && column === 0;
        return <span key={index} className={`${center ? 'trace-center' : ''} ${observed.has(moveKey([row, column])) ? 'trace-observed' : ''}`}>{center ? <PieceFace label="?" tone="shadow" className="shogi-piece trace-center-piece" /> : null}</span>;
      })}
    </div>
  );
}

export function GameApp() {
  const [game, setGame] = useState<GameState | null>(null);
  const [viewer, setViewer] = useState<Side>(2);
  const [phase, setPhase] = useState<Phase>('intro');
  const [gameMode, setGameMode] = useState<GameMode>('local');
  const [cpuLevel, setCpuLevel] = useState<CpuLevel>(2);
  const [cpuReport, setCpuReport] = useState<{ depth: number; nodes: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [guessTarget, setGuessTarget] = useState<Piece | null>(null);
  const [promotionRequest, setPromotionRequest] = useState<PromotionRequest>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [timeline, setTimeline] = useState<GameState[]>([]);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [revealOpponent, setRevealOpponent] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [matchSelection, setMatchSelection] = useState<MatchSelection>('local');
  const reviewing = reviewIndex !== null;
  const shownGame = reviewing ? timeline[reviewIndex] ?? game ?? PREVIEW_GAME : game ?? PREVIEW_GAME;

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

  const startLocalMatch = useCallback(() => {
    const initial = createInitialGame();
    setGame(initial);
    setTimeline([initial]);
    setViewer(HUMAN_SIDE);
    setGameMode('local');
    setCpuReport(null);
    setSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
    setPhase('playing');
  }, []);

  const startCpuMatch = useCallback((level: CpuLevel) => {
    const initial = createInitialGame();
    setGame(initial);
    setTimeline([initial]);
    setViewer(HUMAN_SIDE);
    setGameMode('cpu');
    setCpuLevel(level);
    setCpuReport(null);
    setSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
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
        startLocalMatch();
        return { status: 'started', turn: '先手', mode: 'local_two_player' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    void Promise.resolve(context.registerTool({
      name: 'start_shadow_shogi_cpu_match',
      title: '影将棋のCPU対局を始める',
      description: '初級・中級・最強から選び、このブラウザだけでCPU対局を開始します。',
      inputSchema: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['easy', 'normal', 'hard'] } },
        required: ['level'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { level?: string } = {}) => {
        const keys = Object.keys(input);
        if (keys.length !== 1 || keys[0] !== 'level' || !['easy', 'normal', 'hard'].includes(input.level ?? '')) {
          throw new Error('level は easy・normal・hard のいずれかで指定してください');
        }
        const level = input.level === 'easy' ? 1 : input.level === 'hard' ? 3 : 2;
        startCpuMatch(level);
        return { status: 'started', turn: '先手', mode: 'cpu', level: input.level };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [startCpuMatch, startLocalMatch]);

  useEffect(() => {
    if (gameMode !== 'cpu' || phase !== 'cpu-thinking' || !game || game.winner || game.turn !== CPU_SIDE) return;
    const timer = window.setTimeout(() => {
      const decision = chooseCpuAction(game, cpuLevel, CPU_SIDE);
      setCpuReport({ depth: decision.depth, nodes: decision.nodes });
      if (!decision.action) {
        setPhase('playing');
        return;
      }
      const next = applyCpuAction(game, decision.action);
      setGame(next);
      setTimeline((current) => [...current, next]);
      if (next.winner) setResultOpen(true);
      setPhase(next.winner ? 'finished' : 'playing');
    }, cpuLevel === 3 ? 520 : 680);
    return () => window.clearTimeout(timer);
  }, [cpuLevel, game, gameMode, phase]);

  function resetToIntro() {
    setGame(null);
    setViewer(HUMAN_SIDE);
    setGameMode('local');
    setCpuReport(null);
    setSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setTimeline([]);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
    setMatchSelection('local');
    setPhase('intro');
  }

  function completeMove(next: GameState) {
    setGame(next);
    setTimeline((current) => [...current, next]);
    setSelection(null);
    setPromotionRequest(null);
    setGuessTarget(null);
    if (next.winner) {
      setResultOpen(true);
      setPhase('finished');
    } else if (gameMode === 'cpu') {
      setViewer(HUMAN_SIDE);
      setPhase(next.turn === CPU_SIDE ? 'cpu-thinking' : 'playing');
    } else {
      setPhase('handoff');
    }
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
    const guessed = withGuess(game, guessTarget.id, guess);
    setGame(guessed);
    setTimeline((current) => current.length > 0 ? [...current.slice(0, -1), guessed] : current);
    setGuessTarget(null);
  }

  function openReview(moveNumber: number) {
    if (gameMode !== 'cpu' || phase !== 'finished' || timeline.length === 0) return;
    setReviewIndex(Math.max(0, Math.min(moveNumber, timeline.length - 1)));
    if (!reviewing) setRevealOpponent(false);
    setResultOpen(false);
  }

  function selectHistoryMove(moveNumber: number) {
    if (gameMode !== 'cpu' || phase !== 'finished') return;
    openReview(moveNumber);
    setHistoryOpen(false);
  }

  function closeReview() {
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(true);
  }

  function startSelectedMatch() {
    if (matchSelection === 'local') {
      startLocalMatch();
      return;
    }
    if (matchSelection === 'online') return;
    startCpuMatch(Number(matchSelection.slice(-1)) as CpuLevel);
  }

  const opponent = otherSide(viewer);
  const cpuLevelInfo = CPU_LEVELS.find((item) => item.level === cpuLevel) ?? CPU_LEVELS[1];
  const playerLabel = (side: Side) => gameMode === 'cpu' && side === CPU_SIDE ? 'CPU' : sideLabel(side);
  const opponentLabel = gameMode === 'cpu' ? `CPU・${cpuLevelInfo.name}` : sideLabel(opponent);
  const selectedText = selection?.kind === 'board'
    ? `${shownGame.board[selection.from[0]][selection.from[1]]?.name ?? ''}を選択中`
    : selection?.kind === 'hand' ? `${selection.name}を打つ場所を選択中` : '自分の駒を選んでください';
  const lastReviewIndex = Math.max(0, timeline.length - 1);
  const currentReviewMove = reviewing ? shownGame.lastMove : null;
  const canReview = gameMode === 'cpu' && phase === 'finished' && timeline.length > 0;
  const resultTitle = gameMode === 'cpu'
    ? game?.winner === HUMAN_SIDE ? 'あなたの勝ち' : 'あなたの負け'
    : game?.winner ? `${sideLabel(game.winner)}の勝利` : '';
  const selectedCpuLevel = matchSelection.startsWith('cpu-') ? Number(matchSelection.slice(-1)) as CpuLevel : null;
  const selectedCpu = selectedCpuLevel ? CPU_LEVELS.find((item) => item.level === selectedCpuLevel) ?? null : null;
  const homeTitle = matchSelection === 'local'
    ? '同じ盤を、ふたりで囲む。'
    : matchSelection === 'online'
      ? '遠くの影と、つながる。'
      : `${selectedCpu?.name ?? ''}に挑む。`;
  const homeDescription = matchSelection === 'local'
    ? '一台の端末を手渡しながら遊ぶ、影将棋の基本対局。'
    : matchSelection === 'online'
      ? 'ネット対戦は準備中です。今後のアップデートで解放されます。'
      : selectedCpu?.description ?? '';

  return (
    <main className={`game-page ${phase === 'handoff' ? 'handoff-active' : ''} ${reviewing ? 'review-active' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-piece">影</span><div><p className="brand-kicker">SHADOW SHOGI</p><h1>影将棋</h1></div></div>
        <p className="tagline">その一手が、正体を語る。</p>
        <nav className="top-actions" aria-label="ゲーム操作">
          <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)}><BookOpen /> 遊び方</Button>
          <Button variant="outline" size="sm" onClick={resetToIntro}><RotateCcw /> 新しい対局</Button>
        </nav>
      </header>

      <section className={`game-stage ${phase === 'intro' ? 'home-stage' : ''}`} aria-hidden={phase === 'handoff'}>
        {phase === 'intro' ? (
          <section className="home-screen" aria-label="対局方法の選択">
            <div className="home-selection-visual" key={matchSelection}>
              <div className="home-visual-glow" />
              {selectedCpu ? <div className={`home-character portrait-${selectedCpu.level}`} aria-hidden="true" /> : (
                <div className={`home-mode-visual ${matchSelection === 'online' ? 'online' : ''}`} aria-hidden="true">
                  <span className="home-mode-ring" />
                  {matchSelection === 'online' ? <Globe2 /> : <Users />}
                  <i className="home-orbit-piece">影</i>
                </div>
              )}
              <div className="home-visual-copy">
                <p className="section-label">SELECT YOUR MATCH</p>
                <span className="home-visual-badge">{selectedCpu?.badge ?? (matchSelection === 'online' ? 'COMING SOON' : 'LOCAL MATCH')}</span>
                <h2>{homeTitle}</h2>
                <p>{homeDescription}</p>
              </div>
            </div>

            <div className="home-menu-row home-local-row" aria-label="二人対局">
              <button type="button" className={matchSelection === 'local' ? 'selected' : ''} aria-pressed={matchSelection === 'local'} onClick={() => setMatchSelection('local')}>
                <span className="home-option-icon"><Users /></span><span><strong>二人対局</strong><small>ローカル</small></span>
              </button>
              <button type="button" className={matchSelection === 'online' ? 'selected' : ''} aria-pressed={matchSelection === 'online'} onClick={() => setMatchSelection('online')}>
                <span className="home-option-icon"><Globe2 /></span><span><strong>二人対局</strong><small>ネット対戦・準備中</small></span>
              </button>
            </div>

            <div className="home-menu-row home-cpu-row" aria-label="CPU対局">
              {CPU_LEVELS.map((item) => {
                const value = `cpu-${item.level}` as MatchSelection;
                return (
                  <button type="button" className={matchSelection === value ? 'selected' : ''} aria-pressed={matchSelection === value} key={item.level} onClick={() => setMatchSelection(value)}>
                    <span className={`home-cpu-avatar portrait-${item.level}`} aria-hidden="true" />
                    <span><small>CPU対局</small><strong>vs {item.name}</strong></span>
                    <em>LV.{item.level}</em>
                  </button>
                );
              })}
            </div>

            <Button className="home-start-button" disabled={matchSelection === 'online'} onClick={startSelectedMatch}>
              {matchSelection === 'online' ? <><Sparkles /> ネット対戦は準備中</> : <><Swords /> この対局を開始</>}
            </Button>
            <p className="home-footnote"><Gamepad2 /> 対局処理はすべてこの端末内で動作します</p>
          </section>
        ) : null}
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
                  <span>{game.moveHistory.length - index}</span><strong>{playerLabel(move.side)}</strong><span>{move.from ? `${boardCoordinates(move.from)} → ${boardCoordinates(move.to)}` : `${boardCoordinates(move.to)} 打`}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="board-column" aria-label="影将棋の盤面">
          <div className="captured-zone opponent-zone">
            <div className="zone-heading"><div><span className="mini-piece">影</span><p><strong>{opponentLabel}</strong><small>{reviewing && revealOpponent ? 'リプレイで正体を表示中' : '持ち駒の種類は非公開'}</small></p></div><span className="shadow-count">合計 {handTotal(shownGame.hands[opponent])} 枚</span></div>
            {reviewing && revealOpponent ? (
              <div className="review-opponent-hand" aria-label="相手の持ち駒の正体">
                {HAND_NAMES.filter((name) => shownGame.hands[opponent][name] > 0).map((name) => <span className="review-hand-piece" key={name}><PieceFace label={name} tone="light" className="hand-piece-face enemy-piece" /><small>×{shownGame.hands[opponent][name]}</small></span>)}
                {handTotal(shownGame.hands[opponent]) === 0 ? <span className="opponent-hand-empty">持ち駒なし</span> : null}
              </div>
            ) : <div className="opponent-hand-hidden" aria-label={`相手の持ち駒は合計${handTotal(shownGame.hands[opponent])}枚。種類は非公開です。`}><ShieldQuestion /><span>相手の持ち駒は合計だけ表示されます</span></div>}
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
                const label = piece ? (piece.side === viewer || revealOpponent ? piece.name : `${displayName(shownGame.guesses[piece.id])}の予想`) : '空き升';
                return (
                  <button
                    className={`board-square ${selected ? 'selected-square' : ''} ${target ? 'legal-square' : ''} ${last ? 'last-square' : ''}`}
                    type="button"
                    disabled={reviewing}
                    key={displayIndex}
                    onClick={() => clickSquare(position)}
                    aria-label={`${9 - position[1]}筋${position[0] + 1}段 ${label}`}
                  >
                    {piece ? <PieceGlyph piece={piece} viewer={viewer} guess={shownGame.guesses[piece.id]} revealOpponent={reviewing && revealOpponent} /> : null}
                    {target ? <span className={`move-dot ${piece ? 'capture-dot' : ''}`} /> : null}
                  </button>
                );
              })}
            </div>
            <span className="rank-labels" aria-hidden="true">一 二 三 四 五 六 七 八 九</span>
          </div>

          {reviewing ? (
            <section className="replay-dock" aria-label="棋譜の振り返り操作">
              <div className="replay-dock-heading"><span>対局を振り返る</span><strong>{reviewIndex} / {lastReviewIndex}手</strong></div>
              <div className="review-step-buttons">
                <button type="button" disabled={reviewIndex === 0} onClick={() => setReviewIndex(0)}>最初</button>
                <button type="button" disabled={reviewIndex === 0} onClick={() => setReviewIndex((current) => Math.max(0, (current ?? 0) - 1))}>前へ</button>
                <button type="button" disabled={reviewIndex === lastReviewIndex} onClick={() => setReviewIndex((current) => Math.min(lastReviewIndex, (current ?? 0) + 1))}>次へ</button>
                <button type="button" disabled={reviewIndex === lastReviewIndex} onClick={() => setReviewIndex(lastReviewIndex)}>最後</button>
              </div>
              <div className="replay-slider-row"><span>0</span><input type="range" min={0} max={lastReviewIndex} value={reviewIndex} onChange={(event) => setReviewIndex(Number(event.target.value))} aria-label="表示する手数" /><span>{lastReviewIndex}</span></div>
              <div className="replay-dock-actions">
                <button type="button" className={`reveal-toggle ${revealOpponent ? 'active' : ''}`} onClick={() => setRevealOpponent((visible) => !visible)}>
                  {revealOpponent ? <EyeOff /> : <Eye />}
                  <span><strong>{revealOpponent ? '相手の駒を影に戻す' : '相手の駒の正体を表示'}</strong><small>盤上と持ち駒を切り替え</small></span>
                </button>
                <Button variant="outline" className="review-result-button" onClick={closeReview}>対局結果に戻る</Button>
              </div>
            </section>
          ) : null}

          <div className="captured-zone own-zone">
            <div className="zone-heading"><div><span className="mini-piece gold">王</span><p><strong>{sideLabel(viewer)}・あなた</strong><small>{phase === 'playing' ? selectedText : phase === 'cpu-thinking' ? 'CPUが次の一手を探索中' : '手番を待っています'}</small></p></div><span className="turn-pill">{phase === 'playing' ? '手番' : phase === 'cpu-thinking' ? '思考中' : '待機'}</span></div>
            <div className="hand-list" aria-label="持ち駒">
              {HAND_NAMES.map((name) => {
                const count = shownGame.hands[viewer][name];
                const active = selection?.kind === 'hand' && selection.name === name;
                return <button type="button" key={name} aria-label={`${name}を打つ（${count}枚）`} disabled={!game || count < 1 || phase !== 'playing'} className={`hand-piece ${active ? 'active' : ''}`} onClick={() => selectHand(name)}><PieceFace label={name} tone="light" className="hand-piece-face" /><small>×{count}</small></button>;
              })}
            </div>
          </div>
        </section>

        <aside className="side-panel control-panel">
          {phase === 'intro' ? (
            <>
              <p className="section-label">SELECT MATCH</p><h3>対局方法を選ぶ</h3>
              <p>一台での二人対局に加え、ブラウザだけで動く3段階のCPUと対局できます。</p>
              <Button className="start-button" onClick={startLocalMatch}><Users /> 二人で対局する</Button>
              <div className="cpu-picker-heading"><Bot /><span>CPUと対局</span></div>
              <div className="cpu-level-grid">
                {CPU_LEVELS.map((item) => (
                  <button type="button" key={item.level} onClick={() => startCpuMatch(item.level)}>
                    <span className="cpu-level-number">{item.level}</span>
                    <span><strong>{item.name}</strong><small>{item.badge}</small></span>
                    <em>{item.description}</em>
                  </button>
                ))}
              </div>
              <dl className="setup-list"><div><dt>盤面</dt><dd>9 × 9</dd></div><div><dt>初期配置</dt><dd>Swift版準拠</dd></div><div><dt>CPU処理</dt><dd>端末内で完結</dd></div></dl>
            </>
          ) : reviewing ? (
            <>
              <p className="section-label">GAME REVIEW</p>
              <h3>{reviewIndex}手目 / {lastReviewIndex}手</h3>
              <p className="review-description">{currentReviewMove ? actionLogText(currentReviewMove, HUMAN_SIDE) : '対局開始時の配置です。'}</p>
              <ActivityLog state={shownGame} viewer={HUMAN_SIDE} onOpenHistory={() => setHistoryOpen(true)} />
            </>
          ) : (
            <>
              <p className="section-label">{gameMode === 'cpu' ? `${cpuLevelInfo.badge} CPU` : 'CURRENT TURN'}</p><h3>{phase === 'cpu-thinking' ? 'CPUが思考中' : `${playerLabel(game?.turn ?? viewer)}の手番`}</h3>
              <p>{phase === 'cpu-thinking' ? `${cpuLevelInfo.name}CPUが盤面を読んでいます。相手の駒はあなたには影のままです。` : '自分の駒を選ぶと移動可能な升が光ります。相手の影を選ぶと予想を記録できます。'}</p>
              {gameMode === 'cpu' ? <div className={`cpu-thinking ${phase === 'cpu-thinking' ? 'is-active' : ''}`} aria-hidden={phase !== 'cpu-thinking'}><BrainCircuit /><span /><span /><span /></div> : null}
              <ActivityLog state={shownGame} viewer={viewer} onOpenHistory={() => setHistoryOpen(true)} />
              {gameMode === 'cpu' ? <p className={`cpu-report ${cpuReport ? 'is-active' : ''}`} aria-hidden={!cpuReport}>{cpuReport ? `前回の探索：深さ ${cpuReport.depth}・${cpuReport.nodes.toLocaleString()}局面` : '探索結果の表示領域'}</p> : null}
              <button type="button" className="tip-card" onClick={() => setRulesOpen(true)}><CircleHelp /><span><strong>ルールを確認</strong><small>成り・持ち駒・二歩について</small></span></button>
            </>
          )}
        </aside>
      </section>

      {phase === 'handoff' && game ? (
        <dialog open className="handoff-screen" aria-modal="true" aria-labelledby="handoff-title">
          <span className="handoff-piece">影</span><p className="section-label">PASS THE DEVICE</p>
          <h2 id="handoff-title">{sideLabel(game.turn)}番に<br />渡してください</h2>
          <p>盤面と両者の持ち駒を隠しています。端末を渡してから、次のプレイヤーだけが開いてください。</p>
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
              <p className="dialog-label">確定予想</p><div className="guess-grid">{GUESS_NAMES.map((name) => <button type="button" key={name} aria-label={`${name}に確定`} onClick={() => saveGuess(name)}><PieceFace label={name} tone="shadow" className="guess-piece-face" /></button>)}</div>
              <p className="dialog-label">まだ自信がない</p><div className="guess-grid uncertain-grid">{GUESS_NAMES.map((name) => <button type="button" key={name} aria-label={`${name}かもしれない`} onClick={() => saveGuess(`${name}?` as GuessName)}><PieceFace label={name} tone="shadow" className="guess-piece-face" uncertain /></button>)}</div>
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

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="history-dialog sm:max-w-lg">
          <DialogHeader><DialogTitle>この対局の行動ログ</DialogTitle><DialogDescription>{canReview ? '確認したい手を選ぶと、その時点の盤面へ移動します。' : 'この対局で指された手を、最初から順番に確認できます。'}</DialogDescription></DialogHeader>
          <div className="full-history-list" aria-label="全対局ログ">
            {game && game.moveHistory.length > 0 ? game.moveHistory.map((move, index) => {
              const moveNumber = index + 1;
              const coordinates = move.from ? `${boardCoordinates(move.from)} → ${boardCoordinates(move.to)}` : `${boardCoordinates(move.to)} 打`;
              return (
                <button type="button" className={reviewing && reviewIndex === moveNumber ? 'active' : ''} disabled={!canReview} key={`${move.pieceId}-${moveNumber}`} onClick={() => selectHistoryMove(moveNumber)}>
                  <span className="history-move-number">{moveNumber}</span>
                  <span className="history-move-copy"><strong>{actionLogText(move, gameMode === 'cpu' ? HUMAN_SIDE : viewer)}</strong><small>{playerLabel(move.side)}・{coordinates}</small></span>
                </button>
              );
            }) : <p className="history-empty">まだ行動はありません</p>}
          </div>
          <DialogFooter><Button onClick={() => setHistoryOpen(false)}>閉じる</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={phase === 'finished' && resultOpen && Boolean(game?.winner)} onOpenChange={() => undefined}>
        <DialogContent showCloseButton={false} className="result-dialog">
          <span className="result-piece">王</span><DialogHeader><DialogTitle>{resultTitle}</DialogTitle><DialogDescription>{gameMode === 'cpu' && game?.winner === CPU_SIDE ? 'あなたの王が影の中から見つかりました。盤面を開いて、どの手で捕まったか確認できます。' : '相手の王を捕らえました。'}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={resetToIntro}>タイトルへ</Button>{gameMode === 'cpu' ? <Button variant="outline" onClick={() => openReview(lastReviewIndex)}><Footprints /> 盤面で振り返る</Button> : null}<Button onClick={() => gameMode === 'cpu' ? startCpuMatch(cpuLevel) : startLocalMatch()}>もう一局</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="rules-dialog sm:max-w-lg">
          <DialogHeader><DialogTitle>影将棋の遊び方</DialogTitle><DialogDescription>Swift版のルールをWebへ移植し、端末内で動くCPU対局を追加しています。</DialogDescription></DialogHeader>
          <ol className="rules-list">
            <li><span>01</span><div><strong>配置は毎局ランダム</strong><p>各列に歩が1枚、王は最下段。その他の駒はSwift版と同じ手順で入れ替わります。</p></div></li>
            <li><span>02</span><div><strong>相手の駒は影</strong><p>影を押すと予想を記録できます。移動方向の履歴も予想画面で確認できます。</p></div></li>
            <li><span>03</span><div><strong>通常の移動・成り・持ち駒</strong><p>二歩と行き所のない駒打ちは禁止。王手・詰み・打ち歩詰めの判定はしません。</p></div></li>
            <li><span>04</span><div><strong>王を取れば勝ち</strong><p>王の位置は最後まで分かりません。実際に王を捕らえた瞬間に決着します。</p></div></li>
            <li><span>05</span><div><strong>3段階のCPU</strong><p>初級は捕獲優先、中級は観察した動きを評価。最強はあなたの配置を含む完全情報で3手先まで探索します。</p></div></li>
          </ol>
          <DialogFooter><Button onClick={() => setRulesOpen(false)}>わかった</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
