---
name: swift
description: This skill should be used when writing or reviewing Swift —
  archetypally a SwiftUI iOS client app for an agent/daemon protocol (an Xcode
  app target plus local SPM packages, Swift 6 language mode) — covering strict
  concurrency (actors, Sendable, @MainActor, structured tasks), optionals and
  error design, SwiftUI state ownership, retain-cycle and continuation
  correctness, availability when deploying back while using newer SDK APIs,
  and the swift-quality gates (config-gated format, SwiftLint, per-package
  swift test). Carries the review checklist and severity rubric the
  swift-developer and swift-reviewer agents share.
permalink: tooling/claude-plugins/plugins/swift-quality/skills/swift/skill
---

# Swift (idioms, app + package conventions, review)

Knowledge base: swift-quality/2026.07

Shared domain knowledge for authoring and reviewing Swift. The swift-developer
applies it while writing; the swift-reviewer applies it while critiquing. Same
knowledge, two jobs.

## The archetype

These idioms are anchored to a recurring shape of Swift repo: a **SwiftUI iOS
client app** that talks to an agent daemon over a wire protocol — an Xcode app
target for the UI plus **local SPM packages** for the protocol/transport
clients, in **Swift 6 language mode** with strict concurrency. The app often
uses current-SDK APIs while deploying back several iOS versions, so
availability handling is load-bearing, not ceremony. For any task, read the
relevant GitHub issue(s) (`gh issue view N`) and the repo's own `CLAUDE.md` /
`CONTRIBUTING.md` first — they carry constraints these notes won't.

Two structural rules of the archetype:

1. **Packages own the protocol, the app stays thin.** Wire-protocol logic,
   transport, and models live in the SPM packages with their own unit tests;
   the app layer holds view models and views. Don't smuggle protocol logic
   into the app target where only the slow simulator gate can test it.
2. **Unit tests gate; UI tests don't.** XCUITest launch tests are
   minutes-long and flake under headless CI, so the enforced gates are the
   unit bundles and package tests. Run the UI suite locally when touching UI
   flows — its absence from the gates is a known trade-off, not license to
   skip it.

## Idioms & Correctness

- **Concurrency & isolation**: this is Swift 6 strict concurrency — make the
  compiler's model true rather than silencing it. UI-facing state is
  `@MainActor`; shared mutable state lives in an `actor`; `Sendable`
  conformances are honest (`@unchecked Sendable` only with the protecting
  mechanism documented at the declaration). Prefer structured concurrency
  (`async let`, task groups, the `.task` view modifier) over
  `Task.detached`/free-floating `Task {}` whose lifetime nobody owns; a task
  that outlives its owner is a leak and often a retain cycle.
- **Continuations & bridging**: every `withCheckedContinuation` /
  `withCheckedThrowingContinuation` resumes **exactly once on every path** —
  double-resume crashes, never-resume hangs the caller forever. Bridge
  delegate/callback APIs with `AsyncStream`/`AsyncThrowingStream` and mind the
  buffering policy and termination (`onTermination` cancels the underlying
  work).
- **Fallibility**: no `!` force-unwrap, `try!`, or `as!` on reachable runtime
  paths — those crash the app. They're acceptable only where an invariant is
  truly infallible (say why) or in tests. Model errors as typed `Error` enums
  with context (what failed, on which endpoint/session), thrown with `throws`
  + `do`/`catch` at the layer that can act; don't catch-and-drop or reduce a
  useful error to a `print`.
- **Memory**: `[weak self]` in escaping closures and long-lived `Task`s held
  by the object they capture; watch delegate cycles (`weak var delegate`),
  observation/cancellable sets that pin their owner, and closures stored in
  properties capturing `self` strongly.
- **SwiftUI state ownership**: `@State` for view-local, `@Observable` (the
  Observation framework) for model objects where the deployment target
  allows — `ObservableObject`/`@Published` only for legacy compatibility;
  `@Binding` to share mutation, `@Environment` for ambient dependencies. Keep
  `body` cheap: no I/O, no formatting-heavy loops; stable `ForEach`
  identities (real IDs, not array indices). Async work belongs in `.task(id:)`
  so cancellation follows view lifetime.
- **Availability**: using a newer SDK API while deploying back requires
  `if #available` / `@available` on exactly the symbol's floor — and a real
  fallback branch, not an empty one. A missing check is a crash on every
  older-OS device; CI compiling against the newest SDK won't catch it.
- **API design**: follow the Swift API Design Guidelines — clarity at the call
  site, argument labels that read as prose. Value types (`struct`) by
  default; protocols as seams for testability (mock via protocol, not
  subclass). In packages, `public` is a contract — keep surface minimal and
  deliberate.

## Project Conventions (authoring discipline)

- **Dependency hygiene.** SPM only; add the smallest package that does the
  job and pin it deliberately (exact or `from:` per the repo's existing
  style). A new dependency in a protocol package taxes every consumer —
  justify it.
- **Keep the diff scoped** to the stated target/package. Don't wander from a
  package task into app-target code or vice versa.
- **Match the surrounding code** — error modelling, actor layout, and test
  style the way the repo already does them. New tests follow the repo's
  framework (Swift Testing `@Test`/`#expect` vs XCTest — check before
  writing).
- **Plan first.** Trace where the change lands — which package, which actor,
  which view-model — before writing it.

## What Matters in Review

Focus on the changed lines and what they touch; read the surrounding code to
understand intent before judging; don't review the whole repo. Work the
Idioms & Correctness axes above as the checklist, in priority order:
concurrency & isolation and continuation correctness first (they hang or
corrupt), then fallibility (crash paths), memory (leaks/cycles), SwiftUI state
ownership, availability, API design. One review-only axis:

- **Package manifests** — Package.swift changes that widen platform/tool
  requirements, loosen a pin, or expose surface that should stay internal.

## Severity Rubric

Rate every finding, give a `file:line`, and separate real bugs from style
observations:

- **Critical** — a data race or actor-isolation violation hidden by
  `@unchecked Sendable`/`nonisolated(unsafe)` without an upheld invariant, a
  continuation that can double-resume or never resume, a force-unwrap/`try!`
  crash on a reachable runtime path, or a missing availability guard that
  crashes older deployment targets.
- **High** — blocking or heavy work on the main actor that hitches the UI, an
  unstructured task or stream that leaks past its owner's lifetime, a retain
  cycle holding a session/view-model alive, an error path that swallows the
  context needed to diagnose.
- **Medium** — wrong state-ownership wrapper for the job, unstable `ForEach`
  identity, protocol logic landed in the app target instead of its package,
  thin test coverage on a changed path.
- **Low** — style-and-polish / SwiftLint-level nits that don't affect
  correctness.

## Quality Gates & Tooling

The swift-quality plugin's hooks are config-gated where Swift has no single
canonical tool: auto-format on edit runs only when the repo declares a
formatter config (`.swiftformat` → SwiftFormat, `.swift-format` → Apple
swift-format); SwiftLint runs on modified files only when the repo has a
root `.swiftlint.yml`. The Stop-event test gate dispatches `swift test`
per-package on the SPM package owning each modified file (skipping iOS-only
packages that can't build on the host).

**App-target code is not hook-gated** — xcodebuild + simulator is minutes per
run. Before handing off a PR that touches app-target Swift, run the repo's CI
commands yourself; the CI-mirroring loop is:

```bash
swift test                        # from each touched package dir
swiftlint lint --quiet            # when the repo has .swiftlint.yml
xcodebuild build-for-testing -project <App>.xcodeproj -scheme <App> \
  -destination "platform=iOS Simulator,name=<CI's device>" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
xcodebuild test-without-building ... -only-testing:<UnitTestBundle>
```

Run them, read failures, fix, repeat until green; don't declare done on a red
gate. Fix SwiftLint findings rather than blanket `// swiftlint:disable`-ing
them (disable only narrowly, with a justified reason). **CI owns formatting
and style-level lint** — a reviewer shouldn't re-flag those unless they point
at a genuine correctness bug.
