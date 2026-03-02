/**
 * Notion Document Comment Plugin for OpenClaw
 * 
 * Polls Notion pages for new comments and responds via Agent.
 * Supports "index page" pattern: a main page links to pages to monitor.
 * Runs every 15 minutes (configurable).
 */

import { Client } from "@notionhq/client";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Types
interface NotionComment {
    id: string;
    discussion_id: string;
    created_time: string;
    parent: {
        type: string;
        page_id?: string;
        block_id?: string;
    };
    rich_text: Array<{
        type: string;
        text?: { content: string; link?: { url: string } | null };
        plain_text: string;
    }>;
    created_by: {
        id: string;
        object: string;
    };
}

interface PluginConfig {
    enabled: boolean;
    pollIntervalMinutes: number;
    indexPage?: string;      // Index page ID - reads links from this page
    watchedPages: string[];  // Fallback: explicit page IDs
    notionApiKey?: string;   // Notion integration secret
    notionApiKeyEnv?: string; // Env var name for Notion API key
    integrationUserId?: string; // Bot user ID to avoid self-reply
    aiBaseUrl?: string;      // AI API base URL (e.g. https://right.codes/codex/v1)
    aiApiKey?: string;       // AI API key
    aiApiKeyEnv?: string;    // Env var name for AI API key
    aiModel?: string;        // AI model name (e.g. gpt-5.1-codex)
    useGatewayChatCompletions?: boolean; // Prefer local OpenClaw gateway /v1/chat/completions
    gatewayBaseUrl?: string; // Local gateway base URL (default http://127.0.0.1:18789/v1)
    gatewayApiKey?: string;  // Optional Bearer token for gateway HTTP endpoint
    gatewayApiKeyEnv?: string; // Env var name for gateway API key
    systemPrompt?: string;   // Optional override for assistant system prompt
}

interface ProcessedState {
    lastPollTime: number;
    processedComments: Record<string, string[]>; // pageId -> commentId[]
}

// Plugin state
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");
const CONFIG_FILE = join(__dirname, "config.json");

const LOG_PREFIX = "[notion-doc-comment]";

// Load plugin-specific config from config.json
function loadPluginConfig(): Partial<PluginConfig> {
    if (existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        } catch {
            console.log(`${LOG_PREFIX} Failed to parse config file`);
        }
    }
    return {};
}

function getEnv(name?: string): string {
    if (!name) return "";
    return process.env[name] ?? "";
}

function firstNonEmpty(...values: Array<string | undefined>): string {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }
    return "";
}

// Helper functions
function loadState(): ProcessedState {
    if (existsSync(STATE_FILE)) {
        try {
            return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        } catch {
            console.log(`${LOG_PREFIX} Failed to parse state file, starting fresh`);
        }
    }
    return { lastPollTime: 0, processedComments: {} };
}

function saveState(state: ProcessedState): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractTextFromComment(comment: NotionComment): string {
    return comment.rich_text
        .map((rt) => rt.plain_text)
        .join("");
}

// Extract text content from a block (for inline comment context / "quote")
function extractBlockText(block: any): string {
    const content = block[block.type];
    if (!content?.rich_text) return "";
    return content.rich_text
        .map((rt: any) => rt.plain_text)
        .join("");
}

// Notion API: get comments for a specific block or page
async function getCommentsForBlock(
    notion: Client,
    blockId: string
): Promise<NotionComment[]> {
    const allComments: NotionComment[] = [];
    let cursor: string | undefined;

    try {
        do {
            const response = await notion.comments.list({
                block_id: blockId,
                start_cursor: cursor,
            });

            allComments.push(...(response.results as unknown as NotionComment[]));
            cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
        } while (cursor);
    } catch (error: any) {
        // Silently skip blocks that don't support comments
        if (!error.message?.includes("Could not find block")) {
            console.error(`${LOG_PREFIX} Failed to get comments for ${blockId}:`, error.message);
        }
    }

    return allComments;
}

// Get ALL comments for a page: page-level + inline (block-level)
// Returns comments along with their block context (quote text)
async function getAllCommentsForPage(
    notion: Client,
    pageId: string
): Promise<{ comment: NotionComment; quote?: string }[]> {
    const results: { comment: NotionComment; quote?: string }[] = [];

    // 1. Page-level comments
    const pageComments = await getCommentsForBlock(notion, pageId);
    for (const c of pageComments) {
        results.push({ comment: c });
    }

    // 2. Block-level (inline) comments — iterate all blocks
    const blocks = await getPageBlocks(notion, pageId);
    for (const block of blocks) {
        // Skip non-commentable block types
        if (["child_page", "child_database", "unsupported"].includes(block.type)) {
            continue;
        }

        const blockComments = await getCommentsForBlock(notion, block.id);
        if (blockComments.length > 0) {
            const quote = extractBlockText(block);
            for (const c of blockComments) {
                results.push({ comment: c, quote: quote || undefined });
            }
        }
    }

    console.log(`${LOG_PREFIX} Found ${results.length} total comments (${pageComments.length} page-level, ${results.length - pageComments.length} inline)`);
    return results;
}

// Reply to a comment (in the same discussion thread)
async function replyToComment(
    notion: Client,
    discussionId: string,
    replyText: string
): Promise<boolean> {
    try {
        await notion.comments.create({
            discussion_id: discussionId,
            rich_text: [
                {
                    text: { content: replyText },
                },
            ],
        });
        return true;
    } catch (error: any) {
        console.error(`${LOG_PREFIX} Failed to reply:`, error.message);
        return false;
    }
}

// Get page content blocks (for index page link extraction)
async function getPageBlocks(
    notion: Client,
    pageId: string
): Promise<any[]> {
    const allBlocks: any[] = [];
    let cursor: string | undefined;

    try {
        do {
            const response = await notion.blocks.children.list({
                block_id: pageId,
                start_cursor: cursor,
                page_size: 100,
            });

            allBlocks.push(...response.results);
            cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
        } while (cursor);
    } catch (error: any) {
        console.error(`${LOG_PREFIX} Failed to get page blocks:`, error.message);
    }

    return allBlocks;
}

// Extract Notion page IDs from blocks (links in the index page)
function extractPageLinks(blocks: any[]): string[] {
    const pageIds: string[] = [];

    // Notion page ID pattern (32 hex chars, with or without dashes)
    const notionIdPattern = /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;

    function extractFromUrl(url: string) {
        // Notion URLs look like: https://www.notion.so/Page-Title-abc123def456...
        // Or: https://www.notion.so/workspace/abc123def456...
        const decodedUrl = decodeURIComponent(url);

        // Try to extract the page ID (last 32 hex chars in URL path)
        const urlMatch = decodedUrl.match(/([a-f0-9]{32})\s*$/i);
        if (urlMatch) {
            const id = urlMatch[1];
            // Format as UUID
            const formatted = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
            if (!pageIds.includes(formatted)) {
                pageIds.push(formatted);
                console.log(`${LOG_PREFIX} Found linked page: ${formatted}`);
            }
        }

        // Also try UUID format directly
        const uuidMatch = decodedUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (uuidMatch && !pageIds.includes(uuidMatch[1])) {
            pageIds.push(uuidMatch[1]);
            console.log(`${LOG_PREFIX} Found linked page: ${uuidMatch[1]}`);
        }
    }

    function processRichText(richTextArray: any[]) {
        if (!richTextArray) return;
        for (const rt of richTextArray) {
            // Check for links in rich text
            if (rt.text?.link?.url) {
                extractFromUrl(rt.text.link.url);
            }
            if (rt.href) {
                extractFromUrl(rt.href);
            }
        }
    }

    for (const block of blocks) {
        // child_page blocks directly reference a page
        if (block.type === "child_page") {
            if (!pageIds.includes(block.id)) {
                pageIds.push(block.id);
                console.log(`${LOG_PREFIX} Found child page: ${block.id} (${block.child_page?.title})`);
            }
            continue;
        }

        // child_database blocks
        if (block.type === "child_database") {
            continue; // Skip databases
        }

        // Link to page blocks
        if (block.type === "link_to_page") {
            const linkedId = block.link_to_page?.page_id;
            if (linkedId && !pageIds.includes(linkedId)) {
                pageIds.push(linkedId);
                console.log(`${LOG_PREFIX} Found link_to_page: ${linkedId}`);
            }
            continue;
        }

        // For text-based blocks, check rich_text for links
        const blockContent = block[block.type];
        if (blockContent?.rich_text) {
            processRichText(blockContent.rich_text);
        }
    }

    console.log(`${LOG_PREFIX} Extracted ${pageIds.length} page links from index`);
    return pageIds;
}

// Get watched pages from index page
async function getWatchedPagesFromIndex(
    notion: Client,
    indexPageId: string
): Promise<string[]> {
    const blocks = await getPageBlocks(notion, indexPageId);
    if (blocks.length === 0) {
        console.error(`${LOG_PREFIX} Could not read index page or it's empty`);
        return [];
    }
    return extractPageLinks(blocks);
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

function extractAssistantTextFromChatCompletions(data: any): string {
    return data?.choices?.[0]?.message?.content || "";
}

async function callChatCompletions(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemPrompt: string,
    prompt: string
): Promise<string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
            max_tokens: 1024,
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API error ${response.status}: ${errText}`);
    }

    const data = await response.json() as any;
    const text = extractAssistantTextFromChatCompletions(data);
    return text || "抱歉，我暂时无法处理这条评论。";
}

// AI completion: prefer local OpenClaw gateway, fallback to external API
async function callAI(
    config: PluginConfig,
    prompt: string
): Promise<string> {
    const systemPrompt =
        config.systemPrompt ||
        "你是一个友好、专业的 AI 助手。用户在 Notion 文档中发表了评论，请用简洁的中文回复。不要使用 Markdown 格式。";

    const useGateway = config.useGatewayChatCompletions !== false;
    const gatewayModel = config.aiModel || "openclaw:friday";
    const externalModel =
        config.aiModel && !config.aiModel.startsWith("openclaw:")
            ? config.aiModel
            : "gpt-5.3-codex-xhigh";

    const gatewayBaseUrl = config.gatewayBaseUrl || "http://127.0.0.1:18789/v1";
    const gatewayApiKey = firstNonEmpty(config.gatewayApiKey, getEnv(config.gatewayApiKeyEnv));

    const externalBaseUrl = config.aiBaseUrl || "https://right.codes/codex/v1";
    const externalApiKey = firstNonEmpty(config.aiApiKey, getEnv(config.aiApiKeyEnv));

    if (useGateway) {
        try {
            return await callChatCompletions(
                gatewayBaseUrl,
                gatewayApiKey,
                gatewayModel,
                systemPrompt,
                prompt
            );
        } catch (error: any) {
            console.error(`${LOG_PREFIX} Gateway chat/completions failed:`, error?.message || error);
            if (!externalApiKey) {
                return "抱歉，AI 网关暂时不可用，请稍后再试。";
            }
            console.log(`${LOG_PREFIX} Falling back to external AI API`);
        }
    }

    if (!externalApiKey) {
        console.error(`${LOG_PREFIX} AI API key not configured. Set aiApiKey/aiApiKeyEnv or enable gateway chat completions.`);
        return "抱歉，AI 回复功能未配置。";
    }

    return callChatCompletions(
        externalBaseUrl,
        externalApiKey,
        externalModel,
        systemPrompt,
        prompt
    );
}

// Agent integration
async function processCommentWithAgent(
    config: PluginConfig,
    commentText: string,
    pageTitle?: string,
    quote?: string
): Promise<string> {
    let prompt: string;
    if (quote) {
        prompt = pageTitle
            ? `用户在 Notion 页面「${pageTitle}」中对以下内容划词评论：\n\n引用内容：「${quote}」\n\n评论：${commentText}\n\n请回复这条评论。`
            : `用户在 Notion 文档中对以下内容划词评论：\n\n引用内容：「${quote}」\n\n评论：${commentText}\n\n请回复这条评论。`;
    } else {
        prompt = pageTitle
            ? `用户在 Notion 页面「${pageTitle}」中发表了评论：${commentText}\n\n请回复这条评论。`
            : `用户在 Notion 文档中发表了评论：${commentText}\n\n请回复这条评论。`;
    }

    try {
        return await callAI(config, prompt);
    } catch (error) {
        console.error(`${LOG_PREFIX} Agent invocation failed:`, error);
        return "抱歉，处理评论时遇到了问题，请稍后再试。";
    }
}

// Get page title
async function getPageTitle(notion: Client, pageId: string): Promise<string | undefined> {
    try {
        const page = await notion.pages.retrieve({ page_id: pageId }) as any;
        const titleProp = Object.values(page.properties).find(
            (p: any) => p.type === "title"
        ) as any;
        return titleProp?.title?.map((t: any) => t.plain_text).join("") || undefined;
    } catch {
        return undefined;
    }
}

// Group comments by discussion
function groupByDiscussion(comments: NotionComment[]): Map<string, NotionComment[]> {
    const groups = new Map<string, NotionComment[]>();
    for (const comment of comments) {
        const key = comment.discussion_id;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(comment);
    }
    return groups;
}

// Main polling logic
async function pollNotionComments(
    pluginConfig: PluginConfig,
    notion: Client,
    integrationUserId?: string
): Promise<void> {
    if (!pluginConfig.enabled) {
        console.log(`${LOG_PREFIX} Plugin is disabled`);
        return;
    }

    const state = loadState();

    // Get watched pages: from index page or explicit config
    let watchedPages: string[] = [];

    if (pluginConfig.indexPage) {
        console.log(`${LOG_PREFIX} Reading index page: ${pluginConfig.indexPage}`);
        watchedPages = await getWatchedPagesFromIndex(notion, pluginConfig.indexPage);
    }

    // Fallback to explicit config
    if (watchedPages.length === 0 && pluginConfig.watchedPages?.length > 0) {
        watchedPages = pluginConfig.watchedPages;
    }

    if (watchedPages.length === 0) {
        console.log(`${LOG_PREFIX} No pages to watch (configure indexPage or watchedPages)`);
        return;
    }

    console.log(`${LOG_PREFIX} Polling ${watchedPages.length} page(s)...`);

    for (const pageId of watchedPages) {
        try {
            // Get ALL comments: page-level + inline (block-level)
            const commentEntries = await getAllCommentsForPage(notion, pageId);
            const processedIds = state.processedComments[pageId] || [];

            // Build quote map: discussion_id -> quote text
            const quoteMap = new Map<string, string>();
            for (const entry of commentEntries) {
                if (entry.quote) {
                    quoteMap.set(entry.comment.discussion_id, entry.quote);
                }
            }

            const allComments = commentEntries.map(e => e.comment);
            const discussions = groupByDiscussion(allComments);

            for (const [discussionId, threadComments] of discussions) {
                // Sort by time to find the latest
                threadComments.sort(
                    (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime()
                );

                const latestComment = threadComments[threadComments.length - 1];

                // Skip if latest comment is already processed
                if (processedIds.includes(latestComment.id)) {
                    continue;
                }

                // Skip if the latest comment is from our integration (we already replied)
                if (integrationUserId && latestComment.created_by.id === integrationUserId) {
                    processedIds.push(latestComment.id);
                    continue;
                }

                // New comment or new reply in a thread - process it
                const commentText = extractTextFromComment(latestComment);
                if (!commentText.trim()) {
                    processedIds.push(latestComment.id);
                    continue;
                }

                const quote = quoteMap.get(discussionId);
                const commentType = quote ? "inline" : "page";
                console.log(`${LOG_PREFIX} New ${commentType} comment: "${commentText.substring(0, 50)}..."${quote ? ` [on: "${quote.substring(0, 30)}..."]` : ""}`);

                const pageTitle = await getPageTitle(notion, pageId);
                const response = await processCommentWithAgent(pluginConfig, commentText, pageTitle, quote);
                const success = await replyToComment(notion, discussionId, response);

                if (success) {
                    console.log(`${LOG_PREFIX} Replied to ${commentType} discussion ${discussionId}`);
                    processedIds.push(latestComment.id);
                }
            }

            state.processedComments[pageId] = processedIds;
        } catch (error: any) {
            console.error(`${LOG_PREFIX} Error processing page ${pageId}:`, error.message);
        }
    }

    state.lastPollTime = Date.now();
    saveState(state);
    console.log(`${LOG_PREFIX} Polling complete`);
}

// Plugin entry point
export default function createPlugin(ctx: any) {
    const { config } = ctx;

    const entryConfig = config?.plugins?.entries?.["notion-doc-comment"]?.config ?? {};

    // Load config.json for plugin-specific settings (legacy/compat)
    const fileConfig = loadPluginConfig();

    // Merge priority: plugins.entries.<id>.config > config.json
    const merged: Partial<PluginConfig> = {
        ...fileConfig,
        ...entryConfig,
    };

    // Notion API key resolution priority:
    // 1) direct config notionApiKey
    // 2) env var from notionApiKeyEnv
    // 3) channels.notion.apiKey in openclaw.json
    const notionApiKey = firstNonEmpty(
        merged.notionApiKey,
        getEnv(merged.notionApiKeyEnv),
        config.channels?.notion?.apiKey
    );

    if (!notionApiKey) {
        console.error(
            `${LOG_PREFIX} Notion API key not configured. ` +
            `Set notionApiKey/notionApiKeyEnv (recommended) or channels.notion.apiKey`
        );
        return;
    }

    const notion = new Client({ auth: notionApiKey });

    const pluginConfig: PluginConfig = {
        enabled: (config.plugins?.entries?.["notion-doc-comment"]?.enabled ?? true) as boolean,
        pollIntervalMinutes: merged.pollIntervalMinutes ?? 15,
        indexPage: merged.indexPage,
        watchedPages: merged.watchedPages ?? [],
        notionApiKey: merged.notionApiKey,
        notionApiKeyEnv: merged.notionApiKeyEnv,
        integrationUserId: merged.integrationUserId,
        aiBaseUrl: merged.aiBaseUrl,
        aiApiKey: merged.aiApiKey,
        aiApiKeyEnv: merged.aiApiKeyEnv,
        aiModel: merged.aiModel,
        useGatewayChatCompletions: merged.useGatewayChatCompletions,
        gatewayBaseUrl: merged.gatewayBaseUrl,
        gatewayApiKey: merged.gatewayApiKey,
        gatewayApiKeyEnv: merged.gatewayApiKeyEnv,
        systemPrompt: merged.systemPrompt,
    };

    if (!pluginConfig.enabled) {
        console.log(`${LOG_PREFIX} Plugin is disabled`);
        return;
    }

    // Get integration user ID from config (to avoid replying to ourselves)
    const integrationUserId = pluginConfig.integrationUserId;

    const indexInfo = pluginConfig.indexPage
        ? `index page: ${pluginConfig.indexPage}`
        : `${pluginConfig.watchedPages.length} watched pages`;
    console.log(
        `${LOG_PREFIX} Initialized with ${indexInfo}, ` +
        `polling every ${pluginConfig.pollIntervalMinutes} minutes`
    );

    // Polling
    const pollIntervalMs = pluginConfig.pollIntervalMinutes * 60 * 1000;

    const doPoll = async () => {
        try {
            await pollNotionComments(pluginConfig, notion, integrationUserId);
        } catch (error) {
            console.error(`${LOG_PREFIX} Poll error:`, error);
        }
    };

    // Run immediately after short delay
    setTimeout(doPoll, 10000);

    // Then poll at regular intervals
    setInterval(doPoll, pollIntervalMs);

    return {
        name: "notion-doc-comment",
        version: "0.2.0",
    };
}
