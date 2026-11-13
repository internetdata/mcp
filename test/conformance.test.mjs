// Asserts the shared conformance corpus, from the MCP server's side of it.
//
// The twelve language SDKs assert that the corpus decodes into the right client
// values. This one asserts what only a wrapper can get wrong: that a plan-gated
// answer reaches a model carrying an explicit statement of what was NOT checked,
// so an absent member is never read as a negative finding; that the kind and
// retryability the SDK worked out still reach the MODEL, instead of being
// flattened into a generic failure it cannot act on; and that the visibility
// rules survive a layer that could so easily cache or reshape a catalog.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DATABASE_FORMATS, InternetData } from '@internetdata/internetdata';

import {
    ASN_LOOKUP_GATED_MEMBERS, createTools, DOMAIN_LOOKUP_GATED_MEMBERS, LOOKUP_GATED_MEMBERS,
} from '../dist/index.js';

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

// Answers every lookup with `body`. A batch arrives as one POST per chunk and is
// answered from the addresses in its body, `body` under each of them.
function lookupServing(body) {
    const state = { calls: 0, paths: [] };
    const fn = async (input) => {
        state.calls++;
        const path = new URL(input.url).pathname;
        state.paths.push(path);
        let answer = body;
        if (path === '/batch') {
            const { ips } = JSON.parse(await input.text());
            answer = { results: Object.fromEntries(ips.map((ip) => [ip, { ...body, ip: ip }])), errors: {} };
        }
        return new Response(JSON.stringify(answer), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, state: state };
}

const CALLS = {
    lookup: { tool: 'lookup_ip', arg: 'ip', gated: LOOKUP_GATED_MEMBERS },
    lookupAsn: { tool: 'lookup_asn', arg: 'asn', gated: ASN_LOOKUP_GATED_MEMBERS },
    lookupDomain: { tool: 'lookup_domain', arg: 'domain', gated: DOMAIN_LOOKUP_GATED_MEMBERS },
};

const lookupCase = (name) => data.lookup.find((c) => c.name === name);

// Whether an answer carries a member, `location.city` naming one inside `location`.
function carries(body, member) {
    const [outer, inner] = member.split('.');
    return Object.hasOwn(body, outer) && (inner === undefined || Object.hasOwn(body[outer], inner));
}

async function lookedUp(c) {
    const call = CALLS[c.call];
    const out = await toolsFor(lookupServing(c.body).fetch).get(call.tool).handler({ [call.arg]: c.target });
    assert.equal(out.isError, undefined, `${c.name}: ${out.content?.[0]?.text}`);
    return out;
}

test('every lookup fixture reports exactly the members it did not cover', async () => {
    for (const c of data.lookup) {
        const got = (await lookedUp(c)).structuredContent;

        const expected = CALLS[c.call].gated.filter((m) => !carries(c.body, m));
        assert.deepEqual(got.coverage.not_included, expected, `${c.name}: not_included`);
        assert.deepEqual(got.result, c.body, `${c.name}: result is the served body, verbatim`);
        // trial_expired marks the answer rather than reporting on a dataset, so no list names it.
        for (const m of c.expect.absent.filter((x) => x !== 'trial_expired')) {
            assert.ok(got.coverage.not_included.includes(m), `${c.name}: ${m} is absent but not reported`);
        }
        for (const m of got.coverage.included) {
            assert.ok(carries(c.body, m), `${c.name}: ${m} reported as included but is absent`);
        }
    }
});

// The members a paid plan adds inside an object every plan is served (`location.city`)
// are as absent from an Unlimited answer as a whole dataset is, and named by path.
test('an Unlimited answer names every gated member as not covered, nested ones by path', async () => {
    const { structuredContent: { coverage } } = await lookedUp(lookupCase('unlimited-answer'));

    assert.deepEqual(coverage.not_included, [...LOOKUP_GATED_MEMBERS]);
    assert.ok(coverage.not_included.includes('location.city'));
    assert.ok(coverage.not_included.includes('is_vpn'));
    assert.ok(coverage.included.includes('location') && coverage.included.includes('is_tor'));
    assert.match(coverage.note, /not a negative result/);
    assert.match(coverage.note, /the address was never checked/);
});

test('a paid answer that found nothing reports full coverage, not absence', async () => {
    for (const name of ['paid-full-shape', 'asn-paid-answer', 'domain-paid-answer']) {
        const { structuredContent: { coverage } } = await lookedUp(lookupCase(name));
        assert.deepEqual(coverage.not_included, [], name);
        assert.match(coverage.note, /real negative result/, name);
    }
});

test('an AS or domain answer on Unlimited says which it was', async () => {
    for (const [name, subject] of [['asn-unlimited-answer', 'AS'], ['domain-unlimited-answer', 'domain']]) {
        const { structuredContent: { coverage } } = await lookedUp(lookupCase(name));
        assert.ok(coverage.not_included.length > 0, name);
        assert.match(coverage.note, new RegExp(`the ${subject} was never checked`), name);
    }
});

// trial_expired says which answer a free-plan key got, so it is neither a dataset
// covered nor one left out, and the result carries it verbatim.
test("a free-plan key's full answer reports full coverage and keeps trial_expired", async () => {
    const { structuredContent: { result, coverage } } = await lookedUp(lookupCase('trial-full-answer'));

    assert.equal(result.trial_expired, false);
    assert.ok(!coverage.included.includes('trial_expired'));
    assert.deepEqual(coverage.not_included, []);
    assert.match(coverage.note, /real negative result/);
});

test("a free-plan key's spent trial says so beside what was not covered", async () => {
    const { structuredContent: { result, coverage } } = await lookedUp(lookupCase('trial-expired-answer'));

    assert.equal(result.trial_expired, true);
    assert.ok(!coverage.included.includes('trial_expired'));
    assert.ok(!coverage.not_included.includes('trial_expired'));
    assert.ok(coverage.not_included.includes('is_hosting'));
    assert.match(coverage.note, /trial/);
    assert.match(coverage.note, /not a negative result/);
});

test('the note reaches a client that only renders content', async () => {
    const out = await lookedUp(lookupCase('unlimited-answer'));

    assert.equal(out.content[0].type, 'text');
    assert.ok(out.content[0].text.includes(out.structuredContent.coverage.note));
});

test('a bogon is answered locally and says so', async () => {
    const stub = lookupServing({});
    const tools = toolsFor(stub.fetch);
    for (const c of data.isBogon.filter((x) => x.expect).slice(0, 8)) {
        const out = await tools.get('lookup_ip').handler({ ip: c.ip });
        assert.match(out.structuredContent.coverage.note, /non-routable/, c.ip);
    }
    assert.equal(stub.state.calls, 0, 'a bogon must never reach the network');
});

// The corpus fixes the bogon shape as the API answers one on a paid plan: every flag
// present and false, every detail object present and empty, and every shared object
// with each key empty, so nothing about it can read as uncovered.
test('a bogon is answered in the full documented shape', async () => {
    const out = await toolsFor(lookupServing({}).fetch).get('lookup_ip').handler({ ip: '10.0.0.1' });
    const body = out.structuredContent.result;
    const shape = data.bogonResponse;

    assert.equal(body.is_bogon, true);
    for (const flag of shape.flagsFalse) {
        assert.equal(body[flag], false, `${flag} must be present and false`);
    }
    for (const obj of shape.emptyObjects) {
        assert.deepEqual(body[obj], {}, `${obj} must be present and empty`);
    }
    for (const list of shape.emptyLists) {
        assert.deepEqual(body[list], [], `${list} must be present and empty`);
    }
    for (const obj of ['location', 'asn', 'company', 'abuse', 'whois', 'rwhois']) {
        assert.deepEqual(body[obj], shape[obj], `${obj} must carry every member, empty`);
    }
    assert.deepEqual(body.hosted_domains, shape.hostedDomains);
    assert.equal(body.hostname, shape.hostname);
    assert.deepEqual(out.structuredContent.coverage.not_included, [],
        'nothing is uncovered in a locally answered address');
    assert.ok(!('trial_expired' in body), 'a bogon was never served, so it carries no trial marker');
});

// A server listening on :: logs every IPv4 visitor as ::ffff:a.b.c.d, and a model triaging that
// log passes the form on: it must find each answer under the address it passed.
test('an IPv4-mapped address is the IPv4 address it carries, keyed as passed', async () => {
    const stub = lookupServing({ ...lookupCase('unlimited-answer').body, ip: '8.8.8.8' });
    const tools = toolsFor(stub.fetch);
    for (const c of data.ipv4Mapped) {
        stub.state.paths.length = 0;
        const out = await tools.get('lookup_ip').handler({ ip: c.ip });
        assert.equal(out.structuredContent.result.ip, c.carries, c.ip);
        assert.equal(out.structuredContent.result.is_bogon, c.expect, c.ip);
        assert.deepEqual(stub.state.paths, c.expect ? [] : [`/${c.carries}`], `${c.ip}: what was sent`);
    }

    const ips = data.ipv4Mapped.map((c) => c.ip);
    const out = await tools.get('lookup_ips').handler({ ips: ips });
    assert.deepEqual(Object.keys(out.structuredContent.results), ips);
    for (const c of data.ipv4Mapped) {
        assert.equal(out.structuredContent.results[c.ip].ip, c.carries, c.ip);
    }
});

test('batch coverage comes from a served answer, never from a bogon', async () => {
    const unlimited = lookupCase('unlimited-answer');
    const out = await toolsFor(lookupServing(unlimited.body).fetch).get('lookup_ips')
        .handler({ ips: ['10.0.0.1', unlimited.target] });

    assert.deepEqual(out.structuredContent.coverage.not_included, [...LOOKUP_GATED_MEMBERS],
        'the bogon\'s full shape must not be read as full plan coverage');
    assert.equal(Object.keys(out.structuredContent.results).length, 2);
});

test('an all-bogon batch declines to claim coverage', async () => {
    const stub = lookupServing({});
    const out = await toolsFor(stub.fetch).get('lookup_ips').handler({ ips: ['10.0.0.1', '192.168.1.1'] });

    assert.match(out.structuredContent.coverage.note, /No served answer/);
    assert.equal(stub.state.calls, 0);
});

function toolsFor(fetchImpl, opts = {}) {
    // Retries off: the corpus pins which failures are RETRYABLE, and asserting
    // that is separate from waiting for the SDK's backoff to run out. The cache
    // off too, so every lookup reaches the stub it is asserted against.
    const client = new InternetData({ apiKey: 'k', retries: 0, cache: false, fetch: fetchImpl, ...opts });
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
// a misspelled ID was retried twice before failing.
test('a 4xx outside the enumerated ones is not retryable', async () => {
    const c = data.errors.find((x) => x.name === 'unknown-dataset');
    const out = await toolsFor(serving(c.body, c.status).fetch)
        .get('database_metadata').handler({ dataset_id: 'nope' });
    const { error } = JSON.parse(out.content[0].text);
    assert.equal(error.retryable, false, 'a bad ID must not be retried');
});

test('the published formats are the vocabulary the tools accept', async () => {
    assert.deepEqual([...DATABASE_FORMATS].sort(), [...data.formats].sort());

    const def = toolsFor(serving({}).fetch).get('database_checksum');
    assert.deepEqual([...def.tool.inputSchema.properties.format.enum].sort(),
        [...data.formats].sort());

    const out = await def.handler({ dataset_id: 'bogon_ip_v1', format: 'parquet' });
    assert.equal(out.isError, true, 'a format outside the vocabulary must be refused');
    const { error } = JSON.parse(out.content[0].text);
    assert.equal(error.kind, 'invalid_argument',
        'a format the corpus does not publish is the caller\'s error, not ours');
});

// visibility.clientRules, one test each. The corpus does not name the private
// families - it lands in public repos - so each rule is asserted as behavior.
test('listing-is-returned-as-served: nothing is filtered, reordered or invented', async () => {
    const served = {
        databases: data.standings.map((standing, i) => ({
            base: `fam_${i}`,
            name: `Family ${i}`,
            summary: 'x',
            standing: standing,
            open: false,
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
            base: 'other', name: 'Other', summary: 'x', standing: 'licensed', open: false,
            license_type: 'standard', starts: null, expires: null, renews_at: null,
            notice_due_at: null,
            versions: [{ id: 'other_v1', version: 1, summary: 'v1', formats: ['csvgz'] }],
        }],
    });
    const out = await toolsFor(second.fetch).get('list_databases').handler({});
    assert.equal(out.structuredContent.databases.length, 1,
        'a second client must not see the first one\'s answer');
});
