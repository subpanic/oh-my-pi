# Quick build

Build a standalone `omp` executable for the current machine. Commands below target macOS/Linux and work in fish, bash, or zsh unless labeled otherwise. Run repository commands from the checkout root.

## First-time setup

Prerequisites: Git, curl, a C/C++ toolchain, CMake, Ninja, and pkg-config. On macOS, install Xcode Command Line Tools (`xcode-select --install`); with Homebrew, install the remaining build tools with `brew install cmake ninja pkgconf`.

Install Bun (currently requires **1.4.4+**) and Rust via rustup, if missing:

```sh
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

Ensure both toolchains are on PATH:

**fish** (persists across sessions):

```fish
fish_add_path $HOME/.bun/bin $HOME/.cargo/bin
```

**bash/zsh** (current shell; add to your shell configuration to persist):

```sh
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
```

Clone, install dependencies, build the release-profile native addon, then compile the CLI:

```sh
git clone https://github.com/can1357/oh-my-pi.git
cd oh-my-pi
bun --version
cargo --version
env OMP_NATIVE_CARGO_PROFILE=release bun setup
bun --cwd=packages/coding-agent run build
./packages/coding-agent/dist/omp --smoke-test
```

Rustup selects/downloads the repository's pinned Rust toolchain when invoked inside the checkout. `bun setup` installs workspace dependencies, builds the native addon, and links the source `omp` launcher. Use `./packages/coding-agent/dist/omp` to run the **compiled binary**, not that source launcher. The compiled binary does not need Bun installed on the machine where it runs.

Nix alternative: `nix develop` supplies the pinned toolchains and native build dependencies; skip the toolchain installers and PATH setup, then run the same setup/build commands. See [Development](README.md#development) for Nix packaging options.

## Subsequent builds

### CLI-only changes

Reuse the existing native addon:

```sh
bun --cwd=packages/coding-agent run build
./packages/coding-agent/dist/omp --smoke-test
```

### Native changes, version bumps, or updates from Git

After pulling updates, use this sequence when dependencies/native inputs changed, or whenever unsure:

```sh
bun install
env OMP_NATIVE_CARGO_PROFILE=release bun run build:native
bun --cwd=packages/coding-agent run build
./packages/coding-agent/dist/omp --smoke-test
```

No need to repeat `bun setup` or reinstall the toolchains. For faster native iteration, omit `env OMP_NATIVE_CARGO_PROFILE=release`; the default `local` profile uses thin LTO and incremental compilation.

## Deploy to the local fork install (macOS)

If `~/.local/bin/omp` already points to `~/.local/lib/omp-fork/bin/omp`, run this from the checkout root:

```sh
./scripts/deploy-local-fork.sh
```

The script builds for the current Mac, runs `--smoke-test` with a temporary home, and replaces the installed binary only if both pass. The PATH symlink and `manager.json` stay in place, so new `omp` invocations use the fork and `omp update` leaves it alone.

The script reuses the native addon. If dependencies or native inputs changed, run `bun install` and `bun run build:native` first. To target another existing managed fork install, set `OMP_FORK_INSTALL_DIR` to its absolute root path (the directory containing `manager.json` and `bin/omp`).

## Common build messages

- **`bun: No such file or directory` / `cargo metadata failed to run`:** check `bun --version` and `cargo --version`; ensure both toolchain directories are on PATH. If Cargo is available, run `cargo metadata --manifest-path crates/pi-natives/Cargo.toml --no-deps --format-version 1` to expose the underlying metadata error.
- **Native addon version-stamp mismatch:** run the native rebuild sequence above. Do not merely restamp an old addon to bypass the check.
- **`no Swift 6.4+ toolchain with the macOS 27 SDK`:** nonfatal for Cargo builds. Only Apple Foundation Models support is omitted; no Swift upgrade is needed unless you want that feature.
- **Long silence during a release native build:** fat LTO and a single codegen unit make the final compile/link stage slow and memory-intensive. The Swift warning may simply be the last message printed. Check compiler activity in Activity Monitor before treating it as a hang.

Build entrypoints: [setup](scripts/setup.ts), [native build](packages/natives/package.json), [CLI build](packages/coding-agent/scripts/build-binary.ts). The CLI build embeds an already-built native addon; it does not rebuild Rust automatically.
