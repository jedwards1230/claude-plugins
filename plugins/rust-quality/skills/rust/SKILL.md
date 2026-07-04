---
name: rust
description: This skill should be used when writing or reviewing Rust in this
  lab's two daemons — gpu-arbiter (privileged musl-static root daemon, axum
  metrics, cn_proc netlink) and the game-shell input/AV daemon (evdev→uinput,
  HDMI-CEC via cec-rs, axum dev endpoints) — covering ownership/borrowing,
  async/tokio correctness, error design, unsafe, dependency and feature-gate
  hygiene (musl/no-C/no-TLS, CEC ABI pins), and the rust-quality gates (cargo
  fmt / clippy / test). Carries the review checklist and severity rubric the
  rust-developer and rust-reviewer agents share.
permalink: tooling/claude-plugins/plugins/rust-quality/skills/rust/skill
---

# Rust (idioms, lab conventions, review)

Knowledge base: rust-quality/2026.07

Shared domain knowledge for authoring and reviewing Rust in this homelab. The
rust-developer applies it while writing; the rust-reviewer applies it while
critiquing. Same knowledge, two jobs.

## The two codebases you ship to

This homelab has two real Rust daemons. Know their constraints cold before
adding a line. For any task, read the relevant GitHub issue(s) (`gh issue view
N`) and the repo's own `CLAUDE.md` first — they carry constraints these notes
won't.

1. **gpu-arbiter** (`jedwards1230/gpu-arbiter`) — privileged root daemon on the
   deployment host. Detects games via the kernel `cn_proc` proc-connector
   netlink, evicts Ollama/ASR from the GPU on game launch, restores them when
   the GPU frees, exposes Prometheus metrics via **axum**.
   - **Hard constraint: musl-static** (`x86_64-unknown-linux-musl`). The
     dependency tree is kept **pure-Rust/libc — NO C deps, NO TLS** to keep the
     musl cross-build clean. Before adding any crate, check it (and its
     transitive deps) don't pull in C or a TLS stack. If a feature seems to need
     TLS or a C library, stop and surface that trade-off rather than breaking
     the build.
   - `cn_proc` `ENOBUFS` is recoverable — treat it non-fatal, don't panic the
     daemon on it.

2. **game-shell input/AV daemon** (`jedwards1230/game-shell`, the `daemon/`
   crate / module `game-shell-input`) — paired with a Quickshell/QML couch shell
   on Hyprland. Owns evdev gamepad input → uinput key synthesis, HDMI-CEC
   (libcec via `cec-rs`), axum HTTP dev-control endpoints, session-env
   self-discovery, AV lifecycle.
   - **Scope discipline is critical.** Most tasks here are "touch ONLY `daemon/`
     (Rust), do NOT edit anything under `shell/`" — QML is handled in parallel.
     Stay in your crate.
   - **CEC version sensitivity**: `cec-rs`/`libcec-sys` are libcec-ABI-sensitive.
     The target box runs libcec 7 and needs `cec-rs 12.x`, behind a Cargo
     feature gate. A naive pin reverts the feature — read the existing gate
     before bumping.
   - evdev button maps are physical-controller-specific (BTN_WEST/BTN_NORTH can
     be swapped). Don't assume a layout.

## Idioms & Correctness

- **Ownership & borrowing**: lean on the type system rather than fighting it.
  Prefer borrowing over cloning on hot paths; watch for needless clones masking
  a borrow-checker fight, over-constrained lifetimes that could be elided,
  `Rc`/`RefCell` where ownership could be simpler, returning references to
  locals, and self-referential structs.
- **Fallibility**: model errors with `Result` and `?`. **In a long-running
  daemon, no needless `unwrap()`/`expect()`/`panic!`/array-indexing on fallible
  runtime paths** — those panic the daemon. `unwrap` is acceptable only where an
  invariant is truly infallible (say why) or in tests. This matters most in
  library code, request handlers, and daemons that must stay up.
- **Async & cancellation**: these daemons use tokio + axum. Don't block the
  async runtime — no sync I/O, `std::fs`, `std::thread::sleep`, CPU-bound loops,
  or a blocking mutex inside async without `spawn_blocking`. Keep shared state
  behind the right primitive (`Arc<Mutex<…>>`, channels, `watch`) and **avoid
  holding a lock across an `.await`**. Mind cancellation safety in `select!` and
  avoid unbounded channels / task leaks.
- **Error design**: error enums via `thiserror` with `?` propagation and `From`
  conversions, not stringly-typed errors; `anyhow` at the right layer (binaries)
  vs typed errors (libraries); don't lose context.
- **unsafe**: every `unsafe` block's invariants documented and actually upheld;
  watch UB risks (aliasing, uninitialized memory, `transmute`, raw-pointer
  lifetimes); prefer a safe API where one exists.
- **Idiom**: iterator chains over manual index loops, `match` exhaustiveness and
  `#[non_exhaustive]`, `Option`/`Result` combinators, `impl Trait` vs boxed
  `dyn`, avoiding `.clone()` in hot paths.
- **Concurrency**: `Send`/`Sync` correctness across thread/task boundaries,
  `Arc<Mutex<_>>` contention, deadlock-prone lock ordering.

## Lab Conventions (authoring discipline)

- **Dependency hygiene.** Add the smallest crate that does the job; check it
  against the musl-static/no-C/no-TLS rule (gpu-arbiter especially); put
  optional functionality behind a Cargo **feature gate** rather than making it
  unconditional. Read existing feature gates before touching pins (CEC).
- **Keep the diff scoped** to the stated subsystem/crate. Don't wander across
  crates or into `shell/`.
- **Plan first.** Understand the issue, the existing module boundaries, and the
  constraints above; trace where the change lands before writing it.
- **Match the surrounding code** — model errors the way the repo already does
  (`thiserror`/`anyhow` where established), follow its module boundaries.

## What Matters in Review

Focus on the changed lines and what they touch; read the surrounding code to
understand intent before judging. The load-bearing axes:

- **Ownership & borrowing** — needless clones, over-constrained lifetimes,
  `Rc`/`RefCell` overuse, references to locals, self-referential structs.
- **Fallibility** — `unwrap`/`expect`/`panic!`/indexing on realistically
  fallible paths (prefer `?` with a typed error).
- **Async & cancellation** — blocking calls inside async without
  `spawn_blocking`; a guard (e.g. `std::sync::Mutex`) held across `.await`;
  cancellation safety in `select!`; unbounded channels / task leaks.
- **Error design** — `thiserror` enums, `?` propagation, `From` conversions;
  `anyhow` at binaries vs typed errors at libraries; context not lost.
- **unsafe** — invariants documented and upheld; UB risks; safe alternative.
- **Concurrency** — `Send`/`Sync` correctness, data races behind `unsafe`, lock
  contention and ordering.
- **Cargo** — dependency version/feature changes that widen surface or pull
  blocking runtimes; feature-gate correctness (and the musl/no-C/no-TLS rule).

## Severity Rubric

Rate every finding, give a `file:line`, and separate real bugs from style
observations:

- **Critical** — unsound `unsafe` / UB, a data race, a panic on a reachable
  daemon runtime path that takes the process down, or a dependency change that
  breaks the musl-static build.
- **High** — a lock held across `.await` or a blocking call on the async runtime
  that can stall the daemon, a task/channel leak, an error path that loses
  context needed to diagnose, a CEC/feature-gate pin that silently reverts a
  feature.
- **Medium** — avoidable clones on hot paths, non-idiomatic error modelling,
  over-constrained lifetimes, thin test coverage on a changed path.
- **Low** — style and polish clippy-level nits that don't affect correctness.

## Quality Gates & Tooling

The rust-quality plugin's Stop hooks run `cargo fmt`, `cargo clippy`, and
`cargo test` against changed crates, so every turn must end clean. The full
authoring loop:

```bash
cargo fmt
cargo clippy --all-targets -- -D warnings   # default features — NOT --no-default-features/--lib, that misses things
cargo build
cargo test
```

Run them, read failures, fix, repeat until all pass; don't declare done on a red
gate. If clippy flags something, fix the code rather than blanket-`#[allow]`-ing
it (allow only with a justified reason). **CI owns `cargo fmt` and plain clippy
style lints** — a reviewer shouldn't re-flag those unless they point at a genuine
correctness or soundness bug.
