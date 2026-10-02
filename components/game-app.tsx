import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  BookOpen,
  BrainCircuit,
  CircleHelp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Footprints,
  Gamepad2,
  Globe2,
  Link2,
  LockKeyhole,
  LoaderCircle,
  RotateCcw,
  Share2,
  ShieldQuestion,
  Swords,
  Users,
  Wifi,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  randomSide,
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
import {
  applyCpuAction,
  chooseCpuAction,
  type CpuDecision,
  type CpuLevel,
} from '@/lib/shadow-shogi-ai';
import { normalizeRoomCode, onlineInviteUrl } from '@/lib/shadow-shogi-room';
import type { OnlineRoom } from '@/lib/shadow-shogi-online';

type OnlineModule = typeof import('@/lib/shadow-shogi-online');
let onlineModuleRequest: Promise<OnlineModule> | null = null;

function loadOnlineModule() {
  onlineModuleRequest ??= import('@/lib/shadow-shogi-online');
  return onlineModuleRequest;
}

function isOnlineJoinBlockedError(
  error: unknown,
): error is Error & { reason: 'playing' | 'finished' } {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return (
    error instanceof Error &&
    error.name === 'OnlineRoomJoinBlockedError' &&
    (reason === 'playing' || reason === 'finished')
  );
}

type Phase =
  | 'intro'
  | 'playing'
  | 'handoff'
  | 'cpu-thinking'
  | 'online-lobby'
  | 'online-waiting'
  | 'finished';
type GameMode = 'local' | 'cpu' | 'online';
type MatchSelection = 'local' | 'online' | 'cpu-1' | 'cpu-2' | 'cpu-3';
type Selection =
  | { kind: 'board'; from: Position }
  | { kind: 'hand'; name: HandPieceName }
  | null;
type PromotionRequest = { from: Position; to: Position } | null;

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

const PREVIEW_GAME = createInitialGame(seededRandom(20260926));
const CPU_LEVELS: Array<{
  level: CpuLevel;
  name: string;
  badge: string;
  description: string;
  slug: string;
  winQuote: string;
  lossQuote: string;
  artwork: {
    portrait: { compact: string; wide: string };
    result: { win: string; loss: string };
  };
}> = [
  {
    level: 1,
    name: 'あゆむくん',
    badge: 'BEGINNER',
    description: '気軽に対局できる、やさしい強さです。',
    slug: 'ayumu',
    winQuote: '運負けっス...',
    lossQuote: '時にはブラフも必要っス',
    artwork: {
      portrait: {
        compact: '/characters/main-ayumu.webp',
        wide: '/characters/hero-ayumu.webp',
      },
      result: {
        win: '/result-ayumu-win-v2.webp',
        loss: '/result-ayumu-loss.webp',
      },
    },
  },
  {
    level: 2,
    name: '金一',
    badge: 'TACTICIAN',
    description: '数手先まで読み、隙を見逃さない実戦派です。',
    slug: 'kinichi',
    winQuote: '流石の腕前でござる',
    lossQuote: 'まだまだ修練が足りませぬぞ',
    artwork: {
      portrait: {
        compact: '/characters/main-kinichi.webp',
        wide: '/characters/hero-kinichi.webp',
      },
      result: {
        win: '/result-kinichi-win.webp',
        loss: '/result-kinichi-loss.webp',
      },
    },
  },
  {
    level: 3,
    name: 'かげむしゃ王',
    badge: 'MASTER',
    description: '取り合いの先まで深く読む、最強の相手です。',
    slug: 'kagemusha-oh',
    winQuote: '',
    lossQuote: '快勝、快勝！',
    artwork: {
      portrait: {
        compact: '/characters/main-kagemusha-oh.webp',
        wide: '/characters/hero-kagemusha-oh.webp',
      },
      result: {
        win: '/result-kagemusha-oh-win.webp',
        loss: '/result-kagemusha-oh-loss.webp',
      },
    },
  },
];

const preloadedArtwork = new Map<string, HTMLImageElement>();

function preloadArtwork(source: string, priority: 'high' | 'low') {
  if (typeof Image === 'undefined' || preloadedArtwork.has(source)) return;
  const image = new Image();
  image.decoding = 'async';
  image.fetchPriority = priority;
  image.src = source;
  preloadedArtwork.set(source, image);
  void image.decode().catch(() => preloadedArtwork.delete(source));
}

function cpuArtwork(level: CpuLevel) {
  return CPU_LEVELS.find((item) => item.level === level)?.artwork;
}

function preloadCpuPortrait(level: CpuLevel) {
  const artwork = cpuArtwork(level);
  if (!artwork) return;
  const source = window.matchMedia('(min-width: 851px)').matches
    ? artwork.portrait.wide
    : artwork.portrait.compact;
  preloadArtwork(source, 'high');
}

function preloadCpuResultArtwork(level: CpuLevel) {
  const artwork = cpuArtwork(level);
  if (!artwork) return;
  preloadArtwork(artwork.result.win, 'low');
  preloadArtwork(artwork.result.loss, 'low');
}
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

function ActivityLog({
  state,
  viewer,
  onOpenHistory,
  className = '',
}: {
  state: GameState;
  viewer: Side;
  onOpenHistory?: () => void;
  className?: string;
}) {
  const actions = state.moveHistory.slice(-2);
  const firstMoveNumber = state.moveHistory.length - actions.length + 1;

  return (
    <div className={`activity-card ${className}`} aria-live="polite">
      <div className="activity-heading">
        <span>
          <Footprints />
          <strong>最新の行動</strong>
        </span>
        {onOpenHistory ? <small>タップで全履歴</small> : null}
      </div>
      {actions.length > 0 ? (
        <ol className="activity-list">
          {actions.map((move, index) => {
            const moveNumber = firstMoveNumber + index;
            return (
              <li
                className={move.captured ? 'capture-activity' : ''}
                key={`${move.pieceId}-${moveNumber}`}
              >
                <button
                  type="button"
                  disabled={!onOpenHistory}
                  onClick={onOpenHistory}
                >
                  <span>{moveNumber}</span>
                  <p>{actionLogText(move, viewer)}</p>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="activity-empty">まだ行動はありません</p>
      )}
    </div>
  );
}

function PieceFace({
  label,
  tone,
  className = '',
  uncertain = false,
}: {
  label: string;
  tone: 'light' | 'shadow';
  className?: string;
  uncertain?: boolean;
}) {
  return (
    <span
      className={`piece-face piece-face-${tone} ${className}`}
      aria-hidden="true"
    >
      <span className="piece-face-label">{label}</span>
      {uncertain ? <small className="piece-face-uncertain">?</small> : null}
    </span>
  );
}

function boardPosition(
  displayRow: number,
  displayColumn: number,
  viewer: Side,
): Position {
  return viewer === 1
    ? [8 - displayRow, 8 - displayColumn]
    : [displayRow, displayColumn];
}

function PieceGlyph({
  piece,
  viewer,
  guess,
  revealOpponent = false,
}: {
  piece: Piece;
  viewer: Side;
  guess?: GuessName;
  revealOpponent?: boolean;
}) {
  const own = piece.side === viewer;
  const revealed = !own && revealOpponent;
  return (
    <PieceFace
      label={own || revealed ? piece.name : displayName(guess)}
      tone={own || revealed ? 'light' : 'shadow'}
      className={`shogi-piece ${own ? 'own-piece' : 'enemy-piece'} ${revealed ? 'revealed-piece' : ''}`}
      uncertain={!own && !revealed && isUncertain(guess)}
    />
  );
}

function MoveTrace({ moves }: { moves: Position[] }) {
  const observed = new Set(moves.map(moveKey));
  return (
    <div className="trace-grid" aria-label="この駒が見せた動き">
      {Array.from({ length: 25 }, (_, index) => {
        const row = Math.floor(index / 5) - 2;
        const column = (index % 5) - 2;
        const center = row === 0 && column === 0;
        return (
          <span
            key={index}
            className={`${center ? 'trace-center' : ''} ${observed.has(moveKey([row, column])) ? 'trace-observed' : ''}`}
          >
            {center ? (
              <PieceFace
                label="?"
                tone="shadow"
                className="shogi-piece trace-center-piece"
              />
            ) : null}
          </span>
        );
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
  const [humanSide, setHumanSide] = useState<Side>(2);
  const [selection, setSelection] = useState<Selection>(null);
  const selectionRef = useRef<Selection>(null);
  const [guessTarget, setGuessTarget] = useState<Piece | null>(null);
  const [promotionRequest, setPromotionRequest] =
    useState<PromotionRequest>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [timeline, setTimeline] = useState<GameState[]>([]);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [revealOpponent, setRevealOpponent] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareFeedback, setShareFeedback] = useState('');
  const [matchSelection, setMatchSelection] = useState<MatchSelection>('local');
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoom | null>(null);
  const [onlineRoomCode, setOnlineRoomCode] = useState('');
  const [onlineUid, setOnlineUid] = useState('');
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [onlineAccessStatus, setOnlineAccessStatus] = useState<
    'playing' | 'finished' | null
  >(null);
  const [joinCode, setJoinCode] = useState('');
  const [inviteFeedback, setInviteFeedback] = useState('');
  const autoJoinAttempted = useRef(false);
  const localGuesses = useRef<GameState['guesses']>({});
  const reviewing = reviewIndex !== null;
  const cpuSide = otherSide(humanSide);
  const shownGame = reviewing
    ? (timeline[reviewIndex] ?? game ?? PREVIEW_GAME)
    : (game ?? PREVIEW_GAME);

  const legalTargets = useMemo(() => {
    if (!game || phase !== 'playing' || !selection) return [];
    return selection.kind === 'board'
      ? getLegalMoves(game, selection.from)
      : getDropTargets(game, selection.name, game.turn);
  }, [game, phase, selection]);
  const targetKeys = useMemo(
    () => new Set(legalTargets.map(moveKey)),
    [legalTargets],
  );
  const markAppReady = useCallback((node: HTMLElement | null) => {
    if (node) node.dataset.appReady = 'true';
  }, []);
  const updateSelection = useCallback((next: Selection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        updateSelection(null);
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
  }, [game, phase, updateSelection]);

  const startLocalMatch = useCallback(() => {
    const initial = createInitialGame();
    localGuesses.current = {};
    setGame(initial);
    setTimeline([initial]);
    setViewer(2);
    setGameMode('local');
    updateSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
    setShareFeedback('');
    setPhase('playing');
  }, [updateSelection]);

  const startCpuMatch = useCallback((level: CpuLevel) => {
    preloadCpuPortrait(level);
    preloadCpuResultArtwork(level);
    const nextHumanSide = randomSide();
    const initial = createInitialGame();
    localGuesses.current = {};
    setGame(initial);
    setTimeline([initial]);
    setHumanSide(nextHumanSide);
    setViewer(nextHumanSide);
    setGameMode('cpu');
    setCpuLevel(level);
    updateSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
    setShareFeedback('');
    setPhase(initial.turn === nextHumanSide ? 'playing' : 'cpu-thinking');
  }, [updateSelection]);

  const applyOnlineRoomState = useCallback((room: OnlineRoom, uid: string) => {
    const side =
      room.hostUid === uid
        ? room.hostSide
        : room.guestUid === uid
          ? room.guestSide
          : null;
    if (!side) {
      setOnlineError('この対局には参加していません');
      return;
    }
    const gameWithLocalGuesses = {
      ...room.game,
      guesses: { ...room.game.guesses, ...localGuesses.current },
    };
    setOnlineRoom(room);
    setGame(gameWithLocalGuesses);
    setViewer(side);
    setGameMode('online');
    updateSelection(null);
    setPromotionRequest(null);
    setTimeline(
      room.timeline.map((snapshot, index) =>
        index === room.timeline.length - 1
          ? gameWithLocalGuesses
          : snapshot,
      ),
    );
    setOnlineError('');
    if (!room.guestUid) {
      setPhase('online-lobby');
    } else if (room.game.winner) {
      setResultOpen(true);
      setPhase('finished');
    } else {
      setPhase(room.game.turn === side ? 'playing' : 'online-waiting');
    }
  }, [updateSelection]);

  const startOnlineMatch = useCallback(async () => {
    setOnlineBusy(true);
    setOnlineError('');
    setOnlineAccessStatus(null);
    setInviteFeedback('');
    try {
      const { createOnlineRoom } = await loadOnlineModule();
      const initial = createInitialGame();
      localGuesses.current = {};
      const created = await createOnlineRoom(initial);
      setOnlineRoomCode(created.roomCode);
      setOnlineUid(created.uid);
      setTimeline([initial]);
      setReviewIndex(null);
      setRevealOpponent(false);
      setResultOpen(false);
      setHistoryOpen(false);
      setShareFeedback('');
      applyOnlineRoomState(created.room, created.uid);
    } catch (error) {
      setOnlineError(
        error instanceof Error
          ? error.message
          : '対局部屋を作成できませんでした',
      );
      setPhase('intro');
    } finally {
      setOnlineBusy(false);
    }
  }, [applyOnlineRoomState]);

  const joinOnlineMatch = useCallback(
    async (roomCodeValue: string) => {
      const roomCode = normalizeRoomCode(roomCodeValue);
      setJoinCode(roomCode);
      setOnlineBusy(true);
      setOnlineError('');
      try {
        const { joinOnlineRoom } = await loadOnlineModule();
        const joined = await joinOnlineRoom(roomCode);
        localGuesses.current = {};
        setOnlineRoomCode(joined.roomCode);
        setOnlineUid(joined.uid);
        setTimeline([joined.room.game]);
        setReviewIndex(null);
        setRevealOpponent(false);
        setResultOpen(false);
        setHistoryOpen(false);
        setShareFeedback('');
        applyOnlineRoomState(joined.room, joined.uid);
      } catch (error) {
        if (isOnlineJoinBlockedError(error)) {
          setOnlineAccessStatus(error.reason);
          setOnlineError('');
        } else {
          setOnlineError(
            error instanceof Error
              ? error.message
              : '対局部屋に参加できませんでした',
          );
        }
        setGameMode('local');
        setPhase('intro');
        setMatchSelection('online');
      } finally {
        setOnlineBusy(false);
      }
    },
    [applyOnlineRoomState],
  );

  useEffect(() => {
    if (autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    const roomCode = normalizeRoomCode(
      new URLSearchParams(window.location.search).get('room') ?? '',
    );
    if (!roomCode) return;
    const timer = window.setTimeout(() => void joinOnlineMatch(roomCode), 0);
    return () => window.clearTimeout(timer);
  }, [joinOnlineMatch]);

  useEffect(() => {
    if (gameMode !== 'online' || !onlineRoomCode || !onlineUid) return;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void loadOnlineModule()
      .then(({ subscribeOnlineRoom }) => {
        if (stopped) return;
        unsubscribe = subscribeOnlineRoom(
          onlineRoomCode,
          (room) => applyOnlineRoomState(room, onlineUid),
          (message) => setOnlineError(message),
        );
      })
      .catch((error: unknown) => {
        if (!stopped)
          setOnlineError(
            error instanceof Error
              ? error.message
              : '対局へ接続できませんでした',
          );
      });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }, [applyOnlineRoomState, gameMode, onlineRoomCode, onlineUid]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'start_local_shadow_shogi_match',
          title: '影将棋の二人対局を始める',
          description:
            '盤面をランダム生成し、この端末で先手から二人対局を開始します。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: (input: Record<string, unknown> = {}) => {
            if (Object.keys(input).length > 0)
              throw new Error('この操作には入力項目はありません');
            startLocalMatch();
            return {
              status: 'started',
              turn: '先手',
              mode: 'local_two_player',
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    void Promise.resolve(
      context.registerTool(
        {
          name: 'start_shadow_shogi_cpu_match',
          title: '影将棋のCPU対局を始める',
          description:
            '初級・中級・最強から選び、このブラウザだけでCPU対局を開始します。',
          inputSchema: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: ['easy', 'normal', 'hard'] },
            },
            required: ['level'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: (input: { level?: string } = {}) => {
            const keys = Object.keys(input);
            if (
              keys.length !== 1 ||
              keys[0] !== 'level' ||
              !['easy', 'normal', 'hard'].includes(input.level ?? '')
            ) {
              throw new Error(
                'level は easy・normal・hard のいずれかで指定してください',
              );
            }
            const level =
              input.level === 'easy' ? 1 : input.level === 'hard' ? 3 : 2;
            startCpuMatch(level);
            return {
              status: 'started',
              turn: '先手',
              mode: 'cpu',
              level: input.level,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [startCpuMatch, startLocalMatch]);

  useEffect(() => {
    if (
      gameMode !== 'cpu' ||
      phase !== 'cpu-thinking' ||
      !game ||
      game.winner ||
      game.turn !== cpuSide
    )
      return;
    let worker: Worker | null = null;
    let settled = false;

    const finishCpuTurn = (decision: CpuDecision) => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      worker = null;
      if (!decision.action) {
        setPhase('playing');
        return;
      }
      const next = applyCpuAction(game, decision.action);
      setGame(next);
      setTimeline((current) => [...current, next]);
      if (next.winner) setResultOpen(true);
      setPhase(next.winner ? 'finished' : 'playing');
    };

    const thinkOnMainThread = () => {
      finishCpuTurn(chooseCpuAction(game, cpuLevel, cpuSide));
    };

    const timer = window.setTimeout(
      () => {
        try {
          worker = new Worker(
            new URL('../lib/shadow-shogi-ai.worker.ts', import.meta.url),
            { type: 'module' },
          );
          worker.onmessage = ({ data }: MessageEvent<CpuDecision>) => finishCpuTurn(data);
          worker.onerror = () => {
            worker?.terminate();
            worker = null;
            thinkOnMainThread();
          };
          worker.postMessage({ state: game, level: cpuLevel, side: cpuSide });
        } catch {
          thinkOnMainThread();
        }
      },
      cpuLevel === 3 ? 360 : 620,
    );
    return () => {
      settled = true;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [cpuLevel, cpuSide, game, gameMode, phase]);

  function resetToIntro() {
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${window.location.hash}`,
      );
    }
    setGame(null);
    setHumanSide(2);
    setViewer(2);
    setGameMode('local');
    updateSelection(null);
    setGuessTarget(null);
    setPromotionRequest(null);
    setTimeline([]);
    setReviewIndex(null);
    setRevealOpponent(false);
    setResultOpen(false);
    setHistoryOpen(false);
    setShareFeedback('');
    setOnlineRoom(null);
    setOnlineRoomCode('');
    setOnlineUid('');
    setOnlineBusy(false);
    setOnlineError('');
    setOnlineAccessStatus(null);
    setJoinCode('');
    setInviteFeedback('');
    localGuesses.current = {};
    setMatchSelection('local');
    setPhase('intro');
  }

  async function completeMove(next: GameState) {
    setGame(next);
    setTimeline((current) => [...current, next]);
    updateSelection(null);
    setPromotionRequest(null);
    setGuessTarget(null);
    if (gameMode === 'online') {
      const expectedRevision = onlineRoom?.revision;
      if (!onlineRoomCode || expectedRevision === undefined) {
        setOnlineError('対局部屋との接続が切れました');
        return;
      }
      setPhase(next.winner ? 'finished' : 'online-waiting');
      if (next.winner) setResultOpen(true);
      try {
        const { commitOnlineGame } = await loadOnlineModule();
        const room = await commitOnlineGame(
          onlineRoomCode,
          expectedRevision,
          viewer,
          next,
          onlineRoom,
        );
        applyOnlineRoomState(room, onlineUid);
      } catch (error) {
        setOnlineError(
          error instanceof Error ? error.message : '着手を送信できませんでした',
        );
        if (onlineRoom) applyOnlineRoomState(onlineRoom, onlineUid);
      }
      return;
    }
    if (next.winner) {
      setResultOpen(true);
      setPhase('finished');
    } else if (gameMode === 'cpu') {
      setViewer(humanSide);
      setPhase(next.turn === cpuSide ? 'cpu-thinking' : 'playing');
    } else {
      setPhase('handoff');
    }
  }

  function commitBoardMove(from: Position, to: Position, promote: boolean) {
    if (!game) return;
    void completeMove(applyBoardMove(game, from, to, promote));
  }

  function clickSquare(position: Position) {
    if (!game) return;
    const piece = game.board[position[0]][position[1]];
    const activeSelection = selectionRef.current;
    const canPlay = phase === 'playing' && viewer === game.turn;
    const canInspectWhileWaiting =
      (gameMode === 'cpu' && phase === 'cpu-thinking') ||
      (gameMode === 'online' && phase === 'online-waiting');
    if (!canPlay) {
      if (canInspectWhileWaiting && piece && piece.side !== viewer)
        setGuessTarget(piece);
      return;
    }
    const legalTarget = activeSelection
      ? (activeSelection.kind === 'board'
          ? getLegalMoves(game, activeSelection.from)
          : getDropTargets(game, activeSelection.name, game.turn)
        ).some((target) => isSamePosition(target, position))
      : false;

    if (activeSelection && legalTarget) {
      if (activeSelection.kind === 'hand') {
        void completeMove(applyDrop(game, activeSelection.name, position));
        return;
      }
      const movingPiece =
        game.board[activeSelection.from[0]][activeSelection.from[1]];
      if (!movingPiece) return;
      if (mustPromote(movingPiece.name, movingPiece.side, position)) {
        commitBoardMove(activeSelection.from, position, true);
      } else if (
        canPromote(
          movingPiece.name,
          movingPiece.side,
          activeSelection.from,
          position,
        )
      ) {
        setPromotionRequest({ from: activeSelection.from, to: position });
      } else {
        commitBoardMove(activeSelection.from, position, false);
      }
      return;
    }

    if (piece?.side === viewer) {
      if (
        activeSelection?.kind === 'board' &&
        isSamePosition(activeSelection.from, position)
      ) {
        updateSelection(null);
      } else {
        updateSelection({ kind: 'board', from: position });
      }
      return;
    }
    if (piece && piece.side !== viewer) {
      setGuessTarget(piece);
      return;
    }
    updateSelection(null);
  }

  function selectHand(name: HandPieceName) {
    if (
      !game ||
      phase !== 'playing' ||
      game.turn !== viewer ||
      game.hands[viewer][name] < 1
    )
      return;
    if (
      selectionRef.current?.kind === 'hand' &&
      selectionRef.current.name === name
    )
      updateSelection(null);
    else updateSelection({ kind: 'hand', name });
  }

  function saveGuess(guess: GuessName) {
    if (!game || !guessTarget) return;
    localGuesses.current = {
      ...localGuesses.current,
      [guessTarget.id]: guess,
    };
    const guessed = withGuess(game, guessTarget.id, guess);
    setGame(guessed);
    setTimeline((current) =>
      current.length > 0 ? [...current.slice(0, -1), guessed] : current,
    );
    setGuessTarget(null);
  }

  function openReview(moveNumber: number) {
    if (
      (gameMode !== 'cpu' && gameMode !== 'online') ||
      phase !== 'finished' ||
      timeline.length === 0
    )
      return;
    setReviewIndex(Math.max(0, Math.min(moveNumber, timeline.length - 1)));
    if (!reviewing) setRevealOpponent(false);
    setResultOpen(false);
  }

  function selectHistoryMove(moveNumber: number) {
    if (
      (gameMode !== 'cpu' && gameMode !== 'online') ||
      phase !== 'finished'
    )
      return;
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
    if (matchSelection === 'online') {
      void startOnlineMatch();
      return;
    }
    startCpuMatch(Number(matchSelection.slice(-1)) as CpuLevel);
  }

  async function copyOnlineInvite() {
    if (!onlineRoomCode) return;
    try {
      await navigator.clipboard.writeText(onlineInviteUrl(onlineRoomCode));
      setInviteFeedback('招待URLをコピーしました');
    } catch {
      setInviteFeedback(`部屋番号: ${onlineRoomCode}`);
    }
  }

  async function shareOnlineInvite() {
    if (!onlineRoomCode) return;
    const url = onlineInviteUrl(onlineRoomCode);
    if (navigator.share) {
      try {
        await navigator.share({
          title: '影将棋の対局招待',
          text: `部屋番号 ${onlineRoomCode} で対局しましょう。`,
          url,
        });
        setInviteFeedback('対局招待を共有しました');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
      }
    }
    await copyOnlineInvite();
  }

  function resultShareDetails() {
    const playerWon =
      gameMode === 'cpu'
        ? game?.winner === humanSide
        : gameMode === 'online'
          ? game?.winner === viewer
          : Boolean(game?.winner);
    const configuredSiteUrl = import.meta.env.VITE_PUBLIC_SITE_URL?.replace(
      /\/$/,
      '',
    );
    const url =
      window.location.hostname === 'localhost' && configuredSiteUrl
        ? configuredSiteUrl
        : `${window.location.origin}${window.location.pathname}`;
    const text =
      gameMode === 'cpu'
        ? playerWon
          ? `影将棋で${cpuLevelInfo.name}に勝利！影の正体を読み切って王を捕らえました。 #影将棋`
          : `影将棋で${cpuLevelInfo.name}に挑戦。次こそ影の中から王を見つける！ #影将棋`
        : gameMode === 'online'
          ? playerWon
            ? '影将棋のネット対戦で勝利！影の中から王を見つけました。 #影将棋'
            : '影将棋のネット対戦で対局しました。影の動きから王を探す将棋ゲーム。 #影将棋'
          : `影将棋で対局しました。影の動きから王を探す将棋ゲーム。 #影将棋`;
    return { text, url };
  }

  async function shareResult() {
    const details = resultShareDetails();
    const shareData: ShareData = {
      title: '影将棋 | Shadow Shogi',
      text: details.text,
      url: details.url,
    };

    if (navigator.share) {
      try {
        if (resultArtwork) {
          const response = await fetch(resultArtwork);
          const blob = await response.blob();
          const file = new File(
            [blob],
            `shadow-shogi-${cpuLevelInfo.slug}-${playerWon ? 'win' : 'loss'}.webp`,
            { type: blob.type || 'image/webp' },
          );
          const imageShare = { ...shareData, files: [file] };
          if (!navigator.canShare || navigator.canShare(imageShare)) {
            await navigator.share(imageShare);
            setShareFeedback('結果画像を共有しました');
            return;
          }
        }
        await navigator.share(shareData);
        setShareFeedback('対局結果を共有しました');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
      }
    }

    try {
      await navigator.clipboard.writeText(`${details.text}\n${details.url}`);
      setShareFeedback('共有文とURLをコピーしました');
    } catch {
      setShareFeedback('Xで共有ボタンから投稿できます');
    }
  }

  function shareResultOnX() {
    const details = resultShareDetails();
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(details.text)}&url=${encodeURIComponent(details.url)}`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  const opponent = otherSide(viewer);
  const cpuLevelInfo =
    CPU_LEVELS.find((item) => item.level === cpuLevel) ?? CPU_LEVELS[1];
  const playerLabel = (side: Side) =>
    gameMode === 'cpu' && side === cpuSide
      ? 'CPU'
      : gameMode === 'online'
        ? side === viewer
          ? 'あなた'
          : '相手'
        : sideLabel(side);
  const opponentLabel =
    gameMode === 'cpu'
      ? `CPU・${cpuLevelInfo.name}`
      : gameMode === 'online'
        ? '対戦相手'
        : sideLabel(opponent);
  const selectedText =
    selection?.kind === 'board'
      ? `${shownGame.board[selection.from[0]][selection.from[1]]?.name ?? ''}を選択中`
      : selection?.kind === 'hand'
        ? `${selection.name}を打つ場所を選択中`
        : '自分の駒を選んでください';
  const lastReviewIndex = Math.max(0, timeline.length - 1);
  const currentReviewMove = reviewing ? shownGame.lastMove : null;
  const canReview =
    (gameMode === 'cpu' || gameMode === 'online') &&
    phase === 'finished' &&
    timeline.length > 0;
  const resultTitle =
    gameMode === 'cpu'
      ? game?.winner === humanSide
        ? 'あなたの勝ち'
        : 'あなたの負け'
      : gameMode === 'online'
        ? game?.winner === viewer
          ? 'あなたの勝ち'
          : 'あなたの負け'
        : game?.winner
          ? `${sideLabel(game.winner)}の勝利`
          : '';
  const playerWon =
    gameMode === 'cpu'
      ? game?.winner === humanSide
      : gameMode === 'online' && game?.winner === viewer;
  const resultArtwork =
    gameMode === 'cpu' && game?.winner
      ? cpuLevelInfo.artwork.result[playerWon ? 'win' : 'loss']
      : null;
  const resultQuote =
    gameMode === 'cpu' && game?.winner
      ? playerWon
        ? cpuLevelInfo.winQuote
        : cpuLevelInfo.lossQuote
      : null;
  const resultDescriptionParts =
    gameMode === 'cpu' && game?.winner === cpuSide
      ? [
          'あなたの王が',
          '影の中から見つかりました。',
          '盤面を開いて、',
          '捕まった一手を確認できます。',
        ]
      : gameMode === 'online' && game?.winner !== viewer
        ? [
            'あなたの王が',
            '影の中から見つかりました。',
            '盤面を開いて、',
            '最後の一手まで確認できます。',
          ]
        : ['相手の王を', '捕らえました。'];
  const selectedCpuLevel = matchSelection.startsWith('cpu-')
    ? (Number(matchSelection.slice(-1)) as CpuLevel)
    : null;
  const selectedCpu = selectedCpuLevel
    ? (CPU_LEVELS.find((item) => item.level === selectedCpuLevel) ?? null)
    : null;
  const homeTitle =
    matchSelection === 'local'
      ? '同じ盤を、ふたりで囲む。'
      : matchSelection === 'online'
        ? '遠くの影と、つながる。'
        : `${selectedCpu?.name ?? ''}に挑む。`;
  const homeDescription =
    matchSelection === 'local'
      ? '一台の端末を手渡しながら遊ぶ、影将棋の基本対局。'
      : matchSelection === 'online'
        ? '招待URLを送るだけ。匿名のまま、すぐに二人対局を始められます。'
        : (selectedCpu?.description ?? '');

  return (
    <main
      ref={markAppReady}
      className={`game-page ${phase === 'handoff' ? 'handoff-active' : ''} ${reviewing ? 'review-active' : ''}`}
      data-phase={phase}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-piece">影</span>
          <div>
            <p className="brand-kicker">SHADOW SHOGI</p>
            <h1>影将棋</h1>
          </div>
        </div>
        <p className="tagline">その一手が、正体を語る。</p>
        <nav className="top-actions" aria-label="ゲーム操作">
          <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)}>
            <BookOpen /> 遊び方
          </Button>
          <Button variant="outline" size="sm" onClick={resetToIntro}>
            <RotateCcw /> 新しい対局
          </Button>
        </nav>
      </header>

      <section
        className={`game-stage ${phase === 'intro' ? 'home-stage' : ''}`}
        aria-hidden={phase === 'handoff'}
      >
        {phase === 'intro' ? (
          <section className="home-screen" aria-label="対局方法の選択">
            <div className="home-selection-visual" key={matchSelection}>
              <div className="home-visual-glow" />
              {selectedCpu ? (
                <div
                  className={`home-character portrait-${selectedCpu.level}`}
                  aria-hidden="true"
                />
              ) : (
                <div
                  className={`home-mode-visual ${matchSelection === 'online' ? 'online' : ''}`}
                  aria-hidden="true"
                >
                  <span className="home-mode-ring" />
                  {matchSelection === 'online' ? <Globe2 /> : <Users />}
                  <i className="home-orbit-piece">影</i>
                </div>
              )}
              <div className="home-visual-copy">
                <p className="section-label">SELECT YOUR MATCH</p>
                <span className="home-visual-badge">
                  {selectedCpu?.badge ??
                    (matchSelection === 'online'
                      ? 'ONLINE MATCH'
                      : 'LOCAL MATCH')}
                </span>
                <h2>{homeTitle}</h2>
                <p>{homeDescription}</p>
              </div>
            </div>

            <div className="home-menu-row home-local-row" aria-label="二人対局">
              <button
                type="button"
                className={matchSelection === 'local' ? 'selected' : ''}
                aria-pressed={matchSelection === 'local'}
                onClick={() => setMatchSelection('local')}
              >
                <span className="home-option-icon">
                  <Users />
                </span>
                <span>
                  <strong>二人対局</strong>
                  <small>ローカル</small>
                </span>
              </button>
              <button
                type="button"
                className={matchSelection === 'online' ? 'selected' : ''}
                aria-pressed={matchSelection === 'online'}
                onClick={() => setMatchSelection('online')}
              >
                <span className="home-option-icon">
                  <Globe2 />
                </span>
                <span>
                  <strong>二人対局</strong>
                  <small>ネット対戦</small>
                </span>
              </button>
            </div>

            <div className="home-menu-row home-cpu-row" aria-label="CPU対局">
              {CPU_LEVELS.map((item) => {
                const value = `cpu-${item.level}` as MatchSelection;
                return (
                  <button
                    type="button"
                    className={matchSelection === value ? 'selected' : ''}
                    aria-pressed={matchSelection === value}
                    key={item.level}
                    onPointerEnter={() => preloadCpuPortrait(item.level)}
                    onFocus={() => preloadCpuPortrait(item.level)}
                    onClick={() => {
                      preloadCpuPortrait(item.level);
                      setMatchSelection(value);
                    }}
                  >
                    <span
                      className={`home-cpu-avatar portrait-${item.level}`}
                      aria-hidden="true"
                    />
                    <span>
                      <small>CPU対局</small>
                      <strong>vs {item.name}</strong>
                    </span>
                    <em>LV.{item.level}</em>
                  </button>
                );
              })}
            </div>

            {matchSelection === 'online' ? (
              <form
                className="online-join-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void joinOnlineMatch(joinCode);
                }}
              >
                <label htmlFor="online-room-code">
                  <Link2 /> 招待された部屋へ参加
                </label>
                <div>
                  <Input
                    id="online-room-code"
                    value={joinCode}
                    maxLength={8}
                    autoComplete="off"
                    inputMode="text"
                    placeholder="8文字の部屋番号"
                    onChange={(event) =>
                      setJoinCode(normalizeRoomCode(event.target.value))
                    }
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={onlineBusy || joinCode.length !== 8}
                  >
                    参加
                  </Button>
                </div>
              </form>
            ) : null}

            <Button
              className="home-start-button"
              disabled={onlineBusy}
              onClick={startSelectedMatch}
            >
              {onlineBusy ? (
                <>
                  <LoaderCircle className="online-spinner" /> 接続しています
                </>
              ) : matchSelection === 'online' ? (
                <>
                  <Globe2 /> 新しい対局部屋を作る
                </>
              ) : (
                <>
                  <Swords /> この対局を開始
                </>
              )}
            </Button>
            {onlineError ? (
              <p className="online-error" role="alert">
                {onlineError}
              </p>
            ) : null}
            <p className="home-footnote">
              {matchSelection === 'online' ? (
                <>
                  <Wifi /> 匿名接続・アカウント登録不要
                </>
              ) : (
                <>
                  <Gamepad2 /> 対局処理はすべてこの端末内で動作します
                </>
              )}
            </p>
          </section>
        ) : null}
        <aside className="side-panel intro-panel">
          <p className="section-label">SHADOW TACTICS</p>
          <h2>
            影を読み、
            <br />
            王を探せ。
          </h2>
          <p className="lead">
            相手の駒はすべて影。動き方を観察し、予想マークを更新しながら、正体の分からない王を捕らえます。
          </p>
          <div className="rule-card">
            <Eye />
            <div>
              <strong>影をタップして予想</strong>
              <span>確定・未確定の2段階で記録</span>
            </div>
          </div>
          <div className="rule-card">
            <ShieldQuestion />
            <div>
              <strong>王手・詰み判定なし</strong>
              <span>王を実際に取れば勝利</span>
            </div>
          </div>
          {game ? (
            <div className="history-panel">
              <p className="section-label">MOVE LOG</p>
              {game.moveHistory.length === 0 ? (
                <p className="empty-copy">まだ指し手はありません</p>
              ) : (
                game.moveHistory
                  .slice(-6)
                  .reverse()
                  .map((move, index) => (
                    <div
                      className="history-row"
                      key={`${move.pieceId}-${game.moveHistory.length - index}`}
                    >
                      <span>{game.moveHistory.length - index}</span>
                      <strong>{playerLabel(move.side)}</strong>
                      <span>
                        {move.from
                          ? `${boardCoordinates(move.from)} → ${boardCoordinates(move.to)}`
                          : `${boardCoordinates(move.to)} 打`}
                      </span>
                    </div>
                  ))
              )}
            </div>
          ) : null}
        </aside>

        <section className="board-column" aria-label="影将棋の盤面">
          <div className="captured-zone opponent-zone">
            <div className="zone-heading">
              <div>
                {gameMode === 'cpu' ? (
                  <span
                    className={`opponent-cpu-avatar portrait-${cpuLevelInfo.level}`}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="mini-piece">影</span>
                )}
                <p>
                  <strong>{opponentLabel}</strong>
                  <small>
                    {reviewing && revealOpponent
                      ? 'リプレイで正体を表示中'
                      : '持ち駒の種類は非公開'}
                  </small>
                </p>
              </div>
              <span className="shadow-count">
                合計 {handTotal(shownGame.hands[opponent])} 枚
              </span>
            </div>
            {reviewing && revealOpponent ? (
              <div
                className="review-opponent-hand"
                aria-label="相手の持ち駒の正体"
              >
                {HAND_NAMES.filter(
                  (name) => shownGame.hands[opponent][name] > 0,
                ).map((name) => (
                  <span className="review-hand-piece" key={name}>
                    <PieceFace
                      label={name}
                      tone="light"
                      className="hand-piece-face enemy-piece"
                    />
                    <small>×{shownGame.hands[opponent][name]}</small>
                  </span>
                ))}
                {handTotal(shownGame.hands[opponent]) === 0 ? (
                  <span className="opponent-hand-empty">持ち駒なし</span>
                ) : null}
              </div>
            ) : (
              <div
                className="opponent-hand-hidden"
                aria-label={`相手の持ち駒は合計${handTotal(shownGame.hands[opponent])}枚。種類は非公開です。`}
              >
                <ShieldQuestion />
                <span>相手の持ち駒は合計だけ表示されます</span>
              </div>
            )}
          </div>

          <div className="board-frame">
            <div className="file-labels" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <span key={index}>{viewer === 2 ? 9 - index : index + 1}</span>
              ))}
            </div>
            <div className="board-grid">
              {Array.from({ length: 81 }, (_, displayIndex) => {
                const displayRow = Math.floor(displayIndex / 9);
                const displayColumn = displayIndex % 9;
                const position = boardPosition(
                  displayRow,
                  displayColumn,
                  viewer,
                );
                const piece = shownGame.board[position[0]][position[1]];
                const selected =
                  selection?.kind === 'board' &&
                  isSamePosition(selection.from, position);
                const target = targetKeys.has(moveKey(position));
                const last =
                  shownGame.lastMove &&
                  (isSamePosition(shownGame.lastMove.to, position) ||
                    Boolean(
                      shownGame.lastMove.from &&
                      isSamePosition(shownGame.lastMove.from, position),
                    ));
                const label = piece
                  ? piece.side === viewer || revealOpponent
                    ? piece.name
                    : `${displayName(shownGame.guesses[piece.id])}の予想`
                  : '空き升';
                return (
                  <button
                    className={`board-square ${selected ? 'selected-square' : ''} ${target ? 'legal-square' : ''} ${last ? 'last-square' : ''}`}
                    type="button"
                    disabled={reviewing}
                    data-display-cell={`${displayRow}-${displayColumn}`}
                    data-legal-target={target || undefined}
                    key={displayIndex}
                    onClick={() => clickSquare(position)}
                    aria-label={`${9 - position[1]}筋${position[0] + 1}段 ${label}`}
                  >
                    {piece ? (
                      <PieceGlyph
                        piece={piece}
                        viewer={viewer}
                        guess={shownGame.guesses[piece.id]}
                        revealOpponent={reviewing && revealOpponent}
                      />
                    ) : null}
                    {target ? (
                      <span
                        className={`move-dot ${piece ? 'capture-dot' : ''}`}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="rank-labels" aria-hidden="true">
              {(viewer === 2
                ? ['一', '二', '三', '四', '五', '六', '七', '八', '九']
                : ['九', '八', '七', '六', '五', '四', '三', '二', '一']
              ).map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>

          {reviewing ? (
            <section className="replay-dock" aria-label="棋譜の振り返り操作">
              <div className="replay-dock-heading">
                <span>対局を振り返る</span>
                <strong>
                  {reviewIndex} / {lastReviewIndex}手
                </strong>
              </div>
              <div className="review-step-buttons">
                <button
                  type="button"
                  disabled={reviewIndex === 0}
                  onClick={() => setReviewIndex(0)}
                >
                  最初
                </button>
                <button
                  type="button"
                  disabled={reviewIndex === 0}
                  onClick={() =>
                    setReviewIndex((current) => Math.max(0, (current ?? 0) - 1))
                  }
                >
                  前へ
                </button>
                <button
                  type="button"
                  disabled={reviewIndex === lastReviewIndex}
                  onClick={() =>
                    setReviewIndex((current) =>
                      Math.min(lastReviewIndex, (current ?? 0) + 1),
                    )
                  }
                >
                  次へ
                </button>
                <button
                  type="button"
                  disabled={reviewIndex === lastReviewIndex}
                  onClick={() => setReviewIndex(lastReviewIndex)}
                >
                  最後
                </button>
              </div>
              <div className="replay-slider-row">
                <span>0</span>
                <input
                  type="range"
                  min={0}
                  max={lastReviewIndex}
                  value={reviewIndex}
                  onChange={(event) =>
                    setReviewIndex(Number(event.target.value))
                  }
                  aria-label="表示する手数"
                />
                <span>{lastReviewIndex}</span>
              </div>
              <div className="replay-dock-actions">
                <button
                  type="button"
                  className={`reveal-toggle ${revealOpponent ? 'active' : ''}`}
                  onClick={() => setRevealOpponent((visible) => !visible)}
                >
                  {revealOpponent ? <EyeOff /> : <Eye />}
                  <span>
                    <strong>
                      {revealOpponent
                        ? '相手の駒を影に戻す'
                        : '相手の駒の正体を表示'}
                    </strong>
                    <small>盤上と持ち駒を切り替え</small>
                  </span>
                </button>
                <Button
                  variant="outline"
                  className="review-result-button"
                  onClick={closeReview}
                >
                  対局結果に戻る
                </Button>
              </div>
            </section>
          ) : null}

          <div className="captured-zone own-zone">
            <div className="zone-heading">
              <div>
                <span className="mini-piece gold">王</span>
                <p>
                  <strong>{sideLabel(viewer)}・あなた</strong>
                  <small>
                    {phase === 'playing'
                      ? selectedText
                      : phase === 'cpu-thinking'
                        ? 'CPUの手番・影の予想はできます'
                        : phase === 'online-lobby'
                          ? '相手の参加を待っています'
                          : phase === 'online-waiting'
                            ? '相手の手番・影の予想はできます'
                            : '手番を待っています'}
                  </small>
                </p>
              </div>
              <span className="turn-pill">
                {phase === 'playing'
                  ? '手番'
                  : phase === 'cpu-thinking'
                    ? '思考中'
                    : phase === 'online-lobby'
                      ? '参加待ち'
                      : '待機'}
              </span>
            </div>
            <div className="hand-list" aria-label="持ち駒">
              {HAND_NAMES.map((name) => {
                const count = shownGame.hands[viewer][name];
                const active =
                  selection?.kind === 'hand' && selection.name === name;
                return (
                  <button
                    type="button"
                    key={name}
                    aria-label={`${name}を打つ（${count}枚）`}
                    disabled={!game || count < 1 || phase !== 'playing'}
                    className={`hand-piece ${active ? 'active' : ''}`}
                    onClick={() => selectHand(name)}
                  >
                    <PieceFace
                      label={name}
                      tone="light"
                      className="hand-piece-face"
                    />
                    <small>×{count}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <ActivityLog
            className="mobile-activity-log"
            state={shownGame}
            viewer={gameMode === 'cpu' ? humanSide : viewer}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        </section>

        <aside className="side-panel control-panel">
          {phase === 'intro' ? (
            <>
              <p className="section-label">SELECT MATCH</p>
              <h3>対局方法を選ぶ</h3>
              <p>
                一台での二人対局に加え、ブラウザだけで動く3段階のCPUと対局できます。
              </p>
              <Button className="start-button" onClick={startLocalMatch}>
                <Users /> 二人で対局する
              </Button>
              <div className="cpu-picker-heading">
                <Bot />
                <span>CPUと対局</span>
              </div>
              <div className="cpu-level-grid">
                {CPU_LEVELS.map((item) => (
                  <button
                    type="button"
                    key={item.level}
                    onPointerEnter={() => preloadCpuPortrait(item.level)}
                    onFocus={() => preloadCpuPortrait(item.level)}
                    onClick={() => startCpuMatch(item.level)}
                  >
                    <span className="cpu-level-number">{item.level}</span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.badge}</small>
                    </span>
                    <em>{item.description}</em>
                  </button>
                ))}
              </div>
              <dl className="setup-list">
                <div>
                  <dt>盤面</dt>
                  <dd>9 × 9</dd>
                </div>
                <div>
                  <dt>初期配置</dt>
                  <dd>毎局ランダム</dd>
                </div>
                <div>
                  <dt>CPU処理</dt>
                  <dd>端末内で完結</dd>
                </div>
              </dl>
            </>
          ) : reviewing ? (
            <>
              <p className="section-label">GAME REVIEW</p>
              <h3>
                {reviewIndex}手目 / {lastReviewIndex}手
              </h3>
              <p className="review-description">
                {currentReviewMove
                  ? actionLogText(
                      currentReviewMove,
                      gameMode === 'cpu' ? humanSide : viewer,
                    )
                  : '対局開始時の配置です。'}
              </p>
              <ActivityLog
                className="control-activity-log"
                state={shownGame}
                viewer={gameMode === 'cpu' ? humanSide : viewer}
                onOpenHistory={() => setHistoryOpen(true)}
              />
            </>
          ) : (
            <>
              <p className="section-label">
                {gameMode === 'cpu'
                  ? `${cpuLevelInfo.badge} CPU`
                  : gameMode === 'online'
                    ? 'ONLINE MATCH'
                    : 'CURRENT TURN'}
              </p>
              <h3>
                {phase === 'cpu-thinking'
                  ? 'CPUが思考中'
                  : phase === 'online-lobby'
                    ? '対戦相手を待っています'
                    : `${playerLabel(game?.turn ?? viewer)}の手番`}
              </h3>
              <p>
                {gameMode === 'cpu'
                  ? phase === 'cpu-thinking'
                    ? `${cpuLevelInfo.description} 待っている間も相手の影を押して予想できます。`
                    : cpuLevelInfo.description
                  : gameMode === 'online'
                    ? phase === 'playing'
                      ? 'あなたの手番です。着手すると相手の盤面へすぐ同期されます。'
                      : '相手の着手を待っています。待っている間も相手の影を押して予想できます。'
                    : '自分の駒を選ぶと移動可能な升が光ります。相手の影を選ぶと予想を記録できます。'}
              </p>
              {gameMode === 'online' ? (
                <div className="online-room-status">
                  <Wifi />
                  <span>
                    <small>部屋番号</small>
                    <strong>{onlineRoomCode}</strong>
                  </span>
                </div>
              ) : null}
              {gameMode === 'cpu' ? (
                <div
                  className={`cpu-thinking ${phase === 'cpu-thinking' ? 'is-active' : ''}`}
                  aria-hidden={phase !== 'cpu-thinking'}
                >
                  <BrainCircuit />
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              {gameMode === 'online' && onlineError ? (
                <p className="online-error" role="alert">
                  {onlineError}
                </p>
              ) : null}
              <ActivityLog
                className="control-activity-log"
                state={shownGame}
                viewer={viewer}
                onOpenHistory={() => setHistoryOpen(true)}
              />
              <button
                type="button"
                className="tip-card"
                onClick={() => setRulesOpen(true)}
              >
                <CircleHelp />
                <span>
                  <strong>ルールを確認</strong>
                  <small>成り・持ち駒・二歩について</small>
                </span>
              </button>
            </>
          )}
        </aside>
      </section>

      {phase === 'handoff' && game ? (
        <dialog
          open
          className="handoff-screen"
          aria-modal="true"
          aria-labelledby="handoff-title"
        >
          <span className="handoff-piece">影</span>
          <p className="section-label">PASS THE DEVICE</p>
          <h2 id="handoff-title">
            {sideLabel(game.turn)}番に
            <br />
            渡してください
          </h2>
          <p>
            盤面と両者の持ち駒を隠しています。端末を渡してから、次のプレイヤーだけが開いてください。
          </p>
          <Button
            className="handoff-button"
            onClick={() => {
              setViewer(game.turn);
              setPhase('playing');
            }}
          >
            準備できたら盤面を見る
          </Button>
          <small>Enter キーでも進めます</small>
        </dialog>
      ) : null}

      <Dialog
        open={gameMode === 'online' && phase === 'online-lobby'}
        onOpenChange={() => undefined}
      >
        <DialogContent
          showCloseButton={false}
          className="online-lobby-dialog sm:max-w-md"
        >
          <div className="online-lobby-icon">
            <Globe2 />
            <span />
          </div>
          <DialogHeader>
            <DialogTitle>対戦相手を招待</DialogTitle>
            <DialogDescription>
              招待URLを送るか、8文字の部屋番号を伝えてください。相手が参加すると自動で始まります。
            </DialogDescription>
          </DialogHeader>
          <div
            className="online-room-code"
            aria-label={`部屋番号 ${onlineRoomCode}`}
          >
            {onlineRoomCode.split('').map((character, index) => (
              <span key={`${character}-${index}`}>{character}</span>
            ))}
          </div>
          <div className="online-waiting-line">
            <LoaderCircle />
            <span>相手の参加を待っています</span>
          </div>
          <div className="online-invite-actions">
            <Button onClick={() => void shareOnlineInvite()}>
              <Share2 /> 招待を共有
            </Button>
            <Button variant="outline" onClick={() => void copyOnlineInvite()}>
              <Copy /> URLをコピー
            </Button>
          </div>
          <p className="share-feedback" aria-live="polite">
            {inviteFeedback}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={resetToIntro}>
              キャンセルして戻る
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={onlineAccessStatus !== null} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className="online-lobby-dialog sm:max-w-md"
        >
          <div className="online-lobby-icon">
            <LockKeyhole />
            <span />
          </div>
          <DialogHeader>
            <DialogTitle>
              {onlineAccessStatus === 'finished'
                ? 'この対局は終了しています'
                : 'この対局は対戦中です'}
            </DialogTitle>
            <DialogDescription>
              {onlineAccessStatus === 'finished'
                ? '終了した対局には参加できません。新しい部屋を作成してください。'
                : 'すでに二人の参加者が確定しています。このリンクから途中参加・操作はできません。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={resetToIntro}>タイトルへ戻る</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(guessTarget)}
        onOpenChange={(open) => {
          if (!open) setGuessTarget(null);
        }}
      >
        <DialogContent className="guess-dialog sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>この影の正体を予想</DialogTitle>
            <DialogDescription>
              これまでに見せた動きから、駒の種類をマークします。未確定なら「?」付きで残せます。
            </DialogDescription>
          </DialogHeader>
          <div className="guess-layout">
            <div>
              <p className="dialog-label">
                <Footprints /> 今までの移動
              </p>
              <MoveTrace
                moves={
                  guessTarget && game
                    ? (game.moveLogs[guessTarget.id] ?? [])
                    : []
                }
              />
            </div>
            <div className="guess-choices">
              <p className="dialog-label">確定予想</p>
              <div className="guess-grid">
                {GUESS_NAMES.map((name) => (
                  <button
                    type="button"
                    key={name}
                    aria-label={`${name}に確定`}
                    onClick={() => saveGuess(name)}
                  >
                    <PieceFace
                      label={name}
                      tone="shadow"
                      className="guess-piece-face"
                    />
                  </button>
                ))}
              </div>
              <p className="dialog-label">まだ自信がない</p>
              <div className="guess-grid uncertain-grid">
                {GUESS_NAMES.map((name) => (
                  <button
                    type="button"
                    key={name}
                    aria-label={`${name}かもしれない`}
                    onClick={() => saveGuess(`${name}?` as GuessName)}
                  >
                    <PieceFace
                      label={name}
                      tone="shadow"
                      className="guess-piece-face"
                      uncertain
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => saveGuess('?')}>
              予想を消す
            </Button>
            <Button variant="ghost" onClick={() => setGuessTarget(null)}>
              戻る
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(promotionRequest)}
        onOpenChange={(open) => {
          if (!open) setPromotionRequest(null);
        }}
      >
        <DialogContent showCloseButton={false} className="promotion-dialog">
          <DialogHeader>
            <DialogTitle>成りますか？</DialogTitle>
            <DialogDescription>
              この手は敵陣に入るか、敵陣から出る手です。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                promotionRequest &&
                commitBoardMove(
                  promotionRequest.from,
                  promotionRequest.to,
                  false,
                )
              }
            >
              成らない
            </Button>
            <Button
              onClick={() =>
                promotionRequest &&
                commitBoardMove(
                  promotionRequest.from,
                  promotionRequest.to,
                  true,
                )
              }
            >
              成る
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="history-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>この対局の行動ログ</DialogTitle>
            <DialogDescription>
              {canReview
                ? '確認したい手を選ぶと、その時点の盤面へ移動します。'
                : 'この対局で指された手を、最初から順番に確認できます。'}
            </DialogDescription>
          </DialogHeader>
          <div className="full-history-list" aria-label="全対局ログ">
            {game && game.moveHistory.length > 0 ? (
              game.moveHistory.map((move, index) => {
                const moveNumber = index + 1;
                const coordinates = move.from
                  ? `${boardCoordinates(move.from)} → ${boardCoordinates(move.to)}`
                  : `${boardCoordinates(move.to)} 打`;
                return (
                  <button
                    type="button"
                    className={
                      reviewing && reviewIndex === moveNumber ? 'active' : ''
                    }
                    disabled={!canReview}
                    key={`${move.pieceId}-${moveNumber}`}
                    onClick={() => selectHistoryMove(moveNumber)}
                  >
                    <span className="history-move-number">{moveNumber}</span>
                    <span className="history-move-copy">
                      <strong>
                        {actionLogText(
                          move,
                          gameMode === 'cpu' ? humanSide : viewer,
                        )}
                      </strong>
                      <small>
                        {playerLabel(move.side)}・{coordinates}
                      </small>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="history-empty">まだ行動はありません</p>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setHistoryOpen(false)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={phase === 'finished' && resultOpen && Boolean(game?.winner)}
        onOpenChange={() => undefined}
      >
        <DialogContent
          showCloseButton={false}
          className="result-dialog sm:max-w-2xl"
        >
          {resultArtwork ? (
            <div className="result-artwork">
              {/* oxlint-disable-next-line next/no-img-element -- Vite emits fingerprinted static assets. */}
              <img
                src={resultArtwork}
                alt={`${cpuLevelInfo.name}との対局で${resultTitle}になった場面`}
              />
              <div className="result-artwork-caption">
                <div className="result-artwork-speaker">
                  <span>VS {cpuLevelInfo.name}</span>
                  {resultQuote ? <p>「{resultQuote}」</p> : null}
                </div>
              </div>
            </div>
          ) : (
            <span className="result-piece">王</span>
          )}
          <DialogHeader>
            <DialogTitle>{resultTitle}</DialogTitle>
            <DialogDescription className="result-description">
              {resultDescriptionParts.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </DialogDescription>
          </DialogHeader>
          <div className="result-share-actions">
            <Button onClick={shareResult}>
              <Share2 /> 結果画像を共有
            </Button>
            <Button variant="outline" onClick={shareResultOnX}>
              <ExternalLink /> Xで共有
            </Button>
          </div>
          <p className="share-feedback" aria-live="polite">
            {shareFeedback}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={resetToIntro}>
              タイトルへ
            </Button>
            {canReview ? (
              <Button
                variant="outline"
                onClick={() => openReview(lastReviewIndex)}
              >
                <Footprints /> 盤面で振り返る
              </Button>
            ) : null}
            <Button
              onClick={() =>
                gameMode === 'cpu'
                  ? startCpuMatch(cpuLevel)
                  : gameMode === 'online'
                    ? void startOnlineMatch()
                    : startLocalMatch()
              }
            >
              もう一局
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="rules-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>影将棋の遊び方</DialogTitle>
            <DialogDescription>
              駒の正体を読み合いながら、相手の王を先に捕らえる対局です。
            </DialogDescription>
          </DialogHeader>
          <ol className="rules-list">
            <li>
              <span>01</span>
              <div>
                <strong>配置は毎局ランダム</strong>
                <p>
                  各列に歩が1枚、王は最下段。その他の駒は条件に沿って毎局入れ替わります。
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>相手の駒は影</strong>
                <p>
                  影を押すと予想を記録できます。移動方向の履歴も予想画面で確認できます。
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>通常の移動・成り・持ち駒</strong>
                <p>
                  二歩と行き所のない駒打ちは禁止。王手・詰み・打ち歩詰めの判定はしません。
                </p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>王を取れば勝ち</strong>
                <p>
                  王の位置は最後まで分かりません。実際に王を捕らえた瞬間に決着します。
                </p>
              </div>
            </li>
            <li>
              <span>05</span>
              <div>
                <strong>3段階のCPU</strong>
                <p>
                  あゆむくん、金一、かげむしゃ王の順に手強くなります。好みの強さを選んで対局できます。
                </p>
              </div>
            </li>
          </ol>
          <DialogFooter>
            <Button onClick={() => setRulesOpen(false)}>わかった</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
