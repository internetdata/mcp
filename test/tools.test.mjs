// The manifest itself, and the behaviors a transport relies on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { InternetData } from '@internetdata/internetdata';

import { createTools, DOWNLOADS_LIMIT, registerTools } from '../dist/index.js';
import { clientOptions } from '../dist/env.js';

// MCP names the allowed characters explicitly; a name outside them is a tool
// some clients will refuse to surface at all.
const NAME_CHARS = /^[A-Za-z0-9_.-]{1,128}$/;

const TOOL_NAMES = [
    'lookup_ip', 'lookup_ips', 'lookup_asn', 'lookup_domain', 'my_entitlement', 'list_databases',
    'database_metadata', 'database_checksum', 'list_downloads',
];

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

// An Unlimited answer from the shared corpus, re-addressed: the client SDK refuses an
// answer missing a member every plan is served, so a stub cannot serve less.
const UNLIMITED = data.lookup.find((c) => c.name === 'unlimited-answer').body;

function answerFor(ip, extra = {}) {
    return { ...UNLIMITED, ip: ip, ...extra };
}

// One family, both standings, so a fixture cannot be tuned to a single shape.
const CATALOG = {
    databases: [
        {
            base: 'bogon_ip',
            name: 'Bogon IP',
            summary: 'Non-routable address space.',
            standing: 'licensed',
            open: true,
            license_type: 'standard',
            starts: '2026-01-01T00:00:00.000Z',
            expires: null,
            renews_at: null,
            notice_due_at: null,
            versions: [
                {
                    id: 'bogon_ip_v1', version: 1, summary: 'v1', formats: ['csvgz', 'mmdb'],
                    sample_formats: [],
                },
            ],
        },
        {
            base: 'hosting_ip',
            name: 'Hosting IP',
            summary: 'Hosting provider address space.',
            standing: 'unlicensed',
            open: false,
            license_type: null,
            starts: null,
            expires: null,
            renews_at: null,
            notice_due_at: null,
            versions: [
                {
                    id: 'hosting_ip_v1', version: 1, summary: 'v1', formats: ['csvgz'],
                    sample_formats: ['csvgz'],
                },
            ],
        },
    ],
};

const METADATA = {
    id: 'bogon_ip_v1',
    update_freq: 'daily',
    updated: '2026-09-09',
    entries: 1234,
    schema: { csvgz: [{ name: 'range_start', type: 'string', description: 'first address' }] },
    sample: { csvgz: [{ range_start: '10.0.0.0' }] },
    size: { csvgz: 4096, mmdb: 8192 },
};

const CHECKSUMS = {
    md5: 'a'.repeat(32), sha1: 'b'.repeat(40), sha256: 'c'.repeat(64), sha512: 'd'.repeat(128),
};

// Every nullable field null at once, so the schema has to admit each of them.
// `sample` and `open` are required as well, and not nullable.
const NULL_DOWNLOADS = {
    downloads: [{
        dataset_id: 'hosting_ip_v1', format: 'csvgz', outcome: 'unknown', sample: false, open: false,
        bytes: null, http_status: null, apikey_id: null, client_ip: null, user_agent: null,
        created: '2026-09-12T10:00:00.000Z',
    }],
};

function toolsFor(fetchImpl) {
    const client = new InternetData({ apiKey: 'k', cache: false, fetch: fetchImpl });
    return createTools({ client: client });
}

function byName(fetchImpl) {
    return new Map(toolsFor(fetchImpl).map((d) => [d.tool.name, d]));
}

function serving(body, status = 200) {
    const state = { calls: 0 };
    const fn = async () => {
        state.calls++;
        return new Response(JSON.stringify(body), {
            status: status, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, state: state };
}

function validator() {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    return ajv;
}

test('every tool is well formed', () => {
    for (const { tool } of toolsFor(serving(CATALOG).fetch)) {
        assert.match(tool.name, NAME_CHARS, tool.name);
        assert.ok(tool.description.length > 40, `${tool.name}: description too thin`);
        assert.equal(tool.inputSchema.type, 'object', tool.name);
        assert.ok(tool.outputSchema, `${tool.name}: no outputSchema`);
        assert.equal(tool.annotations.readOnlyHint, true, `${tool.name}: must be read-only`);
    }
});

// Claude's connector directory reads a tool's name from `annotations.title` and
// flags every tool without one, however the top-level `title` reads. Both are
// published, and they are the same string.
test('every tool carries its title in its annotations too', () => {
    for (const { tool } of toolsFor(serving(CATALOG).fetch)) {
        assert.ok(tool.title, `${tool.name}: no title`);
        assert.equal(tool.annotations.title, tool.title, `${tool.name}: annotations.title`);
    }
});

// OpenAI's plugin review requires all three hints as explicit booleans on every
// tool; an absent destructiveHint means true to an MCP client.
test('every tool states whether it reads, destroys and reaches the open world', () => {
    for (const { tool } of toolsFor(serving(CATALOG).fetch)) {
        for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
            assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}: ${hint}`);
        }
        assert.equal(tool.annotations.destructiveHint, false, `${tool.name}: destructiveHint`);
    }
});

// OpenAI's openWorldHint is a public or open-ended set of entities: any address, AS or domain is
// one, where the account, our own catalog and the organization's own downloads are bounded.
test('only the lookups reach the open world', () => {
    const open = toolsFor(serving(CATALOG).fetch).filter((d) => d.tool.annotations.openWorldHint);
    assert.deepEqual(open.map((d) => d.tool.name),
        ['lookup_ip', 'lookup_ips', 'lookup_asn', 'lookup_domain']);
});

// The databases reach several GB. An agent that treats a tool result as text
// will try to read one, so the capability is absent rather than discouraged.
test('no tool downloads a database', () => {
    const names = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    assert.deepEqual(names, TOOL_NAMES);
    for (const n of names) {
        assert.doesNotMatch(n, /download(?!s$)/, 'a download tool would hand an agent a multi-GB file');
    }
});

// Uncapped by decision: the caller's whole list goes in one call and the SDK
// splits it at the endpoint's own bound. A private address is answered locally,
// so it never takes room in a batch.
test('lookup_ips takes any number of addresses, one POST /batch per 1000', async () => {
    const posts = [];
    const batchServer = async (input) => {
        const { ips } = JSON.parse(await input.text());
        posts.push({ method: input.method, path: new URL(input.url).pathname, ips: ips });
        const results = Object.fromEntries(ips.map((ip) => [ip, answerFor(ip)]));
        return new Response(JSON.stringify({ results: results, errors: {} }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const batch = toolsFor(batchServer).find((d) => d.tool.name === 'lookup_ips');
    assert.equal(batch.tool.inputSchema.properties.ips.maxItems, undefined, 'no cap is published');

    const routable = Array.from({ length: 2500 }, (_, i) => `9.9.${(i >> 8) & 255}.${i & 255}`);
    const bogons = Array.from({ length: 100 }, (_, i) => `10.0.0.${i}`);
    const out = await batch.handler({ ips: [...routable, ...bogons] });

    assert.equal(out.isError, undefined, 'a long list must be answered, not refused');
    assert.deepEqual(posts.map((p) => `${p.method} ${p.path}`), Array(3).fill('POST /batch'));
    assert.deepEqual(posts.map((p) => p.ips.length).sort((a, b) => b - a), [1000, 1000, 500]);
    assert.deepEqual(posts.flatMap((p) => p.ips).sort(), [...routable].sort(),
        'every routable address is sent exactly once, and no private one is sent at all');

    const { results } = out.structuredContent;
    assert.equal(Object.keys(results).length, 2600, 'one entry per address');
    assert.ok(routable.every((ip) => results[ip].is_bogon === false), 'a served answer per address');
    assert.ok(bogons.every((ip) => results[ip].is_bogon === true), 'a local answer per bogon');
});

test('every lookup fixture validates against the published outputSchema', async () => {
    const ajv = validator();
    const tools = { lookup: 'lookup_ip', lookupAsn: 'lookup_asn', lookupDomain: 'lookup_domain' };
    const args = { lookup: 'ip', lookupAsn: 'asn', lookupDomain: 'domain' };
    for (const c of data.lookup) {
        const def = byName(serving(c.body, c.status).fetch).get(tools[c.call]);
        const validate = ajv.compile(def.tool.outputSchema);
        const out = await def.handler({ [args[c.call]]: c.target });
        assert.equal(out.isError, undefined, `${c.name}: ${out.content[0].text}`);
        assert.ok(validate(out.structuredContent), `${c.name}: ${ajv.errorsText(validate.errors)}`);
    }
});

test('a bogon answer also validates, and declares every member it carries', async () => {
    const ajv = validator();
    const tools = byName(serving({}).fetch);
    const one = tools.get('lookup_ip');
    const many = tools.get('lookup_ips');
    const undeclared = (answer, schema) => Object.keys(answer).filter((k) => !(k in schema.properties));

    const single = await one.handler({ ip: '10.0.0.1' });
    const validate = ajv.compile(one.tool.outputSchema);
    assert.ok(validate(single.structuredContent), ajv.errorsText(validate.errors));
    const resultSchema = one.tool.outputSchema.properties.result;
    assert.deepEqual(undeclared(single.structuredContent.result, resultSchema), []);

    const entry = (await many.handler({ ips: ['10.0.0.1'] })).structuredContent.results['10.0.0.1'];
    const entrySchema = many.tool.outputSchema.properties.results.additionalProperties.anyOf[0];
    assert.deepEqual(undeclared(entry, entrySchema), []);
});

// What the API answers a free-plan key: a batch of two or more refused with a 402,
// and a single lookup answered.
function trialServer(calls) {
    return async (input) => {
        const path = new URL(input.url).pathname;
        calls.push(`${input.method} ${path}`);
        if (path === '/batch') {
            return new Response('{"error":"POST /batch needs a paid plan"}', {
                status: 402, headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(answerFor(path.slice(1), { trial_expired: true })), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
}

test("a free-plan key's short list is looked up one address at a time", async () => {
    const calls = [];
    const batch = toolsFor(trialServer(calls)).find((d) => d.tool.name === 'lookup_ips');
    const ips = ['9.9.9.1', '9.9.9.2', '10.0.0.1'];

    const out = await batch.handler({ ips: ips });

    assert.equal(out.isError, undefined);
    const { results } = out.structuredContent;
    assert.deepEqual(Object.keys(results), ips);
    for (const ip of ['9.9.9.1', '9.9.9.2']) {
        assert.equal(results[ip].ip, ip);
        assert.equal(results[ip].trial_expired, true, `${ip} is the single lookup's answer`);
    }
    assert.equal(results['10.0.0.1'].is_bogon, true);
    assert.deepEqual(calls, ['POST /batch', 'GET /9.9.9.1', 'GET /9.9.9.2']);
});

test("a free-plan key's long list keeps the refusal, and says what to pass instead", async () => {
    const calls = [];
    const batch = toolsFor(trialServer(calls)).find((d) => d.tool.name === 'lookup_ips');
    const ips = Array.from({ length: 11 }, (_, i) => `9.9.9.${i + 1}`);

    const out = await batch.handler({ ips: ips });

    const { results } = out.structuredContent;
    for (const ip of ips) {
        assert.equal(results[ip].error.kind, 'bad_request', ip);
        assert.match(results[ip].error.message, /POST \/batch needs a paid plan/, ip);
        assert.match(results[ip].error.message, /at most 10 addresses/, ip);
    }
    assert.deepEqual(calls, ['POST /batch'], 'no address is looked up on its own');
});

// A batch answer holds results AND the package's own entry errors side by side,
// so the map's value schema has to admit both shapes.
test('a batch with a failed address validates against the published outputSchema', async () => {
    const ajv = validator();
    const body = {
        results: { '9.9.9.9': answerFor('9.9.9.9') },
        errors: { 'nope': { status: 400, error: 'not a valid IP address, AS number or domain' } },
    };
    const batch = byName(serving(body).fetch).get('lookup_ips');
    const validate = ajv.compile(batch.tool.outputSchema);

    const out = await batch.handler({ ips: ['9.9.9.9', 'nope'] });

    assert.equal(out.isError, undefined, 'one failed address must not fail the batch');
    const { results } = out.structuredContent;
    assert.equal(results['9.9.9.9'].is_bogon, false, 'the served address carries its result');
    assert.equal(results['nope'].error.kind, 'bad_request', 'the failed address carries its error');
    assert.ok(validate(out.structuredContent), ajv.errorsText(validate.errors));
});

// An address is the caller's own string, and `__proto__` assigned to a plain object
// sets its prototype rather than a key, which would drop that entry from the answer.
test('lookup_ips answers every address it was given, __proto__ included', async () => {
    const body = `{"results":{"9.9.9.9":${JSON.stringify(answerFor('9.9.9.9'))}},`
        + '"errors":{"__proto__":{"status":400,"error":"not a valid IP address, AS number or domain"}}}';
    const batch = toolsFor(async () => new Response(body, {
        status: 200, headers: { 'content-type': 'application/json' },
    })).find((d) => d.tool.name === 'lookup_ips');

    const out = await batch.handler({ ips: ['9.9.9.9', '__proto__'] });

    const { results } = out.structuredContent;
    assert.deepEqual(Object.keys(results), ['9.9.9.9', '__proto__']);
    assert.equal(Object.getPrototypeOf(results), Object.prototype, 'no address becomes a prototype');
    // Its kind is the client SDK's classification, so only its presence is this package's.
    assert.equal(typeof JSON.parse(out.content[0].text).results['__proto__'].error.kind, 'string',
        'the text block carries the entry too');
});

const ENTITLEMENT_BODY = {
    org_id: '85bb51e4-2eb6-4a31-8e4d-02ba8b98fe61',
    apikey: { id: '0ab424cc-7619-4dad-b027-afacdc2cedb0', expires: null, allowed_cidrs: [] },
    plan: { key: 'max', tier: 'max' },
    usage: {
        requests: 580,
        quota: 5000000,
        hard_limit: null,
        window_start: '2026-09-04T07:00:00Z',
        window_end: '2026-10-04T07:00:00Z',
    },
};

// Each lookup reaches the path the API answers it at, through the SDK.
test('each lookup calls its own route', async () => {
    const bodies = {
        '/9.9.9.9': answerFor('9.9.9.9'),
        '/asn/9009': data.lookup.find((c) => c.name === 'asn-unlimited-answer').body,
        '/domain/example.com': data.lookup.find((c) => c.name === 'domain-unlimited-answer').body,
        '/api/v1/entitlement': ENTITLEMENT_BODY,
    };
    const paths = [];
    const tools = byName(async (input) => {
        const path = new URL(input.url).pathname;
        paths.push(path);
        return new Response(JSON.stringify(bodies[path]), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    });
    for (const [name, args] of [
        ['lookup_ip', { ip: '9.9.9.9' }],
        ['lookup_asn', { asn: 9009 }],
        ['lookup_domain', { domain: 'example.com' }],
        ['my_entitlement', {}],
    ]) {
        const out = await tools.get(name).handler(args);
        assert.equal(out.isError, undefined, `${name}: ${out.content[0].text}`);
    }
    assert.deepEqual(paths, Object.keys(bodies));
});

test('my_entitlement reports the plan and the usage', async () => {
    const result = await byName(serving(ENTITLEMENT_BODY).fetch).get('my_entitlement').handler({});

    assert.equal(result.structuredContent.entitlement.plan.key, 'max');
    assert.equal(result.structuredContent.entitlement.plan.tier, 'max');
    assert.equal(result.structuredContent.entitlement.usage.requests, 580);
    // Null means NEVER stop, which is not the same as a limit of zero, and the
    // description says so because a model would otherwise read it as a stop.
    assert.equal(result.structuredContent.entitlement.usage.hard_limit, null);
});

test('my_entitlement validates against the published outputSchema', async () => {
    const ajv = validator();
    const def = byName(serving(ENTITLEMENT_BODY).fetch).get('my_entitlement');
    const validate = ajv.compile(def.tool.outputSchema);
    const out = await def.handler({});
    assert.equal(out.isError, undefined);
    assert.ok(validate(out.structuredContent), ajv.errorsText(validate.errors));
});

// The number it reports moves with every other call, which is the whole point
// of asking - a model told otherwise could cache it across a long session.
test('my_entitlement is not advertised as idempotent', () => {
    const def = byName(serving(ENTITLEMENT_BODY).fetch).get('my_entitlement');
    assert.equal(def.tool.annotations.idempotentHint, false);
});

// Over a hosted transport the observed address belongs to whatever proxied the
// call, so a my_ip tool would answer confidently and wrongly.
test('there is no my_ip tool', () => {
    const names = toolsFor(serving({}).fetch).map((d) => d.tool.name);
    assert.ok(!names.includes('my_ip'), 'my_ip cannot mean what a model would read it to mean');
});

test('the tool list is deterministic, so clients can cache it', () => {
    const a = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    const b = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    assert.deepEqual(a, b);
});

// Both spellings exist and only one is accepted, so the description is the only
// thing standing between a model that has just read `base` and a refusal that
// looks like a missing database.
test('every ID-taking tool names both spellings', () => {
    const tools = byName(serving(CATALOG).fetch);
    for (const n of ['database_metadata', 'database_checksum']) {
        const described = tools.get(n).tool.inputSchema.properties.dataset_id.description;
        assert.match(described, /versions\[\]\.id/, `${n}: does not name the versioned ID`);
        assert.match(described, /base/, `${n}: does not warn about the base ID`);
    }
});

// The unwrap DEPTH is the documented way these bindings break: the nodejs SDK
// shipped 1.0.x reading a top-level `sha256` off a body that nests it.
test('each tool answers at the documented depth', async () => {
    const tools = byName(serving(CATALOG).fetch);
    const listed = await tools.get('list_databases').handler({});
    assert.deepEqual(listed.structuredContent, CATALOG, 'the listing is returned as served');

    const meta = byName(serving(METADATA).fetch);
    const described = await meta.get('database_metadata').handler({ dataset_id: 'bogon_ip_v1' });
    assert.equal(described.structuredContent.id, 'bogon_ip_v1', 'metadata is NOT wrapped');
    assert.equal(described.structuredContent.size.csvgz, 4096);

    const sums = byName(serving({ id: 'bogon_ip_v1', format: 'csvgz', checksums: CHECKSUMS }).fetch);
    const digested = await sums.get('database_checksum')
        .handler({ dataset_id: 'bogon_ip_v1', format: 'csvgz' });
    assert.equal(digested.structuredContent.sha256, undefined, 'digests must stay nested');
    assert.deepEqual(digested.structuredContent.checksums, CHECKSUMS);
});

test('every tool result validates against its published outputSchema', async () => {
    const ajv = validator();
    const cases = [
        ['list_databases', CATALOG, {}],
        ['database_metadata', METADATA, { dataset_id: 'bogon_ip_v1' }],
        ['database_checksum', { id: 'x', format: 'csvgz', checksums: CHECKSUMS },
            { dataset_id: 'bogon_ip_v1', format: 'csvgz' }],
        ['list_downloads', NULL_DOWNLOADS, {}],
    ];
    for (const [name, body, args] of cases) {
        const def = byName(serving(body).fetch).get(name);
        const validate = ajv.compile(def.tool.outputSchema);
        const out = await def.handler(args);
        assert.ok(validate(out.structuredContent), `${name}: ${ajv.errorsText(validate.errors)}`);
    }
});

// JSON Schema has no `nullable`; OpenAPI 3.0 does. A validator that follows JSON
// Schema ignores the keyword and rejects the nulls above, as the Python MCP SDK
// does. Ajv honors it as an OpenAPI extension, so the test above passes with or
// without it and cannot be the check.
test('no published schema leans on OpenAPI\'s nullable', () => {
    for (const { tool } of toolsFor(serving(CATALOG).fetch)) {
        assert.deepEqual(keywordPaths(tool.inputSchema, 'nullable'), [], `${tool.name}: inputSchema`);
        assert.deepEqual(keywordPaths(tool.outputSchema, 'nullable'), [], `${tool.name}: outputSchema`);
    }
});

// Every output schema comes from the spec, never a free-form object this package
// makes up (decided 2026-09-17). The one left is the spec's own: a sample row's
// columns are whatever that database's are.
const SPEC_FREE_FORM = {
    database_metadata: ['/properties/sample/additionalProperties/items'],
};

test('no output schema is free-form unless the spec declares it', () => {
    for (const { tool } of toolsFor(serving(CATALOG).fetch)) {
        assert.deepEqual(freeFormPaths(tool.outputSchema), SPEC_FREE_FORM[tool.name] ?? [],
            `${tool.name}: outputSchema`);
    }
});

test('the downloads window is published and enforced', async () => {
    const tools = byName(serving({ downloads: [] }).fetch);
    const def = tools.get('list_downloads');
    assert.equal(def.tool.inputSchema.properties.limit.maximum, DOWNLOADS_LIMIT);

    const out = await def.handler({ limit: DOWNLOADS_LIMIT + 1 });
    assert.equal(out.isError, true, 'over the cap must be refused, not silently truncated');
    assert.equal(out.structuredContent, undefined, 'an error must not be validated as a success');
});

// A refusal is the whole point of the tool: it is what answers "it stopped
// working", and an empty history answers nothing.
test('a refused attempt is carried through, not filtered out', async () => {
    const refused = {
        downloads: [{
            dataset_id: 'hosting_ip_v1', format: 'csvgz', outcome: 'denied', sample: false, open: false,
            bytes: 0, http_status: 403, apikey_id: 'k1', client_ip: '198.51.100.9',
            user_agent: 'curl/8', created: '2026-09-12T10:00:00.000Z',
        }],
    };
    const out = await byName(serving(refused).fetch).get('list_downloads').handler({});
    assert.deepEqual(out.structuredContent, refused);
});

test('an upstream failure becomes a tool execution error, not a throw', async () => {
    const def = byName(serving({ rc: 'NOT_FOUND' }, 404).fetch).get('database_metadata');
    const out = await def.handler({ dataset_id: 'nope' });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent, undefined, 'an error must not be validated as a success');
    assert.ok(JSON.parse(out.content[0].text).error.kind, 'the error carries a kind the model can act on');
});

// The hosted server depends on this package AND on `@internetdata/internetdata`,
// so the two can each resolve their own copy of the module. Two copies of a
// class are two identities, so an `instanceof` check would quietly report every
// upstream failure as `internal` - losing the real kind and the retryable flag.
// This stands in a foreign error object carrying the right shape and no shared
// prototype, which is exactly what that situation produces.
test('an upstream error is classified by shape, not by class identity', async () => {
    const foreign = Object.assign(new Error('NOT_LICENSED'), {
        name: 'InternetDataError',
        kind: 'forbidden',
        retryable: false,
    });
    const out = await throwingClient(foreign).handler({});

    const { error } = JSON.parse(out.content[0].text);
    assert.equal(out.isError, true);
    assert.equal(error.kind, 'forbidden', 'a duplicate module copy must not degrade the kind');
    assert.equal(error.retryable, false);
});

test('an unrecognized throw still produces a readable error', async () => {
    const out = await throwingClient(new Error('socket exploded')).handler({});
    const { error } = JSON.parse(out.content[0].text);
    assert.equal(error.kind, 'internal');
});

// A bad argument is the model's OWN mistake and the only failure here it can
// fix unaided, so it must not read as `internal` - which says the server broke
// and invites the identical call again. The message has to name the field too:
// a raw zod issue array is JSON the model must decode before it can act.
test('a rejected argument is the model\'s to fix, not an internal failure', async () => {
    const tools = byName(serving({}).fetch);
    const cases = [
        ['lookup_ip', { ip: 12345 }, 'ip'],
        ['lookup_ips', { ips: [] }, 'ips'],
        ['lookup_asn', { asn: 'AS15169' }, 'asn'],
        ['lookup_asn', { asn: 1.5 }, 'asn'],
        ['lookup_asn', { asn: -1 }, 'asn'],
        ['lookup_asn', { asn: 4294967296 }, 'asn'],
        ['lookup_domain', { domain: 5 }, 'domain'],
        ['database_metadata', { dataset_id: 12345 }, 'dataset_id'],
        ['database_checksum', { dataset_id: 'bogon_ip_v1', format: 'parquet' }, 'format'],
        ['list_downloads', { limit: DOWNLOADS_LIMIT + 1 }, 'limit'],
    ];
    for (const [name, args, field] of cases) {
        const out = await tools.get(name).handler(args);
        const { error } = JSON.parse(out.content[0].text);
        assert.equal(error.kind, 'invalid_argument', `${name} must not report internal`);
        assert.equal(error.retryable, false, `${name}: the same call cannot succeed`);
        assert.match(error.message, new RegExp(field), `${name} must name the field at fault`);
        assert.doesNotMatch(error.message, /"code":/, `${name} must not be a raw issue array`);
    }
});

// zod rejects an array argument one issue per bad element. Spelled out in full, a
// megabyte of numbers passed as `ips` would come back as tens of megabytes of text.
test('a rejection lists its first ten issues and counts the rest', async () => {
    const lookupIps = byName(serving({}).fetch).get('lookup_ips');
    const cases = [
        [1, undefined],
        [10, undefined],
        [11, '... and 1 more issue'],
        [50000, '... and 49990 more issues'],
    ];
    for (const [bad, tail] of cases) {
        const res = await lookupIps.handler({ ips: Array.from({ length: bad }, (_, i) => i) });
        assert.equal(res.isError, true, `${bad} bad`);
        const { error } = JSON.parse(res.content[0].text);
        assert.equal(error.kind, 'invalid_argument', `${bad} bad`);

        const at = [...error.message.matchAll(/→ at ips\[(\d+)\]/g)].map((m) => Number(m[1]));
        const firstTen = Array.from({ length: Math.min(bad, 10) }, (_, i) => i);
        assert.deepEqual(at, firstTen, `${bad} bad: the first ten are listed, in order`);
        if (tail === undefined) {
            assert.doesNotMatch(error.message, /more issue/, `${bad} bad: nothing is left to count`);
        } else {
            assert.equal(error.message.split('\n').at(-1), tail, `${bad} bad: the rest are counted`);
        }
        assert.ok(res.content[0].text.length < 2000, `${bad} bad: ${res.content[0].text.length} chars`);
    }
});

// Every tool publishes `additionalProperties: false` and holds to it: an argument
// it does not take is refused by name, before any request. A lenient tool dropped
// a misspelled optional one and answered as if it had never been passed, so
// `{max: 10}` came back as the default 50 rows. The lookups take a routable
// address, AS or domain, which a lenient tool would have sent.
const STRAY_ARGUMENTS = [
    ['lookup_ip', { ip: '9.9.9.9', fields: 'vpn' }, 'fields'],
    ['lookup_ips', { ips: ['9.9.9.9'], fields: 'vpn' }, 'fields'],
    ['lookup_asn', { asn: 15169, fields: 'whois' }, 'fields'],
    ['lookup_domain', { domain: 'example.com', fields: 'dns' }, 'fields'],
    ['my_entitlement', { dataset_id: 'nope' }, 'dataset_id'],
    ['list_databases', { dataset_id: 'nope' }, 'dataset_id'],
    ['database_metadata', { dataset_id: 'bogon_ip_v1', format: 'csvgz' }, 'format'],
    ['database_checksum', { dataset_id: 'bogon_ip_v1', format: 'csvgz', algorithm: 'sha256' }, 'algorithm'],
    ['list_downloads', { max: 10 }, 'max'],
];

test('every tool is held to refusing an argument it does not take', () => {
    assert.deepEqual(STRAY_ARGUMENTS.map(([name]) => name), TOOL_NAMES);
});

for (const [name, args, extra] of STRAY_ARGUMENTS) {
    test(`${name} refuses an argument it does not take, before the API is asked`, async () => {
        const stub = serving(CATALOG);
        const def = byName(stub.fetch).get(name);
        assert.equal(def.tool.inputSchema.additionalProperties, false, 'the published schema says so');

        const out = await def.handler(args);
        const { error } = JSON.parse(out.content[0].text);
        assert.equal(error.kind, 'invalid_argument');
        assert.equal(error.retryable, false);
        assert.match(error.message, new RegExp(`Unrecognized key: "${extra}"`));
        assert.equal(stub.state.calls, 0, 'a refused call must not reach the API');
    });
}

// A tool name the model guessed, such as `list_datasets` from before 2.0.0, is its
// mistake too: a protocol error, since no tool exists to answer it, but never -32603.
test('an unknown tool is invalid params, not an internal error', async () => {
    const server = new Server({ name: 'test', version: '0' }, { capabilities: { tools: {} } });
    registerTools(server, toolsFor(serving({}).fetch));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    try {
        await assert.rejects(client.callTool({ name: 'list_datasets', arguments: {} }),
            { code: ProtocolErrorCode.InvalidParams, message: /Unknown tool: list_datasets/ });
    } finally {
        await client.close();
    }
});

// The installed entry point serves both protocol eras: a 2025-11-25 client opens
// with `initialize`, a 2026-07-28 one with `server/discover` and no handshake.
for (const [era, versionNegotiation] of [
    ['2025-11-25', undefined],
    ['2026-07-28', { mode: { pin: '2026-07-28' } }],
]) {
    test(`the stdio server lists the manifest to a ${era} client`, async () => {
        const client = new Client({ name: 'test', version: '0' }, { versionNegotiation: versionNegotiation });
        await client.connect(new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url))],
            env: { PATH: process.env.PATH ?? '' },
        }));
        try {
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
        } finally {
            await client.close();
        }
    });
}

test('a blank variable counts as unset, and every value is trimmed', () => {
    assert.deepEqual(clientOptions({}), {});
    assert.deepEqual(clientOptions({ INTERNETDATA_API_KEY: '', INTERNETDATA_BASE_URL: '' }), {});
    assert.deepEqual(clientOptions({ INTERNETDATA_API_KEY: ' \t', INTERNETDATA_BASE_URL: '  ' }), {});
    assert.deepEqual(
        clientOptions({ INTERNETDATA_API_KEY: ' key-1\n', INTERNETDATA_BASE_URL: ' https://api.test/ ' }),
        { apiKey: 'key-1', baseUrl: 'https://api.test/' });
});

// What reaches the API from the installed entry point, given a padded base URL
// and a padded or blank key: a blank one sends no Authorization header at all.
test('the stdio server trims its environment before the API sees it', async () => {
    const seen = [];
    const api = createServer((req, res) => {
        seen.push(req.headers.authorization);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
    });
    await new Promise((resolve) => {
        api.listen(0, '127.0.0.1', resolve);
    });
    try {
        for (const [key, authorization] of [[' key-1 ', 'Bearer key-1'], ['   ', undefined]]) {
            const client = new Client({ name: 'test', version: '0' });
            await client.connect(new StdioClientTransport({
                command: process.execPath,
                args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url))],
                env: {
                    PATH: process.env.PATH ?? '',
                    INTERNETDATA_BASE_URL: ` http://127.0.0.1:${api.address().port} `,
                    INTERNETDATA_API_KEY: key,
                },
            }));
            try {
                const out = await client.callTool({ name: 'list_databases', arguments: {} });
                assert.notEqual(out.isError, true, out.content?.[0]?.text);
                assert.deepEqual(seen.splice(0), [authorization], JSON.stringify(key));
            } finally {
                await client.close();
            }
        }
    } finally {
        api.closeAllConnections();
        api.close();
    }
});

// Every bound is READ off the spec, not restated here: the API enforces them,
// and a second hand-written copy is free to keep advertising the old number.
// The default is the one a model reads as prose, so it is asserted against the
// published description rather than against a constant.
test('the downloads bounds and default come from the spec', () => {
    const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8'));
    const limit = spec.paths['/api/v2/database/downloads'].get.parameters
        .find((p) => p.name === 'limit' && p.in === 'query');
    assert.equal(DOWNLOADS_LIMIT, limit.schema.maximum);

    const published = byName(serving({ downloads: [] }).fetch)
        .get('list_downloads').tool.inputSchema.properties.limit;
    assert.equal(published.maximum, limit.schema.maximum);
    assert.equal(published.minimum, limit.schema.minimum);
    assert.match(published.description, new RegExp(`defaults to ${limit.schema.default}\\.`));
});

// The list_databases description explains each standing in prose a model reads,
// which no generator can write. So the prose is pinned to the spec's enum: a
// standing the API adds reddens this at the re-pin that brings it, rather than
// reaching models with no word of what it means.
test('the list_databases description names every standing the spec declares', () => {
    const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8'));
    const standings = spec.components.schemas.Standing.enum;
    assert.ok(standings.length > 0, 'the spec declares no standing');

    const described = byName(serving(CATALOG).fetch).get('list_databases').tool.description;
    for (const standing of standings) {
        assert.ok(described.includes(`\`${standing}\``), `the description never names \`${standing}\``);
    }
});

// Prose writes ID and IDs in every description a tool serves, its output schema's
// included, which the generator copies from the spec. A code span is an identifier
// and keeps its spelling (`versions[].id`).
test('every description a tool serves writes ID, never id or ids', () => {
    for (const { tool } of toolsFor(serving({}).fetch)) {
        const bare = descriptions(tool)
            .filter((text) => /\b(?:id|ids|Id|Ids)\b/.test(text.replace(/`[^`]*`/g, '')));
        assert.deepEqual(bare, [], `${tool.name}: a bare id`);
    }
});

// lookup_ip's description and the README's opening sentence name every family a
// lookup flags, in prose no generator writes. Each flag the spec declares needs its
// words here, so the re-pin that adds one reddens this until both texts name it.
const FLAG_WORDS = {
    is_bogon: 'reserved',
    is_vpn: 'a VPN',
    is_tor: 'a Tor node',
    is_relay: 'a privacy relay',
    is_resproxy: 'residential',
    is_dcproxy: 'datacenter',
    is_mobproxy: 'mobile or public proxy',
    is_pubproxy: 'public proxy',
    is_hosting: 'a hosting provider',
    is_cdn: 'a CDN',
    is_anycast: 'anycast',
    is_carrier: 'carrier',
    is_satellite: 'satellite',
    is_ssh: 'SSH',
    is_smtp: 'mail',
    is_web: 'web',
    is_dns_resolver: 'open DNS resolver',
    is_bittorrent: 'BitTorrent',
};

test('lookup_ip and the README name every family the spec flags', () => {
    const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8'));
    const flags = Object.keys(spec.components.schemas.LookupResponse.properties)
        .filter((m) => m.startsWith('is_'));
    assert.deepEqual(Object.keys(FLAG_WORDS).sort(), flags.sort(),
        'a flag with no words, or words with no flag');

    const described = byName(serving({}).fetch).get('lookup_ip').tool.description;
    const intro = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
        .split('\n').find((l) => l.startsWith('It gives an AI agent'));
    assert.ok(intro, 'the README has no opening sentence to check');
    for (const [flag, words] of Object.entries(FLAG_WORDS)) {
        assert.ok(described.includes(words), `lookup_ip's description never says "${words}" (${flag})`);
        assert.ok(intro.includes(words), `the README's intro never says "${words}" (${flag})`);
    }
});

// An absent member reads as a negative finding unless the model is told otherwise,
// so every tool that answers with a coverage block says to read its note.
test('every tool that answers with coverage says to read its note', () => {
    const withCoverage = toolsFor(serving({}).fetch)
        .filter((d) => d.tool.outputSchema.properties?.coverage !== undefined);
    assert.deepEqual(withCoverage.map((d) => d.tool.name),
        ['lookup_ip', 'lookup_ips', 'lookup_asn', 'lookup_domain']);
    for (const { tool } of withCoverage) {
        assert.ok(tool.description.includes('Always read `coverage.note`'),
            `${tool.name}: the description never says to read \`coverage.note\``);
    }
});

// Each lookup's description states what Unlimited answers and what a paid plan does,
// which is the spec's plan tables in a model's words.
test('every lookup states what Unlimited and a paid plan answer', () => {
    for (const name of ['lookup_ip', 'lookup_asn', 'lookup_domain']) {
        const described = byName(serving({}).fetch).get(name).tool.description;
        assert.match(described, /Unlimited, the free plan, answers/, `${name}: Unlimited's column`);
        assert.match(described, /Every paid plan answers every field/, `${name}: the paid column`);
        assert.doesNotMatch(described, /keyless/i, `${name}: the plan is Unlimited, never "keyless"`);
    }
});

// Rejects from the CLIENT rather than from fetch: the SDK's own retry layer
// turns a transport throw into its own `network` error, so a stub one level
// lower would never reach the classifier under test.
function throwingClient(err) {
    const client = { database: { list: async () => { throw err } } };
    return createTools({ client: client }).find((d) => d.tool.name === 'list_databases');
}

// Where a keyword appears in a schema. A keyword's value is never an object, so
// a PROPERTY that happens to share the name is not mistaken for one.
function keywordPaths(node, keyword, path = '') {
    if (node === null || typeof node !== 'object') {
        return [];
    }
    return Object.entries(node).flatMap(([k, v]) => {
        if (k === keyword && (v === null || typeof v !== 'object')) {
            return [`${path}/${k}`];
        }
        return keywordPaths(v, keyword, `${path}/${k}`);
    });
}

// Every description string anywhere in `node`. A property NAMED `description`
// holds a schema, never a string, so it is walked rather than collected.
function descriptions(node) {
    if (node === null || typeof node !== 'object') {
        return [];
    }
    return Object.entries(node).flatMap(([k, v]) => {
        if (k === 'description' && typeof v === 'string') {
            return [v];
        }
        return descriptions(v);
    });
}

// Where a schema declares an object without saying what is in it: no `properties`,
// and `additionalProperties` absent or `true`.
function freeFormPaths(node, path = '') {
    if (node === null || typeof node !== 'object') {
        return [];
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const freeForm = types.includes('object') && node.properties === undefined
        && (node.additionalProperties === undefined || node.additionalProperties === true);
    return [
        ...(freeForm ? [path === '' ? '/' : path] : []),
        ...Object.entries(node).flatMap(([k, v]) => freeFormPaths(v, `${path}/${k}`)),
    ];
}
