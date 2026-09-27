/**
 * P0 试点：TurnEngine——从 service.ts 抽出的缓冲回合状态管理。
 *
 * 拥有 bufferedNarrativeTurns + narratingStories 两个状态容器，
 * 以及直接操作它们的四个方法（buffer/signal/invalidate/hasPending）。
 * flushBufferedNarrative 的执行体留在 service（它调用模型/投递/持久化），
 * 但通过 beginFlush/endFlush 与本模块交互状态。
 */
import type { Session } from 'koishi'
import type { InterludeStory, InterludeParticipant, NarrativeIntent, QuotedMessageContext } from './types'

export interface BufferedUserMessage {
  content: string
  occurredAt: Date
  supersededIntents: NarrativeIntent[]
  imageSources: string[]
  audioSources: string[]
  quote?: QuotedMessageContext
}

export interface BufferedNarrativeTurn {
  storyId: string
  participantId: string
  messages: BufferedUserMessage[]
  latestSession?: Session
  timer?: () => void
  nextRevision: number
  inFlightRequestId?: number
  firstMessageCommittedRequestId?: number
  obsoleteRequestIds: Set<number>
}

/** 最小依赖集——不含模型调用/投递/持久化（那些留在 service）。 */
export interface TurnEngineDeps {
  setTimeout: (fn: () => void, ms: number) => () => void
  userMessageDebounceSeconds: number
  reportOperation: (level: string, kind: string, story: InterludeStory, phase: string, format: string, ...args: unknown[]) => void
}

export function shouldSupersedeRequest(
  inFlightRequestId: number | undefined,
  firstMessageCommittedRequestId: number | undefined,
  obsoleteRequestIds: ReadonlySet<number>,
): boolean {
  return inFlightRequestId != null
    && inFlightRequestId !== firstMessageCommittedRequestId
    && !obsoleteRequestIds.has(inFlightRequestId)
}

export interface TurnEngine {
  /** 状态容器（service 的 flushBufferedNarrative 直接访问） */
  readonly turns: Map<string, BufferedNarrativeTurn>
  readonly narrating: Set<string>

  bufferUserNarrative(
    story: InterludeStory, participant: InterludeParticipant, session: Session,
    now: Date, supersededIntents: NarrativeIntent[],
    content: string, imageSources: string[], audioSources: string[], quote: QuotedMessageContext | undefined,
    flushTrigger: (key: string, revision: number) => void,
  ): void

  signalIncomingInterruption(story: InterludeStory, participant: InterludeParticipant): void

  hasPendingNarrative(storyId: string, hasPendingGroupTurn: (storyId: string) => boolean): boolean

  /** flush 开始：取回 turn 并标记 narrating；返回 null 表示不该 flush。 */
  beginFlush(key: string, revision: number, retryDelay: (key: string, revision: number) => void): BufferedNarrativeTurn | null

  /** flush 结束：清理 narrating 标记和空 turn。 */
  endFlush(key: string, requestId: number): void

  /** 暂停/恢复时重设定时器。 */
  rescheduleTimers(flushTrigger: (key: string, revision: number) => void): void

  /** 使全部（或指定故事的）回合失效。 */
  invalidateNarratives(storyId?: string, invalidateGroups?: (storyId?: string) => void): void

  /** 只读查询 */
  isNarrating(storyId: string): boolean
  getTurn(key: string): BufferedNarrativeTurn | undefined
  pendingTurnCount(): number
}

export function createTurnEngine(deps: TurnEngineDeps): TurnEngine {
  const turns = new Map<string, BufferedNarrativeTurn>()
  const narrating = new Set<string>()

  function bufferUserNarrative(
    story: InterludeStory, participant: InterludeParticipant, session: Session,
    now: Date, supersededIntents: NarrativeIntent[],
    content: string, imageSources: string[], audioSources: string[], quote: QuotedMessageContext | undefined,
    flushTrigger: (key: string, revision: number) => void,
  ) {
    const key = participant.id
    const existing = turns.get(key)
    const turn: BufferedNarrativeTurn = existing ?? {
      storyId: story.id, participantId: participant.id, messages: [], nextRevision: 0, obsoleteRequestIds: new Set(),
    }
    if (shouldSupersedeRequest(turn.inFlightRequestId, turn.firstMessageCommittedRequestId, turn.obsoleteRequestIds)) {
      turn.obsoleteRequestIds.add(turn.inFlightRequestId!)
      deps.reportOperation('standard', 'info', story, 'user-message', '新消息到达且首条回复尚未提交，放弃旧请求 参与者=%s 请求=%d', participant.id, turn.inFlightRequestId)
    }
    turn.messages.push({ content, occurredAt: now, supersededIntents, imageSources, audioSources, ...(quote !== undefined && quote !== null ? { quote } : {}) })
    turn.latestSession = session
    if (turn.timer) turn.timer()
    const revision = ++turn.nextRevision
    const delay = Math.max(0, deps.userMessageDebounceSeconds) * 1000
    turn.timer = deps.setTimeout(() => flushTrigger(key, revision), delay)
    turns.set(key, turn)
    deps.reportOperation('diagnostic', 'debug', story, 'user-message', '短时消息合并 参与者=%s 待处理=%d 等待=%dms', participant.id, turn.messages.length, delay)
  }

  function signalIncomingInterruption(story: InterludeStory, participant: InterludeParticipant) {
    const turn = turns.get(participant.id)
    if (!turn || !shouldSupersedeRequest(turn.inFlightRequestId, turn.firstMessageCommittedRequestId, turn.obsoleteRequestIds)) return
    turn.obsoleteRequestIds.add(turn.inFlightRequestId!)
    deps.reportOperation('standard', 'info', story, 'user-message',
      '新消息到达且首条回复尚未提交，放弃旧请求 参与者=%s 请求=%d', participant.id, turn.inFlightRequestId)
  }

  function hasPendingNarrative(storyId: string, hasPendingGroupTurn: (storyId: string) => boolean): boolean {
    if (narrating.has(storyId)) return true
    for (const turn of turns.values()) {
      if (turn.storyId === storyId && (turn.messages.length || turn.timer || turn.inFlightRequestId)) return true
    }
    return hasPendingGroupTurn(storyId)
  }

  function beginFlush(key: string, revision: number, retryDelay: (key: string, revision: number) => void): BufferedNarrativeTurn | null {
    const turn = turns.get(key)
    if (!turn || turn.nextRevision !== revision) return null
    if (narrating.has(turn.storyId)) {
      turn.timer = deps.setTimeout(() => retryDelay(key, revision), 250)
      return null
    }
    narrating.add(turn.storyId)
    turn.timer = undefined
    return turn
  }

  function endFlush(key: string, requestId: number) {
    const turn = turns.get(key)
    if (!turn) return
    if (turn.inFlightRequestId === requestId) {
      turn.inFlightRequestId = undefined
      turn.firstMessageCommittedRequestId = undefined
      narrating.delete(turn.storyId)
    }
    turn.obsoleteRequestIds.delete(requestId)
    if (!turn.messages.length && !turn.timer && !turn.inFlightRequestId) turns.delete(key)
  }

  function rescheduleTimers(flushTrigger: (key: string, revision: number) => void) {
    for (const [key, turn] of turns) {
      if (!turn.timer && !turn.inFlightRequestId && turn.messages.length) {
        const revision = ++turn.nextRevision
        turn.timer = deps.setTimeout(() => flushTrigger(key, revision), 0)
      }
    }
  }

  function invalidateNarratives(storyId?: string, invalidateGroups?: (storyId?: string) => void) {
    for (const [key, turn] of turns) {
      if (storyId && turn.storyId !== storyId) continue
      if (turn.timer) turn.timer()
      if (turn.inFlightRequestId) turn.obsoleteRequestIds.add(turn.inFlightRequestId)
      turns.delete(key)
    }
    invalidateGroups?.(storyId)
  }

  return {
    turns, narrating,
    bufferUserNarrative, signalIncomingInterruption, hasPendingNarrative,
    beginFlush, endFlush, rescheduleTimers, invalidateNarratives,
    isNarrating: (storyId: string) => narrating.has(storyId),
    getTurn: (key: string) => turns.get(key),
    pendingTurnCount: () => turns.size,
  }
}

export type { BufferedNarrativeTurn as TurnBufferedNarrativeTurn, BufferedUserMessage as TurnBufferedUserMessage }
