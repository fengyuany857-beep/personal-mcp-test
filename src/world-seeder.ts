/**
 * 世界事件播种器（World Event Seeder）：后台低频生成与主角有关的外部事件，
 * 模型给定发生时间，宿主到点以 world-event 剧本条目注入（[世界事件] 前缀）。
 * 设计文档：docs/WORLD_EVENT_SEEDER_DESIGN.md。
 *
 * 事实权威、反应自由：事件是既成现实；她如何感知与应对是主作者的领地。
 * 注册参与者严格拉黑（他们背后是真实的人）；只允许线下通道与 NPC。
 */
import type { Context } from 'koishi'
import { OpenAICompatibleNarrator, type ModelConfig, type ProviderConfig, type TokenUsageRecord } from './narrator'

export type SeedImportance = 'low' | 'medium' | 'high'

/** 模型输出经解析与校验后的候选事件（尚未入库）。 */
export interface WorldSeedEventDraft {
  summary: string
  importance: SeedImportance
  occursAt: Date
  expiresAt?: Date
  subjects: string[]
  rationale: string
}

export interface WorldSeederRuntime {
  enabled: boolean
  provider?: ProviderConfig
  cadenceMinutes: number
  maxPending: number
  dailyCap: number
  maxHorizonHours: number
  temperature: number
  maxTokens: number
  timeout: number
}

export const DEFAULT_WORLD_SEEDER_RUNTIME: WorldSeederRuntime = {
  enabled: false, cadenceMinutes: 45, maxPending: 4, dailyCap: 4,
  maxHorizonHours: 72, temperature: 0.9, maxTokens: 1_000, timeout: 60_000,
}

/** 提供商不再单独配置：模型中心的连接行勾选“用于世界播种”（useForWorldSeeding）
 * 即为选择；服务侧解析出该连接后传入。未勾选（provider 为空）即视为关闭。 */
export function resolveWorldSeederRuntime(value: unknown, provider?: ProviderConfig): WorldSeederRuntime {
  const record = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const assigned = provider && provider.enabled !== false && provider.model?.trim() ? provider : undefined
  const clamp = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  }
  return {
    ...DEFAULT_WORLD_SEEDER_RUNTIME,
    enabled: record.enabled === true && !!assigned,
    provider: assigned,
    cadenceMinutes: clamp(record.cadenceMinutes, 5, 1_440, DEFAULT_WORLD_SEEDER_RUNTIME.cadenceMinutes),
    maxPending: clamp(record.maxPending, 1, 20, DEFAULT_WORLD_SEEDER_RUNTIME.maxPending),
    dailyCap: clamp(record.dailyCap, 1, 20, DEFAULT_WORLD_SEEDER_RUNTIME.dailyCap),
    maxHorizonHours: clamp(record.maxHorizonHours, 1, 336, DEFAULT_WORLD_SEEDER_RUNTIME.maxHorizonHours),
    temperature: Math.max(0, Math.min(2, Number(record.temperature) || DEFAULT_WORLD_SEEDER_RUNTIME.temperature)),
    maxTokens: clamp(record.maxTokens, 256, 8_192, DEFAULT_WORLD_SEEDER_RUNTIME.maxTokens),
    timeout: clamp(record.timeout, 5_000, 300_000, DEFAULT_WORLD_SEEDER_RUNTIME.timeout),
  }
}

// ── 提示词 ──────────────────────────────────────────────────────────────────

export function worldSeederSystemPrompt() {
  return [
    'You are the world seeder for HDS Interlude. Your only job is to occasionally originate small external events in the protagonist’s world.',
    'You will receive: current local time and season, the story’s world setting, current scene and arc summaries, a bounded excerpt of her recent established life, her in-flight working details, her relationship network listed as BLOCKED NAMES, and recently seeded events to avoid repeating.',
    'Rules:',
    '- External facts only: things that happen TO her world — environment, neighborhood, offline social world, NPCs she knows, minor mishaps, small opportunities. Never her own decisions, feelings or actions.',
    '- Offline channels only: phone calls, in-person encounters, notices, deliveries, weather, public events. Never any chat message, platform notification or online conversation content.',
    '- NEVER generate events about BLOCKED NAMES or the user. Family, classmates, shopkeepers and strangers who exist only in her offline life are fine.',
    '- Fit the environment: season, weather, the canon setting’s texture (city or village, era, neighborhood), and her daily circumstances.',
    '- Fit her established life: events must be plausible next to the recent script, her working details and the current arc; never contradict what has already happened.',
    '- Place events at concrete future times within the allowed horizon, expressed in the story timezone. Ordinary gaps in her day are the best slots.',
    '- Importance: low = texture she may barely notice; medium = a small practical change; high = relationship-relevant or disruptive. Low must be most of your output; high is rare.',
    'Real life is mostly uneventful. MOST RUNS MUST RETURN an empty events array. Output at most 2 events.',
    'Output one JSON object only: {"events":[{"summary":"one concrete Chinese sentence stating what happened","importance":"low|medium|high","occursAt":"ISO-8601 with offset","expiresAt":"optional ISO-8601","subjects":["names of offline people involved, empty when none"],"rationale":"short reason this fits now"}]}',
  ].join('\n')
}

// ── 解析与校验闸（纯函数，可测） ────────────────────────────────────────────

export interface SeedValidationInput {
  now: Date
  timezone: string
  maxHorizonHours: number
  blockedNames: string[]
  recentSummaries: string[]
}

function bigrams(text: string): Set<string> {
  const normalized = text.replace(/[\p{P}\p{S}\s]+/gu, '')
  const grams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i += 1) grams.add(normalized.slice(i, i + 2))
  return grams
}

export function summaryJaccard(left: string, right: string): number {
  const a = bigrams(left), b = bigrams(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

function localHourIn(date: Date, timezone: string): number {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(date))
    return Number.isFinite(hour) ? hour : date.getUTCHours()
  } catch {
    return date.getUTCHours()
  }
}

export type SeedRejection = 'invalid-shape' | 'empty-summary' | 'invalid-importance' | 'invalid-time' | 'blocked-name' | 'night-high' | 'duplicate'

/** 单事件校验闸；宁可错杀：任何一项不过即弃，不重试。 */
export function validateSeedEvent(draft: WorldSeedEventDraft, input: SeedValidationInput): SeedRejection | undefined {
  if (!draft.summary.trim() || draft.summary.length > 200) return 'empty-summary'
  if (draft.importance !== 'low' && draft.importance !== 'medium' && draft.importance !== 'high') return 'invalid-importance'
  const time = draft.occursAt.getTime()
  if (!Number.isFinite(time) || time <= input.now.getTime() || time > input.now.getTime() + input.maxHorizonHours * 3_600_000) return 'invalid-time'
  for (const name of input.blockedNames) {
    const trimmed = name.trim()
    if (trimmed.length >= 2 && (draft.summary.includes(trimmed) || draft.subjects.some(subject => subject.includes(trimmed) || trimmed.includes(subject.trim())))) return 'blocked-name'
  }
  if (draft.importance === 'high') {
    const hour = localHourIn(draft.occursAt, input.timezone)
    if (hour >= 0 && hour < 6) return 'night-high'
  }
  for (const recent of input.recentSummaries) {
    if (summaryJaccard(draft.summary, recent) > 0.6) return 'duplicate'
  }
  return undefined
}

/** 防御解析模型输出：字段裁剪、时间解析、subjects/rationale 归一；坏项丢弃。 */
export function parseWorldSeedEvents(value: unknown, limit = 2): WorldSeedEventDraft[] {
  const record = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const rawEvents = Array.isArray(record.events) ? record.events : []
  const drafts: WorldSeedEventDraft[] = []
  for (const raw of rawEvents.slice(0, limit)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const summary = typeof item.summary === 'string' ? item.summary.trim().slice(0, 200) : ''
    const importance = item.importance
    if (!summary || (importance !== 'low' && importance !== 'medium' && importance !== 'high')) continue
    const occursAt = new Date(String(item.occursAt ?? ''))
    if (Number.isNaN(occursAt.getTime())) continue
    const expiresRaw = typeof item.expiresAt === 'string' ? new Date(item.expiresAt) : undefined
    const expiresAt = expiresRaw && !Number.isNaN(expiresRaw.getTime()) && expiresRaw > occursAt ? expiresRaw : undefined
    const subjects = Array.isArray(item.subjects)
      ? item.subjects.filter((s): s is string => typeof s === 'string').map(s => s.trim().slice(0, 40)).filter(Boolean).slice(0, 4)
      : []
    drafts.push({
      summary, importance, occursAt, subjects,
      rationale: typeof item.rationale === 'string' ? item.rationale.trim().slice(0, 200) : '',
      ...(expiresAt ? { expiresAt } : {}),
    })
  }
  return drafts
}

// ── 模型客户端：独立配置块复用主提供商请求链 ────────────────────────────────

export interface WorldSeeder {
  available: boolean
  generate(userPayload: string): Promise<unknown>
}

export function createWorldSeeder(
  ctx: Context,
  modelConfig: ModelConfig,
  runtime: WorldSeederRuntime,
  onUsage?: (record: TokenUsageRecord) => void,
): WorldSeeder {
  const provider = runtime.provider
  if (!runtime.enabled || !provider?.model?.trim()) return { available: false, generate: async () => { throw new Error('世界播种器未配置模型。') } }
  const client = new OpenAICompatibleNarrator(ctx, modelConfig, true, onUsage)
  return {
    available: true,
    generate: userPayload => client.customSideTask<unknown>(
      provider, '世界播种', runtime.timeout, runtime.temperature, runtime.maxTokens,
      worldSeederSystemPrompt(), userPayload,
    ),
  }
}
