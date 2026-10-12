#!/bin/sh
# Test suite for entrypoint.sh privilege escalation handling
# Run with: sh test-entrypoint.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/entrypoint.sh"

echo "Testing entrypoint.sh"
echo "===================="

# Test 1: Syntax check
echo "Test 1: Shell syntax"
if sh -n "$ENTRYPOINT"; then
    echo "✓ entrypoint.sh has valid shell syntax"
else
    echo "✗ entrypoint.sh has syntax errors"
    exit 1
fi

# Test 2: Key functions are present
echo "Test 2: Required checks in code"
if grep -q "su -" "$ENTRYPOINT"; then
    echo "✓ Privilege drop logic (su -) present"
else
    echo "✗ Missing privilege drop logic"
    exit 1
fi

if grep -q "test -w" "$ENTRYPOINT"; then
    echo "✓ Write permission checks present"
else
    echo "✗ Missing write permission checks"
    exit 1
fi

if grep -q "BOT_CREATOR_DATA_DIR" "$ENTRYPOINT"; then
    echo "✓ Data directory check present"
else
    echo "✗ Missing data directory check"
    exit 1
fi

# Test 3: Entrypoint respects env vars
echo "Test 3: Environment variable handling"
if grep -q "APP_USER" "$ENTRYPOINT"; then
    echo "✓ APP_USER configuration present"
else
    echo "✗ Missing APP_USER configuration"
    exit 1
fi

# Test 4: Logging is implemented
echo "Test 4: Logging implementation"
if grep -q "\[entrypoint\]" "$ENTRYPOINT"; then
    echo "✓ Logging messages present"
else
    echo "✗ Missing logging implementation"
    exit 1
fi

echo ""
echo "===================="
echo "All tests passed ✓"
