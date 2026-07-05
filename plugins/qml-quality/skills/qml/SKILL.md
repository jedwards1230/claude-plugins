---
name: qml
description: This skill should be used when writing or reviewing QML / Qt Quick
  in this lab's UIs (the game-shell Quickshell couch shell on Hyprland, and
  general Qt Quick views) — idiomatic declarative bindings, FocusScope/keyboard
  navigation for a TV/gamepad shell, the parse-passes-but-fails-to-load class of
  bug, binding loops, Loader/Repeater lifecycle, same-module qmldir imports, and
  the qml-quality gates (qmlformat / qmllint). Carries the review checklist and
  severity rubric the qml-developer and qml-reviewer agents share.
permalink: tooling/claude-plugins/plugins/qml-quality/skills/qml/skill
---

# QML / Qt Quick (idioms, lab conventions, review)

Knowledge base: qml-quality/2026.07

Shared domain knowledge for authoring and reviewing QML in this homelab. The
qml-developer applies it while writing; the qml-reviewer applies it while
critiquing. Same knowledge, two jobs.

Grounded in general QML / Qt Quick best practices, lightly anchored to whatever
project is in hand. QML runs in many runtimes — a Qt Quick application
(`qml`/`qmlscene` or an embedded `QQmlApplicationEngine`), a Quickshell desktop
shell, a KDE/Plasma surface, an embedded/automotive HMI. Read the project to
learn which runtime you're in; the principles below hold across all of them.
Read the project's own `CLAUDE.md`/`README` and any relevant issue (`gh issue
view N`) first — they carry conventions these notes won't. Match the idiom of
the existing QML rather than importing a new style.

## The most dangerous trap: `qmlformat` passing ≠ the QML loads

`qmlformat` (and `qmllint`, and CI) only **parse** the QML — they do **not**
instantiate it. Formatting and CI can be completely green while the component
fails to load or renders nothing at runtime. **Never call a QML change done on a
clean qmlformat alone.** The only real verification is to run the QML in its
target runtime and read the console: `qml file.qml` (or `qmlscene`), the host
application, or the project's shell/runtime. A clean load with the expected
render — not a clean format — is the gate.

The high-frequency load/instantiation failures to actively hunt:

1. **Attached properties used without their import** — e.g. `Layout.*` without
   `import QtQuick.Layouts`, or `Keys`/`Drag` attached usage without the right
   module. The parser accepts it; at runtime the property is ignored (invisible
   layout) or errors.
2. **A manually declared `signal` colliding with a property's auto-generated
   `onXChanged`** — the parser accepts the duplicate; the engine errors on load.
3. **Imperative assignment to a read-only signal handler** (e.g.
   `Keys.onPressed = fn`) — handlers are declared, not assigned. The parser
   accepts it; the binding never fires.
4. **Binding loops** — a depends-on-b depends-on-a. qmllint catches some; many
   only surface as a runtime warning and a stuck value. Classics: `width`/
   `height` ↔ `implicitWidth`/`implicitHeight` cycles, and a binding
   overwritten imperatively then re-bound.
5. **Type/enum/version mismatches** against the imported module version —
   accepted by the parser, rejected by the engine.
6. **A `Component`/`Loader` `sourceComponent` referencing an id outside its
   scope.**

## Idioms & Correctness

- **Declarative over imperative**: prefer property bindings over imperative
  assignment; let the binding engine do the work. Use anchors and
  `QtQuick.Layouts` for geometry rather than hard-coded x/y.
- **Focus & keyboard nav**: give each navigable control its own `FocusScope` and
  manage focus explicitly (`focus: true` vs `activeFocus`, `Keys` handling,
  tab/arrow order); focus must not be trapped or lost — critical for a TV/gamepad
  shell. Keep ids scoped and meaningful.
- **Model state explicitly**: data-driven views need real loading / error /
  empty states — don't let a view silently collapse to nothing when its data
  source is slow, missing, or failing. Make those states first-class.
- **Reuse before building**: check the project's existing components/modules
  before implementing a pattern from scratch; if a component almost fits, extend
  it rather than duplicating. Expose configuration via properties and signals,
  not by reaching into internals.
- **Imports & qmldir**: every type and attached property needs its module
  imported at a version the runtime provides; don't rely on an implicit/
  transitive import. **Exception — same-module siblings**: standard QML resolves
  all types registered in a directory's `qmldir` for every file in that same
  module automatically. A file in `module components` can reference `Theme`,
  `SettingsStore`, registered singletons, or any other type listed in that same
  `qmldir` with no `import` statement — that is correct QML, not a missing
  import. An unnamed relative import (`import "../"`) gives a file all types from
  the parent qmldir; `import "lib"` gives the `lib/` qmldir types. Only treat an
  import as missing when a type clearly originates outside the file's own module
  with no covering import (e.g. `Keys.onPressed` without `import QtQuick`, or a
  type absent from all reachable qmldir registries and declared imports).
- **Loader / Repeater lifecycle**: items created and destroyed cleanly; no
  leaked `Component.onCompleted` handlers or dangling signal connections;
  `active`/`asynchronous` correctness; model changes not orphaning delegates.
- **State & transitions**: `states`/`transitions` that can wedge, `when` clauses
  that overlap, animations on a property also driven by a binding.
- **Property/signal hygiene**: `required` properties declared, sane defaults,
  `Connections` target validity, `property var` where a typed property would
  catch errors.
- **Performance**: avoid heavy work in a binding (re-evaluated on every change),
  `anchors` vs `Layout` thrash, and a large `Repeater` where a view with
  delegate recycling belongs.

## Lab Conventions (authoring discipline)

- **Keep the diff scoped** to the stated component/view. Don't wander into
  unrelated screens or backend code. In game-shell specifically, QML work stays
  under `shell/`; the Rust `daemon/` is handled in parallel.
- **Plan first.** Understand the goal and component boundaries; trace where the
  change lands — which view, which component, which module — before writing.
- **Don't introduce a second style** in a file that already has one.

## What Matters in Review

Read the surrounding QML to learn the project's conventions before judging;
don't review the whole repo. Hunt the load-time class of bug first (see the
trap above — binding loops and missing imports, respecting the same-module
qmldir exception), then work the Idioms & Correctness axes as the checklist:
focus & keyboard nav, Loader/Repeater lifecycle, state & transitions,
property/signal hygiene, performance.

## Severity Rubric

Rate every finding, give a `file:line`, and separate real bugs from style
observations. Anything that will **fail to load or render blank is at least
High**:

- **Critical** — the change will not load or renders nothing (a load-time trap
  hit), or wedges the UI / traps focus with no escape on a TV/gamepad shell.
- **High** — a binding loop with a visibly stuck value, focus lost or trapped on
  a navigable path, a Loader/Repeater lifecycle leak, an attached property
  silently ignored for a missing import.
- **Medium** — missing loading/error/empty state on a data-driven view,
  heavy work in a hot binding, non-idiomatic imperative geometry.
- **Low** — style and polish that doesn't affect load or interaction.

## Quality Gates & Tooling

The qml-quality plugin's PostToolUse hook runs `qmlformat -i` on every
Write/Edit, and the Stop hook blocks on an unformatted `.qml` (with `qmllint`
warn-only). So files stay formatted turn-by-turn — but those gates are
**necessary, not sufficient**:

1. Let the format hook keep files clean; address any actionable `qmllint`
   warnings (the import/unqualified noise off-target is expected — focus on the
   real ones).
2. **Run the component in its runtime.** Confirm it instantiates without console
   errors and renders what was intended. If it can't be run in this environment
   (no display, no runtime), say so explicitly rather than claiming it works.
3. **Fix until it loads clean.** Don't hand back a change whose runtime behavior
   hasn't been observed.

**CI owns pure `qmlformat` style** — a reviewer shouldn't re-flag it.
