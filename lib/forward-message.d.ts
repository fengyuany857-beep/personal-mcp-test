export interface ForwardReadLimits {
    maxNodes: number;
    maxCharacters: number;
    maxDepth: number;
}
export interface ForwardReadResult {
    content: string;
    nodeCount: number;
    forwardCount: number;
    truncated: boolean;
    failed: boolean;
    /** P2-7：整体拉取失败的原因（模块保持零依赖，日志由调用方记录）。 */
    cause?: string;
    /** P2-7：嵌套合并转发读取失败次数（>0 时正文以占位符降级，调用方记 warn）。 */
    nestedFailed?: number;
}
export declare function readForwardContent(session: any, limits?: Partial<ForwardReadLimits>): Promise<ForwardReadResult | undefined>;
export declare function forwardReadLimits(value?: Partial<ForwardReadLimits>): ForwardReadLimits;
export declare function extractForwardIds(content: unknown): string[];
export declare function normalizeForwardMessages(messages: unknown[], limits?: Partial<ForwardReadLimits>, depth?: number): ForwardReadResult;
