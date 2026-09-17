// Emits src/schema.gen.ts from the pinned OpenAPI spec.
//
// The output SCHEMAS are what MCP clients validate a tool result against, so
// deriving them from the spec is what keeps a tool's advertised shape and the
// shape the API actually serves from being two separate claims. A column added
// to the catalog reaches the manifest by re-pinning the spec, not by anyone
// remembering to widen a hand-written schema here.

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

const downloadsLimit = queryParam('/api/v2/database/downloads', 'limit');

const out = `${banner()}

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

export const DATABASE_SCHEMA: ObjectSchema = ${ts(schema('Database'))};

export const DATABASE_METADATA_SCHEMA: ObjectSchema = ${ts(schema('DatabaseMetadata'))};

export const DB_CHECKSUMS_SCHEMA: ObjectSchema = ${ts(schema('DbChecksums'))};

export const DOWNLOAD_SCHEMA: ObjectSchema = ${ts(schema('Download'))};
`;

writeFileSync(resolve(root, 'src/schema.gen.ts'), out);
console.log(`src/schema.gen.ts  (spec ${spec.info.version})`);

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
    return out;
}

function ts(node) {
    return JSON.stringify(node, null, 4);
}

function banner() {
    return '// Code generated by scripts/gen-schema.mjs from spec/openapi.json. DO NOT EDIT.';
}
