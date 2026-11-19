#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  *) printf 'Local fork deployment requires macOS.\n' >&2; exit 1 ;;
esac

install_root=${OMP_FORK_INSTALL_DIR:-"$HOME/.local/lib/omp-fork"}
if [[ ! -f "$install_root/manager.json" || ! -x "$install_root/bin/omp" ]]; then
  printf 'Expected an existing managed fork install at %s.\n' "$install_root" >&2
  exit 1
fi

repo=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
binary="$repo/packages/coding-agent/dist/omp-$target"
(cd "$repo" && CROSS_TARGET="$target" bun --cwd=packages/coding-agent run build)

# Keep the smoke test out of the checkout and the live user's config and daemons.
runtime=$(mktemp -d /tmp/omp-fork-smoke.XXXXXXXX)
trap 'rm -rf -- "$runtime"' EXIT
mkdir -p "$runtime/home" "$runtime/run"
(
  cd "$runtime"
  env -u PI_CODING_AGENT_DIR -u PI_PROFILE HOME="$runtime/home" \
    XDG_CONFIG_HOME="$runtime/config" XDG_DATA_HOME="$runtime/data" \
    XDG_CACHE_HOME="$runtime/cache" XDG_RUNTIME_DIR="$runtime/run" \
    "$binary" --smoke-test
)

# macOS install replaces the executable atomically; the PATH symlink stays put.
/usr/bin/install -m 755 -- "$binary" "$install_root/bin/omp"
version=$("$install_root/bin/omp" --version)
printf 'Deployed %s to %s/bin/omp\n' "$version" "$install_root"
