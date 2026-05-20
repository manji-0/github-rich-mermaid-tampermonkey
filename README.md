# GitHub Rich Mermaid Tampermonkey

GitHub の Markdown preview に含まれる Mermaid diagram を、Tampermonkey 内の Docattice-style JavaScript SVG renderer で置き換える userscript。

## Requirements

- Tampermonkey

## Install

1. Tampermonkey の dashboard で new script を作る。
2. `github-docattice-mermaid.user.js` の内容を貼り付ける。
3. GitHub の Markdown / PR / issue preview を開く。

## Supported Renderers

The userscript is self-contained and supports the diagram types used most often in GitHub Markdown previews:

- `C4Context`
- `C4Container`
- `C4Component`
- `erDiagram`
- `journey`
- `flowchart` / `graph`
- `gantt`
- `pie`
- `quadrantChart`
- `requirementDiagram`
- `gitGraph`
- `mindmap`
- `timeline`
- `sequenceDiagram`

## Gallery

### Flowchart

```mermaid
flowchart LR
  A[Write] --> B{Review}
  B -- Approved --> C[Merge]
  B -- Changes --> A
```

### Sequence Diagram

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: GET /api/data
  S-->>C: 200 OK
```

### ER Diagram

```mermaid
erDiagram
  USER ||--o{ POST : writes
  POST ||--o{ COMMENT : has
  USER {
    string id PK
    string email UK
  }
  POST {
    string id PK
    string title
  }
```

### Journey

```mermaid
journey
  title Draft save experience
  section Write
    Open editor: 5: Author
    Edit content: 4: Author
  section Publish
    Request review: 3: Author, Reviewer
    Approve: 5: Reviewer
```

### Gantt

```mermaid
gantt
  title MVP rollout
  section Backend
    API design  :done,  api,  2026-01-01, 7d
    Integration :active, int, 2026-01-08, 5d
  section Frontend
    UI build    :        ui,  2026-01-10, 7d
```

### Pie

```mermaid
pie title Dependency kinds
  "Runtime"  : 42
  "Dev"      : 33
  "Optional" : 25
```

### Quadrant Chart

```mermaid
quadrantChart
  title Impact vs effort
  x-axis Low Effort --> High Effort
  y-axis Low Impact --> High Impact
  quadrant-1 Quick wins
  quadrant-2 Major projects
  quadrant-3 Fill-ins
  quadrant-4 Thankless tasks
  Caching: [0.2, 0.8]
  Auth refactor: [0.7, 0.9]
  Log cleanup: [0.3, 0.3]
```

### Requirement Diagram

```mermaid
requirementDiagram
  requirement auth_req {
    id: 1
    text: Users must authenticate via OAuth 2.0
    risk: high
    verifymethod: test
  }
  element login_svc {
    type: component
  }
  login_svc - satisfies -> auth_req
```

### Git Graph

```mermaid
gitGraph
  title "Release Flow"
  commit id: "init"
  branch feature
  checkout feature
  commit id: "feat: add auth"
  checkout main
  merge feature
  commit id: "chore: release v1.0"
```

### C4 Container

```mermaid
C4Container
  title Docattice Cloudflare delivery
  Person(user, "User", "Reads documents")
  System_Boundary(edge, "Cloudflare Edge") {
    Container(worker, "Rust Worker", "Cloudflare Workers", "Serves content")
    ContainerDb(kv, "KV Cache", "Workers KV", "Cached responses")
  }
  Rel_R(user, worker, "HTTPS")
  Rel_D(worker, kv, "Reads cache")
```

### Mindmap

```mermaid
mindmap
  root((Docattice))
    Rendering
      Mermaid
      Markdown
    Storage
      D1
      R2
    Delivery
      Cloudflare Workers
```

### Timeline

```mermaid
timeline
  title Docattice milestones
  2024 : Initial prototype
  2025 : Public beta
       : Rust renderer
  2026 : GA release
```

## Notes

- No WASM or Docattice Web server is required.
- GitHub DOM is observed continuously, so diagrams inserted by live preview are enhanced after they appear.
- If Docattice rendering fails, the original GitHub block remains visible with an error caption.
- The C4 renderer ports the Docattice C4 model and scene pipeline for `C4Context`, `C4Container`, and `C4Component`: boundary nesting, node kind/external/data-store handling, directed relation constraints, recursive container measurement, row lane spacing, row crossing reduction, row relaxation, orthogonal routing, label candidate assignment, label lane reservations, boundary crossing lane reservations, scope transition validation, validation issue detection, reroute/relabel repair iterations, C4 icons, and boundary/leaf rendering. The parser still targets common Mermaid/C4 forms, not every Mermaid grammar feature.

## Verify

```bash
node /Users/manji0/src/docattice/extensions/github-mermaid-tampermonkey/verify.js
node /Users/manji0/src/docattice/extensions/github-mermaid-tampermonkey/verify.js --rust-parity
```

The verifier renders the supported gallery diagrams plus regression samples derived from the Rust renderer tests. It checks C4 routing/label validation, label lane reservations, crossing lane reservations, scope transition mismatch detection, repair summary consistency, route detour/bend budgets, canvas waste, deterministic output, same-row spacing, cascade alignment, fan-out alignment, route/node avoidance, parallel lane separation, fan-out anchor ordering, collinear overlap prevention, orthogonal routes, canvas bounds, data attributes, and default C4 titles. It also covers Rust-compatible parser/rendering cases for Flowchart, ER, Journey, Gantt, Pie, Quadrant, Requirement, GitGraph, Mindmap, Timeline, ZenUML, and Sequence quality regressions for GitHub entity-decoded source.

`--rust-parity` builds a temporary Rust helper from the current workspace and compares the JavaScript renderer against `docattice-mermaid-extras` for supported non-sequence samples. It requires `cargo` and checks exact `viewBox`, text-token parity, and large SVG-shape count drift.
