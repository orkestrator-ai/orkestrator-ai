#!/bin/bash

# Try creating a branch from preferred base branches.
#
# Args:
#   1: target branch name
#   2: configured base branch override (optional)
#   3: remote default branch (optional)
#
# Prints the selected base branch on success.
create_branch_from_preferred_bases() {
    local branch="$1"
    local configured_base="$2"
    local remote_default="$3"
    local candidate=""
    local tried_branches=""

    for candidate in "$configured_base" "$remote_default" "main" "master"; do
        if [ -z "$candidate" ]; then
            continue
        fi

        if [[ " $tried_branches " == *" $candidate "* ]]; then
            continue
        fi

        tried_branches="$tried_branches $candidate"

        if git checkout -b "$branch" "origin/$candidate" >/dev/null 2>&1; then
            printf "%s" "$candidate"
            return 0
        fi
    done

    return 1
}
