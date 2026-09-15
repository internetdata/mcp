// Exercises the PUBLISHED server, spawned the way a client spawns it, against
// the staging API.
//
// The unit suite stubs the network, so it cannot see what matters most here:
// that the ids a model reads out of `list_databases` are the ids the other
// tools actually accept. Everything below is derived from the live listing -
// a hardcoded database id turns a license change into a red build that says
// nothing about the server.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { skipForNoKey, stagingKey } from '../lib/key.mjs';

const BASE_URL = 'https://staging.internetdata.io';
const TOOL_NAMES = ['list_databases', 'database_metadata', 'database_checksum', 'list_downloads'];

const NO_KEY = skipForNoKey();

async function connect({ withKey = true } = {}) {
    const transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', 'internetdata-mcp'],
        env: {
            ...process.env,
            INTERNETDATA_BASE_URL: BASE_URL,
            INTERNETDATA_API_KEY: withKey ? stagingKey() : '',
        },
    });
    const client = new Client({ name: 'integration', version: '0' });
    await client.connect(transport);
    return client;
}

async function withClient(fn, opts) {
    const client = await connect(opts);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

function structured(out) {
    assert.notEqual(out.isError, true, `tool failed: ${out.content?.[0]?.text}`);
    return out.structuredContent;
}

// The one test that needs no credential: the package resolves, the `bin`
// runs, and the manifest is what this version claims. A broken `files` list
// fails here and nowhere else.
test('the server starts and lists its tools', async () => {
    await withClient(async (client) => {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
        assert.ok(!tools.some((t) => t.name.includes('download') && t.name !== 'list_downloads'));
        for (const t of tools) {
            assert.equal(t.annotations.readOnlyHint, true, `${t.name} is not read-only`);
        }
    }, { withKey: false });
});

// Every endpoint is authenticated, so this is what a keyless caller sees. It
// has to be a readable tool error the model can act on, not a crashed server.
test('no key gets a readable refusal, not a crash', async () => {
    await withClient(async (client) => {
        const out = await client.callTool({ name: 'list_databases', arguments: {} });
        assert.equal(out.isError, true);
        assert.equal(out.structuredContent, undefined,
            'an error must not be validated against the outputSchema');
        assert.equal(JSON.parse(out.content[0].text).error.kind, 'unauthorized');
    }, { withKey: false });
});

test('the catalog answers what this key is entitled to see', { skip: NO_KEY }, async () => {
    await withClient(async (client) => {
        const { databases } = structured(
            await client.callTool({ name: 'list_databases', arguments: {} }));

        assert.ok(databases.length > 0, 'the staging catalog is empty');
        for (const db of databases) {
            assert.equal(typeof db.base, 'string');
            assert.ok(['licensed', 'expired', 'unlicensed'].includes(db.standing),
                `${db.base} carries standing ${db.standing}`);
            assert.ok(Array.isArray(db.versions) && db.versions.length > 0,
                `${db.base} carries no versions`);
        }
    });
});

// The trap the tool descriptions exist to close, checked against the real API
// rather than a fixture: the versioned id works and the base id does not, so a
// description that stopped saying so would be a silent regression.
test('a versioned id is accepted where the base id is refused', { skip: NO_KEY }, async () => {
    await withClient(async (client) => {
        const { databases } = structured(
            await client.callTool({ name: 'list_databases', arguments: {} }));
        const family = databases.find((db) => db.standing === 'licensed');
        if (family === undefined) {
            return;
        }
        const version = family.versions[family.versions.length - 1];

        const meta = structured(await client.callTool({
            name: 'database_metadata', arguments: { dataset_id: version.id },
        }));
        assert.equal(meta.id, version.id, 'metadata must answer at the top level, not wrapped');
        assert.equal(typeof meta.entries, 'number');
        assert.ok(version.formats.every((f) => typeof meta.size[f] === 'number'),
            `${version.id} publishes a format with no size`);

        const refused = await client.callTool({
            name: 'database_metadata', arguments: { dataset_id: family.base },
        });
        assert.equal(refused.isError, true, `the base id ${family.base} was accepted`);
    });
});

test('checksums come back nested, for a real licensed build', { skip: NO_KEY }, async () => {
    await withClient(async (client) => {
        const { databases } = structured(
            await client.callTool({ name: 'list_databases', arguments: {} }));
        const family = databases.find((db) => db.standing === 'licensed');
        if (family === undefined) {
            return;
        }
        const version = family.versions[family.versions.length - 1];

        const out = structured(await client.callTool({
            name: 'database_checksum',
            arguments: { dataset_id: version.id, format: version.formats[0] },
        }));
        assert.equal(out.sha256, undefined, 'digests must stay under `checksums`');
        assert.equal(typeof out.checksums.sha256, 'string');
        assert.equal(out.checksums.sha256.length, 64);
    });
});

// Bounded server-side at 200 however large a limit is asked for, which is what
// the tool description promises a model.
test('the download history is this org\'s own and stays bounded', { skip: NO_KEY }, async () => {
    await withClient(async (client) => {
        const { downloads } = structured(await client.callTool({
            name: 'list_downloads', arguments: { limit: 200 },
        }));
        assert.ok(Array.isArray(downloads));
        assert.ok(downloads.length <= 200, `the API returned ${downloads.length} rows`);
        for (const d of downloads) {
            assert.equal(typeof d.dataset_id, 'string');
            assert.ok(['ok', 'unauthorized', 'denied', 'expired', 'unknown', 'unavailable']
                .includes(d.outcome), `unexpected outcome ${d.outcome}`);
        }

        const over = await client.callTool({ name: 'list_downloads', arguments: { limit: 201 } });
        assert.equal(over.isError, true, 'over the published cap must be refused here, not clamped');
    });
});
