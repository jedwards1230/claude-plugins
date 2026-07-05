---
name: go
description: This skill should be used when writing or reviewing Go in this
  lab's codebases (earmark, lilbro-whisper, mcp-proxy, cardigan, deck,
  wiki-server) — idiomatic Go, error wrapping, context propagation, pgx/Postgres
  and concurrency correctness, htmx/template dashboards in internal/mcp/, MCP
  servers, additive schema migrations, table-driven tests, and the go-quality
  gates (go vet / go test / golangci-lint). Carries the review checklist and
  severity rubric the go-developer and go-reviewer agents share.
permalink: tooling/claude-plugins/plugins/go-quality/skills/go/skill
---

# Go (idioms, lab conventions, review)

Knowledge base: go-quality/2026.07

Shared domain knowledge for authoring and reviewing Go in this homelab. The
go-developer applies it while writing; the go-reviewer applies it while
critiquing. Same knowledge, two jobs.

## How This Lab Ships Go

The homelab's Go codebases (earmark, lilbro-whisper, mcp-proxy, cardigan, deck,
wiki-server) share strong conventions:

- **Server-rendered htmx dashboards live in `internal/mcp/`** (e.g.
  `dashboard.go`, `findings.go`) — Go templates rendering HTML, driven by htmx.
  There is no separate JS frontend.
- **MCP servers** ("Audiobook Processor" and friends) — structured-output
  tools, registries, eval/judge pipelines.
- **Postgres via pgx**, embeddings, additive schema migrations.
- Provider/interface **seams** are introduced in one PR and consumed in later
  ones (e.g. a `MetadataProvider` in `internal/metaprovider`).

These repos keep a **`docs/CONTRACT.md`** with numbered sections for the control
API / registry / eval, alongside a repo **`CLAUDE.md`**. Read both before
touching code — honor the documented design intent; do not redesign or re-add
things a refactor deliberately removed. When a design doc names a Phase/PR,
that names the exact scope.

## Idioms & Correctness

- **Error wrapping**: wrap errors with context — `fmt.Errorf("loading book %s:
  %w", id, err)`. Never swallow or drop an error silently. Compare sentinel
  errors with `errors.Is` and typed errors with `errors.As`, not string
  matching; use `%w` where unwrapping matters.
- **Context propagation & cancellation**: thread `context.Context` through call
  chains and honor it (select on `ctx.Done()`); don't stash a context in a
  struct; don't use `context.Background()` where a request context exists; put
  deadlines/timeouts on outbound calls.
- **Concurrency correctness is non-negotiable**: every goroutine has a clear
  exit (no leaks); guard shared mutable state against races; a single
  `*pgx.Conn` shared across goroutines (e.g. monitor + worker) is a real bug —
  use a `*pgxpool.Pool` or a per-goroutine conn. Prefer channels for handoff;
  watch for channels that deadlock or are never closed, and `WaitGroup` misuse.
- **Nil & bounds**: nil-pointer derefs, unchecked type assertions (`v.(T)`
  without the comma-ok form), slice/map index assumptions, nil map writes.
- **defer/Close on error paths**: `defer rows.Close()` / `resp.Body.Close()`
  present and correctly ordered; resources released on early returns; watch for
  `defer` inside loops accumulating until function exit.
- **SQL/pgx safety**: parameterized queries always — never string-concatenated
  SQL; guard against injection in dynamic query building.
- **Idiom & API**: zero-value usefulness, accept-interfaces-return-structs,
  exported surface documented and minimal, `io.Reader`/`io.Writer` over
  concrete types where sensible.
- **htmx/template work**: demo and fixture views MUST use the **real data
  builders** (e.g. `demoBooks()`). Fixtures that fabricate a different shape
  render per-entity pages empty.
- **gosec G203**: `template.URL` / `template.HTML` trip it. Only annotate
  `// #nosec G203 -- <why the input is genuinely safe>` when the input truly is
  safe, and back the claim with a test.
- **Table-driven tests** with subtests (`t.Run`) and meaningful assertions —
  not just "it ran". Exercise the changed code paths.

## Lab Conventions (authoring discipline)

- **Pure refactors change zero behavior.** When introducing a seam or finishing
  an incomplete refactor, prove behavior identity — same inputs, same outputs.
  Correctness and behavior-identity beat speed.
- **Schema work is additive-only** unless told otherwise: add a table +
  best-effort write; don't break readers that don't know about it yet.
- **Scope discipline.** If told "edit ONLY Go source (`internal/`, `cmd/`), do
  NOT touch Dockerfile/deploy/.github/scripts" — another agent owns deployment —
  respect it absolutely.
- **No premature abstraction.** Add an interface when there's a second
  implementation or a real test seam, not speculatively.
- **Match the surrounding code** — package layout, naming, error-wrapping
  style, and test idioms. Write code that reads like the code already there.

## What Matters in Review

Focus on the changed lines and what they touch; read the surrounding code to
understand intent before judging; don't review the whole repo. Work the
Idioms & Correctness axes above as the checklist, in priority order:
concurrency (incl. the shared `*pgx.Conn` bug), error handling, and SQL/pgx
safety first; then context propagation, nil & bounds, and defer/Close on error
paths; then idiom/API surface and test quality.

## Severity Rubric

Rate every finding, give a `file:line`, and separate real bugs from style
observations:

- **Critical** — data loss, a race or goroutine leak that will bite in
  production, SQL injection, a shared `*pgx.Conn` corrupting state, or a
  swallowed error that hides failure.
- **High** — missing cancellation/deadline that can hang, a leaked resource on
  an error path, an unchecked assertion/nil deref on a reachable path, a
  non-additive schema change that breaks existing readers.
- **Medium** — weak or missing error context, non-idiomatic API surface,
  thin test coverage on a changed path.
- **Low** — style and polish that doesn't affect correctness.

## Quality Gates & Tooling

The go-quality plugin's Stop hooks run `go vet ./...`, `go test ./...`, and
`golangci-lint run` against any module with changed files, so every turn must
end clean. The full authoring loop:

```bash
go build ./...
go vet ./...
go test ./...
golangci-lint run ./...
```

Drive all four to green before opening a PR; a failure is the author's job to
fix, not defer. Don't suppress a lint with a blanket `//nolint` to dodge a real
issue. **CI owns `gofmt`, `go vet`, and `golangci-lint` formatting** — a
reviewer shouldn't re-flag those unless they point at a genuine correctness bug
the linter would miss.
