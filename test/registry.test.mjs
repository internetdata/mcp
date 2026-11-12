// server.json is what the official MCP registry lists, and the release workflow publishes it
// right after npm. The registry takes its version as the npm version it points at, so the two
// must agree before a tag, not after a failed publish. The integration suite's range moves in
// the same release commit, its floor at the version being released.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const integration = JSON.parse(readFileSync(new URL('../integration/package.json', import.meta.url), 'utf8'));
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const gemini = JSON.parse(readFileSync(new URL('../gemini-extension.json', import.meta.url), 'utf8'));

test('server.json names this package at its version', () => {
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages.length, 1);
    assert.equal(server.packages[0].identifier, pkg.name);
    assert.equal(server.packages[0].version, pkg.version);
});

test('integration/ pins the version being released', () => {
    assert.equal(integration.dependencies[pkg.name], `^${pkg.version}`);
});

// The release signs in for one domain, which may publish only names under that domain reversed.
// A name outside it is refused by the registry after npm has already taken the version.
test('server.json names a server the release may publish', () => {
    const login = release.match(/login dns --domain (\S+)/);
    assert.ok(login, 'release.yml signs in to the registry by DNS');
    const namespace = login[1].split('.').reverse().join('.');
    assert.ok(server.name.startsWith(`${namespace}/`), `${server.name} is outside ${namespace}/`);
});

// Gemini CLI installs gemini-extension.json from the latest GitHub Release's source archive, and
// shows its version beside that tag. It runs the package every other stdio client runs.
test('gemini-extension.json runs this package at its version', () => {
    assert.match(gemini.name, /^[a-z0-9-]+$/);
    assert.equal(gemini.version, pkg.version);
    assert.equal(gemini.description, server.description);
    assert.deepEqual(Object.values(gemini.mcpServers), [{ command: 'npx', args: ['-y', pkg.name] }]);
    const secrets = server.packages[0].environmentVariables.filter((v) => v.isSecret);
    assert.deepEqual(
        gemini.settings.map((s) => [s.envVar, s.description, s.sensitive]),
        secrets.map((v) => [v.name, v.description, true]),
    );
});
