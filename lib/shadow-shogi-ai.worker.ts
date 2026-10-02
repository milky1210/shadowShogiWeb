import { chooseCpuAction, type CpuDecision, type CpuLevel } from './shadow-shogi-ai';
import type { GameState, Side } from './shadow-shogi';

interface CpuWorkerRequest {
  state: GameState;
  level: CpuLevel;
  side: Side;
}

self.onmessage = ({ data }: MessageEvent<CpuWorkerRequest>) => {
  const decision: CpuDecision = chooseCpuAction(data.state, data.level, data.side);
  self.postMessage(decision);
};
