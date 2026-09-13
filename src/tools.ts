import { z } from 'zod';

import { DATASET_FORMATS } from '@internetdata/internetdata';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DatasetFormat, InternetData } from '@internetdata/internetdata';

import {
    CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
    DATABASE_METADATA_SCHEMA, DATABASE_SCHEMA, DB_CHECKSUMS_SCHEMA, DOWNLOAD_SCHEMA,
} from './schema.gen.js';

/** The most history rows one `list_downloads` call may ask for. The API clamps to the same. */
export const DOWNLOADS_LIMIT = 200;

export interface ToolContext {
    client: InternetData;
}

export interface ToolDef {
    tool: Tool;
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

// The formats come from the SDK's own exported vocabulary rather than a literal
// here. It is typed by the union generated from the spec, so a format this
// package spells wrong does not compile, and one the API adds arrives with a
// version bump instead of a silent divergence. The tuple cast is about z.enum
// wanting a non-empty tuple, not a claim about the wire.
const FORMATS = z.enum([...DATASET_FORMATS] as [DatasetFormat, ...DatasetFormat[]]);

// Both spellings of a dataset id, stated wherever one is taken. `list_databases`
// answers a `base` id (what a licence names) and a `versions[].id`; everything
// else accepts only the versioned one. A model that has just read
// `base: "bogon_ip"` will otherwise pass it and get a refusal that reads like a
// bad dataset rather than a wrong spelling.
const VERSIONED_ID = 'A VERSIONED database id, from `versions[].id` in `list_databases` - '
    + '`bogon_ip_v1`, not `bogon_ip`. The unversioned base id is a licence reference and is '
    + 'not accepted here.';

/**
 * The tool manifest, and the single place either transport gets it from.
 *
 * Descriptions are read by a model rather than a developer, so they say what
 * the tool answers and what it costs, not how it is implemented.
 */
export function createTools(ctx: ToolContext): ToolDef[] {
    const defs: ToolDef[] = [
        {
            tool: {
                name: 'list_databases',
                title: 'List databases',
                description: 'The IP database catalog as this API key\'s organization may see it, '
                    + 'one entry per database FAMILY, with `standing` saying where their licence '
                    + 'stands: `licensed` if the family is theirs today, `expired` if the term has '
                    + 'ended, `unlicensed` if it is published but has never been bought. Each entry '
                    + 'has a `base` id, which is what a licence names, and a `versions` array whose '
                    + '`id` is what the other tools take - pass `versions[].id` (`bogon_ip_v1`), '
                    + 'never the `base` (`bogon_ip`). Ask again rather than holding on to this: it '
                    + 'is answered per key and is not the same for everyone.',
                inputSchema: { type: 'object', additionalProperties: false },
                outputSchema: objectSchema({
                    databases: { type: 'array', items: DATABASE_SCHEMA },
                }, ['databases']),
                annotations: {
                    readOnlyHint: true,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: async () => {
                return ok({ databases: await ctx.client.database.list() });
            },
        },
        {
            tool: {
                name: 'database_metadata',
                title: 'Describe a database',
                description: 'What is inside one database before you fetch it: the columns in each '
                    + 'published format with their types, a few sample rows, the row count, the '
                    + 'build date and the file sizes. Use this to answer questions about what a '
                    + 'database contains without downloading it - the files reach several GB - and '
                    + 'to budget a transfer before starting one.',
                inputSchema: jsonSchema(z.object({
                    dataset_id: z.string().describe(VERSIONED_ID),
                })),
                outputSchema: DATABASE_METADATA_SCHEMA,
                annotations: {
                    readOnlyHint: true,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: async (args) => {
                const { dataset_id } = z.object({ dataset_id: z.string() }).parse(args);
                return ok(await ctx.client.database.metadata(dataset_id));
            },
        },
        {
            tool: {
                name: 'database_checksum',
                title: 'Get a database\'s checksums',
                description: 'The published digests for one database file, for verifying a copy '
                    + 'you already hold or deciding whether a build has changed since you last '
                    + 'fetched it.',
                inputSchema: jsonSchema(z.object({
                    dataset_id: z.string().describe(VERSIONED_ID),
                    format: FORMATS.describe('Which published file to digest.'),
                })),
                outputSchema: objectSchema({ checksums: DB_CHECKSUMS_SCHEMA }, ['checksums']),
                annotations: {
                    readOnlyHint: true,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: async (args) => {
                const parsed = z.object({
                    dataset_id: z.string(),
                    format: FORMATS,
                }).parse(args);
                const checksums = await ctx.client.database.checksums(
                    parsed.dataset_id, parsed.format);
                return ok({ checksums: checksums });
            },
        },
        {
            tool: {
                name: 'list_downloads',
                title: 'List recent download attempts',
                description: 'This organization\'s own recent download attempts, newest first, '
                    + 'REFUSALS INCLUDED - a denial carries the `outcome` and `http_status` that '
                    + 'answer "it stopped working", which nothing else here can. Use it to explain '
                    + 'a failing fetch, to confirm a transfer ran, or to check whether a request '
                    + 'was theirs. This is a bounded WINDOW of at most '
                    + `${DOWNLOADS_LIMIT} rows, so a database missing from the answer means it is `
                    + 'not in this window - never that it was never downloaded.',
                inputSchema: jsonSchema(z.object({
                    limit: z.number().int().min(1).max(DOWNLOADS_LIMIT).optional().describe(
                        `How many attempts to return, newest first. At most ${DOWNLOADS_LIMIT}; `
                        + 'the API defaults to 50.'),
                })),
                outputSchema: objectSchema({
                    downloads: { type: 'array', items: DOWNLOAD_SCHEMA },
                }, ['downloads']),
                annotations: {
                    readOnlyHint: true,
                    idempotentHint: false,
                    openWorldHint: true,
                },
            },
            handler: async (args) => {
                const { limit } = z.object({
                    limit: z.number().int().min(1).max(DOWNLOADS_LIMIT).optional(),
                }).parse(args);
                const downloads = await ctx.client.database.downloads(
                    limit === undefined ? {} : { limit: limit });
                return ok({ downloads: downloads });
            },
        },
    ];

    // A handler NEVER throws: an upstream 404 or a rejected argument is a result
    // the model can read and correct itself from, while a JSON-RPC protocol error
    // is not. Wrapping here rather than in `registerTools` keeps that true for
    // any consumer of a ToolDef, including a transport that mounts its own.
    return defs.map((d) => ({ tool: d.tool, handler: guard(d.handler) }));
}

/** Mounts a manifest on a server. Both transports use this and nothing else. */
export function registerTools(server: Server, defs: ToolDef[]): void {
    const byName = new Map(defs.map((d) => [d.tool.name, d]));

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools: defs.map((d) => d.tool) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const def = byName.get(req.params.name);
        if (def === undefined) {
            throw new Error(`Unknown tool: ${req.params.name}`);
        }
        return await def.handler(req.params.arguments ?? {});
    });
}

function guard(handler: ToolDef['handler']): ToolDef['handler'] {
    return async (args) => {
        try {
            return await handler(args);
        } catch (err) {
            return toolError(err);
        }
    };
}

/**
 * The serialized structured content IS the text block, rather than a prose
 * summary beside it. Writing it once puts the same answer in front of a client
 * that reads `structuredContent` and one that only renders `content`.
 */
function ok(structured: Record<string, unknown>): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
    };
}

/**
 * An error carries no `structuredContent`, deliberately.
 *
 * A tool that declares an `outputSchema` has every structured result validated
 * against it by the client, and an error is not shaped like a success - so
 * attaching one turns a readable failure into a protocol error the model cannot
 * act on. The text block is what it reads instead.
 */
function toolError(err: unknown): CallToolResult {
    const known = asClientError(err);
    const detail = known !== undefined
        ? { kind: known.kind, message: known.message, retryable: known.retryable === true }
        : { kind: 'internal', message: err instanceof Error ? err.message : String(err) };
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: detail }, null, 2) }],
        isError: true,
    };
}

/**
 * Recognises an `InternetDataError` by SHAPE, not by `instanceof`.
 *
 * This package and whatever mounts it can each end up with their own copy of
 * the `@internetdata/internetdata` module - the hosted service depends on both -
 * and two copies of one class are two identities, so `instanceof` silently
 * returns false and every upstream failure degrades to a generic `internal`. A
 * caller then sees "internal" for what was really `forbidden`, and loses the
 * `retryable` flag that decides whether trying again is worth anything.
 */
function asClientError(err: unknown): ClientError | undefined {
    if (err === null || typeof err !== 'object') {
        return undefined;
    }
    const e = err as Partial<ClientError> & { name?: unknown };
    if (e.name !== 'InternetDataError' || typeof e.kind !== 'string') {
        return undefined;
    }
    return e as ClientError;
}

interface ClientError {
    kind: string;
    message: string;
    retryable?: boolean;
}

// One zod declaration yields both the published schema and the runtime parse, so
// a cap advertised to a client is the same cap the handler enforces.
function jsonSchema(schema: z.ZodType): Tool['inputSchema'] {
    const out = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
    delete out['$schema'];
    return { ...out, type: 'object' } as Tool['inputSchema'];
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Tool['outputSchema'] {
    return {
        type: 'object',
        properties: properties,
        required: required,
    } as Tool['outputSchema'];
}
