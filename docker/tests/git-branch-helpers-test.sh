#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../git-branch-helpers.sh"

TEST_ROOT=""

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_eq() {
    local expected="$1"
    local actual="$2"
    local message="$3"

    if [ "$expected" != "$actual" ]; then
        fail "$message (expected: '$expected', actual: '$actual')"
    fi
}

setup_remote_repo() {
    local test_root="$1"
    local remote_repo="$test_root/remote.git"
    local seed_repo="$test_root/seed"

    git init --bare "$remote_repo" >/dev/null 2>&1
    git init "$seed_repo" >/dev/null 2>&1

    git -C "$seed_repo" config user.email "test@example.com"
    git -C "$seed_repo" config user.name "Test User"

    printf "initial\n" > "$seed_repo/README.md"
    git -C "$seed_repo" add README.md
    git -C "$seed_repo" commit -m "initial commit" >/dev/null 2>&1

    git -C "$seed_repo" branch -M trunk
    git -C "$seed_repo" remote add origin "$remote_repo"
    git -C "$seed_repo" push -u origin trunk >/dev/null 2>&1

    git -C "$seed_repo" checkout -b develop >/dev/null 2>&1
    printf "develop\n" >> "$seed_repo/README.md"
    git -C "$seed_repo" commit -am "develop commit" >/dev/null 2>&1
    git -C "$seed_repo" push -u origin develop >/dev/null 2>&1

    git -C "$seed_repo" checkout trunk >/dev/null 2>&1
    git -C "$seed_repo" checkout -b main >/dev/null 2>&1
    printf "main\n" >> "$seed_repo/README.md"
    git -C "$seed_repo" commit -am "main commit" >/dev/null 2>&1
    git -C "$seed_repo" push -u origin main >/dev/null 2>&1

    git --git-dir "$remote_repo" symbolic-ref HEAD refs/heads/trunk
}

test_prefers_configured_base_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-configured"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local remote_head_ref
    remote_head_ref=$(git symbolic-ref --short refs/remotes/origin/HEAD)
    local remote_default_branch="${remote_head_ref#origin/}"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/configured" "develop" "$remote_default_branch")

    assert_eq "develop" "$created_from" "configured base branch should be preferred"
    assert_eq "feature/configured" "$(git branch --show-current)" "should check out requested branch"
    assert_eq "$(git rev-parse origin/develop)" "$(git rev-parse HEAD)" "branch should start from origin/develop"
}

test_falls_back_to_remote_default_branch() {
    local test_root="$1"
    local clone_dir="$test_root/clone-remote-default"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local remote_head_ref
    remote_head_ref=$(git symbolic-ref --short refs/remotes/origin/HEAD)
    local remote_default_branch="${remote_head_ref#origin/}"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/remote-default" "missing-base" "$remote_default_branch")

    assert_eq "trunk" "$created_from" "should fall back to remote default branch"
    assert_eq "$(git rev-parse origin/trunk)" "$(git rev-parse HEAD)" "branch should start from origin/trunk"
}

test_falls_back_to_main_when_remote_default_missing() {
    local test_root="$1"
    local clone_dir="$test_root/clone-main-fallback"

    git clone "$test_root/remote.git" "$clone_dir" >/dev/null 2>&1
    cd "$clone_dir"

    local created_from
    created_from=$(create_branch_from_preferred_bases "feature/main-fallback" "missing-base" "")

    assert_eq "main" "$created_from" "should fall back to main when remote default is unavailable"
    assert_eq "$(git rev-parse origin/main)" "$(git rev-parse HEAD)" "branch should start from origin/main"
}

main() {
    TEST_ROOT="$(mktemp -d)"
    trap 'rm -rf "${TEST_ROOT:-}"' EXIT

    setup_remote_repo "$TEST_ROOT"

    test_prefers_configured_base_branch "$TEST_ROOT"
    test_falls_back_to_remote_default_branch "$TEST_ROOT"
    test_falls_back_to_main_when_remote_default_missing "$TEST_ROOT"

    echo "PASS: git branch helper tests"
}

main
