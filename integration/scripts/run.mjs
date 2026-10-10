#!/usr/bin/env node
// Runs the integration suite against the package as PUBLISHED on the registry,
// which is the one thing the unit suite cannot check: it tests the working tree,
// so it stays green through a broken `files` list, a missing export map entry,
// a `bin` that does not resolve, or a release that never landed. The suite
// spawns the server the way an MCP client spawns it, over stdio.
//
//   node scripts/run.mjs
//
// Nothing on the registry satisfying the declared range makes the run
// meaningless rather than failing, so it skips with a reason instead: before the
// first release there is no published artifact to test. A missing staging key
// costs only the tests that need one, which skip from inside the suite with a
// named reason; the keyless ones run regardless.
//
// npm, deliberately, not pnpm: the repo root carries a pnpm workspace whose
// `minimumReleaseAge` would refuse a version published minutes ago, and a
// workspace can resolve the dependency to the local source, which is exactly
// what this suite exists to rule out.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEY_VAR, stagingKey } from '../lib/key.mjs';

const PACKAGE = 'internetdata-mcp';
// The client library the server wraps, which a stranger's install fetches with it.
const CLIENT = '@internetdata/internetdata';
// Both are public, and this is the registry that serves them. Stated for each
// name rather than inherited, because a developer machine may map the client's
// SCOPE to a private registry, and that mapping outranks `--registry`: the
// install then fails, or resolves something that is not what a stranger gets.
const NPMJS = 'https://registry.npmjs.org/';
const REGISTRY = [`--registry=${NPMJS}`, `--@internetdata:registry=${NPMJS}`];

try {
    main();
} catch (err) {
    console.error(`==> FAILED: ${err.message}`);
    process.exitCode = 1;
}

function main() {
    const dir = dirname(dirname(fileURLToPath(import.meta.url)));
    const range = readJson(join(dir, 'package.json')).dependencies[PACKAGE];

    const versions = publishedVersions(range);
    if (versions === null) {
        skip(`${PACKAGE}@${range} is not on the registry, so there is no published artifact to test`);
        return;
    }
    console.log(`==> ${PACKAGE}@${range} matches published ${versions.join(', ')}`);

    if (stagingKey() === '') {
        notice(`${KEY_VAR} is not set, so the tests that need it skip`);
    }

    // Both removed so every run resolves the range afresh. A kept lockfile would
    // pin whatever the first run happened to pick, and the daily run would stop
    // noticing new releases.
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    rmSync(join(dir, 'package-lock.json'), { force: true });
    run('npm', ['install', '--no-audit', '--no-fund', ...REGISTRY], dir);

    assertInstalledFromRegistry(dir, versions);
    // node's own glob, not the shell's: this spawns without one.
    run('node', ['--test', 'test/*.test.mjs'], dir);
}

// `npm view <name>@<range> version` is the registry's own resolver, so the range
// is read exactly as npm will read it at install time. A package that does not
// exist and a range nothing satisfies both answer E404, and both mean the same
// thing here: there is nothing published to test yet.
function publishedVersions(range) {
    let out;
    try {
        out = execFileSync('npm', ['view', `${PACKAGE}@${range}`, 'version', '--json', ...REGISTRY], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        if (String(err.stderr ?? '').includes('E404')) {
            return null;
        }
        throw err;
    }
    const parsed = JSON.parse(out.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
}

// The suite is worthless if npm handed it a link to the working tree, or an
// artifact from anywhere but the registry a stranger installs from, and both
// failures are silent: every test passes, against the wrong code. So the server
// and the client library it wraps must each have come from npm, which a check
// for any `https://` URL could not tell from a private registry.
function assertInstalledFromRegistry(dir, versions) {
    const installed = join(dir, 'node_modules', PACKAGE);
    if (lstatSync(installed).isSymbolicLink()) {
        throw new Error(`${installed} is a symlink, so the tests would run against local source`);
    }
    const packages = readJson(join(dir, 'package-lock.json')).packages;
    for (const name of [PACKAGE, CLIENT]) {
        const entries = Object.entries(packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
        if (entries.length === 0) {
            throw new Error(`${name} is not in the install at all`);
        }
        for (const [path, entry] of entries) {
            if (!String(entry.resolved).startsWith(NPMJS)) {
                throw new Error(`${path} was not resolved from ${NPMJS}: ${JSON.stringify(entry)}`);
            }
        }
    }
    const version = readJson(join(installed, 'package.json')).version;
    if (!versions.includes(version)) {
        throw new Error(`installed ${version}, which is not one of ${versions.join(', ')}`);
    }
    console.log(`==> installed ${PACKAGE}@${version} from ${packages[`node_modules/${PACKAGE}`].resolved}`);
}

function run(command, args, cwd) {
    console.log(`==> ${command} ${args.join(' ')}`);
    const res = spawnSync(command, args, { cwd: cwd, stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited ${res.status}`);
    }
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function skip(reason) {
    console.log(`==> SKIPPED: ${reason}`);
    notice(`Integration suite skipped: ${reason}`);
}

// Surfaced on the workflow run itself, so a skip is visible without opening the
// log and reading to the end of it.
function notice(message) {
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::notice title=Integration::${message}`);
    }
}
