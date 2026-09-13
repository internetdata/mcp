#!/usr/bin/env node
// Runs the integration suite against the package as PUBLISHED on the registry,
// which is the one thing the unit suite cannot check: it tests the working tree,
// so it stays green through a broken `files` list, a missing export map entry,
// a `bin` that does not resolve, or a release that never landed. The suite
// spawns the server the way an MCP client spawns it, over stdio.
//
//   node scripts/run.mjs
//
// Two conditions make the run meaningless rather than failing, and each one
// skips with a reason instead:
//
//   1. Nothing on the registry satisfies the declared range. Before the first
//      release there is no published artifact to test.
//   2. The staging key is missing. Every endpoint this API has is authenticated,
//      so without it there is nothing at all to exercise.
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
// This package is unscoped, but its DEPENDENCY is not: it pulls in the public
// `@internetdata/internetdata`. A developer machine may map that whole scope to
// a private registry, in which case the install fails outright rather than
// resolving something wrong. Stated here rather than inherited from the
// environment; a CI runner has no such mapping and is unaffected.
const REGISTRY = ['--@internetdata:registry=https://registry.npmjs.org/'];

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
        skip(`${KEY_VAR} is not set, so nothing can be exercised against staging`);
        return;
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

// The suite is worthless if npm handed it a link to the working tree, and that
// failure is silent: every test passes, against the wrong code.
function assertInstalledFromRegistry(dir, versions) {
    const installed = join(dir, 'node_modules', PACKAGE);
    if (lstatSync(installed).isSymbolicLink()) {
        throw new Error(`${installed} is a symlink, so the tests would run against local source`);
    }
    const entry = readJson(join(dir, 'package-lock.json')).packages[`node_modules/${PACKAGE}`];
    if (entry === undefined || !String(entry.resolved).startsWith('https://')) {
        throw new Error(`${PACKAGE} was not resolved from a registry: ${JSON.stringify(entry)}`);
    }
    const version = readJson(join(installed, 'package.json')).version;
    if (!versions.includes(version)) {
        throw new Error(`installed ${version}, which is not one of ${versions.join(', ')}`);
    }
    console.log(`==> installed ${PACKAGE}@${version} from ${entry.resolved}`);
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
