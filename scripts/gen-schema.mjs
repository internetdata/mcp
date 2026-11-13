// Emits src/schema.gen.ts from the pinned OpenAPI spec.
//
// Two things come out of it, and both exist so that no copy of a plan table is
// ever written down here. The MEMBER lists are what a coverage note is derived
// from: an answer's absent members are the spec's members minus the ones served,
// so a field added to the API appears in the note as soon as the spec is
// refreshed. The output SCHEMAS are what MCP clients validate a tool result
// against, so a tool's advertised shape and the shape the API serves are one claim.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(resolve(root, 'spec/openapi.json'), 'utf8'));

const schema = (name) => {
    const node = spec.components.schemas[name];
    if (node === undefined) {
        throw new Error(`spec has no components.schemas.${name}`);
    }
    return toJsonSchema(spec, node);
};

const lookup = schema('LookupResponse');
const asnLookup = schema('AsnLookupResponse');
const domainLookup = schema('DomainLookupResponse');

// Members that mark an answer rather than report on a dataset. `trial_expired` is on
// a free-plan key's answers only, so it is neither something a plan covers nor
// something whose absence means anything: it stays out of every coverage list.
// Checked against the spec, so a rename there fails this script rather than
// quietly turning the marker into a dataset.
const markers = ['trial_expired'];
const ip = coverageMembers('LookupResponse', lookup);
const asn = coverageMembers('AsnLookupResponse', asnLookup);
const domain = coverageMembers('DomainLookupResponse', domainLookup);

const downloadsLimit = queryParam('/api/v2/database/downloads', 'limit');

const out = `${banner()}

export const LOOKUP_MEMBERS: readonly string[] = ${list(ip.all)};

export const LOOKUP_GATED_MEMBERS: readonly string[] = ${list(ip.gated)};

export const ASN_LOOKUP_MEMBERS: readonly string[] = ${list(asn.all)};

export const ASN_LOOKUP_GATED_MEMBERS: readonly string[] = ${list(asn.gated)};

export const DOMAIN_LOOKUP_MEMBERS: readonly string[] = ${list(domain.all)};

export const DOMAIN_LOOKUP_GATED_MEMBERS: readonly string[] = ${list(domain.gated)};

export const LOOKUP_MARKERS: readonly string[] = ${list(markers)};

export const SPEC_VERSION = '${spec.info.version}';

/** The most history rows \`list_downloads\` may ask for. The API clamps to the same. */
export const DOWNLOADS_LIMIT = ${numeric(downloadsLimit, 'maximum')};

/** The fewest it may ask for. */
export const DOWNLOADS_LIMIT_MIN = ${numeric(downloadsLimit, 'minimum')};

/** What the API returns when \`list_downloads\` names no limit. */
export const DOWNLOADS_LIMIT_DEFAULT = ${numeric(downloadsLimit, 'default')};

// Matches the shape the MCP Tool type wants for inputSchema/outputSchema, so a
// generated schema can be handed straight to a tool definition.
export interface ObjectSchema {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    [k: string]: unknown;
}

export const LOOKUP_RESULT_SCHEMA: ObjectSchema = ${ts(lookup)};

export const ASN_LOOKUP_RESULT_SCHEMA: ObjectSchema = ${ts(asnLookup)};

export const DOMAIN_LOOKUP_RESULT_SCHEMA: ObjectSchema = ${ts(domainLookup)};

export const DATABASE_SCHEMA: ObjectSchema = ${ts(schema('Database'))};

export const DATABASE_METADATA_SCHEMA: ObjectSchema = ${ts(schema('DatabaseMetadata'))};

export const DB_CHECKSUMS_SCHEMA: ObjectSchema = ${ts(schema('DbChecksums'))};

export const DOWNLOAD_SCHEMA: ObjectSchema = ${ts(schema('Download'))};

export const ENTITLEMENT_SCHEMA: ObjectSchema = ${ts(schema('Entitlement'))};
`;

writeFileSync(resolve(root, 'src/schema.gen.ts'), out);
console.log(`src/schema.gen.ts  (spec ${spec.info.version}, ${ip.all.length} address, `
    + `${asn.all.length} AS and ${domain.all.length} domain lookup members)`);

// What a coverage note reads off one kind of answer: every member it may carry, and
// the ones a plan may leave out. A member the spec does not require is a plan's.
// A required one can still hold members only a paid plan is served (`location.city`,
// `company.type`): its schema's own `required` list is what every plan gets, so the
// rest are named by path. A detail object requires nothing, since `{}` is its answer
// under a false flag, so none of its members is ever named here.
function coverageMembers(name, answer) {
    for (const m of markers) {
        if (!(m in answer.properties)) {
            throw new Error(`${m} is no longer a ${name} member: update the markers list`);
        }
    }
    const required = answer.required ?? [];
    const top = Object.keys(answer.properties).filter((m) => !markers.includes(m));
    const nested = required.flatMap((m) => {
        const member = answer.properties[m];
        if (member.type !== 'object' || member.properties === undefined || member.required === undefined) {
            return [];
        }
        return Object.keys(member.properties)
            .filter((p) => !member.required.includes(p))
            .map((p) => `${m}.${p}`);
    });
    return {
        all: [...top, ...nested],
        gated: [...top.filter((m) => !required.includes(m)), ...nested],
    };
}

// The bounds the API enforces on one query parameter, read off the spec rather
// than restated in the manifest. Each reaches a tool description and its runtime
// check by re-pinning the spec, the same contract the output schemas have. The
// DEFAULT is the copy that misleads soonest: it is stated in prose a model
// reads, and nothing rejects it once the API moves off it.
function queryParam(path, name) {
    const params = spec.paths[path]?.get?.parameters ?? [];
    const param = params.find((q) => q.name === name && q.in === 'query');
    if (param?.schema === undefined) {
        throw new Error(`spec has no query parameter ?${name} on GET ${path}`);
    }
    return { path: path, name: name, schema: param.schema };
}

function numeric(param, field) {
    const value = param.schema[field];
    if (typeof value !== 'number') {
        throw new Error(`spec has no numeric ${field} for GET ${param.path} ?${param.name}`);
    }
    return value;
}

// Rewrites a spec schema into the JSON Schema an MCP client validates tool
// output with, which is not the dialect the spec is written in.
//
// Every $ref is inlined: that validator has no document to resolve a local $ref
// against, so a schema carrying one would fail validation rather than skip it.
//
// OpenAPI 3.0's `nullable: true` becomes a `null` member of `type`. JSON Schema
// has no `nullable` keyword, so a validator that follows it ignores the keyword
// and rejects every null the API serves - the Python MCP SDK's does. Ajv, which
// the TS SDK and this repo's tests use, honors `nullable` as an OpenAPI
// extension, so no TS client can see the difference.
function toJsonSchema(doc, node, seen = new Set()) {
    if (node === null || typeof node !== 'object') {
        return node;
    }
    if (Array.isArray(node)) {
        return node.map((n) => toJsonSchema(doc, n, seen));
    }
    if (typeof node.$ref === 'string') {
        if (seen.has(node.$ref)) {
            throw new Error(`circular $ref: ${node.$ref}`);
        }
        const path = node.$ref.replace(/^#\//, '').split('/');
        let target = doc;
        for (const p of path) {
            target = target[p];
        }
        if (target === undefined) {
            throw new Error(`unresolvable $ref: ${node.$ref}`);
        }
        return toJsonSchema(doc, target, new Set([...seen, node.$ref]));
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === 'example' || k === 'examples') {
            continue;
        }
        if (k === 'nullable' && typeof v === 'boolean') {
            continue;
        }
        out[k] = toJsonSchema(doc, v, seen);
    }
    if (node.nullable === true) {
        // Only `type` widens. OpenAPI 3.0.3 leaves every other constraint as
        // written, so an enum admits null only where it lists null itself.
        if (typeof node.type !== 'string') {
            throw new Error(`nullable with no single type to widen: ${JSON.stringify(node)}`);
        }
        out.type = [node.type, 'null'];
    }
    return flattenSingleAllOf(out);
}

// The spec wraps each detail member as `allOf: [$ref]` purely to hang a
// per-member description off a shared schema. Once the $ref is inlined the
// wrapper is noise, and it hides the member's `type` one level down - which is
// how a reader ends up thinking the member has no type at all. The member's own
// description wins, since it is the more specific one.
function flattenSingleAllOf(node) {
    if (!Array.isArray(node.allOf) || node.allOf.length !== 1) {
        return node;
    }
    const { allOf, ...rest } = node;
    return { ...allOf[0], ...rest };
}

function list(names) {
    return `[\n${names.map((m) => `    '${m}',`).join('\n')}\n]`;
}

function ts(node) {
    return JSON.stringify(node, null, 4);
}

function banner() {
    return '// Code generated by scripts/gen-schema.mjs from spec/openapi.json. DO NOT EDIT.';
}
