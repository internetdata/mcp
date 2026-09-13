// The manifest itself, and the behaviours a transport relies on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { InternetData } from '@internetdata/internetdata';

import { createTools, DOWNLOADS_LIMIT } from '../dist/index.js';

// MCP names the allowed characters explicitly; a name outside them is a tool
// some clients will refuse to surface at all.
const NAME_CHARS = /^[A-Za-z0-9_.-]{1,128}$/;

const TOOL_NAMES = ['list_databases', 'database_metadata', 'database_checksum', 'list_downloads'];

// One family, both standings, so a fixture cannot be tuned to a single shape.
const CATALOG = {
    databases: [
        {
            base: 'bogon_ip',
            name: 'Bogon IP',
            summary: 'Non-routable address space.',
            standing: 'licensed',
            license_type: 'standard',
            starts: '2026-01-01T00:00:00.000Z',
            expires: null,
            renews_at: null,
            notice_due_at: null,
            versions: [
                { id: 'bogon_ip_v1', version: 1, summary: 'v1', formats: ['csvgz', 'mmdb'] },
            ],
        },
        {
            base: 'hosting_ip',
            name: 'Hosting IP',
            summary: 'Hosting provider address space.',
            standing: 'unlicensed',
            license_type: null,
            starts: null,
            expires: null,
            renews_at: null,
            notice_due_at: null,
            versions: [
                { id: 'hosting_ip_v1', version: 1, summary: 'v1', formats: ['csvgz'] },
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

function toolsFor(fetchImpl) {
    const client = new InternetData({ apiKey: 'k', fetch: fetchImpl });
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

// The databases reach several GB. An agent that treats a tool result as text
// will try to read one, so the capability is absent rather than discouraged.
test('no tool downloads a database', () => {
    const names = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    assert.deepEqual(names, TOOL_NAMES);
    for (const n of names) {
        assert.doesNotMatch(n, /download(?!s$)/, 'a download tool would hand an agent a multi-GB file');
    }
});

test('the tool list is deterministic, so clients can cache it', () => {
    const a = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    const b = toolsFor(serving(CATALOG).fetch).map((d) => d.tool.name);
    assert.deepEqual(a, b);
});

// Both spellings exist and only one is accepted, so the description is the only
// thing standing between a model that has just read `base` and a refusal that
// looks like a missing database.
test('every id-taking tool names both spellings', () => {
    const tools = byName(serving(CATALOG).fetch);
    for (const n of ['database_metadata', 'database_checksum']) {
        const described = tools.get(n).tool.inputSchema.properties.dataset_id.description;
        assert.match(described, /versions\[\]\.id/, `${n}: does not name the versioned id`);
        assert.match(described, /base/, `${n}: does not warn about the base id`);
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
        ['list_downloads', { downloads: [] }, {}],
    ];
    for (const [name, body, args] of cases) {
        const def = byName(serving(body).fetch).get(name);
        const validate = ajv.compile(def.tool.outputSchema);
        const out = await def.handler(args);
        assert.ok(validate(out.structuredContent), `${name}: ${ajv.errorsText(validate.errors)}`);
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
            dataset_id: 'hosting_ip_v1', format: 'csvgz', outcome: 'denied', bytes: 0,
            http_status: 403, apikey_id: 'k1', client_ip: '198.51.100.9',
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

test('an unrecognised throw still produces a readable error', async () => {
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
    }
});

// The cap is READ off the spec, not restated here: the API clamps to it, and a
// second hand-written copy is free to keep advertising the old number.
test('the downloads cap comes from the spec', () => {
    const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8'));
    const limit = spec.paths['/api/v2/database/downloads'].get.parameters
        .find((p) => p.name === 'limit' && p.in === 'query');
    assert.equal(DOWNLOADS_LIMIT, limit.schema.maximum);
});

// Rejects from the CLIENT rather than from fetch: the SDK's own retry layer
// turns a transport throw into its own `network` error, so a stub one level
// lower would never reach the classifier under test.
function throwingClient(err) {
    const client = { database: { list: async () => { throw err } } };
    return createTools({ client: client }).find((d) => d.tool.name === 'list_databases');
}
