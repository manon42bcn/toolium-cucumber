#!/bin/sh
set -eu

test -s .github/workflows/ci.yml
test -s .github/workflows/release.yml
test -s scripts/release.py

npm ci
npm test
