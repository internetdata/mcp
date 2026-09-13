// The staging credential, and nothing else.
//
// Imported by `scripts/run.mjs` as well as by the tests, so it must not import
// the package under test: the runner reads it BEFORE `npm install` has put
// anything in node_modules.
//
// Empty counts as absent. A GitHub Actions `env:` mapping SETS the variable
// even when the secret does not exist, interpolating it to an empty string, so
// a `=== undefined` gate would never fire and the suite would run keyless.

export const KEY_VAR = 'INTERNETDATA_STAGING_KEY';

export function stagingKey() {
    return (process.env[KEY_VAR] ?? '').trim();
}

// A reason string, or false, which is the shape node:test's `skip` option wants.
export function skipForNoKey() {
    if (stagingKey() !== '') {
        return false;
    }
    return `${KEY_VAR} is not set, so nothing can be exercised against staging`;
}
