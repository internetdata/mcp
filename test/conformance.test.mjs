// Asserts the shared conformance corpus, from the MCP server's side of it.
//
// The twelve language SDKs assert that the corpus decodes into the right client
// values. This one asserts what only a wrapper can get wrong: that the kind and
// retryability the SDK worked out still reach the MODEL, instead of being
// flattened into a generic failure it cannot act on - and that the visibility
// rules survive a layer that could so easily cache or reshape a catalog.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DATASET_FORMATS, InternetData } from '@internetdata/internetdata';

import { createTools } from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

function serving(body, status = 200, headers = {}) {
    const state = { calls: 0 };
    const fn = async () => {
        state.calls++;
        return new Response(JSON.stringify(body), {
            status: status, headers: { 'content-type': 'application/json', ...headers },
        });
    };
    return { fetch: fn, state: state };
}

function toolsFor(fetchImpl, opts = {}) {
    // Retries off: the corpus pins which failures are RETRYABLE, and asserting
    // that is separate from waiting for the SDK's backoff to run out.
    const client = new InternetData({ apiKey: 'k', retries: 0, fetch: fetchImpl, ...opts });
    return new Map(createTools({ client: client }).map((d) => [d.tool.name, d]));
}

// The error a model sees is the only thing it can act on, so every kind the
// corpus pins has to survive the trip out through a tool result. Getting this
// wrong is silent: the call still fails, just uninformatively.
test('every corpus error reaches the model with its kind and retryability', async () => {
    for (const c of data.errors) {
        const stub = serving(c.body, c.status, c.headers ?? {});
        const out = await toolsFor(stub.fetch).get('list_databases').handler({});

        assert.equal(out.isError, true, `${c.name}: must be a tool error`);
        assert.equal(out.structuredContent, undefined,
            `${c.name}: an error must not be validated against the outputSchema`);

        const { error } = JSON.parse(out.content[0].text);
        assert.equal(error.kind, c.expect.kind, `${c.name}: kind`);
        assert.equal(error.retryable, c.expect.retryable, `${c.name}: retryable`);
        assert.match(error.message, new RegExp(c.expect.message), `${c.name}: message`);
    }
});

// The pair the corpus exists to separate. Both are HTTP 429 and only the header
// tells them apart, so a wrapper that reported one flag for both would turn a
// spent allowance into a retry loop against an exhausted quota.
test('the two 429s stay distinguishable at the tool boundary', async () => {
    const transient = data.errors.find((c) => c.name === 'rate-limited-transient');
    const spent = data.errors.find((c) => c.name === 'quota-spent');

    const a = await toolsFor(serving(transient.body, 429, transient.headers).fetch)
        .get('list_databases').handler({});
    const b = await toolsFor(serving(spent.body, 429).fetch)
        .get('list_databases').handler({});

    assert.equal(JSON.parse(a.content[0].text).error.retryable, true);
    assert.equal(JSON.parse(b.content[0].text).error.retryable, false);
});

// `unknown-dataset` is a 404. Three of the first four vpndetection SDKs let a
// 4xx outside the enumerated list fall through to a retryable server_error, so
// a misspelled id was retried twice before failing.
test('a 4xx outside the enumerated ones is not retryable', async () => {
    const c = data.errors.find((x) => x.name === 'unknown-dataset');
    const out = await toolsFor(serving(c.body, c.status).fetch)
        .get('database_metadata').handler({ dataset_id: 'nope' });
    const { error } = JSON.parse(out.content[0].text);
    assert.equal(error.retryable, false, 'a bad id must not be retried');
});

test('the published formats are the vocabulary the tools accept', async () => {
    assert.deepEqual([...DATASET_FORMATS].sort(), [...data.formats].sort());

    const def = toolsFor(serving({}).fetch).get('database_checksum');
    assert.deepEqual([...def.tool.inputSchema.properties.format.enum].sort(),
        [...data.formats].sort());

    const out = await def.handler({ dataset_id: 'bogon_ip_v1', format: 'parquet' });
    assert.equal(out.isError, true, 'a format outside the vocabulary must be refused');
});

// visibility.clientRules, one test each. The corpus does not name the private
// families - it lands in public repos - so each rule is asserted as behaviour.
test('listing-is-returned-as-served: nothing is filtered, reordered or invented', async () => {
    const served = {
        databases: data.standings.map((standing, i) => ({
            base: `fam_${i}`,
            name: `Family ${i}`,
            summary: 'x',
            standing: standing,
            license_type: standing === 'licensed' ? data.license_type[0] : null,
            starts: null,
            expires: null,
            renews_at: null,
            notice_due_at: null,
            versions: [{ id: `fam_${i}_v1`, version: 1, summary: 'v1', formats: [...data.formats] }],
        })),
    };
    const out = await toolsFor(serving(served).fetch).get('list_databases').handler({});
    assert.deepEqual(out.structuredContent, served);
});

// A family this organization does not license is ABSENT, not listed as
// unlicensed, so an empty catalog is a real answer. A wrapper that padded it
// from any other source would be publishing a catalog that is not this key's.
test('no-catalog-is-compiled-into-the-client: an empty listing stays empty', async () => {
    const out = await toolsFor(serving({ databases: [] }).fetch).get('list_databases').handler({});
    assert.deepEqual(out.structuredContent, { databases: [] });
});

// The catalog is per key and per moment. A memo anywhere in this layer would
// serve one organization's entitlement to another the moment the hosted
// transport reused a client, which is the exact failure the rule names.
test('a-listing-is-never-reused-across-clients: each call asks again', async () => {
    const first = serving({ databases: [] });
    const tools = toolsFor(first.fetch);
    await tools.get('list_databases').handler({});
    await tools.get('list_databases').handler({});
    assert.equal(first.state.calls, 2, 'a second call must reach the API, not a memo');

    const second = serving({
        databases: [{
            base: 'other', name: 'Other', summary: 'x', standing: 'licensed',
            license_type: 'standard', starts: null, expires: null, renews_at: null,
            notice_due_at: null,
            versions: [{ id: 'other_v1', version: 1, summary: 'v1', formats: ['csvgz'] }],
        }],
    });
    const out = await toolsFor(second.fetch).get('list_databases').handler({});
    assert.equal(out.structuredContent.databases.length, 1,
        'a second client must not see the first one\'s answer');
});
