/**
 * 世界事件播种器（World Event Seeder）：后台低频生成与主角有关的外部事件，
 * 模型给定发生时间，宿主到点以 world-event 剧本条目注入（[世界事件] 前缀）。
 * 设计文档：docs/WORLD_EVENT_SEEDER_DESIGN.md。
 *
 * 事实权威、反应自由：事件是既成现实；她如何感知与应对是主作者的领地。
 * 注册参与者严格拉黑（他们背后是真实的人）；只允许线下通道与 NPC。
 */
import type { Context } from 'koishi';
import { type ModelConfig, type ProviderConfig, type TokenUsageRecord } from './narrator';
export type SeedImportance = 'low' | 'medium' | 'high';
/** 模型输出经解析与校验后的候选事件（尚未入库）。 */
export interface WorldSeedEventDraft {
    summary: string;
    importance: SeedImportance;
    occursAt: Date;
    expiresAt?: Date;
    subjects: string[];
    rationale: string;
}
export interface WorldSeederRuntime {
    enabled: boolean;
    provider?: ProviderConfig;
    cadenceMinutes: number;
    maxPending: number;
    dailyCap: number;
    maxHorizonHours: number;
    temperature: number;
    maxTokens: number;
    timeout: number;
}
export declare const DEFAULT_WORLD_SEEDER_RUNTIME: WorldSeederRuntime;
/** 提供商不再单独配置：模型中心的连接行勾选“用于世界播种”（useForWorldSeeding）
 * 即为选择；服务侧解析出该连接后传入。未勾选（provider 为空）即视为关闭。 */
export declare function resolveWorldSeederRuntime(value: unknown, provider?: ProviderConfig): WorldSeederRuntime;
export declare function worldSeederSystemPrompt(): string;
export interface SeedValidationInput {
    now: Date;
    timezone: string;
    maxHorizonHours: number;
    blockedNames: string[];
    recentSummaries: string[];
}
export declare function summaryJaccard(left: string, right: string): number;
export type SeedRejection = 'invalid-shape' | 'empty-summary' | 'invalid-importance' | 'invalid-time' | 'blocked-name' | 'night-high' | 'duplicate';
/** 单事件校验闸；宁可错杀：任何一项不过即弃，不重试。 */
export declare function validateSeedEvent(draft: WorldSeedEventDraft, input: SeedValidationInput): SeedRejection | undefined;
/** 防御解析模型输出：字段裁剪、时间解析、subjects/rationale 归一；坏项丢弃。 */
export declare function parseWorldSeedEvents(value: unknown, limit?: number): WorldSeedEventDraft[];
export interface WorldSeeder {
    available: boolean;
    generate(userPayload: string): Promise<unknown>;
}
export declare function createWorldSeeder(ctx: Context, modelConfig: ModelConfig, runtime: WorldSeederRuntime, onUsage?: (record: TokenUsageRecord) => void): WorldSeeder;
