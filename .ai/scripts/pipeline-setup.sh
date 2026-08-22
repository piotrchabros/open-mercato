#!/bin/sh
set -eu

# pipeline-setup — first step of the cezar spec/implementation pipelines.
#
#   .ai/scripts/pipeline-setup.sh <analysis-dir> [--deps]
#
# It installs the skills the pipeline's agent steps depend on and resets the gate
# state (creates <analysis-dir>, removes a stale HALT marker from a previous run).
#
# WHY THIS IS NOT `corepack yarn install-skills`.
#
# Every cezar run starts in a FRESH git worktree, where node_modules does not
# exist yet. Yarn 4 resolves `yarn <script>` through the install state, so ANY
# `corepack yarn <script>` there dies before the script runs, with
#
#   Usage Error: Couldn't find the node_modules state file - running an install
#   might help (findPackageLocation)
#
# which reads like a broken installer rather than a missing install. The skills
# installer is a POSIX shell script with no package dependencies, so it is
# invoked as one. A pipeline whose later steps DO run yarn scripts (build,
# typecheck, test) passes --deps, and the dependencies are installed here — at
# the step whose job is preparing the worktree — instead of failing several
# steps later with the same opaque message.

ANALYSIS_DIR=""
WITH_DEPS=0

for arg in "$@"; do
  case "$arg" in
    --deps) WITH_DEPS=1 ;;
    -*) echo "pipeline-setup: unknown option: $arg" >&2; exit 2 ;;
    *) ANALYSIS_DIR="$arg" ;;
  esac
done

if [ -z "$ANALYSIS_DIR" ]; then
  echo "Usage: .ai/scripts/pipeline-setup.sh <analysis-dir> [--deps]" >&2
  exit 2
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

if [ "$WITH_DEPS" = "1" ] && [ ! -d node_modules ]; then
  echo "--- installing dependencies (no node_modules in this worktree) ---"
  corepack yarn install --immutable
fi

echo "--- installing skills ---"
if ! sh scripts/install-skills.sh; then
  echo "pipeline-setup: skill install failed. If this machine is offline, re-run with" >&2
  echo "  OM_SKIP_EXTERNAL_SKILLS=1 to install the local tier skills only." >&2
  exit 1
fi

mkdir -p "$ANALYSIS_DIR"
rm -f "$ANALYSIS_DIR/HALT"

echo "--- skills installed, gate state reset ($ANALYSIS_DIR) ---"
