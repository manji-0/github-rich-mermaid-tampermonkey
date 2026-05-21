# Flowchart Gallery

<!-- derived-from ./rendering-algorithm.md#Public Pipeline -->
<!-- dagayn: discusses-artifact github-rich-mermaid.user.js::renderFlowchart -->
<!-- dagayn: discusses-artifact verify.js::buildFlowchartQualitySamples -->

This gallery is a visual QA page for the userscript flowchart renderer. It intentionally mixes direction, size, shape, labels, loops, fan-out, fan-in, and subgraph cases so regressions are easy to spot by scrolling the rendered GitHub page.

The automated counterpart lives in `verify.js`, where generated samples check clipping, orthogonality, node overlap, label placement, and route/node crossings.

## Direction Samples

### TD Chain

```mermaid
flowchart TD
  A[Collect input] --> B[Normalize fields]
  B --> C[Validate schema]
  C --> D[Persist snapshot]
  D --> E[Notify watchers]
```

### LR Chain

```mermaid
flowchart LR
  A[Draft change] --> B[Run verifier]
  B --> C[Inspect output]
  C --> D[Publish script]
```

### BT Chain

```mermaid
flowchart BT
  A[Render SVG] --> B[Build layout]
  B --> C[Parse source]
  C --> D[Read Markdown]
```

### RL Chain

```mermaid
flowchart RL
  A[Release] --> B[Package]
  B --> C[Test]
  C --> D[Edit]
```

## Branching

### Decision Split and Merge

```mermaid
flowchart TD
  Start[Receive request] --> Gate{Policy allows?}
  Gate -- yes --> Accept[Accept request]
  Gate -- no --> Reject[Reject request]
  Accept --> Join[Record decision]
  Reject --> Join
  Join --> End[Return response]
```

### Wide Fan-out and Fan-in

```mermaid
flowchart TD
  Hub[Dispatch hub]
  Hub -- parse --> Parse[Parse worker]
  Hub -- route --> Route[Route worker]
  Hub -- label --> Label[Label worker]
  Hub -- validate --> Validate[Validate worker]
  Parse --> Sink[Shared result]
  Route --> Sink
  Label --> Sink
  Validate --> Sink
```

### Uneven Branch Depth

```mermaid
flowchart TD
  A[Start] --> B{Fast path?}
  B -- yes --> C[Use cache]
  B -- no --> D[Fetch source]
  D --> E[Transform]
  E --> F[Validate]
  C --> G[Assemble output]
  F --> G
  G --> H[Done]
```

## Loops

### Review Loop

```mermaid
flowchart LR
  Draft[Write] --> Review{Review}
  Review -- approved --> Merge[Merge]
  Review -- changes --> Draft
  Merge --> Release[Release]
```

### Audit Retry Loop

```mermaid
flowchart TD
  Plan[Plan work] --> Run[Run operations]
  Run --> Audit{Audit clean?}
  Audit -- clean --> Done[Done]
  Audit -- retry required --> Plan
```

### Nested Retry Loop

```mermaid
flowchart TD
  A[Receive job] --> B{Authorized?}
  B -- user accepted --> C[Build execution plan]
  B -- needs review --> G[Hold for manual review]
  C --> D[Run selected operations]
  D --> E{Audit clean?}
  E -- clean --> F[Close workflow]
  E -- retry required --> C
  G --> B
```

## Labels

### Short Labels

```mermaid
flowchart TD
  A[Input] -- ok --> B[Process]
  A -- fail --> C[Repair]
  B -- emit --> D[Output]
  C -- retry --> B
```

### Long Labels

```mermaid
flowchart LR
  A[Markdown source] -- decoded source text --> B[Diagram detector]
  B -- supported diagram family --> C[Custom renderer]
  B -- unsupported fallback path --> D[GitHub original]
  C -- deterministic SVG result --> E[Replacement shell]
```

### Mixed Edge Styles

```mermaid
flowchart TD
  A[Solid path] --> B[Next step]
  B == thick path ==> C[Important step]
  C -. dotted path .-> D[Optional step]
  D <--> E[Bidirectional note]
  E --- F[Open connector]
```

## Shapes

### Basic Shapes

```mermaid
flowchart TD
  A[Rectangle] --> B(Rounded)
  B --> C{Diamond}
  C --> D((Circle))
  D --> E([Stadium])
```

### Data and Worker Shapes

```mermaid
flowchart LR
  A[Request] --> B[[Reusable worker]]
  B --> C[(Document store)]
  C --> D{{Routing gate}}
  D -- continue --> E([Complete])
  D -- retry --> B
```

### Skewed Shapes

```mermaid
flowchart TD
  A[/Input payload/] --> B[\Normalized payload\]
  B --> C[/External response\]
  C --> D[\Internal response/]
  D --> E>Async message]
```

## Subgraphs

### Simple Subgraph

```mermaid
flowchart TD
  subgraph Stage[Render stage]
    A[Parse source] --> B[Measure nodes]
    B --> C[Route edges]
  end
  C --> D[Emit SVG]
```

### Subgraph With Local Direction

```mermaid
flowchart TD
  Request[Request] --> A
  subgraph Cache[Cache lookup]
    direction LR
    A[Check key] --> B{Hit?}
    B -- hit --> C[Return cached]
  end
  B -- miss --> D[Fetch origin]
  C --> E[Respond]
  D --> E
```

### Multiple Subgraphs

```mermaid
flowchart LR
  subgraph Input[Input side]
    A[Markdown] --> B[Mermaid block]
  end
  subgraph Output[Output side]
    C[SVG] --> D[Replacement shell]
  end
  B --> C
```

## Larger Workflows

### Public Pipeline

```mermaid
flowchart TD
  A[Read Mermaid source] --> B[Parse C4 model]
  B --> C[Measure leaves and boundaries]
  C --> D[Place nodes in recursive grids]
  D --> E[Build relation work items]
  E --> F[Route orthogonal polylines]
  F --> G[Assign relation labels]
  G --> H[Build validation scene]
  H --> I[Repair labels or routes]
  I --> J[Derive gap overrides]
  J --> K{Compact scene better?}
  K -- yes --> L[Use compact scene]
  K -- no --> M[Use initial scene]
  L --> N[Render SVG]
  M --> N
```

### CI Workflow

```mermaid
flowchart LR
  A[Push branch] --> B[Install dependencies]
  B --> C[Run syntax checks]
  C --> D[Run gallery verification]
  D --> E{All checks pass?}
  E -- yes --> F[Ready to merge]
  E -- no --> G[Inspect failure]
  G --> H[Patch renderer]
  H --> D
```

### Document Publishing

```mermaid
flowchart TD
  A[Author Markdown] --> B[Preview on GitHub]
  B --> C{Diagram readable?}
  C -- yes --> D[Publish document]
  C -- clipped --> E[Adjust renderer]
  C -- crowded --> F[Improve routing]
  E --> B
  F --> B
```

## Dense Cases

### Dense Fan-out

```mermaid
flowchart TD
  A[Hub] -- alpha --> B[Alpha]
  A -- beta --> C[Beta]
  A -- gamma --> D[Gamma]
  A -- delta --> E[Delta]
  A -- epsilon --> F[Epsilon]
  B --> G[Sink]
  C --> G
  D --> G
  E --> G
  F --> G
```

### Crossing Pressure

```mermaid
flowchart TD
  A[Source A] --> D[Target D]
  B[Source B] --> E[Target E]
  C[Source C] --> F[Target F]
  A --> E
  B --> F
  C --> D
```

### Label Pressure

```mermaid
flowchart LR
  A[Input stream] -- parse and normalize source text --> B[Parser]
  B -- classify diagram family and direction --> C[Layout]
  C -- route orthogonal paths around node bodies --> D[Router]
  D -- place readable edge labels outside nodes --> E[Labeler]
  E -- produce deterministic SVG for GitHub --> F[Output]
```

## Summary

<!-- derived-from #direction-samples -->
<!-- derived-from #branching -->
<!-- derived-from #loops -->
<!-- derived-from #labels -->
<!-- derived-from #shapes -->
<!-- derived-from #subgraphs -->
<!-- derived-from #larger-workflows -->
<!-- derived-from #dense-cases -->

Use this page after renderer changes to scan for clipping, overlapping nodes, label collisions, route crossings through node bodies, and overly compressed layouts.
