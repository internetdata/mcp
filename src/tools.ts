import { z } from 'zod';

import { DATABASE_FORMATS } from '@internetdata/internetdata';

import type { CallToolResult, Server, Tool } from '@modelcontextprotocol/server';
import type { DatabaseFormat, InternetData, Result } from '@internetdata/internetdata';

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { batchCoverage, COVERAGE_SCHEMA, coverageOf } from './coverage.js';
import {
    ASN_LOOKUP_RESULT_SCHEMA, DATABASE_METADATA_SCHEMA, DATABASE_SCHEMA, DB_CHECKSUMS_SCHEMA,
    DOMAIN_LOOKUP_RESULT_SCHEMA, DOWNLOAD_SCHEMA, DOWNLOADS_LIMIT, DOWNLOADS_LIMIT_DEFAULT,
    DOWNLOADS_LIMIT_MIN, ENTITLEMENT_SCHEMA, LOOKUP_RESULT_SCHEMA,
} from './schema.gen.js';

export { DOWNLOADS_LIMIT };

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
const FORMATS = z.enum([...DATABASE_FORMATS] as [DatabaseFormat, ...DatabaseFormat[]]);

// Both spellings of a dataset ID, stated wherever one is taken. `list_databases`
// answers a `base` ID (what a license names) and a `versions[].id`; everything
// else accepts only the versioned one. A model that has just read
// `base: "bogon_ip"` will otherwise pass it and get a refusal that reads like a
// bad dataset rather than a wrong spelling.
const VERSIONED_ID = 'A VERSIONED database ID, from `versions[].id` in `list_databases` - '
    + '`bogon_ip_v1`, not `bogon_ip`. The unversioned base ID is a license reference and is '
    + 'not accepted here.';

// Each tool's arguments, declared ONCE. `jsonSchema()` publishes the object and
// the handler parses with the same one, so the cap a client is shown is the cap
// it meets. Two lookalike declarations - a schema for the manifest and another
// in the handler - is how an advertised bound and an enforced bound drift.
// Each is strict, so an argument a tool does not take is refused by name: a
// misspelled optional one (`max` for `limit`) would otherwise be dropped, and
// the call answered as if it had never been passed.
const NO_INPUT = z.strictObject({});

const LOOKUP_INPUT = z.strictObject({
    ip: z.string().describe('The IPv4 or IPv6 address to look up.'),
});

// Uncapped: a caller passes every address it has. The SDK sends them to POST
// /batch in chunks of that endpoint's 1000, so the spec's `maxItems: 1000` bounds
// a REQUEST, not this tool - never derive a cap from it. One call is bounded by
// its transport instead: the hosted server takes a request body of at most 1 MB.
const LOOKUP_BATCH_INPUT = z.strictObject({
    ips: z.array(z.string()).min(1).describe('The IPv4 or IPv6 addresses to look up.'),
});

// An AS number is 32 bits (RFC 6793), which is what the API reads one as. The spec
// takes it as a path string and states no bound, so there is none to derive.
const ASN_INPUT = z.strictObject({
    asn: z.number().int().min(0).max(4294967295).describe('The AS number: 15169 for AS15169.'),
});

const DOMAIN_INPUT = z.strictObject({
    domain: z.string().describe('The domain to look up, such as `example.com`.'),
});

// A batch needs a paid plan, and a free-plan key's batch of two or more is refused
// with a 402. Up to this many refused addresses are then looked up one at a time
// instead, which a free-plan key may do; past it every address keeps the refusal,
// since a caller with that long a list wants a paid plan rather than as many
// single lookups.
const TRIAL_SINGLE_LOOKUPS = 10;

// How many of an AS's prefixes lookup_asn answers. A big AS announces thousands (AS16509's answer is 9 MB, AS9009's
// 2 MB), past the official Python MCP SDK's 1 MiB limit on a streamed response and past any model's context
// (Uman, 2026-11-14). The rest are one API call away, which the answer says.
const ASN_PREFIXES_SHOWN = 100;

// What lookup_asn adds when it cut the prefixes short: how many it carries, how many there are, and where the
// rest are.
const TRUNCATED_SCHEMA = {
    type: 'object',
    description: 'Present only when the answer was cut short: the prefixes it carries, how many the AS announces, '
        + 'and where to get them all.',
    properties: {
        prefixes: {
            type: 'object',
            properties: { shown: { type: 'integer' }, total: { type: 'integer' } },
            required: ['shown', 'total'],
        },
        note: { type: 'string' },
    },
    required: ['prefixes', 'note'],
} as const;

// The paid column of the spec's plan tables, the same for every lookup. Each tool
// names Unlimited's column itself, and the coverage note says answer by answer
// which fields a plan left out.
const PAID = 'Every paid plan answers every field, and so does a key on the free plan while its '
    + 'organization\'s daily trial lasts.';

const METADATA_INPUT = z.strictObject({
    dataset_id: z.string().describe(VERSIONED_ID),
});

const CHECKSUM_INPUT = z.strictObject({
    dataset_id: z.string().describe(VERSIONED_ID),
    format: FORMATS.describe('Which published file to digest.'),
});

const DOWNLOADS_INPUT = z.strictObject({
    limit: z.number().int().min(DOWNLOADS_LIMIT_MIN).max(DOWNLOADS_LIMIT).optional().describe(
        `How many attempts to return, newest first. At most ${DOWNLOADS_LIMIT}; `
        + `the API defaults to ${DOWNLOADS_LIMIT_DEFAULT}.`),
});

// What `lookup_ips` answers in place of a result for an address that failed. It
// is this package's own shape - the client SDK's classification of the failure,
// not the wire's `{status, error}` - so it is declared here in full rather than
// generated, and never left free-form.
const ENTRY_ERROR_SCHEMA = {
    type: 'object',
    properties: {
        error: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    description: 'How the client SDK classified the failure, such as `bad_request` '
                        + 'for a string that is not an IP address.',
                },
                message: { type: 'string' },
            },
            required: ['kind', 'message'],
        },
    },
    required: ['error'],
} as const;

/**
 * The tool manifest, and the single place either transport gets it from.
 *
 * Descriptions are read by a model rather than a developer, so they say what
 * the tool answers and what it costs, not how it is implemented.
 */
export function createTools(ctx: ToolContext): ToolDef[] {
    const defs: ToolDef[] = [...lookupTools(ctx), accountTool(ctx), ...databaseTools(ctx)];

    // A handler NEVER throws: an upstream 404 or a rejected argument is a result
    // the model can read and correct itself from, while a JSON-RPC protocol error
    // is not. Wrapping here rather than in `registerTools` keeps that true for
    // any consumer of a ToolDef, including a transport that mounts its own.
    return defs.map((d) => ({ tool: withAnnotatedTitle(d.tool), handler: guard(d.handler) }));
}

function lookupTools(ctx: ToolContext): ToolDef[] {
    return [
        {
            tool: {
                name: 'lookup_ip',
                title: 'Look up an IP address',
                description: 'What every database InternetData publishes says about one IPv4 or IPv6 '
                    + 'address: where it is, which network announces it, who uses it, its abuse contact and '
                    + 'reverse DNS name; whether it is a Tor node, a privacy relay, anycast, or a mobile '
                    + 'carrier\'s or satellite operator\'s space; whether an SSH, mail, web, open DNS '
                    + 'resolver or BitTorrent service answered on it; whether it is a VPN, a residential, '
                    + 'datacenter, mobile or public proxy, a hosting provider or a CDN; and its Whois and '
                    + 'RWHOIS records and how many domains it hosts. Unlimited, the free plan, answers with '
                    + 'a key or without one: the location to its country, the network, the company, the '
                    + 'abuse email, the reverse DNS name, and the Tor, relay, anycast, carrier, satellite '
                    + `and service flags, with the Tor and relay detail. ${PAID} `
                    + 'Private and reserved addresses are answered locally, without calling the API. '
                    + 'Always read `coverage.note` before concluding anything from a field that is not in '
                    + 'the result.',
                inputSchema: jsonSchema(LOOKUP_INPUT),
                outputSchema: objectSchema({
                    result: LOOKUP_RESULT_SCHEMA,
                    coverage: COVERAGE_SCHEMA,
                }, ['result', 'coverage']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: (args) => lookupIp(ctx, args),
        },
        {
            tool: {
                name: 'lookup_ips',
                title: 'Look up several IP addresses',
                description: 'Look up a list of addresses in one call, returning a map keyed by address so '
                    + 'duplicates collapse and the order you passed them stops mattering. Each answer is '
                    + 'what `lookup_ip` gives for that address. Pass the whole list rather than splitting it '
                    + 'yourself: a long one is batched for you. Prefer this over repeated `lookup_ip` calls '
                    + 'when you already have the list, for example when triaging a log file. A batch needs '
                    + 'a key on a paid plan: with a key on the free plan, a list of up to '
                    + `${TRIAL_SINGLE_LOOKUPS} addresses is looked up one address at a time instead, `
                    + 'and a longer one comes back refused. An address that fails carries its error in '
                    + 'place of a result rather than failing the batch. '
                    + 'Always read `coverage.note` before concluding anything from a field that is not in '
                    + 'the result.',
                inputSchema: jsonSchema(LOOKUP_BATCH_INPUT),
                outputSchema: objectSchema({
                    results: {
                        type: 'object',
                        description: 'Keyed by address. A value is either a result or an error.',
                        additionalProperties: { anyOf: [LOOKUP_RESULT_SCHEMA, ENTRY_ERROR_SCHEMA] },
                    },
                    coverage: COVERAGE_SCHEMA,
                }, ['results', 'coverage']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: (args) => lookupIps(ctx, args),
        },
        {
            tool: {
                name: 'lookup_asn',
                title: 'Look up an AS',
                description: 'What InternetData knows about one autonomous system, by its number: its '
                    + 'operator, country, registry, allocation date and domain, the kind of network it runs, '
                    + 'how many IPv4 addresses and prefixes it announces with their RPKI counts, its ASN '
                    + 'Whois record, and the prefixes it announces in global BGP with their RPKI status: the first '
                    + `${ASN_PREFIXES_SHOWN}, with \`truncated\` giving the total where it announces more. An AS `
                    + 'no database knows comes back as its number with empty values. Unlimited, the free '
                    + 'plan, answers its operator, country, registry, allocation date and domain, with a key '
                    + `or without one. ${PAID} `
                    + 'Always read `coverage.note` before concluding anything from a field that is not in '
                    + 'the result.',
                inputSchema: jsonSchema(ASN_INPUT),
                outputSchema: objectSchema({
                    result: ASN_LOOKUP_RESULT_SCHEMA,
                    coverage: COVERAGE_SCHEMA,
                    truncated: TRUNCATED_SCHEMA,
                }, ['result', 'coverage']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: async (args) => {
                const { asn } = ASN_INPUT.parse(args);
                const body = wireBody(await ctx.client.lookupAsn(asn));
                const coverage = coverageOf(body, 'asn');
                const prefixes = body['prefixes'];
                if (!Array.isArray(prefixes) || prefixes.length <= ASN_PREFIXES_SHOWN) {
                    return ok({ result: body, coverage: coverage });
                }
                return ok({
                    result: { ...body, prefixes: prefixes.slice(0, ASN_PREFIXES_SHOWN) },
                    coverage: coverage,
                    truncated: {
                        prefixes: { shown: ASN_PREFIXES_SHOWN, total: prefixes.length },
                        note: `The first ${ASN_PREFIXES_SHOWN} of the ${prefixes.length} prefixes this AS announces. `
                            + `The API's GET /asn/${asn} returns every one.`,
                    },
                });
            },
        },
        {
            tool: {
                name: 'lookup_domain',
                title: 'Look up a domain',
                description: 'What InternetData knows about one domain, from its latest snapshots rather '
                    + 'than a live DNS query: whether it is registered, which DNS record types it has, the '
                    + 'records themselves, its organization\'s IP ranges, and whether it is a disposable '
                    + 'email domain. Unlimited, the free plan, answers whether it is registered and which '
                    + `record types it has, with a key or without one. ${PAID} `
                    + 'Always read `coverage.note` before concluding anything from a field that is not in '
                    + 'the result.',
                inputSchema: jsonSchema(DOMAIN_INPUT),
                outputSchema: objectSchema({
                    result: DOMAIN_LOOKUP_RESULT_SCHEMA,
                    coverage: COVERAGE_SCHEMA,
                }, ['result', 'coverage']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true,
                },
            },
            handler: async (args) => {
                const { domain } = DOMAIN_INPUT.parse(args);
                const body = wireBody(await ctx.client.lookupDomain(domain));
                return ok({ result: body, coverage: coverageOf(body, 'domain') });
            },
        },
    ];
}

async function lookupIp(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
    const { ip } = LOOKUP_INPUT.parse(args);
    const body = wireBody(await ctx.client.lookup(ip));
    return ok({ result: body, coverage: coverageOf(body) });
}

async function lookupIps(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
    const { ips } = LOOKUP_BATCH_INPUT.parse(args);

    const answers: Map<string, unknown> = await ctx.client.lookupBatch(ips);
    const refused = [...answers.keys()].filter((addr) => asClientError(answers.get(addr))?.status === 402);
    const single = refused.length <= TRIAL_SINGLE_LOOKUPS;
    if (single) {
        for (const addr of refused) {
            answers.set(addr, await lookupOne(ctx, addr));
        }
    }
    // Each address is the caller's own string, and assigning one to a plain object
    // turns `__proto__` into the object's prototype rather than a key, so that entry
    // would vanish from the answer. fromEntries defines every address as a key of its own.
    const results: [string, unknown][] = [];
    const served: Record<string, unknown>[] = [];
    for (const [addr, answer] of answers) {
        const failed = asClientError(answer);
        if (failed !== undefined) {
            let message = failed.message;
            if (!single && failed.status === 402) {
                message += `. With this key, pass at most ${TRIAL_SINGLE_LOOKUPS} addresses at a time, `
                    + 'which are looked up one at a time.';
            }
            results.push([addr, { error: { kind: failed.kind, message: message } }]);
            continue;
        }
        const body = wireBody(answer as Result);
        results.push([addr, body]);
        served.push(body);
    }
    return ok({ results: Object.fromEntries(results), coverage: batchCoverage(served) });
}

/** One address looked up on its own, its failure kept as that address's answer. */
async function lookupOne(ctx: ToolContext, addr: string): Promise<unknown> {
    try {
        return await ctx.client.lookup(addr);
    } catch (err) {
        if (asClientError(err) === undefined) {
            throw err;
        }
        return err;
    }
}

/**
 * The answer in the names the API publishes, which is what a model has read the
 * docs in and what this server's `outputSchema` declares. The SDK keeps it as
 * `raw`, a bogon's included: it answers one locally in the shape the API answers
 * one on a paid plan, every flag false and every detail empty.
 */
function wireBody(answer: { raw: object }): Record<string, unknown> {
    return answer.raw as Record<string, unknown>;
}

/**
 * What the presented key is entitled to, and what it has spent.
 *
 * There is deliberately NO `my_ip` counterpart. The SDKs have one, but over a
 * HOSTED transport the address our edge observes belongs to whatever proxied the
 * call - Claude's infrastructure, not the person asking - so the tool would answer
 * confidently and wrongly for the reading a model would put on it. The account is
 * the same answer whoever forwards the request, because it describes the
 * credential rather than the connection.
 */
function accountTool(ctx: ToolContext): ToolDef {
    return {
        tool: {
            name: 'my_entitlement',
            title: 'Plan and usage for this key',
            description: 'What this API key is entitled to and how much of it has been used: the '
                + 'plan, the field tier that decides how much of a lookup answer comes back, the '
                + 'requests counted so far, the allowance, and when it resets. Use it to explain '
                + 'why a field is missing from a lookup, or before a large batch. A paid plan\'s '
                + 'usage counts against the anniversary of the subscription rather than the '
                + 'calendar month; the free plan\'s counts the lookups its daily trial answered with '
                + 'every field, against the UTC day. Either can lag a few seconds behind. A null '
                + '`hard_limit` means we never stop serving - it is NOT a limit of zero.',
            inputSchema: jsonSchema(NO_INPUT),
            outputSchema: objectSchema({
                entitlement: ENTITLEMENT_SCHEMA,
            }, ['entitlement']),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                // Not idempotent: the number it reports moves with every other
                // call, which is the whole point of asking.
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        handler: async (args) => {
            NO_INPUT.parse(args);
            return ok({ entitlement: await ctx.client.myEntitlement() });
        },
    };
}

function databaseTools(ctx: ToolContext): ToolDef[] {
    return [
        {
            tool: {
                name: 'list_databases',
                title: 'List databases',
                description: 'The IP database catalog as this API key\'s organization may see it, '
                    + 'one entry per database FAMILY, with `standing` saying where their license '
                    + 'stands: `licensed` if the family is theirs today, `expired` if the term has '
                    + 'ended, `unlicensed` if it is published but has never been bought. Each entry '
                    + 'has a `base` ID, which is what a license names, and a `versions` array whose '
                    + '`id` is what the other database tools take - pass `versions[].id` '
                    + '(`bogon_ip_v1`), never the `base` (`bogon_ip`). Ask again rather than holding '
                    + 'on to this: it is answered per key and is not the same for everyone.',
                inputSchema: jsonSchema(NO_INPUT),
                outputSchema: objectSchema({
                    databases: { type: 'array', items: DATABASE_SCHEMA },
                }, ['databases']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            handler: async (args) => {
                NO_INPUT.parse(args);
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
                inputSchema: jsonSchema(METADATA_INPUT),
                outputSchema: DATABASE_METADATA_SCHEMA,
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            handler: async (args) => {
                const { dataset_id } = METADATA_INPUT.parse(args);
                return ok(await ctx.client.database.metadata(dataset_id));
            },
        },
        {
            tool: {
                name: 'database_checksum',
                title: 'Get a database\'s checksums',
                description: 'The published digests for one database file, for verifying a copy '
                    + 'you already hold or deciding whether a build has changed since you last '
                    + 'fetched it. It is licensed like the download itself, so a database this key '
                    + 'cannot download is refused here too. Looking up a checksum is not a '
                    + 'download and does not appear in `list_downloads`.',
                inputSchema: jsonSchema(CHECKSUM_INPUT),
                outputSchema: objectSchema({ checksums: DB_CHECKSUMS_SCHEMA }, ['checksums']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            handler: async (args) => {
                const parsed = CHECKSUM_INPUT.parse(args);
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
                inputSchema: jsonSchema(DOWNLOADS_INPUT),
                outputSchema: objectSchema({
                    downloads: { type: 'array', items: DOWNLOAD_SCHEMA },
                }, ['downloads']),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: false,
                },
            },
            handler: async (args) => {
                const { limit } = DOWNLOADS_INPUT.parse(args);
                const downloads = await ctx.client.database.downloads(
                    limit === undefined ? {} : { limit: limit });
                return ok({ downloads: downloads });
            },
        },
    ];
}

/**
 * Publishes a tool's `title` in `annotations.title` too. MCP clients show the
 * top-level one, while Claude's connector directory reads the annotation and
 * flags every tool without it; copying it here writes each title once.
 */
function withAnnotatedTitle(tool: Tool): Tool {
    return { ...tool, annotations: { title: tool.title, ...tool.annotations } };
}

/** Mounts a manifest on a server. Both transports use this and nothing else. */
export function registerTools(server: Server, defs: ToolDef[]): void {
    const byName = new Map(defs.map((d) => [d.tool.name, d]));

    server.setRequestHandler('tools/list', () => {
        return { tools: defs.map((d) => d.tool) };
    });

    server.setRequestHandler('tools/call', async (req) => {
        const def = byName.get(req.params.name);
        if (def === undefined) {
            // The caller's mistake, as the MCP spec and the SDK's own McpServer
            // answer it. A plain Error would reach the client as -32603, "the
            // server broke", for a model that only guessed a tool name.
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
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
 * summary beside it. The coverage note lives inside the structure, so writing
 * it once puts it in front of both a client that reads `structuredContent` and
 * one that only renders `content`.
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
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: errorDetail(err) }, null, 2) }],
        isError: true,
    };
}

function errorDetail(err: unknown): Record<string, unknown> {
    const known = asClientError(err);
    if (known !== undefined) {
        return { kind: known.kind, message: known.message, retryable: known.retryable === true };
    }
    const rejected = asZodError(err);
    if (rejected !== undefined) {
        // The MODEL's own mistake, and the one failure it can fix unaided - so
        // it must not arrive as `internal`, which reads as "the server broke"
        // and invites an identical retry. zod's formatter names the field and
        // what was expected; the raw `issues` array is JSON a model has to
        // decode before it can act on it.
        return {
            kind: 'invalid_argument',
            message: rejectionMessage(rejected),
            retryable: false,
        };
    }
    return { kind: 'internal', message: err instanceof Error ? err.message : String(err) };
}

// zod reports an array argument one issue per bad element, so listing every issue would
// turn a megabyte of numbers passed as `ips` into tens of megabytes of error text. The
// first few say as much.
const ISSUES_LISTED = 10;

function rejectionMessage(rejected: z.ZodError): string {
    const listed = z.prettifyError({ issues: rejected.issues.slice(0, ISSUES_LISTED) });
    const unlisted = rejected.issues.length - ISSUES_LISTED;
    if (unlisted <= 0) {
        return listed;
    }
    return `${listed}\n... and ${unlisted} more ${unlisted === 1 ? 'issue' : 'issues'}`;
}

/**
 * Recognizes an `InternetDataError` by SHAPE, not by `instanceof`.
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
    status?: number;
    retryable?: boolean;
}

/**
 * Recognizes a rejected ARGUMENT by shape, for the same reason `asClientError`
 * does: zod is a peer of two packages here and each may resolve its own copy,
 * so `instanceof z.ZodError` would quietly miss one and report a fixable
 * argument error as an unfixable internal one.
 */
function asZodError(err: unknown): z.ZodError | undefined {
    if (err === null || typeof err !== 'object') {
        return undefined;
    }
    const e = err as { name?: unknown; issues?: unknown };
    if (e.name !== 'ZodError' || !Array.isArray(e.issues)) {
        return undefined;
    }
    return err as z.ZodError;
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
