#!/bin/bash

# Refreshes the pinned OpenAPI spec from the published one.
#
# The copy in spec/ is what the schema generator reads, so a build stays
# reproducible and offline and the diff shows exactly which spec version
# produced the tool schemas. Run this deliberately and commit the spec change on
# its own: src/schema.gen.ts is gitignored and every build regenerates it, so what
# a re-pin does to the manifest shows in a fresh dist/ compared with the published
# package, never in a diff.
#
# JSON rather than the YAML the other SDKs pin: this package's generator is the
# only consumer and JSON.parse means the build needs no YAML dependency. Both
# are published by the same build, so there is nothing to drift.

set -euo pipefail

cd "$(dirname "$0")/.."

SPEC_URL="${SPEC_URL:-https://s3.internetdata.io/internetdata-public/openapi/openapi.json}"

curl -fsS "$SPEC_URL" -o spec/openapi.json
echo "spec/openapi.json <- ${SPEC_URL}"
node -p "'version: ' + require('./spec/openapi.json').info.version"
