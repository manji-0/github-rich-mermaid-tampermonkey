#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const vm = require('vm')

const root = path.resolve(__dirname, '../..')
const scriptPath = path.join(__dirname, 'github-rich-mermaid.user.js')
const galleryPath = path.join(root, 'docs/50-gallery/28-mermaid-diagram-gallery.md')

const requestedDiagramTypes = new Set([
  'C4Component',
  'C4Code',
  'architecture-beta',
  'classDiagram',
  'erDiagram',
  'flowchart',
  'gantt',
  'block-beta',
  'kanban',
  'packet-beta',
  'pie',
  'requirementDiagram',
  'sankey',
  'treemap-beta',
  'gitGraph',
  'timeline',
  'sequenceDiagram',
  'stateDiagram-v2',
  'radar-beta',
  'venn-beta',
  'xychart',
])

const galleryViewBoxExpectations = [
  { index: 1, type: 'flowchart', viewBox: '0 0 720.0 200.0' },
  { index: 2, type: 'sequenceDiagram', viewBox: '0 0 520.0 240.0' },
  { index: 3, type: 'classDiagram', viewBox: '0 0 468.5 216.0' },
  { index: 4, type: 'stateDiagram-v2', viewBox: '0 0 300.0 536.0' },
  { index: 5, type: 'erDiagram', viewBox: '0 0 300.0 344.0' },
  { index: 6, type: 'journey', title: 'Draft save experience', viewBox: '0 0 920.0 674.0' },
  { index: 7, type: 'gantt', title: 'MVP rollout', viewBox: '0 0 720.0 374.0' },
  { index: 8, type: 'pie', title: 'Dependency kinds', viewBox: '0 0 900.0 494.0' },
  { index: 9, type: 'quadrantChart', title: 'Impact vs effort', viewBox: '0 0 860.0 584.0' },
  { index: 10, type: 'requirementDiagram', viewBox: '0 0 892.0 334.0' },
  { index: 11, type: 'gitGraph', title: '"Release Flow"', viewBox: '0 0 1900.0 400.0' },
  { index: 12, type: 'C4Container', title: 'Docattice Cloudflare delivery', viewBox: '0 0 1151.1 650.0' },
  { index: 13, type: 'C4Container', title: 'Twitter-like feed delivery', viewBox: '0 0 1878.5 1108.0' },
  { index: 14, type: 'C4Container', title: 'E-commerce Checkout', viewBox: '0 0 1097.6 1324.0' },
  { index: 15, type: 'C4Container', title: 'Diamond Topology', viewBox: '0 0 1046.1 584.0' },
  { index: 16, type: 'C4Container', title: 'Wide Fan-out', viewBox: '0 0 1194.0 750.0' },
  { index: 17, type: 'C4Component', title: 'Docattice worker internals', viewBox: '0 0 1495.1 988.0' },
  { index: 18, type: 'C4Component', title: 'SaaS Worker Internals', viewBox: '0 0 1701.5 946.0' },
  { index: 19, type: 'C4Code', title: 'Graph service code structure', viewBox: '0 0 1063.8 340.0' },
  { index: 20, type: 'mindmap', viewBox: '0 0 920.0 520.0' },
  { index: 21, type: 'timeline', title: 'Docattice milestones', viewBox: '0 0 860.0 604.0' },
  { index: 22, type: 'zenuml', viewBox: '0 0 840.0 416.0' },
  { index: 23, type: 'sankey', viewBox: '0 0 1200.0 524.0' },
  { index: 24, type: 'xychart', title: '"Analysis latency"', viewBox: '0 0 860.0 440.0' },
  { index: 25, type: 'block-beta', viewBox: '0 0 820.0 392.0' },
  { index: 26, type: 'packet-beta', title: '"IPv4 Header"', viewBox: '0 0 900.0 304.0' },
  { index: 27, type: 'kanban', viewBox: '0 0 792.0 288.0' },
  { index: 28, type: 'architecture-beta', viewBox: '0 0 896.0 406.0' },
  { index: 29, type: 'architecture-beta', viewBox: '0 0 1208.0 618.0' },
  { index: 30, type: 'radar-beta', title: '"Quality Metrics"', viewBox: '0 0 840.0 584.0' },
  { index: 31, type: 'treemap-beta', viewBox: '0 0 900.0 544.0' },
  { index: 32, type: 'venn-beta', viewBox: '0 0 760.0 484.0' },
]

const c4RegressionSamples = [
  `C4Component
  title SaaS Worker Internals
  Person_Ext(author, "Author", "Writes documents")
  System_Boundary(platform, "Docattice Edge") {
    Container_Boundary(worker, "Rust Worker") {
      Component(router, "Router", "Axum", "HTTP routing")
      Component(authz, "AuthZ", "Rust", "Permission check")
      Component(graph, "Graph", "Rust", "Document graph")
      Component(md, "Markdown", "Rust", "Blob resolver")
      Component(search, "Search", "Rust", "Full-text search")
    }
    ContainerDb(d1, "D1", "Cloudflare D1", "Metadata")
    ContainerDb(r2, "R2", "Cloudflare R2", "Blobs")
    ContainerDb(kv, "KV", "Workers KV", "Cache")
  }
  Rel_R(author, router, "Reads and edits", "HTTPS")
  Rel_D(router, authz, "Checks session")
  Rel_D(router, graph, "Loads graph")
  Rel_D(router, md, "Loads blob")
  Rel_D(router, search, "Queries")
  Rel_D(authz, d1, "Reads perms", "SQL")
  Rel_D(graph, d1, "Reads refs", "SQL")
  Rel_D(md, r2, "Reads blob", "S3")
  Rel_D(search, kv, "Reads index")`,
  `C4Component
  System_Boundary(sb, "SB") {
    Container_Boundary(cb, "CB") {
      Component(c, "C", "Go", "d")
      ComponentDb(cd, "CD", "PG", "d")
    }
  }
  Rel_D(c, cd, "r")`,
  `C4Component
  System_Boundary(sys, "System") {
    Container_Boundary(cont, "Container") {
      Component(comp, "Comp", "Go", "d")
      ComponentDb(cdb, "CDb", "PG", "d")
    }
  }
  Rel_D(comp, cdb, "reads")`,
]

const c4RustComplexScenarios = [
  {
    name: 'twitter feed delivery port ordering minimizes crossings',
    expectedNodes: ['user', 'platform', 'api', 'core', 'timeline', 'fanout', 'graph', 'media', 'postdb', 'homecache', 'blob'],
    expectedRelationCount: 10,
    parentChildren: [
      ['platform', ['api', 'core', 'media', 'postdb', 'homecache', 'blob']],
      ['core', ['timeline', 'fanout', 'graph']],
    ],
    source: `C4Container
  title Twitter-like feed delivery
  Person_Ext(user, "User", "Publishes posts and reads home timeline")
  System_Boundary(platform, "Social Platform") {
    Container(api, "API Gateway", "Edge API", "Authenticates requests and routes mobile/web traffic")
    Container_Boundary(core, "Timeline Core") {
      Container(timeline, "Timeline Service", "Go service", "Builds home timeline and hydrates posts")
      Container(fanout, "Fanout Worker", "Async jobs", "Pushes new post ids into follower inboxes")
      Container(graph, "Social Graph Service", "Graph API", "Resolves follows, blocks, and mutes")
    }
    Container(media, "Media Service", "Media pipeline", "Processes and serves image/video uploads")
    ContainerDb(postdb, "Post Store", "Distributed KV", "Stores posts and author metadata")
    ContainerDb(homecache, "Home Timeline Cache", "Redis", "Caches ranked home timelines")
    ContainerDb(blob, "Media Blob Store", "Object storage", "Stores original and derived media assets")
  }
  Rel_R(user, api, "Publishes posts and loads timeline", "HTTPS")
  Rel_D(api, timeline, "Queries timeline", "gRPC")
  Rel_D(api, media, "Uploads media", "HTTPS")
  Rel_D(api, homecache, "Reads warm timeline", "Redis")
  Rel_R(timeline, graph, "Expands follow graph", "RPC")
  Rel_D(timeline, postdb, "Reads post documents", "KV")
  Rel_D(timeline, homecache, "Reads ranked timeline", "Redis")
  Rel_R(fanout, graph, "Resolves followers", "RPC")
  Rel_D(fanout, homecache, "Writes follower inboxes", "Redis")
  Rel_D(media, blob, "Persists media", "S3 API")`,
    checkRoutes({ workItems }) {
      const apiHome = workItemFor(workItems, 'api', 'homecache')
      const fanoutHome = workItemFor(workItems, 'fanout', 'homecache')
      const timelineGraph = workItemFor(workItems, 'timeline', 'graph')
      const fanoutGraph = workItemFor(workItems, 'fanout', 'graph')
      const mediaBlob = workItemFor(workItems, 'media', 'blob')
      const apiHomeEnd = apiHome.route.points.at(-1)
      const fanoutHomeEnd = fanoutHome.route.points.at(-1)
      const timelineGraphEnd = timelineGraph.route.points.at(-1)
      const fanoutGraphEnd = fanoutGraph.route.points.at(-1)
      if (!(apiHomeEnd.x < fanoutHomeEnd.x - 16)) {
        throw new Error(`twitter homecache fan-in ports out of order: api=${apiHomeEnd.x.toFixed(1)} fanout=${fanoutHomeEnd.x.toFixed(1)}`)
      }
      if (!(fanoutGraphEnd.y < timelineGraphEnd.y - 16)) {
        throw new Error(`twitter graph fan-in ports out of order: fanout=${fanoutGraphEnd.y.toFixed(1)} timeline=${timelineGraphEnd.y.toFixed(1)}`)
      }
      if (timelineGraph.route.points.length > 2) {
        throw new Error(`twitter timeline->graph should stay direct: ${JSON.stringify(timelineGraph.route.points)}`)
      }
      if (mediaBlob.route.points.length > 2) {
        throw new Error(`twitter media->blob should stay direct: ${JSON.stringify(mediaBlob.route.points)}`)
      }
      const totalCrossings = c4RouteCrossingCount(workItems)
      if (totalCrossings > 1) throw new Error(`twitter feed routes still have avoidable crossings: ${totalCrossings}`)
    },
  },
  {
    name: 'complex ecommerce checkout flow',
    expectedNodes: ['buyer', 'payment_gw', 'api_gw', 'order_svc', 'inv_svc', 'notif_svc', 'order_db', 'inv_db'],
    expectedRelationCount: 7,
    parentChildren: [
      ['platform', ['api_gw', 'order_svc', 'inv_svc', 'notif_svc', 'order_db', 'inv_db']],
    ],
    source: `C4Container
  title E-commerce Checkout
  Person_Ext(buyer, "Buyer", "Online customer")
  System_Ext(payment_gw, "Payment Gateway", "Stripe")
  System_Boundary(platform, "E-commerce Platform") {
    Container(api_gw, "API Gateway", "Go", "Routes requests")
    Container(order_svc, "Order Service", "Rust", "Manages orders")
    Container(inv_svc, "Inventory Service", "Rust", "Tracks stock")
    Container(notif_svc, "Notification", "Go", "Sends emails")
    ContainerDb(order_db, "OrderDB", "Postgres", "Orders")
    ContainerDb(inv_db, "InventoryDB", "Postgres", "Stock")
  }
  Rel_R(buyer, api_gw, "Places order", "HTTPS")
  Rel_D(api_gw, order_svc, "Creates order", "gRPC")
  Rel_D(api_gw, inv_svc, "Checks stock", "gRPC")
  Rel_D(order_svc, notif_svc, "Sends receipt", "Async")
  Rel_D(order_svc, order_db, "Persists", "SQL")
  Rel_D(inv_svc, inv_db, "Updates stock", "SQL")
  Rel_D(api_gw, payment_gw, "Charges card", "HTTPS")`,
    checkRoutes({ scene, workItems }) {
      const platform = scene.layouts.get('platform')
      const paymentRoute = workItemFor(workItems, 'api_gw', 'payment_gw').route.points
      const lane = longestVerticalAxis(paymentRoute)
      if (!(lane > platform.x + platform.w + 4)) {
        throw new Error(`external payment route should leave platform boundary: lane=${lane?.toFixed(1)} platformRight=${(platform.x + platform.w).toFixed(1)}`)
      }
      const totalCrossings = c4RouteCrossingCount(workItems)
      if (totalCrossings !== 0) throw new Error(`ecommerce checkout routes should not cross: ${totalCrossings}`)
    },
  },
  {
    name: 'complex diamond shared stores',
    expectedNodes: ['api', 'cache_svc', 'worker', 'db', 'cache_store'],
    expectedRelationCount: 5,
    parentChildren: [],
    source: `C4Container
  title Diamond Topology
  Container(api, "API", "Go", "Entry point")
  Container(cache_svc, "Cache Svc", "Rust", "Caching layer")
  Container(worker, "Worker", "Rust", "Background jobs")
  ContainerDb(db, "Database", "Postgres", "Shared state")
  ContainerDb(cache_store, "Cache", "Redis", "Hot data")
  Rel_R(api, cache_svc, "Reads cached")
  Rel_R(api, worker, "Enqueues jobs")
  Rel_D(cache_svc, db, "Falls back", "SQL")
  Rel_D(cache_svc, cache_store, "Reads", "Redis")
  Rel_D(worker, db, "Writes results", "SQL")`,
    checkRoutes({ workItems }) {
      const cacheDrop = workItemFor(workItems, 'cache_svc', 'cache_store').route.points
      const workerDrop = workItemFor(workItems, 'worker', 'db').route.points
      const apiCache = workItemFor(workItems, 'api', 'cache_svc').route.points
      const apiWorker = workItemFor(workItems, 'api', 'worker').route.points
      if (cacheDrop.length > 3) throw new Error(`near-aligned cache drop introduced an elbow: ${JSON.stringify(cacheDrop)}`)
      if (workerDrop.length > 3) throw new Error(`already-aligned worker drop introduced an elbow: ${JSON.stringify(workerDrop)}`)
      if (orthogonalPathCrossingCount(apiCache, apiWorker) !== 0) throw new Error('diamond API fanout routes should not cross')
    },
  },
  {
    name: 'complex wide fanout with labels',
    expectedNodes: ['hub', 's1', 's2', 's3', 's4', 'db'],
    expectedRelationCount: 6,
    parentChildren: [],
    source: `C4Container
  title Wide Fan-out
  Container(hub, "Hub", "Go", "Central router")
  Container(s1, "Svc1", "Rust", "Worker 1")
  Container(s2, "Svc2", "Rust", "Worker 2")
  Container(s3, "Svc3", "Rust", "Worker 3")
  Container(s4, "Svc4", "Rust", "Worker 4")
  ContainerDb(db, "SharedDB", "Postgres", "State")
  Rel_D(hub, s1, "dispatches", "gRPC")
  Rel_D(hub, s2, "dispatches", "gRPC")
  Rel_D(hub, s3, "dispatches", "gRPC")
  Rel_D(hub, s4, "dispatches", "gRPC")
  Rel_D(s1, db, "writes", "SQL")
  Rel_D(s3, db, "writes", "SQL")`,
    check({ scene }) {
      const centers = ['s1', 's2', 's3', 's4'].map((id) => {
        const box = scene.layouts.get(id)
        return box.x + box.w / 2
      })
      for (let index = 1; index < centers.length; index += 1) {
        if (centers[index - 1] >= centers[index]) {
          throw new Error(`wide fan-out order changed: ${centers.map((value) => value.toFixed(1)).join(', ')}`)
        }
      }
    },
    checkRoutes({ scene, workItems }) {
      const targets = ['s1', 's2', 's3', 's4'].map((id) => {
        const bounds = scene.layouts.get(id)
        const points = workItemFor(workItems, 'hub', id).route.points
        return {
          id,
          targetCenter: bounds.x + bounds.w / 2,
          startX: points[0].x,
          firstTurnY: points[1]?.y ?? points[0].y,
          laneX: longestVerticalAxis(points),
          points,
        }
      }).sort((left, right) => left.targetCenter - right.targetCenter)
      for (let index = 1; index < targets.length; index += 1) {
        const left = targets[index - 1]
        const right = targets[index]
        if (left.startX > right.startX + 0.5) throw new Error(`wide fan-out source anchors regressed: ${left.id}/${right.id}`)
        if (!(left.firstTurnY + 8 <= right.firstTurnY || Math.abs(left.startX - right.startX) > 0.5)) {
          throw new Error(`wide fan-out first turns collapsed: ${left.id}/${right.id}`)
        }
        if (orthogonalPathCrossingCount(left.points, right.points) !== 0) {
          throw new Error(`wide fan-out sibling routes cross: ${left.id}/${right.id}`)
        }
      }
    },
  },
  {
    name: 'boundary crossing lanes stay ordered inside common scope',
    expectedNodes: ['authz', 'graph', 'markdown', 'd1'],
    expectedRelationCount: 3,
    parentChildren: [
      ['platform', ['authz', 'graph', 'markdown', 'd1']],
      ['core', ['authz', 'graph', 'markdown']],
    ],
    source: `C4Container
  title Boundary crossing lanes
  System_Boundary(platform, "Docattice Edge") {
    Container_Boundary(core, "Worker Core") {
      Container(authz, "AuthZ Service", "Rust", "Checks permissions")
      Container(graph, "Graph Service", "Rust", "Loads refs")
      Container(markdown, "Markdown Service", "Rust", "Loads markdown")
    }
    ContainerDb(d1, "D1 Repository", "Cloudflare D1", "Stores docs and refs")
  }
  Rel_D(authz, d1, "Reads membership", "SQL")
  Rel_D(graph, d1, "Reads refs", "SQL")
  Rel_D(markdown, d1, "Reads snapshots", "SQL")`,
    check({ scene, workItems, validation, svg }) {
      assertIncludes(svg, 'viewBox="0 0 1072.0 750.0"', this.name)
      const platform = scene.layouts.get('platform')
      const lanes = ['authz', 'graph', 'markdown'].map((from) => {
        const item = workItemFor(workItems, from, 'd1')
        return longestVerticalAxis(item.route.points)
      })
      const reservations = validation.crossingLaneReservations.filter((reservation) => reservation.scopeId === 'core')
      if (reservations.length < 3) {
        throw new Error(`boundary crossing reservations missing for core scope: ${reservations.length}`)
      }
      const reservationAxes = reservations.map((reservation) => reservation.laneAxis).sort((a, b) => a - b)
      for (let index = 1; index < reservationAxes.length; index += 1) {
        if (reservationAxes[index] - reservationAxes[index - 1] < 10) {
          throw new Error(`boundary crossing reservations collapsed: ${reservationAxes.map((value) => value.toFixed(1)).join(', ')}`)
        }
      }
      if (!(lanes[0] < lanes[1] && lanes[1] < lanes[2])) {
        throw new Error(`boundary crossing lanes out of order: ${lanes.map((value) => value?.toFixed(1)).join(', ')}`)
      }
      const laneClearance = Math.max(34 * 0.5, 12)
      if (lanes[0] < platform.x + laneClearance - 0.1 || lanes[2] > platform.x + platform.w - laneClearance + 0.1) {
        throw new Error(`boundary crossing lanes outside scope: ${lanes.map((value) => value?.toFixed(1)).join(', ')}`)
      }
    },
  },
  {
    name: 'long edge uses virtual corridor hint lane',
    expectedNodes: ['api', 'worker', 'cache', 'db', 'store'],
    expectedRelationCount: 6,
    parentChildren: [],
    source: `C4Container
  title Long edge corridor hint
  Container(api, "API", "Edge API", "Dispatches requests")
  Container(worker, "Worker", "Rust", "Processes jobs")
  Container(cache, "Cache", "Redis", "Caches warm state")
  ContainerDb(db, "DB", "Postgres", "Stores records")
  ContainerDb(store, "Store", "KV", "Stores published items")
  Rel_D(api, worker, "Dispatches", "gRPC")
  Rel_D(api, cache, "Preloads", "gRPC")
  Rel_R(worker, cache, "Shares state", "RPC")
  Rel_D(worker, db, "Reads", "SQL")
  Rel_D(cache, store, "Writes", "KV")
  Rel_D(api, store, "Publishes", "RPC")`,
    check({ scene, workItems }) {
      const worker = scene.layouts.get('worker')
      const cache = scene.layouts.get('cache')
      const leftCenter = Math.min(worker.x + worker.w / 2, cache.x + cache.w / 2)
      const rightCenter = Math.max(worker.x + worker.w / 2, cache.x + cache.w / 2)
      const lane = longestVerticalAxis(workItemFor(workItems, 'api', 'store').route.points)
      if (!(lane > leftCenter + 4 && lane < rightCenter - 4)) {
        throw new Error(`long edge missed worker/cache corridor: lane=${lane?.toFixed(1)} corridor=${leftCenter.toFixed(1)}..${rightCenter.toFixed(1)}`)
      }
    },
  },
  {
    name: 'dense router fanout avoids same-source crossings',
    expectedNodes: ['author', 'router', 'authz', 'graph', 'md', 'search', 'd1', 'r2', 'kv'],
    expectedRelationCount: 9,
    parentChildren: [
      ['platform', ['router', 'authz', 'graph', 'md', 'search', 'd1', 'r2', 'kv']],
      ['worker', ['router', 'authz', 'graph', 'md', 'search']],
    ],
    source: `C4Component
  title SaaS Worker Internals
  Person_Ext(author, "Author", "Writes documents")
  System_Boundary(platform, "Docattice Edge") {
    Container_Boundary(worker, "Rust Worker") {
      Component(router, "Router", "Axum", "HTTP routing")
      Component(authz, "AuthZ", "Rust", "Permission check")
      Component(graph, "Graph", "Rust", "Document graph")
      Component(md, "Markdown", "Rust", "Blob resolver")
      Component(search, "Search", "Rust", "Full-text search")
    }
    ContainerDb(d1, "D1", "Cloudflare D1", "Metadata")
    ContainerDb(r2, "R2", "Cloudflare R2", "Blobs")
    ContainerDb(kv, "KV", "Workers KV", "Cache")
  }
  Rel_R(author, router, "Reads and edits", "HTTPS")
  Rel_D(router, authz, "Checks session")
  Rel_D(router, graph, "Loads graph")
  Rel_D(router, md, "Loads blob")
  Rel_D(router, search, "Queries")
  Rel_D(authz, d1, "Reads perms", "SQL")
  Rel_D(graph, d1, "Reads refs", "SQL")
  Rel_D(md, r2, "Reads blob", "S3")
  Rel_D(search, kv, "Reads index")`,
    checkRoutes({ workItems }) {
      const paths = ['authz', 'graph', 'md', 'search'].map((to) => [to, workItemFor(workItems, 'router', to).route.points])
      for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
          const crossings = orthogonalPathCrossingCount(paths[leftIndex][1], paths[rightIndex][1])
          if (crossings !== 0) throw new Error(`dense router fanout crosses: ${paths[leftIndex][0]} / ${paths[rightIndex][0]}`)
        }
      }
    },
  },
]

const c4InvariantSamples = [
  {
    name: 'L7 same row minimum gap',
    source: `C4Context
  System(a, "A", "d")
  System(b, "B", "d")
  System(c, "C", "d")
  Rel_R(a, b, "r")
  Rel_R(b, c, "r")`,
    check({ scene }) {
      const ranges = ['a', 'b', 'c']
        .map((id) => {
          const box = scene.layouts.get(id)
          return [box.x, box.x + box.w]
        })
        .sort((left, right) => left[0] - right[0])
      for (let index = 1; index < ranges.length; index += 1) {
        const gap = ranges[index][0] - ranges[index - 1][1]
        if (gap < 29.5) throw new Error(`L7 gap too small: ${gap.toFixed(1)}`)
      }
    },
  },
  {
    name: 'L9 deterministic output',
    source: `C4Container
  Person_Ext(u, "User", "d")
  System_Boundary(sb, "SB") {
    Container(a, "A", "Go", "d")
    ContainerDb(db, "DB", "PG", "d")
  }
  Rel_R(u, a, "uses")
  Rel_D(a, db, "reads")`,
    check({ renderer, source, svg }) {
      const second = renderer.renderMermaidSvg(source)
      if (svg !== second) throw new Error('L9 output is not deterministic')
    },
  },
  {
    name: 'C4 parser ignores leaf nodes with too few args like Rust',
    source: `C4Container
  System_Boundary(sb, "System") {
    Container(valid, "Valid", "Rust")
    Container(invalid, "Invalid")
  }`,
    check({ model, scene, workItems }) {
      if (!model.nodes.has('valid')) throw new Error('C4 parser should keep 3-arg leaf node')
      if (model.nodes.has('invalid')) throw new Error('C4 parser should ignore 2-arg leaf node')
      if (scene.layouts.has('invalid')) throw new Error('C4 layout should not contain ignored 2-arg leaf node')
      if (workItems.length !== 0) throw new Error('C4 parser-only sample should not create relations')
    },
  },
  {
    name: 'C4 function args follow Rust quote stripping rules',
    source: `C4Component
  Component(backtick, \`Backtick Label\`, "Rust", "Keeps backticks")
  Component(single, 'Single Label', "Rust", "Strips single quotes")
  Rel_R(backtick, single, \`Backtick relation\`, 'Single tech')`,
    check({ model, svg }) {
      if (model.nodes.get('backtick')?.label !== '`Backtick Label`') throw new Error('C4 backtick label should be preserved like Rust')
      if (model.nodes.get('single')?.label !== 'Single Label') throw new Error('C4 single quoted label should strip outer quotes like Rust')
      const rel = model.relations[0]
      if (rel.label !== '`Backtick relation`') throw new Error(`C4 backtick relation label should be preserved like Rust: ${rel.label}`)
      if (rel.technology !== 'Single tech') throw new Error(`C4 single quoted relation technology should strip like Rust: ${rel.technology}`)
      assertIncludes(svg, '>`Backtick Label`</text>', this.name)
      assertIncludes(svg, '>Single Label</text>', this.name)
    },
  },
  {
    name: 'C4 3-arg nodes and canvas dimensions match Rust renderer',
    source: `C4Component
  title Docattice worker internals
  Person_Ext(author, "Author / Reader", "Uses the browser UI")
  System_Boundary(platform, "Docattice Edge") {
    Container_Boundary(worker, "Rust Worker") {
      Component(router, "HTTP Router", "Axum handlers", "Terminates requests and maps routes")
      Component(authz, "AuthZ Service", "Rust module", "Checks membership and document permissions")
      Component(graph, "Graph Service", "Rust module", "Loads refs and computes document graph")
      Component(markdown, "Markdown Service", "Rust module", "Resolves markdown blobs and snapshots")
      ComponentDb(d1, "D1 Repository", "Cloudflare D1", "Persists docs, refs, and permissions")
      ComponentDb(r2, "R2 Repository", "Cloudflare R2", "Stores markdown snapshots and assets")
    }
  }
  Rel_R(author, router, "Reads and edits documents", "HTTPS")
  Rel_D(router, authz, "Checks session", "In-process")
  Rel_D(router, graph, "Loads document graph", "In-process")
  Rel_D(router, markdown, "Loads markdown blob", "In-process")
  Rel_D(authz, d1, "Reads membership", "SQL")
  Rel_D(graph, d1, "Reads refs", "SQL")
  Rel_D(markdown, r2, "Reads blob", "S3 API")`,
    check({ model, svg }) {
      assertIncludes(svg, 'viewBox="0 0 1495.1 988.0"', this.name)
      if (model.nodes.get('author')?.technology) throw new Error('C4 3-arg node should not duplicate detail as technology')
      const repeated = svg.split('>Uses the browser UI</text>').length - 1
      if (repeated !== 1) throw new Error(`C4 3-arg detail rendered ${repeated} times`)
      assertIncludes(svg, 'x="495.1" y="46.0" width="928.0" height="832.0"', this.name)
      assertIncludes(svg, 'x="839.1" y="214.0" width="240.0" height="124.0"', this.name)
    },
  },
  {
    name: 'C4 parser matches Rust case-sensitive function prefixes',
    source: `C4Container
  TITLE Not A Title
  container(lower, "Lower", "Rust")
  Boundary(alias, "Alias") {
  }
  Container(valid, "Valid", "Rust")
  Container(valid2, "Valid 2", "Rust")
  Relx(valid, lower, "ignored")
  Rel(valid, valid2, "plain")`,
    check({ model, workItems, svg }) {
      if (model.title !== 'C4 Container') throw new Error(`C4 uppercase TITLE should not replace title like Rust: ${model.title}`)
      if (model.nodes.has('lower')) throw new Error('C4 lowercase node function should be ignored like Rust')
      if (model.nodes.has('alias')) throw new Error('C4 Boundary alias should be ignored like Rust')
      if (!model.nodes.has('valid') || !model.nodes.has('valid2')) throw new Error('C4 valid nodes missing')
      if (model.relations.length !== 1 || model.relations[0].tag !== 'Rel') throw new Error(`C4 relation prefix matching should only accept exact Rel: ${model.relations.map((rel) => rel.tag).join(',')}`)
      if (!workItems.length) throw new Error('C4 exact Rel relation should create a work item')
      if (svg.includes('Not A Title') || svg.includes('Lower') || svg.includes('Alias')) throw new Error('C4 ignored Rust-incompatible constructs leaked into SVG')
    },
  },
  {
    name: 'C4 validation detects port and arrow direction mismatches',
    source: `C4Container
  Container(a, "A", "Go", "source")
  Container(b, "B", "Rust", "target")
  Rel_R(a, b, "calls")`,
    check({ renderer, model, scene, workItems }) {
      const item = workItemFor(workItems, 'a', 'b')
      const original = item.route.points.map((point) => ({ ...point }))

      item.route.points = original.map((point) => ({ ...point }))
      item.route.points[1] = { x: item.route.points[0].x - 30, y: item.route.points[0].y }
      let issues = renderer.c4ValidateScene(renderer.c4BuildValidationScene(model, scene, workItems))
      if (!issues.some((issue) => issue.kind === 'PortDirectionMismatch')) {
        throw new Error(`C4 validation missed PortDirectionMismatch: ${issues.map((issue) => issue.kind).join(', ')}`)
      }

      item.route.points = original.map((point) => ({ ...point }))
      const last = item.route.points[item.route.points.length - 1]
      item.route.points[item.route.points.length - 2] = { x: last.x + 30, y: last.y }
      issues = renderer.c4ValidateScene(renderer.c4BuildValidationScene(model, scene, workItems))
      if (!issues.some((issue) => issue.kind === 'ArrowHeadDirectionMismatch')) {
        throw new Error(`C4 validation missed ArrowHeadDirectionMismatch: ${issues.map((issue) => issue.kind).join(', ')}`)
      }

      item.route.points = original
    },
  },
  {
    name: 'C4 validation detects scope transition mismatches',
    source: `C4Container
  System_Boundary(platform, "Platform") {
    Container_Boundary(core, "Core") {
      Container(a, "A", "Go", "source")
    }
    ContainerDb(db, "DB", "Postgres", "target")
  }
  Rel_D(a, db, "reads", "SQL")`,
    check({ renderer, model, scene, workItems }) {
      const item = workItemFor(workItems, 'a', 'db')
      if (!item.crossingReservations.length) throw new Error('C4 scope transition sample should have crossing reservations')
      const original = item.route.points.map((point) => ({ ...point }))
      const core = scene.layouts.get('core')
      item.route.points = original.map((point) => ({
        x: Math.max(core.x + 8, Math.min(core.x + core.w - 8, point.x)),
        y: Math.max(core.y + core.headerH + 8, Math.min(core.y + core.h - 8, point.y)),
      }))
      const issues = renderer.c4ValidateScene(renderer.c4BuildValidationScene(model, scene, workItems))
      if (!issues.some((issue) => issue.kind === 'ScopeTransitionMismatch')) {
        throw new Error(`C4 validation missed ScopeTransitionMismatch: ${issues.map((issue) => issue.kind).join(', ')}`)
      }
      item.route.points = original
    },
  },
  {
    name: 'L10 simple cascade vertical alignment',
    source: `C4Container
  Container(gw, "Gateway", "Go", "Dispatches")
  Container(api, "API", "Rust", "Handles")
  ContainerDb(db, "DB", "Postgres", "Stores")
  Rel_D(gw, api, "Calls")
  Rel_D(api, db, "Reads")`,
    check({ scene, svg }) {
      assertIncludes(svg, 'viewBox="0 0 540.0 750.0"', this.name)
      const centerX = (id) => {
        const box = scene.layouts.get(id)
        return box.x + box.w / 2
      }
      const centers = [centerX('gw'), centerX('api'), centerX('db')]
      const spread = Math.max(...centers) - Math.min(...centers)
      if (spread >= 20) throw new Error(`L10 cascade center spread too high: ${spread.toFixed(1)}`)
    },
  },
  {
    name: 'L10 fan-out source between targets',
    source: `C4Container
  Container(api, "API", "Go", "Routes")
  Container(a, "Service A", "Rust", "Does A")
  Container(b, "Service B", "Rust", "Does B")
  Container(c, "Service C", "Rust", "Does C")
  Rel_D(api, a, "calls")
  Rel_D(api, b, "calls")
  Rel_D(api, c, "calls")`,
    check({ scene, svg }) {
      assertIncludes(svg, 'viewBox="0 0 924.0 508.0"', this.name)
      const centerX = (id) => {
        const box = scene.layouts.get(id)
        return box.x + box.w / 2
      }
      const api = centerX('api')
      const targets = [centerX('a'), centerX('b'), centerX('c')]
      if (api < Math.min(...targets) - 10 || api > Math.max(...targets) + 10) {
        throw new Error(`L10 fan-out source outside target span: ${api.toFixed(1)}`)
      }
    },
  },
  {
    name: 'L11 narrow row compact canvas',
    source: `C4Container
  Container(api, "API", "Go", "Routes")
  Container(a, "A", "Rust", "d")
  Container(b, "B", "Rust", "d")
  Container(c, "C", "Rust", "d")
  Rel_D(api, b, "calls")
  Rel_D(a, c, "calls")`,
    check({ scene, svg }) {
      assertIncludes(svg, 'viewBox="0 0 680.0 508.0"', this.name)
      if (scene.width >= 1100) throw new Error(`L11 canvas too wide: ${scene.width.toFixed(1)}`)
    },
  },
  {
    name: 'RN2 default C4 titles',
    source: `C4Component
  System_Boundary(sb, "SB") {
    Container_Boundary(cb, "CB") {
      Component(c, "C", "Go", "d")
    }
  }`,
    check({ svg }) {
      if (!svg.includes('C4 Component')) throw new Error('RN2 C4 Component title missing')
      assertIncludes(svg, 'data-diagram-body="true"', this.name)
      assertIncludes(svg, 'data-diagram-body-center-x=', this.name)
    },
  },
  {
    name: 'R1 routes avoid non-endpoint node bodies',
    source: `C4Container
  Person_Ext(user, "User", "d")
  System_Boundary(sb, "Platform") {
    Container(gw, "Gateway", "Go", "d")
    Container(svc, "Service", "Rust", "d")
    ContainerDb(db, "DB", "PG", "d")
  }
  Rel_R(user, gw, "uses")
  Rel_R(gw, svc, "calls")
  Rel_D(svc, db, "reads")
  Rel_D(gw, db, "audit")`,
    check({ model, scene, workItems }) {
      assertRoutesAvoidNodeBodies(model, scene, workItems)
    },
  },
  {
    name: 'R3 parallel routes minimum lane separation',
    source: `C4Container
  Container(api, "API", "Go", "d")
  ContainerDb(d1, "D1", "PG", "d")
  ContainerDb(d2, "D2", "Redis", "d")
  Rel_D(api, d1, "reads")
  Rel_D(api, d2, "reads")`,
    check({ workItems, svg }) {
      assertIncludes(svg, 'viewBox="0 0 654.0 516.0"', this.name)
      const axes = workItems.map((item) => longestVerticalAxis(item.route?.points || [])).filter((value) => value != null)
      if (axes.length >= 2 && Math.abs(axes[0] - axes[1]) < 16.5) {
        throw new Error(`R3 lane separation too small: ${Math.abs(axes[0] - axes[1]).toFixed(1)}`)
      }
    },
  },
  {
    name: 'R4 fanout anchor order matches target center x',
    source: `C4Container
  Container(src, "Source", "Go", "d")
  Container(t1, "T1", "Rust", "d")
  Container(t2, "T2", "Rust", "d")
  Container(t3, "T3", "Rust", "d")
  Rel_D(src, t3, "c")
  Rel_D(src, t1, "a")
  Rel_D(src, t2, "b")`,
    check({ scene, workItems, svg }) {
      assertIncludes(svg, 'viewBox="0 0 924.0 508.0"', this.name)
      const rows = workItems
        .map((item) => {
          const target = scene.layouts.get(item.rel.to)
          const first = item.route?.points?.[0]
          if (!target || !first) return null
          return { targetCenter: target.x + target.w / 2, startX: first.x }
        })
        .filter(Boolean)
        .sort((left, right) => left.targetCenter - right.targetCenter)
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index - 1].startX > rows[index].startX + 0.5) {
          throw new Error('R4 fanout anchor order mismatch')
        }
      }
    },
  },
  {
    name: 'R6 no collinear overlap',
    source: `C4Container
  Container(a, "A", "Go", "d")
  Container(b, "B", "Rust", "d")
  Container(c, "C", "Py", "d")
  ContainerDb(d1, "D1", "PG", "d")
  ContainerDb(d2, "D2", "Redis", "d")
  Rel_R(a, b, "r1")
  Rel_R(b, c, "r2")
  Rel_D(a, d1, "r3")
  Rel_D(c, d2, "r4")
  Rel_D(b, d1, "r5")`,
    check({ workItems, svg }) {
      assertIncludes(svg, 'viewBox="0 0 976.0 516.0"', this.name)
      for (let left = 0; left < workItems.length; left += 1) {
        for (let right = left + 1; right < workItems.length; right += 1) {
          const a = workItems[left]
          const b = workItems[right]
          const sharesEndpoint = a.rel.from === b.rel.from || a.rel.from === b.rel.to || a.rel.to === b.rel.from || a.rel.to === b.rel.to
          if (sharesEndpoint) continue
          if (pathsHaveCollinearOverlap(a.route?.points || [], b.route?.points || [])) {
            throw new Error(`R6 collinear overlap: ${a.rel.from}->${a.rel.to} and ${b.rel.from}->${b.rel.to}`)
          }
        }
      }
    },
  },
  {
    name: 'R7 all routes orthogonal',
    source: `C4Container
  Person_Ext(u, "U", "d")
  Container(a, "A", "Go", "d")
  Container(b, "B", "Rust", "d")
  ContainerDb(db, "DB", "PG", "d")
  Rel_R(u, a, "uses")
  Rel_R(a, b, "calls")
  Rel_D(a, db, "reads")
  Rel_D(b, db, "reads")`,
    check({ workItems }) {
      for (const item of workItems) {
        assertOrthogonal(item.route?.points || [], `${item.rel.from}->${item.rel.to}`)
      }
    },
  },
  {
    name: 'R8 routes within canvas',
    source: `C4Container
  Person_Ext(u, "U", "d")
  Container(a, "A", "Go", "d")
  ContainerDb(db, "DB", "PG", "d")
  Rel_R(u, a, "uses")
  Rel_D(a, db, "reads")`,
    check({ scene, workItems }) {
      for (const item of workItems) {
        for (const point of item.route?.points || []) {
          if (point.x < -0.5 || point.y < -0.5 || point.x > scene.width + 0.5 || point.y > scene.height + 42.5) {
            throw new Error(`R8 route outside canvas: ${item.rel.from}->${item.rel.to}`)
          }
        }
      }
    },
  },
  {
    name: 'RN1 C4 data attributes',
    source: `C4Context
  Person(p, "P", "d")
  System(s, "S", "d")
  Rel_R(p, s, "r")`,
    check({ svg }) {
      for (const fragment of ['data-c4-id="p"', 'data-c4-id="s"', 'data-c4-node="Person"', 'data-c4-rel="p->s:Rel_R"']) {
        if (!svg.includes(fragment)) throw new Error(`RN1 missing ${fragment}`)
      }
      assertIncludes(svg, `font-family="'LINE Seed JP','Hiragino Sans','Yu Gothic UI','Segoe UI Variable',system-ui,sans-serif"`, this.name)
    },
  },
  {
    name: 'C4 node badges match Rust node_badge output',
    source: `C4Context
  Person_Ext(user, "User", "external")
  SystemDb(store, "Store", "Postgres", "audit")
  Enterprise_Boundary(ent, "Enterprise") {
    System(app, "App", "service", "core")
  }
  Rel_R(user, app, "uses")
  Rel_D(app, store, "writes")`,
    check({ svg }) {
      for (const fragment of [
        'data-c4-node="Person"',
        'data-c4-node="SystemDb"',
        'data-c4-node="Enterprise"',
        '>Person</text>',
        '>SystemDb</text>',
        '>Enterprise</text>',
      ]) {
        if (!svg.includes(fragment)) throw new Error(`C4 badge parity missing ${fragment}`)
      }
      for (const unexpected of ['External Person', 'System DB', 'Enterprise Boundary']) {
        if (svg.includes(unexpected)) throw new Error(`C4 badge should match Rust and not render ${unexpected}`)
      }
      const store = c4NodeGroup(svg, 'store')
      if (!store.includes('stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"')) {
        throw new Error('C4 database icon paths should use Rust path helper output')
      }
    },
  },
  {
    name: 'C4 leaf metadata lanes follow Rust wrapped title flow',
    source: `C4Component
  Component(svc, "Very Long Service Name", "Rust module", "Detailed behavior")`,
    check({ svg, scene }) {
      const box = scene.layouts.get('svc')
      if (!box) throw new Error('C4 wrapped metadata sample missing svc layout')
      const texts = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]), value: match[3] }))
      const titleFirst = texts.find((item) => item.value === 'Very Long Service')
      const titleSecond = texts.find((item) => item.value === 'Name')
      const tech = texts.find((item) => item.value === 'Rust module')
      const detail = texts.find((item) => item.value === 'Detailed behavior')
      if (!titleFirst || !titleSecond || !tech || !detail) throw new Error('C4 wrapped metadata text lines missing')
      const expected = {
        titleFirst: box.y + 47,
        titleSecond: box.y + 64,
        tech: box.y + 87,
        detail: box.y + 104,
      }
      if (Math.abs(titleFirst.y - expected.titleFirst) > 0.1) throw new Error(`C4 first title y mismatch: ${titleFirst.y}/${expected.titleFirst}`)
      if (Math.abs(titleSecond.y - expected.titleSecond) > 0.1) throw new Error(`C4 second title y mismatch: ${titleSecond.y}/${expected.titleSecond}`)
      if (Math.abs(tech.y - expected.tech) > 0.1) throw new Error(`C4 technology y should move below wrapped title: ${tech.y}/${expected.tech}`)
      if (Math.abs(detail.y - expected.detail) > 0.1) throw new Error(`C4 detail y should flow after technology: ${detail.y}/${expected.detail}`)
    },
  },
  {
    name: 'C4 leaf title wrapping uses Rust text width estimates',
    source: `C4Component
  Component(svc, "ill ill ill ill ill ill ill", "Rust module", "Detailed behavior")`,
    check({ svg, scene }) {
      const box = scene.layouts.get('svc')
      if (!box) throw new Error('C4 narrow-glyph wrapping sample missing svc layout')
      const texts = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]), value: match[3] }))
      const fullTitle = texts.find((item) => item.value === 'ill ill ill ill ill ill ill')
      const tech = texts.find((item) => item.value === 'Rust module')
      if (!fullTitle) throw new Error('C4 Rust text-width wrapping should keep narrow glyph title on one line')
      if (texts.some((item) => item.value === 'ill ill ill ill')) throw new Error('C4 title should not use character-count wrapping')
      if (!tech || Math.abs(tech.y - (box.y + 70)) > 0.1) throw new Error(`C4 technology y should follow one-line title: ${tech?.y}/${box.y + 70}`)
    },
  },
  {
    name: 'C4 light theme fill matches Rust rendering',
    source: `C4Container
  System_Boundary(sys, "System") {
    Container(app, "App", "Go", "serves")
    ContainerDb(db, "DB", "Postgres", "stores")
  }`,
    check() {
      const light = loadRenderer('light')
      const svg = light.renderMermaidSvg(this.source)
      const sys = c4NodeGroup(svg, 'sys')
      const db = c4NodeGroup(svg, 'db')
      if (!/<rect [^>]*fill="none"/.test(sys)) throw new Error('C4 light boundary should use fill="none" like Rust')
      if (!/<rect [^>]*fill="#ffffff"/.test(db)) throw new Error('C4 light data store should use surface fill like Rust')
      if (db.includes('fill="#f1f5ff"')) throw new Error('C4 light data store should not use surfaceAlt fill')
    },
  },
  {
    name: 'C4 relation labels render as Rust text-only labels',
    source: `C4Context
  Person(user, "User", "reads")
  System(app, "App", "serves")
  Rel_R(user, app, "Reads and edits documents")`,
    check({ svg }) {
      const group = c4RelationGroup(svg, 'user->app:Rel_R')
      if (!group.includes('stroke="#9eb0ff"') || !group.includes('fill="#9eb0ff"')) throw new Error('C4 relation should use Rust theme.link inline arrowhead')
      if (group.includes('<rect')) throw new Error('C4 relation labels should not render callout/background rects')
      if (!group.includes('>Reads and edits documents</text>')) throw new Error('C4 relation label text missing')
      if (!group.includes(`font-family="'LINE Seed JP','Hiragino Sans','Yu Gothic UI','Segoe UI Variable',system-ui,sans-serif"`)) throw new Error('C4 relation label should include Rust text font-family')
      if (!/font-size="11\.0" font-weight="650"/.test(group)) throw new Error('C4 relation label text should use Rust label typography')
      if (!/text-anchor="middle"/.test(group)) throw new Error('C4 centered relation label should use centered text anchor')
      if (group.includes('dominant-baseline')) throw new Error('C4 relation label should use Rust baseline text, not middle baseline')
    },
  },
  {
    name: 'C4 vertical relation labels align like Rust',
    source: `C4Container
  title Docattice Cloudflare delivery
  Person_Ext(client, "Author / Reader", "Uses Docattice in browser")
  System_Boundary(managed, "Cloudflare Managed") {
    Container(worker, "Rust Worker", "Cloudflare Workers", "Serves docs, APIs, and auth flow")
    ContainerDb(d1, "D1 Metadata", "Cloudflare D1", "Stores docs, refs, and permissions")
    ContainerDb(r2, "R2 Markdown", "Cloudflare R2", "Stores markdown snapshots and assets")
  }
  Rel_D(worker, d1, "Loads document graph", "SQL")
  Rel_D(worker, r2, "Reads markdown blobs", "S3 API")`,
    check({ svg }) {
      const d1 = c4RelationGroup(svg, 'worker->d1:Rel_D')
      const r2 = c4RelationGroup(svg, 'worker->r2:Rel_D')
      if (!d1.includes('text-anchor="end"')) throw new Error('C4 left-side vertical label should right-align like Rust')
      if (r2.includes('text-anchor="end"')) throw new Error('C4 right-side vertical label should not right-align')
    },
  },
  {
    name: 'C4 boundary children render in Rust validation-node order',
    source: `C4Container
  System_Boundary(sys, "System") {
    ContainerDb(db, "DB", "Postgres", "stores")
    Container(app, "App", "Go", "serves")
  }
  Rel_D(app, db, "writes")`,
    check({ svg, scene }) {
      const app = scene.layouts.get('app')
      const db = scene.layouts.get('db')
      if (!app || !db) throw new Error('C4 child ordering sample missing layouts')
      if (!(app.y < db.y)) throw new Error(`C4 sample should place app above db: ${app.y}/${db.y}`)
      const appIndex = svg.indexOf('data-c4-id="app"')
      const dbIndex = svg.indexOf('data-c4-id="db"')
      if (appIndex < 0 || dbIndex < 0) throw new Error('C4 child ordering sample missing node markup')
      if (!(appIndex < dbIndex)) throw new Error('C4 boundary children should render by y/x/id like Rust, not declaration order')
    },
  },
]

const classRustSamples = [
  {
    name: 'Class relation labels use Rust baseline placement',
    source: `classDiagram
  direction LR
  class Document {
    +String path
    +u64 published_revision
  }
  class DependencyEdge {
    +String kind
    +String target
  }
  Document "1" --> "*" DependencyEdge : contains`,
    check({ svg }) {
      const group = classRelationGroup(svg, 'Document->DependencyEdge')
      const label = group.match(/<text\b[^>]*>contains<\/text>/)?.[0]
      if (!label) throw new Error('class relation label missing')
      if (label.includes('dominant-baseline')) throw new Error('class relation label should use Rust baseline text')
    },
  },
  {
    name: 'C4Code relation labels use Rust baseline placement',
    source: `C4Code
  title Graph service code structure
  class GraphService {
    +load_document_graph(id)
  }
  class GraphRepository {
    +fetch_document(id)
  }
  GraphService --> GraphRepository : reads`,
    check({ svg }) {
      const group = classRelationGroup(svg, 'GraphService->GraphRepository')
      const label = group.match(/<text\b[^>]*>reads<\/text>/)?.[0]
      if (!label) throw new Error('C4Code relation label missing')
      if (label.includes('dominant-baseline')) throw new Error('C4Code relation label should use Rust baseline text')
    },
  },
]

const flowchartRustSamples = [
  {
    name: 'simple TD data attributes',
    source: `flowchart TD
  A[Start] --> B[End]`,
    check({ svg }) {
      assertIncludes(svg, 'data-flowchart-node="A"', this.name)
      assertIncludes(svg, 'data-flowchart-node="B"', this.name)
      assertIncludes(svg, 'data-flowchart-edge="A->B"', this.name)
      assertIncludes(svg, '>Start</text>', this.name)
      assertIncludes(svg, '>End</text>', this.name)
    },
  },
  {
    name: 'chain syntax creates each edge',
    source: `flowchart LR
  A --> B --> C --> D`,
    check({ svg }) {
      for (const edge of ['A->B', 'B->C', 'C->D']) assertIncludes(svg, `data-flowchart-edge="${edge}"`, this.name)
    },
  },
  {
    name: 'Flowchart LR gallery canvas matches Rust horizontal layout',
    source: `flowchart LR
  Draft[Draft save]
  Analyze[Analyze graph]
  Publish[Publish revision]
  Draft --> Analyze --> Publish`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 720.0 200.0"', this.name)
      for (const edge of ['Draft->Analyze', 'Analyze->Publish']) assertIncludes(svg, `data-flowchart-edge="${edge}"`, this.name)
      assertFlowchartNodeTextCentered(svg, 'Draft', 'Draft save', this.name)
      assertFlowchartNodeTextCentered(svg, 'Analyze', 'Analyze graph', this.name)
      assertFlowchartNodeTextCentered(svg, 'Publish', 'Publish revision', this.name)
    },
  },
  {
    name: 'Flowchart LR keeps back edges from collapsing ranks',
    source: `flowchart LR
  A[Write] --> B{Review}
  B -- Approved --> C[Merge]
  B -- Changes --> A`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 768.0 280.0"', this.name)
      const a = flowchartNodeBounds(svg, 'A')
      const b = flowchartNodeBounds(svg, 'B')
      const c = flowchartNodeBounds(svg, 'C')
      if (!(a.x < b.x && b.x < c.x)) {
        throw new Error(`Flowchart LR cyclic sample should remain horizontal: A=${a.x}, B=${b.x}, C=${c.x}`)
      }
      for (const edge of ['A->B', 'B->C', 'B->A']) assertIncludes(svg, `data-flowchart-edge="${edge}"`, this.name)
    },
  },
  {
    name: 'shape elements match node syntax',
    source: `flowchart TD
  A{Decision}
  B((Circle))
  C[[Subroutine]]
  D([Stadium])
  A --> B --> C --> D`,
    check({ svg }) {
      const diamond = flowchartNodeGroup(svg, 'A')
      const circle = flowchartNodeGroup(svg, 'B')
      const subroutine = flowchartNodeGroup(svg, 'C')
      const stadium = flowchartNodeGroup(svg, 'D')
      if (!diamond.includes('<path d=')) throw new Error('flowchart diamond should render as path')
      if (!diamond.includes('stroke-linecap="round" stroke-linejoin="round"')) throw new Error('flowchart path shapes should match Rust path helper line joins')
      if (!circle.includes('<circle')) throw new Error('flowchart circle should render as circle')
      if ((subroutine.match(/<line /g) || []).length < 2) throw new Error('flowchart subroutine should render side lines')
      if (!stadium.includes('<rect') || !/rx="2[0-9.]+"/.test(stadium)) throw new Error('flowchart stadium should use large radius rect')
    },
  },
  {
    name: 'dotted edge is dashed',
    source: `flowchart TD
  A -.-> B`,
    check({ svg }) {
      const group = flowchartEdgeGroup(svg, 'A->B')
      if (!group.includes('stroke-dasharray')) throw new Error('flowchart dotted edge missing stroke-dasharray')
    },
  },
  {
    name: 'rust edge segment variants',
    source: `flowchart TD
  A --|pipe_label|--> B
  B ==thick_label==> C
  C -.dotted_label.-> D
  D <--> E
  E --- F`,
    check({ svg }) {
      for (const edge of ['A->B', 'B->C', 'C->D', 'D->E', 'E->F']) assertIncludes(svg, `data-flowchart-edge="${edge}"`, this.name)
      assertIncludes(svg, '>pipe_label</text>', this.name)
      assertIncludes(svg, '>thick_label</text>', this.name)
      assertIncludes(svg, '>dotted_label</text>', this.name)
      const thick = flowchartEdgeGroup(svg, 'B->C')
      if (!thick.includes('stroke-width="2"')) throw new Error('flowchart thick edge should match Rust renderer stroke width')
      const dotted = flowchartEdgeGroup(svg, 'C->D')
      if (!dotted.includes('stroke-dasharray')) throw new Error('flowchart dotted labeled edge missing stroke-dasharray')
      const bidirectional = flowchartEdgeGroup(svg, 'D->E')
      if ((bidirectional.match(/<path d="M /g) || []).length < 3) throw new Error('flowchart bidirectional edge missing Rust inline arrowheads')
      const open = flowchartEdgeGroup(svg, 'E->F')
      if ((open.match(/<path d="M /g) || []).length !== 1) throw new Error('flowchart open edge should not render arrowhead')
      if (!flowchartEdgeGroup(svg, 'A->B').includes('stroke="#9eb0ff"')) throw new Error('flowchart edges should use Rust theme.link color')
    },
  },
  {
    name: 'Flowchart edge labels preserve quotes like Rust',
    source: `flowchart TD
  A --|"quoted_pipe"|--> B
  B =="quoted_thick"==> C
  C -."quoted_dotted".-> D`,
    check({ svg }) {
      assertIncludes(svg, '>&quot;quoted_pipe&quot;</text>', this.name)
      assertIncludes(svg, '>&quot;quoted_thick&quot;</text>', this.name)
      assertIncludes(svg, '>&quot;quoted_dotted&quot;</text>', this.name)
    },
  },
  {
    name: 'Flowchart node parser follows Rust id and quote rules',
    source: `flowchart TD
  A["Rect Label"]
  B[\`Backtick Label\`]
  A.B[Ignored Label] --> C[]`,
    check({ svg }) {
      assertIncludes(svg, 'data-flowchart-node="A"', this.name)
      assertIncludes(svg, '>Rect Label</text>', this.name)
      assertIncludes(svg, 'data-flowchart-node="B"', this.name)
      assertIncludes(svg, '>`Backtick Label`</text>', this.name)
      assertIncludes(svg, 'data-flowchart-node="A.B"', this.name)
      assertIncludes(svg, '>A.B</text>', this.name)
      if (svg.includes('Ignored Label')) throw new Error('Flowchart invalid shaped id should fall back to id label like Rust')
      assertIncludes(svg, 'data-flowchart-node="C"', this.name)
    },
  },
  {
    name: 'fanout lanes stay distinct and non-overlapping',
    source: `flowchart TD
  Start --> A
  Start --> B
  Start --> C
  A --> End
  B --> End
  C --> End`,
    check({ svg }) {
      const paths = flowchartEdgePaths(svg)
      if (flowchartCollinearOverlapCount(paths) !== 0) throw new Error('flowchart fanout has collinear edge overlap')
      const lanes = ['Start->A', 'Start->B', 'Start->C'].map((edge) => longestVerticalAxis(paths.get(edge)))
      if (!(lanes[0] < lanes[1] && lanes[1] < lanes[2])) throw new Error(`flowchart fanout lanes out of order: ${lanes.join(', ')}`)
      if (lanes[1] - lanes[0] < 18 || lanes[2] - lanes[1] < 18) throw new Error(`flowchart fanout lanes too close: ${lanes.join(', ')}`)
    },
  },
  {
    name: 'diamond split and merge symmetry',
    source: `flowchart TD
  A --> B
  A --> C
  B --> D
  C --> D`,
    check({ svg }) {
      const a = flowchartNodeBounds(svg, 'A')
      const d = flowchartNodeBounds(svg, 'D')
      const aCenter = a.x + a.w / 2
      const dCenter = d.x + d.w / 2
      const branch = ['B', 'C'].map((id) => {
        const box = flowchartNodeBounds(svg, id)
        return box.x + box.w / 2 - aCenter
      })
      const merge = ['B', 'C'].map((id) => {
        const box = flowchartNodeBounds(svg, id)
        return box.x + box.w / 2 - dCenter
      })
      if (pairedOffsetSymmetryError(branch) > 0.1) throw new Error(`flowchart branch symmetry regressed: ${branch.join(', ')}`)
      if (pairedOffsetSymmetryError(merge) > 0.1) throw new Error(`flowchart merge symmetry regressed: ${merge.join(', ')}`)
    },
  },
  {
    name: 'subgraph renders boundary and contains children',
    source: `flowchart TD
  subgraph sg1[Group]
    A[Inside]
  end
  B[Outside] --> A`,
    check({ svg }) {
      assertIncludes(svg, 'data-flowchart-subgraph="sg1"', this.name)
      assertIncludes(svg, 'data-flowchart-node="A"', this.name)
      assertIncludes(svg, 'data-flowchart-node="B"', this.name)
      assertIncludes(svg, 'data-flowchart-edge="B->A"', this.name)
      const sg = flowchartSubgraphGroup(svg, 'sg1')
      if (!sg.includes('stroke-dasharray="8 4"')) throw new Error('flowchart subgraph should render dashed boundary')
      const sgBounds = flowchartNodeBoundsFromGroup(sg)
      const a = flowchartNodeBounds(svg, 'A')
      if (!(a.x > sgBounds.x && a.y > sgBounds.y && a.x + a.w < sgBounds.x + sgBounds.w && a.y + a.h < sgBounds.y + sgBounds.h)) {
        throw new Error(`flowchart subgraph does not contain child: sg=${JSON.stringify(sgBounds)} child=${JSON.stringify(a)}`)
      }
    },
  },
  {
    name: 'Flowchart subgraph labels preserve quotes like Rust',
    source: `flowchart TD
  subgraph sg1["Quoted Group"]
    A[Inside]
  end`,
    check({ svg }) {
      assertIncludes(svg, 'data-flowchart-subgraph="sg1"', this.name)
      assertIncludes(svg, '>&quot;Quoted Group&quot;</text>', this.name)
    },
  },
  {
    name: 'Flowchart node wrapping and edge labels use Rust text estimates',
    source: `flowchart TD
  A[ill ill ill ill ill ill ill]
  B((ill ill ill ill ill ill ill))
  A --|illillill|--> B`,
    check({ svg }) {
      assertIncludes(svg, 'data-diagram-body="true"', this.name)
      assertIncludes(svg, 'data-diagram-body-center-x=', this.name)
      assertIncludes(svg, '>ill ill ill ill ill ill ill</text>', this.name)
      const a = flowchartNodeBounds(svg, 'A')
      const b = flowchartNodeBounds(svg, 'B')
      if (a.h > 42) throw new Error(`Flowchart rect should keep narrow-glyph label on one line like Rust: h=${a.h}`)
      if (b.w > 150) throw new Error(`Flowchart circle should size from Rust text estimate, not fixed char width: w=${b.w}`)
      const edge = flowchartEdgeGroup(svg, 'A->B')
      const labelRect = edge.match(/<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="18(?:\.0)?"/)
      if (!labelRect) throw new Error('Flowchart edge label should render Rust-like label background')
      const width = Number(labelRect[1])
      if (!(width > 40 && width < 50)) throw new Error(`Flowchart edge label width should use Rust text estimate: ${width}`)
    },
  },
]

const erRustSamples = [
  {
    name: 'ER data attributes and entity cards',
    source: `erDiagram
  DOCUMENT ||--o{ SECTION : contains
  DOCUMENT {
    string path
    int published_revision
  }
  SECTION {
    string section_uid
    string heading
  }`,
    check({ svg }) {
      assertIncludes(svg, 'data-diagram-body="true"', this.name)
      assertIncludes(svg, 'data-diagram-body-center-x=', this.name)
      assertIncludes(svg, 'data-er-entity="DOCUMENT"', this.name)
      assertIncludes(svg, 'data-er-entity="SECTION"', this.name)
      assertIncludes(svg, 'data-er-rel="DOCUMENT->SECTION"', this.name)
      assertIncludes(svg, '>DOCUMENT</text>', this.name)
      assertIncludes(svg, '>string path</text>', this.name)
      assertIncludes(svg, '>int published_revision</text>', this.name)
      const doc = erEntityBounds(svg, 'DOCUMENT')
      if (Math.abs(doc.w - 200) > 0.1) throw new Error(`ER entity width should match Rust 200px, got ${doc.w}`)
      const headerY = svgTextY(erEntityGroup(svg, 'DOCUMENT'), 'DOCUMENT')
      const lastFieldY = svgTextY(erEntityGroup(svg, 'DOCUMENT'), 'int published_revision')
      if (Math.abs(headerY - (doc.y + 16)) > 0.1) throw new Error(`ER header text should be vertically centered: ${headerY}/${doc.y + 16}`)
      if (lastFieldY > doc.y + doc.h - 16) throw new Error(`ER field text should keep bottom padding: ${lastFieldY}/${doc.y + doc.h}`)
    },
  },
  {
    name: 'ER key badges and comments',
    source: `erDiagram
  USER {
    string id PK "primary"
    string email UK
    int org_id FK
  }`,
    check({ svg }) {
      for (const key of ['>PK</text>', '>UK</text>', '>FK</text>', '>primary</text>']) assertIncludes(svg, key, this.name)
      const user = erEntityGroup(svg, 'USER')
      if ((user.match(/<rect /g) || []).length < 5) throw new Error('ER key badges/header should add rect layers')
    },
  },
  {
    name: 'ER dashed relationship and cardinality markers',
    source: `erDiagram
  X ||..o{ Y : optional`,
    check({ svg }) {
      const rel = erRelationshipGroup(svg, 'X->Y')
      if (!rel.includes('stroke="#9eb0ff"')) throw new Error('ER relationship should use Rust theme.link color')
      if (!rel.includes('stroke-dasharray="7 5"')) throw new Error('ER dashed relationship missing stroke-dasharray')
      if (!rel.includes('<circle')) throw new Error('ER optional cardinality should render circle marker')
      if (!/<circle [^>]*r="5\.5" [^>]*stroke="#9eb0ff" stroke-width="1\.5"\/>/.test(rel)) throw new Error('ER cardinality circle should match Rust explicit marker output')
      if ((rel.match(/<line /g) || []).length < 5) throw new Error('ER one/many cardinality should render line markers')
    },
  },
  {
    name: 'ER multiple relationships route distinctly',
    source: `erDiagram
  A ||--|| B : one_to_one
  A ||--o{ C : one_to_many
  B }o--o{ C : many_to_many`,
    check({ svg }) {
      for (const edge of ['A->B', 'A->C', 'B->C']) assertIncludes(svg, `data-er-rel="${edge}"`, this.name)
      const paths = erRelationshipPaths(svg)
      if (flowchartCollinearOverlapCount(paths) > 0) throw new Error('ER relationships should avoid collinear overlap')
    },
  },
  {
    name: 'ER relationship parser preserves Rust labels and non-word ids',
    source: `erDiagram
  ORDER-ITEM ||--|| USER-ACCOUNT : "owns item"
  ORDER-ITEM {
    string id PK
  }`,
    check({ svg }) {
      assertIncludes(svg, 'data-er-entity="ORDER-ITEM"', this.name)
      assertIncludes(svg, 'data-er-entity="USER-ACCOUNT"', this.name)
      assertIncludes(svg, 'data-er-rel="ORDER-ITEM->USER-ACCOUNT"', this.name)
      assertIncludes(svg, '>&quot;owns item&quot;</text>', this.name)
    },
  },
  {
    name: 'ER label and key badge widths use Rust text estimates',
    source: `erDiagram
  A ||--|| B : illillill
  A {
    string id PK
  }`,
    check({ svg }) {
      const rel = erRelationshipRenderSpan(svg, 'A->B')
      const labelRect = rel.match(/<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="20(?:\.0)?" rx="10(?:\.0)?"/)
      if (!labelRect) throw new Error('ER relation label should render Rust-like label pill after relation group')
      const labelWidth = Number(labelRect[1])
      if (!(labelWidth > 46 && labelWidth < 58)) throw new Error(`ER label width should use Rust text estimate: ${labelWidth}`)
      const entity = erEntityGroup(svg, 'A')
      const badgeRect = entity.match(/<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="15(?:\.0)?" rx="3(?:\.0)?"/)
      if (!badgeRect) throw new Error('ER key badge should render width from Rust text estimate')
      const badgeWidth = Number(badgeRect[1])
      if (!(badgeWidth > 24 && badgeWidth < 30)) throw new Error(`ER key badge width should use Rust text estimate: ${badgeWidth}`)
    },
  },
]

const journeyRustSamples = [
  {
    name: 'Journey matches Rust section and score layout',
    source: `journey
title Draft save experience
section Review
Resolve dependency conflicts before publish: 3: Author, Reviewer`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 920.0 333.0"', this.name)
      assertIncludes(svg, '>Draft save experience</text>', this.name)
      assertIncludes(svg, '>Review</text>', this.name)
      assertIncludes(svg, '>Resolve dependency conflicts before publish</text>', this.name)
      assertIncludes(svg, '>Author, Reviewer</text>', this.name)
      assertIncludes(svg, 'x="28.0" y="72.0" width="864.0"', this.name)
      assertIncludes(svg, 'x="48.0" y="124.0" width="824.0" height="65.0"', this.name)
      if ((svg.match(/r="7\.0" fill="#7f94ff" stroke="none"\/>/g) || []).length !== 3) throw new Error('Journey score should fill exactly three Rust rating circles')
      if ((svg.match(/r="7\.0" fill="#1a2130" stroke="none"\/>/g) || []).length !== 2) throw new Error('Journey score should leave two soft rating circles')
    },
  },
  {
    name: 'Journey parser follows Rust colon splitting and score clamp',
    source: `journey
section Work
Label: with: colon: 9: Actor`,
    check({ svg }) {
      assertIncludes(svg, '>Label: with: colon</text>', this.name)
      assertIncludes(svg, '>Actor</text>', this.name)
      if ((svg.match(/r="7\.0" fill="#7f94ff" stroke="none"\/>/g) || []).length !== 5) throw new Error('Journey score should clamp high values to five')
    },
  },
]

const ganttRustSamples = [
  {
    name: 'Gantt section headers and tinted rows',
    source: `gantt
title Plan
section Backend
API :done, api, 2026-03-01, 4d
section Web
UI :active, ui, 2026-03-05, 5d`,
    check({ svg }) {
      assertIncludes(svg, 'fill-opacity="0.10"', this.name)
      assertIncludes(svg, '>Backend</text>', this.name)
      assertIncludes(svg, '>Web</text>', this.name)
      assertIncludes(svg, '>4d</text>', this.name)
      assertIncludes(svg, '>5d</text>', this.name)
      assertIncludes(svg, '<rect x="40.0" y="76.0"', this.name)
      if (svgTextY(svg, 'Backend') !== 90) throw new Error('Gantt section label should be vertically centered in header row')
      if (svgTextY(svg, 'API') !== 123) throw new Error('Gantt task label should be vertically centered in task row')
      if (svgTextY(svg, '4d') !== 123) throw new Error('Gantt duration label should be vertically centered in task bar')
      if (svgTextY(svg, 'Web') !== 156) throw new Error('Gantt second section label should be vertically centered in header row')
      if (svgTextY(svg, 'UI') !== 189) throw new Error('Gantt second task label should be vertically centered in task row')
      if (svgTextY(svg, '5d') !== 189) throw new Error('Gantt second duration label should be vertically centered in task bar')
      const backgroundIndex = svg.indexOf('fill-opacity="0.10"')
      const gridIndex = svg.indexOf('stroke-dasharray="4 4"')
      const labelIndex = svg.indexOf('>Backend</text>')
      if (!(backgroundIndex >= 0 && backgroundIndex < gridIndex && gridIndex < labelIndex)) {
        throw new Error('Gantt layers should render backgrounds behind grid and labels')
      }
    },
  },
  {
    name: 'Gantt date axis and dashed grid',
    source: `gantt
title Schedule
section Work
Task A :a, 2026-04-01, 14d`,
    check({ svg }) {
      assertIncludes(svg, '>4/1</text>', this.name)
      assertIncludes(svg, 'stroke-dasharray="4 4"', this.name)
      assertIncludes(svg, '>14d</text>', this.name)
    },
  },
  {
    name: 'Gantt default task uses section color not warning color',
    source: `gantt
title Test
section Alpha
Planning :p, 2026-02-01, 5d`,
    check({ svg }) {
      assertIncludes(svg, '>Alpha</text>', this.name)
      assertIncludes(svg, '>5d</text>', this.name)
      if (svg.includes('fill="#a86419"')) throw new Error('Gantt default task should not force warning color')
    },
  },
  {
    name: 'Gantt week duration matches Rust duration parser',
    source: `gantt
title Weekly Plan
section Alpha
Sprint :active, s1, 2026-02-01, 2w`,
    check({ svg }) {
      assertIncludes(svg, '>14d</text>', this.name)
    },
  },
  {
    name: 'Gantt duration parser is Rust case-sensitive',
    source: `gantt
title Case
section Sprint
Upper : active, 2026-01-01, 1D`,
    check({ svg }) {
      assertIncludes(svg, '>3d</text>', this.name)
      if (svg.includes('>1d</text>')) throw new Error('Gantt uppercase duration suffix should not parse like Rust')
    },
  },
  {
    name: 'Gantt quoted task names are preserved like Rust',
    source: `gantt
title Quoted Plan
section Alpha
"Quoted Task" :p, 2026-02-01, 1d`,
    check({ svg }) {
      assertIncludes(svg, '>&quot;Quoted Task&quot;</text>', this.name)
      assertIncludes(svg, '>1d</text>', this.name)
    },
  },
  {
    name: 'Gantt invalid month is ignored like Rust SimpleDate',
    source: `gantt
title Invalid Date
section Alpha
Bad Start :p, 2026-13-01, 3d`,
    check({ svg }) {
      assertIncludes(svg, '>1/1</text>', this.name)
      assertIncludes(svg, '>3d</text>', this.name)
      if (svg.includes('>1/1</text>') && svg.includes('>1/8</text>')) return
      throw new Error('Gantt invalid start should fall back to the 2026-01-01 axis')
    },
  },
  {
    name: 'Gantt task labels truncate using Rust text width',
    source: `gantt
title Narrow Glyphs
section Alpha
ill ill ill ill ill ill ill ill ill :p, 2026-02-01, 5d`,
    check({ svg }) {
      assertIncludes(svg, '>ill ill ill ill ill ill ill ill ill</text>', this.name)
      if (svg.includes('>ill ill ill ill ill ill il…</text>')) {
        throw new Error('Gantt task label should not use fixed character-count truncation')
      }
    },
  },
]

const pieRustSamples = [
  {
    name: 'Pie uses Rust canvas, center, legend columns, and stripped quotes',
    source: `pie showData
title Dependency kinds
"constrained_by" : 6
"blocked_by" : 2
"ignored" : 0`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 900.0 494.0"', this.name)
      assertIncludes(svg, 'data-diagram-body-center-x="450.0"', this.name)
      assertIncludes(svg, 'data-diagram-body="true"', this.name)
      assertIncludes(svg, '>Dependency kinds</text>', this.name)
      assertIncludes(svg, 'y="480.0"', this.name)
      assertIncludes(svg, 'M 250.0 220.0', this.name)
      assertIncludes(svg, 'stroke="#ffffff" stroke-width="1.5"', this.name)
      assertIncludes(svg, '>constrained_by</text>', this.name)
      assertIncludes(svg, '>blocked_by</text>', this.name)
      assertIncludes(svg, '>6</text>', this.name)
      assertIncludes(svg, '>2</text>', this.name)
      if (svgTextY(svg, 'constrained_by') !== 130) throw new Error('Pie legend label should align with swatch center')
      if (svgTextY(svg, '6') !== 130) throw new Error('Pie legend value should align with swatch center')
      if (svg.includes('ignored')) throw new Error('Pie should skip non-positive slices')
      if (svg.includes('&quot;') || svg.includes('>\"')) throw new Error('Pie should strip quoted labels')
    },
  },
  {
    name: 'Pie accepts Rust f32-style positive values',
    source: `pie
title Numbers
'plus' : +4
"exponent" : 1e2
negative : -5`,
    check({ svg }) {
      assertIncludes(svg, '>plus</text>', this.name)
      assertIncludes(svg, '>exponent</text>', this.name)
      assertIncludes(svg, '>4</text>', this.name)
      assertIncludes(svg, '>100</text>', this.name)
      if (svg.includes('negative')) throw new Error('Pie should skip negative values')
    },
  },
  {
    name: 'Pie preserves backtick labels like Rust strip_quotes',
    source: `pie
title Backticks
\`raw\` : 3`,
    check({ svg }) {
      assertIncludes(svg, '>`raw`</text>', this.name)
    },
  },
  {
    name: 'Pie title directive is Rust case-sensitive',
    source: `pie
TITLE Not A Title
A : 1`,
    check({ svg }) {
      assertIncludes(svg, '>Pie</text>', this.name)
      if (svg.includes('>Not A Title</text>')) throw new Error('Pie uppercase TITLE should not replace title like Rust')
    },
  },
]

const requirementRustSamples = [
  {
    name: 'Requirement title parsing and card styling',
    source: `requirementDiagram
title "Auth Spec"
requirement auth {
id: REQ-1
text: Require auth
}
element worker {
type: service
}`,
    check({ svg }) {
      assertIncludes(svg, 'data-diagram-body="true"', this.name)
      assertIncludes(svg, 'data-diagram-body-center-x="446.0"', this.name)
      assertIncludes(svg, '>Auth Spec</text>', this.name)
      if (svg.includes('>Requirement Diagram</text>')) throw new Error('Requirement explicit title should replace default title')
      assertIncludes(svg, '>requirement</text>', this.name)
      assertIncludes(svg, '>element</text>', this.name)
      assertIncludes(svg, 'rx="9.0"', this.name)
      assertIncludes(svg, 'width="4.0"', this.name)
      assertIncludes(svg, '>Require auth</text>', this.name)
      assertIncludes(svg, '>id: REQ-1</text>', this.name)
    },
  },
  {
    name: 'Requirement default title and edge-to-edge relation',
    source: `requirementDiagram
requirement auth {
id: REQ-1
text: Require auth
}
element worker {
type: service
}
worker - satisfies -> auth`,
    check({ svg }) {
      assertIncludes(svg, '>Requirement Diagram</text>', this.name)
      assertIncludes(svg, '>satisfies</text>', this.name)
      assertIncludes(svg, 'height="306.0"', this.name)
      assertIncludes(svg, '<line x1="28.0" y1="264.0" x2="864.0" y2="264.0"', this.name)
      assertIncludes(svg, '<text x="446.0" y="292.0"', this.name)
      assertIncludes(svg, 'stroke="#9eb0ff"', this.name)
      assertIncludes(svg, 'fill="#9eb0ff"', this.name)
      const pathsOrLines = svg.match(/<line x1="[^"]+" y1="[^"]+" x2="[^"]+" y2="[^"]+"/g) || []
      if (!pathsOrLines.some((line) => /x1="496(?:\.0)?" y1="[^"]+" x2="396(?:\.0)?"/.test(line))) {
        throw new Error('Requirement relation should connect card edges, not centers')
      }
    },
  },
  {
    name: 'Requirement accepts arbitrary Rust block kind and single quoted title',
    source: `requirementDiagram
title 'Trace Spec'
riskControl rc1 {
text: Mitigate risk
}
element worker {
type: service
}
worker - traces -> rc1`,
    check({ svg }) {
      assertIncludes(svg, '>Trace Spec</text>', this.name)
      assertIncludes(svg, '>riskControl</text>', this.name)
      assertIncludes(svg, '>Mitigate risk</text>', this.name)
      assertIncludes(svg, '>traces</text>', this.name)
    },
  },
  {
    name: 'Requirement keeps property quotes like Rust except diagram title',
    source: `requirementDiagram
title "Quote Handling"
requirement quoted {
id: "REQ-2"
text: "Keep quoted text"
}
element worker {
type: "service"
}`,
    check({ svg }) {
      assertIncludes(svg, '>Quote Handling</text>', this.name)
      assertIncludes(svg, '>&quot;Keep quoted text&quot;</text>', this.name)
      assertIncludes(svg, '>id: &quot;REQ-2&quot;</text>', this.name)
      assertIncludes(svg, '>type: &quot;service&quot;</text>', this.name)
    },
  },
  {
    name: 'Requirement preserves backtick title like Rust strip_quotes',
    source: `requirementDiagram
title \`Trace Spec\`
requirement auth {
text: Auth
}`,
    check({ svg }) {
      assertIncludes(svg, '>`Trace Spec`</text>', this.name)
    },
  },
  {
    name: 'Requirement title directive is Rust case-sensitive',
    source: `requirementDiagram
TITLE Not A Title
requirement auth {
text: Auth
}`,
    check({ svg }) {
      assertIncludes(svg, '>Requirement Diagram</text>', this.name)
      if (svg.includes('>Not A Title</text>')) throw new Error('Requirement uppercase TITLE should not replace title like Rust')
    },
  },
  {
    name: 'Requirement relation parsing follows Rust split-on-arrow',
    source: `requirementDiagram
requirement auth {
text: Auth
}
element worker {
type: service
}
worker - verifies with detail -> auth`,
    check({ svg }) {
      assertIncludes(svg, '>verifies with detail</text>', this.name)
    },
  },
  {
    name: 'Requirement wrapping and badge widths use Rust text estimates',
    source: `requirementDiagram
requirement narrow {
text: ill ill ill ill ill ill ill ill ill ill
}
wideKindName worker {
type: WWW service
}`,
    check({ svg }) {
      assertIncludes(svg, '>ill ill ill ill ill ill ill ill ill ill</text>', this.name)
      if (svg.includes('>ill ill ill ill ill</text>')) throw new Error('Requirement title should not use character-count wrapping')
      const badge = [...svg.matchAll(/<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="18.0" rx="9.0" fill="[^"]+" fill-opacity="0.18"\/>/g)]
        .map((match) => Number(match[1]))
      if (!badge.some((width) => width > 82 && width < 90)) {
        throw new Error(`Requirement badge width should use Rust text estimate, got ${badge.join(', ')}`)
      }
    },
  },
]

const gitGraphRustSamples = [
  {
    name: 'GitGraph branch colors and merge label',
    source: `gitGraph
commit id: "init"
branch feature
checkout feature
commit id: "work"
checkout main
merge feature`,
    check({ svg }) {
      assertIncludes(svg, '>Git Graph</text>', this.name)
      assertIncludes(svg, '>main</text>', this.name)
      assertIncludes(svg, '>feature</text>', this.name)
      assertIncludes(svg, '>merge feature</text>', this.name)
      assertIncludes(svg, 'r="10.0"', this.name)
      assertIncludes(svg, 'stroke-width="2"', this.name)
      assertIncludes(svg, 'r="14.0" fill="#66d4a4" fill-opacity="0.20" stroke="none" stroke-width="1.5"', this.name)
      assertIncludes(svg, 'stroke-dasharray="7 5"', this.name)
      if (svgTextY(svg, 'main') !== 94) throw new Error('GitGraph branch label should align with lane center')
      if (svgTextY(svg, 'init') !== 94) throw new Error('GitGraph commit label should align with commit node center')
      if (!svg.includes('fill="#66d4a4"')) throw new Error('GitGraph branch/merge arrows should use Rust inline arrowhead fill')
      if (!svg.includes('#8ea0ff') || !svg.includes('#66d4a4')) throw new Error('GitGraph should use per-branch palette colors')
    },
  },
  {
    name: 'GitGraph explicit title replaces default',
    source: `gitGraph
title "Release Flow"
commit id: "v1"`,
    check({ svg }) {
      assertIncludes(svg, '>Release Flow</text>', this.name)
      if (svg.includes('>Git Graph</text>')) throw new Error('GitGraph explicit title should replace default title')
      assertIncludes(svg, '>v1</text>', this.name)
    },
  },
  {
    name: 'GitGraph single quoted title and commit id match Rust strip_quotes',
    source: `gitGraph
title 'Hotfix Flow'
commit id: 'fix-1'`,
    check({ svg }) {
      assertIncludes(svg, '>Hotfix Flow</text>', this.name)
      assertIncludes(svg, '>fix-1</text>', this.name)
    },
  },
  {
    name: 'GitGraph preserves backtick title and commit id like Rust strip_quotes',
    source: `gitGraph
title \`Backtick Flow\`
commit id: \`rev-1\``,
    check({ svg }) {
      assertIncludes(svg, '>`Backtick Flow`</text>', this.name)
      assertIncludes(svg, '>`rev-1`</text>', this.name)
    },
  },
  {
    name: 'GitGraph commands are Rust case-sensitive',
    source: `gitGraph
TITLE Not A Title
commit id: "v1"`,
    check({ svg }) {
      assertIncludes(svg, '>Git Graph</text>', this.name)
      if (svg.includes('>Not A Title</text>')) throw new Error('GitGraph uppercase TITLE should not replace title like Rust')
    },
  },
  {
    name: 'GitGraph preserves quoted branch names like Rust',
    source: `gitGraph
commit id: "init"
branch "feature qa"
checkout "feature qa"
commit id: "work"
checkout main
merge "feature qa"`,
    check({ svg }) {
      assertIncludes(svg, '>&quot;feature qa&quot;</text>', this.name)
      assertIncludes(svg, '>merge &quot;feature qa&quot;</text>', this.name)
    },
  },
  {
    name: 'GitGraph commit id parser keeps Rust trailing metadata behavior',
    source: `gitGraph
commit id: "v1" tag: "release"`,
    check({ svg }) {
      assertIncludes(svg, '>v1&quot; tag: &quot;release</text>', this.name)
    },
  },
]

const quadrantRustSamples = [
  {
    name: 'Quadrant chart matches Rust canvas and labeled geometry',
    source: `quadrantChart
title Strategy Matrix
x-axis Low --> High
y-axis Cheap --> Expensive
quadrant-1 Winners
quadrant-2 Invest
quadrant-3 Avoid
quadrant-4 Niche
"Alpha" : [0.25, 0.75]
Beta : [1.2, -0.4]`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 860.0 584.0"', this.name)
      assertIncludes(svg, '>Strategy Matrix</text>', this.name)
      assertIncludes(svg, '<clipPath id="qclip">', this.name)
      assertIncludes(svg, 'x="110.0" y="110.0" width="620.0" height="320.0" rx="20.0"', this.name)
      assertIncludes(svg, '>Winners</text>', this.name)
      assertIncludes(svg, '>Invest</text>', this.name)
      assertIncludes(svg, '>Avoid</text>', this.name)
      assertIncludes(svg, '>Niche</text>', this.name)
      assertIncludes(svg, '>Alpha</text>', this.name)
      assertIncludes(svg, 'cx="265.0" cy="190.0" r="7.0"', this.name)
      assertIncludes(svg, 'cx="730.0" cy="430.0" r="7.0"', this.name)
      if (svg.includes('&quot;Alpha&quot;')) throw new Error('Quadrant point labels should strip double quotes like Rust')
    },
  },
  {
    name: 'Quadrant directives are Rust case-sensitive',
    source: `quadrantChart
TITLE Not A Title
A : [0.5, 0.5]`,
    check({ svg }) {
      assertIncludes(svg, '>Quadrant</text>', this.name)
      if (svg.includes('>Not A Title</text>')) throw new Error('Quadrant uppercase TITLE should not replace title like Rust')
    },
  },
]

const mindmapRustSamples = [
  {
    name: 'Mindmap matches Rust layout and curved links',
    source: `mindmap
root((Docattice))
  Authoring
    Markdown
  Graph`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 920.0 376.0"', this.name)
      assertIncludes(svg, '>Mindmap</text>', this.name)
      assertIncludes(svg, '>root((Docattice</text>', this.name)
      assertIncludes(svg, '>Authoring</text>', this.name)
      assertIncludes(svg, '>Markdown</text>', this.name)
      assertIncludes(svg, '>Graph</text>', this.name)
      assertIncludes(svg, 'x="80.0" y="78.0" width="136.0" height="32.0" rx="16.0"', this.name)
      assertIncludes(svg, 'x="240.0" y="126.0" width="136.0" height="32.0" rx="16.0"', this.name)
      assertIncludes(svg, '<path d="M 216 94 C 236 94, 220 142, 240 142"', this.name)
      assertIncludes(svg, 'stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round"', this.name)
    },
  },
  {
    name: 'Mindmap preserves backticks like Rust strip_quotes',
    source: `mindmap
\`Root\`
  'Child'`,
    check({ svg }) {
      assertIncludes(svg, '>`Root`</text>', this.name)
      assertIncludes(svg, '>Child</text>', this.name)
    },
  },
]

const timelineRustSamples = [
  {
    name: 'Timeline section support and Rust geometry',
    source: `timeline
title Project
section Phase 1
2026-01 : Design
2026-02 : Build
section Phase 2
2026-03 : Test`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 860', this.name)
      assertIncludes(svg, '>Project</text>', this.name)
      assertIncludes(svg, '>Phase 1</text>', this.name)
      assertIncludes(svg, '>Phase 2</text>', this.name)
      assertIncludes(svg, '>Design</text>', this.name)
      assertIncludes(svg, '>Build</text>', this.name)
      assertIncludes(svg, '>Test</text>', this.name)
      assertIncludes(svg, 'cx="164.0"', this.name)
    },
  },
  {
    name: 'Timeline backward-compatible first item and wrapping',
    source: `timeline
title Milestones
2026-03 : Seeded local docs
2026-04 : Deliver a timeline event label that definitely wraps into two centered rows so the regression test can verify vertical alignment inside the card renderer without relying on baseline offsets`,
    check({ svg }) {
      assertIncludes(svg, 'y="118.0"', this.name)
      assertIncludes(svg, '>Seeded local docs</text>', this.name)
      assertIncludes(svg, '>Deliver a timeline event label that definitely wraps into two centered rows so</text>', this.name)
      assertIncludes(svg, '>the regression test can verify vertical alignment inside the card renderer</text>', this.name)
      assertIncludes(svg, 'x="226.0"', this.name)
    },
  },
  {
    name: 'Timeline quoted dates and labels are preserved like Rust',
    source: `timeline
title Quotes
section "Phase A"
"2026-Q1" : "Kickoff"`,
    check({ svg }) {
      assertIncludes(svg, '>&quot;Phase A&quot;</text>', this.name)
      assertIncludes(svg, '>&quot;2026-Q1&quot;</text>', this.name)
      assertIncludes(svg, '>&quot;Kickoff&quot;</text>', this.name)
    },
  },
  {
    name: 'Timeline title directive is Rust case-sensitive',
    source: `timeline
TITLE Not A Title
2026 : Event`,
    check({ svg }) {
      assertIncludes(svg, '>Timeline</text>', this.name)
      if (svg.includes('>Not A Title</text>')) throw new Error('Timeline uppercase TITLE should not replace title like Rust')
    },
  },
]

const zenumlRustSamples = [
  {
    name: 'ZenUML matches Rust actor and message geometry',
    source: `zenuml
@Actor "Author"
@Boundary "Web"
"Author"->"Web": Edit markdown`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 500.0 268.0"', this.name)
      assertIncludes(svg, '>ZenUML</text>', this.name)
      assertIncludes(svg, '>Author</text>', this.name)
      assertIncludes(svg, '>Web</text>', this.name)
      assertIncludes(svg, '>Edit markdown</text>', this.name)
      assertIncludes(svg, 'x="52.0" y="82.0" width="116.0" height="42.0" rx="16.0"', this.name)
      assertIncludes(svg, 'x="222.0" y="82.0" width="116.0" height="42.0" rx="16.0"', this.name)
      assertIncludes(svg, '<line x1="110.0" y1="156.0" x2="280.0" y2="156.0" stroke="#9eb0ff" stroke-width="2"', this.name)
      assertIncludes(svg, 'x="128.0" y="132.0" width="134.0" height="28.0" rx="14.0"', this.name)
    },
  },
  {
    name: 'ZenUML preserves backticks and colon labels like Rust',
    source: `zenuml
\`Client\`->'Worker': save: draft`,
    check({ svg }) {
      assertIncludes(svg, '>`Client`</text>', this.name)
      assertIncludes(svg, '>Worker</text>', this.name)
      assertIncludes(svg, '>save: draft</text>', this.name)
    },
  },
]

const sequenceQualitySamples = [
  {
    name: 'Sequence decodes GitHub escaped arrows and keeps participant names clean',
    source: `sequenceDiagram
  participant Client
  participant Worker
  Client-&gt;&gt;Worker: save draft
  Worker--&gt;&gt;Client: merge result`,
    check({ svg }) {
      assertIncludes(svg, 'viewBox="0 0 520.0 240.0"', this.name)
      assertIncludes(svg, '>Client</text>', this.name)
      assertIncludes(svg, '>Worker</text>', this.name)
      assertIncludes(svg, '>save draft</tspan>', this.name)
      assertIncludes(svg, '>merge result</tspan>', this.name)
      if (svg.includes('&gt;&gt;Worker') || svg.includes('&gt;&gt;Client')) throw new Error('Sequence arrow token leaked into participant label')
      if ((svg.match(/stroke-dasharray="7 7"/g) || []).length < 1) throw new Error('Sequence dashed reply should be dashed like Rust')
      if ((svg.match(/marker-end="url\(#doc-seq-[^)]+-arrow\)"/g) || []).length < 1) throw new Error('Sequence solid call should have scoped Rust marker')
      if (svg.includes('doc-sequence-label-bg') || svg.includes('rx="14"')) throw new Error('Sequence should not render old label background boxes')
    },
  },
  {
    name: 'Sequence aliases and self messages use Rust loop geometry',
    source: `sequenceDiagram
  actor U as User
  participant S as Service
  U->>S: request
  S->>S: validate`,
    check({ svg }) {
      assertIncludes(svg, '>User</text>', this.name)
      assertIncludes(svg, '>Service</text>', this.name)
      assertIncludes(svg, '>validate</tspan>', this.name)
      if (!svg.includes('<path class="doc-sequence-line" d="M')) throw new Error('Sequence self message should use Rust loop path')
      if (svg.includes('S-xU')) throw new Error('Sequence unsupported lost syntax should not leak')
    },
  },
]

function loadRenderer(mode = 'dark') {
  let code = fs.readFileSync(scriptPath, 'utf8')
  code = code.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, '')
  code = code.replace(/^\(\(\) => \{\n  'use strict'\n/, '(() => {\n')
  code = code.replace(
    /\n  if \(document\.readyState[\s\S]*?\n\}\)\(\)\n?$/,
    `
return {
  renderMermaidSvg,
  parseC4Model,
  layoutC4Scene,
  c4BuildWorkItems,
  c4AssignLabels,
  c4RepairWorkItems,
  c4BuildValidationScene,
  c4ValidateScene,
  replacementHtml,
  errorHtml,
  extractMermaidFences,
  extractAllMermaidFences,
  rememberRawMarkdownSources,
  rawMarkdownSourceForElement,
  mermaidHeadingDiagramType,
  shouldRenderSourceAtElement,
}
})()`,
  )

  return vm.runInNewContext(code, {
    console,
    Element: function Element() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    MutationObserver: function MutationObserver() {},
    window: {
      location: { pathname: '' },
      matchMedia: () => ({ matches: mode === 'dark' }),
    },
    document: {
      documentElement: { getAttribute: () => mode },
      querySelectorAll: () => [],
      createElement: () => ({
        value: '',
        set innerHTML(value) {
          this.value = String(value)
            .replaceAll('&gt;', '>')
            .replaceAll('&lt;', '<')
            .replaceAll('&amp;', '&')
        },
      }),
    },
  })
}

function mermaidBlocks(markdown) {
  return [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
}

function diagramType(source) {
  return source.split(/\s+/, 1)[0]
}

function assertIncludes(value, fragment, label) {
  if (!value.includes(fragment)) throw new Error(`${label}: missing ${fragment}`)
}

function assertRustSvgShell(svg, label) {
  assertIncludes(svg, 'data-diagram-body="true"', label)
  assertIncludes(svg, 'data-diagram-body-center-x=', label)
  if (svg.includes('docattice-arrow') || svg.includes('marker-end="url(#docattice-arrow)"')) {
    throw new Error(`${label}: Rust SVG shell should use inline arrowheads, not marker defs`)
  }
}

function viewBoxOf(svg, label) {
  const match = svg.match(/viewBox="([^"]+)"/)
  if (!match) throw new Error(`${label}: missing viewBox`)
  return match[1]
}

function titleOf(source) {
  return source.match(/^\s*title\s+(.+)$/m)?.[1] || ''
}

function assertGalleryViewBoxes(renderer, galleryBlocks) {
  const expectedTypes = new Set(galleryViewBoxExpectations.map((expected) => expected.type))
  const targetBlocks = galleryBlocks.filter((source) => expectedTypes.has(diagramType(source)))
  if (targetBlocks.length !== galleryViewBoxExpectations.length) {
    throw new Error(`gallery viewBox expectation count mismatch: ${targetBlocks.length}/${galleryViewBoxExpectations.length}`)
  }
  galleryViewBoxExpectations.forEach((expected, arrayIndex) => {
    const source = targetBlocks[arrayIndex]
    const type = diagramType(source)
    if (type !== expected.type) {
      throw new Error(`gallery #${expected.index}: expected type ${expected.type}, got ${type}`)
    }
    if (expected.title != null && titleOf(source) !== expected.title) {
      throw new Error(`gallery #${expected.index}: expected title ${expected.title}, got ${titleOf(source)}`)
    }
    const svg = renderer.renderMermaidSvg(source)
    const actual = viewBoxOf(svg, `gallery #${expected.index} ${type}`)
    if (actual !== expected.viewBox) {
      throw new Error(`gallery #${expected.index} ${type}: viewBox ${actual}, expected ${expected.viewBox}`)
    }
    if (type === 'architecture-beta') {
      assertArchitectureRoutesAvoidNodeBodies(svg, `gallery #${expected.index} architecture-beta`)
      assertArchitectureJunctionAnchors(svg, `gallery #${expected.index} architecture-beta`)
      assertArchitectureJunctionRoutesClearBodies(svg, `gallery #${expected.index} architecture-beta`)
    }
    if (type === 'stateDiagram-v2') {
      assertStateNodeTextCentered(svg, 'Draft', 'Draft', `gallery #${expected.index} state node`)
      assertStateNodeTextCentered(svg, 'Ready', 'Ready', `gallery #${expected.index} state node`)
      assertStateNodeTextCentered(svg, 'Published', 'Published', `gallery #${expected.index} state node`)
      assertPillTextCentered(svg, 'analyze ok', `gallery #${expected.index} state label`)
      assertPillTextCentered(svg, 'publish', `gallery #${expected.index} state label`)
    }
  })
}

function rustParityHelperPath() {
  const dir = path.join(os.tmpdir(), 'docattice-tampermonkey-rust-parity')
  const srcDir = path.join(dir, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  const cargoToml = `[package]
name = "docattice-tampermonkey-rust-parity"
version = "0.1.0"
edition = "2021"

[dependencies]
docattice-mermaid-extras = { path = ${JSON.stringify(path.join(root, 'crates/mermaid_extras'))} }
`
  const mainRs = `use std::io::{self, Read};

fn main() {
    let mut source = String::new();
    io::stdin().read_to_string(&mut source).expect("read stdin");
    match docattice_mermaid_extras::render_mermaid_extra_svg(&source, "dark") {
        Ok(svg) => print!("{svg}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(42);
        }
    }
}
`
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), cargoToml)
  fs.writeFileSync(path.join(srcDir, 'main.rs'), mainRs)
  cp.execFileSync('cargo', ['build', '--quiet', '--manifest-path', path.join(dir, 'Cargo.toml')], {
    cwd: root,
    stdio: 'inherit',
  })
  const binary = process.platform === 'win32'
    ? path.join(dir, 'target/debug/docattice-tampermonkey-rust-parity.exe')
    : path.join(dir, 'target/debug/docattice-tampermonkey-rust-parity')
  return binary
}

function uniqueSources(sources) {
  const seen = new Set()
  return sources.filter((source) => {
    const normalized = source.trim()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function rustParitySources(galleryBlocks, supportedTypes) {
  return uniqueSources(
    galleryBlocks
      .concat(c4RegressionSamples)
      .concat(c4RustComplexScenarios.map((sample) => sample.source))
      .concat(c4InvariantSamples.map((sample) => sample.source))
      .concat(classRustSamples.map((sample) => sample.source))
      .concat(flowchartRustSamples.map((sample) => sample.source))
      .concat(erRustSamples.map((sample) => sample.source))
      .concat(journeyRustSamples.map((sample) => sample.source))
      .concat(ganttRustSamples.map((sample) => sample.source))
      .concat(pieRustSamples.map((sample) => sample.source))
      .concat(quadrantRustSamples.map((sample) => sample.source))
      .concat(requirementRustSamples.map((sample) => sample.source))
      .concat(gitGraphRustSamples.map((sample) => sample.source))
      .concat(mindmapRustSamples.map((sample) => sample.source))
      .concat(timelineRustSamples.map((sample) => sample.source))
      .concat(zenumlRustSamples.map((sample) => sample.source)),
  ).filter((source) => {
    const type = diagramType(source)
    return supportedTypes.has(type) && type !== 'sequenceDiagram'
  })
}

function textContents(svg) {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
}

function textTokens(values) {
  return values
    .flatMap((value) => value.split(/\s+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
}

function svgQualitySignature(svg, label) {
  const viewBox = viewBoxOf(svg, label)
  return {
    viewBox,
    text: textContents(svg),
    lineCount: (svg.match(/<line\b/g) || []).length,
    pathCount: (svg.match(/<path\b/g) || []).length,
    rectCount: (svg.match(/<rect\b/g) || []).length,
    circleCount: (svg.match(/<circle\b/g) || []).length,
    polygonCount: (svg.match(/<polygon\b/g) || []).length,
    polylineCount: (svg.match(/<polyline\b/g) || []).length,
    markerCount: (svg.match(/marker-end=/g) || []).length,
  }
}

function assertRustParity(renderer, galleryBlocks, supportedTypes) {
  const helper = rustParityHelperPath()
  const mismatches = []
  const sources = rustParitySources(galleryBlocks, supportedTypes)
  for (const source of sources) {
    const type = diagramType(source)
    const label = `${type} ${titleOf(source) || source.split('\n').slice(0, 2).join(' / ')}`
    let rustSvg
    try {
      rustSvg = cp.execFileSync(helper, { input: source, encoding: 'utf8', timeout: 5000 })
    } catch (error) {
      throw new Error(`${label}: Rust renderer failed: ${String(error.stderr || error.message).trim()}`)
    }
    const jsSvg = renderer.renderMermaidSvg(source)
    const rust = svgQualitySignature(rustSvg, `${label} Rust`)
    const js = svgQualitySignature(jsSvg, `${label} JS`)
    const mismatch = []
    if (js.viewBox !== rust.viewBox) mismatch.push(`viewBox JS=${js.viewBox} Rust=${rust.viewBox}`)
    for (const key of ['lineCount', 'pathCount', 'rectCount', 'circleCount', 'polygonCount', 'polylineCount']) {
      if (Math.abs(js[key] - rust[key]) > Math.max(2, Math.ceil(rust[key] * 0.2))) {
        mismatch.push(`${key} JS=${js[key]} Rust=${rust[key]}`)
      }
    }
    const jsText = textTokens(js.text)
    const rustText = textTokens(rust.text)
    if (jsText.length !== rustText.length || jsText.join('\u001f') !== rustText.join('\u001f')) {
      mismatch.push(`text JS=${JSON.stringify(js.text)} Rust=${JSON.stringify(rust.text)}`)
    }
    if (mismatch.length) mismatches.push(`${label}: ${mismatch.join('; ')}`)
  }
  if (mismatches.length) {
    throw new Error(`Rust parity mismatches:\n${mismatches.slice(0, 20).join('\n')}`)
  }
  return sources.length
}

function assertRequestedDiagramCoverage(galleryBlocks, supportedTypes) {
  const galleryTypes = new Set(galleryBlocks.map((source) => diagramType(source)))
  const missingSupport = [...requestedDiagramTypes].filter((type) => !supportedTypes.has(type))
  if (missingSupport.length) {
    throw new Error(`requested diagram types missing from renderer support: ${missingSupport.join(', ')}`)
  }
  const missingGallery = [...requestedDiagramTypes].filter((type) => !galleryTypes.has(type))
  if (missingGallery.length) {
    throw new Error(`requested diagram types missing from gallery verification: ${missingGallery.join(', ')}`)
  }
  const missingViewBox = [...requestedDiagramTypes].filter((type) => (
    !galleryViewBoxExpectations.some((expected) => expected.type === type)
  ))
  if (missingViewBox.length) {
    throw new Error(`requested diagram types missing from viewBox parity expectations: ${missingViewBox.join(', ')}`)
  }
}

function assertGitHubReplacementShell(renderer) {
  const source = 'flowchart LR\n  A[Start] --> B[End]'
  const svg = renderer.renderMermaidSvg(source)
  const html = renderer.replacementHtml(source, svg)
  assertIncludes(html, 'class="docattice-github-mermaid"', 'GitHub replacement shell')
  assertIncludes(html, 'data-docattice-diagram-type="flowchart"', 'GitHub replacement shell')
  assertIncludes(html, 'class="docattice-github-mermaid__stage"', 'GitHub replacement shell')
  assertIncludes(html, '<summary>Mermaid source</summary>', 'GitHub replacement shell')
  assertIncludes(html, 'flowchart LR', 'GitHub replacement shell')
  if (!html.includes('<svg') || !html.includes('data-diagram-body="true"')) {
    throw new Error('GitHub replacement shell should embed rendered Docattice SVG')
  }

  const error = renderer.errorHtml(source, new Error('boom <unsafe>'))
  assertIncludes(error, 'Docattice Mermaid render failed', 'GitHub error shell')
  assertIncludes(error, 'boom &lt;unsafe&gt;', 'GitHub error shell')
  if (error.includes('boom <unsafe>')) throw new Error('GitHub error shell should escape error text')

  const mixedMarkdown = [
    '```mermaid',
    'venn',
    '  A',
    '```',
    '',
    '```mermaid',
    'C4Container',
    '  Container(api, "API", "Go", "Entry point")',
    '```',
  ].join('\n')
  if (renderer.extractAllMermaidFences(mixedMarkdown).length !== 2) {
    throw new Error('Raw Mermaid extraction should keep unsupported fences for positional matching')
  }
  if (renderer.extractMermaidFences(mixedMarkdown).length !== 1) {
    throw new Error('Supported Mermaid extraction should still filter unsupported fences')
  }
  renderer.rememberRawMarkdownSources(mixedMarkdown)
  const firstElement = {}
  const secondElement = {}
  if (diagramType(renderer.rawMarkdownSourceForElement(firstElement)) !== 'venn') {
    throw new Error('Raw source mapping should consume unsupported fences instead of skipping to the next supported diagram')
  }
  if (diagramType(renderer.rawMarkdownSourceForElement(secondElement)) !== 'C4Container') {
    throw new Error('Raw source mapping should preserve source order after unsupported fences')
  }
  renderer.rememberRawMarkdownSources(mixedMarkdown)
  if (diagramType(renderer.rawMarkdownSourceForElement({}, 'C4Container')) !== 'C4Container') {
    throw new Error('Typed raw source mapping should skip unsupported fences without assigning them to supported render slots')
  }
  if (renderer.mermaidHeadingDiagramType('Venn') !== 'venn-beta') {
    throw new Error('Heading type detection should recognize Venn sections')
  }
  const vennHeading = {
    textContent: 'Venn',
    matches: (selector) => selector.includes('h3'),
    previousElementSibling: null,
  }
  const directive = {
    matches: () => false,
    previousElementSibling: vennHeading,
  }
  const renderedBlock = {
    matches: () => false,
    previousElementSibling: directive,
    parentElement: null,
  }
  if (renderer.shouldRenderSourceAtElement(renderedBlock, 'C4Container\n  Container(api, "API", "Go", "Entry point")')) {
    throw new Error('Unsupported section headings should block fallback assignment of a different supported diagram')
  }
  const fences = renderer.extractMermaidFences(`x\n\`\`\`mermaid\n${source}\n\`\`\`\ny`)
  if (fences.length !== 1 || fences[0] !== source) throw new Error('GitHub fence extraction should preserve supported source')
}

function svgAttrValue(snippet, attrName) {
  const match = snippet.match(new RegExp(`(?:^|\\s)${attrName}="([^"]+)"`))
  return match?.[1] ?? null
}

function svgTextY(svg, content) {
  const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = svg.match(new RegExp(`<text\\b[^>]*>${escaped}</text>`))
  if (!match) throw new Error(`missing SVG text ${content}`)
  return Number(svgAttrValue(match[0], 'y'))
}

function assertPillTextCentered(svg, content, label) {
  const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const textMatch = new RegExp(`<text\\b([^>]*)>${escaped}</text>`).exec(svg)
  if (!textMatch) throw new Error(`${label}: missing label text ${content}`)
  const textStart = textMatch.index
  const textY = Number(svgAttrValue(textMatch[0], 'y'))
  const rectMatches = [...svg.slice(0, textStart).matchAll(/<rect\b[^>]*height="20(?:\.0)?"[^>]*>/g)]
  const rectTag = rectMatches.at(-1)?.[0]
  if (!rectTag) throw new Error(`${label}: missing pill background for ${content}`)
  const rectY = Number(svgAttrValue(rectTag, 'y'))
  const rectH = Number(svgAttrValue(rectTag, 'height'))
  if (Math.abs(textY - (rectY + rectH / 2)) > 0.1) {
    throw new Error(`${label}: pill text ${content} not centered ${textY}/${rectY + rectH / 2}`)
  }
}

function svgGroupAt(svg, start) {
  const tokens = [...svg.slice(start).matchAll(/<g(?:\s|>)|<\/g>/g)]
  let depth = 0
  for (const token of tokens) {
    if (token[0].startsWith('<g')) depth += 1
    else {
      depth -= 1
      if (depth === 0) return svg.slice(start, start + token.index + token[0].length)
    }
  }
  return null
}

function flowchartNodeGroup(svg, id) {
  const marker = `<g data-flowchart-node="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing flowchart node ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated flowchart node ${id}`)
  return group
}

function c4NodeGroup(svg, id) {
  const marker = `data-c4-id="${id}"`
  const attrIndex = svg.indexOf(marker)
  if (attrIndex < 0) throw new Error(`missing C4 node ${id}`)
  const start = svg.lastIndexOf('<g ', attrIndex)
  const next = svg.indexOf('<g data-c4-node=', attrIndex + marker.length)
  const end = next >= 0 ? next : svg.indexOf('</g>', attrIndex)
  if (start < 0 || end < start) throw new Error(`unterminated C4 node ${id}`)
  return svg.slice(start, end)
}

function c4RelationGroup(svg, id) {
  const marker = `<g data-c4-rel="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing C4 relation ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated C4 relation ${id}`)
  return group
}

function classRelationGroup(svg, id) {
  const marker = `<g data-class-rel="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing class relation ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated class relation ${id}`)
  return group
}

function flowchartEdgeGroup(svg, id) {
  const marker = `<g data-flowchart-edge="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing flowchart edge ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated flowchart edge ${id}`)
  return group
}

function flowchartSubgraphGroup(svg, id) {
  const marker = `<g data-flowchart-subgraph="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing flowchart subgraph ${id}`)
  const nextSubgraph = svg.indexOf('<g data-flowchart-subgraph="', start + marker.length)
  const nextEdge = svg.indexOf('<g data-flowchart-edge="', start + marker.length)
  const searchEnd = [nextSubgraph, nextEdge].filter((pos) => pos >= 0).sort((a, b) => a - b)[0] ?? svg.length
  const end = svg.lastIndexOf('</g>', searchEnd)
  if (end < 0 || end < start) throw new Error(`unterminated flowchart subgraph ${id}`)
  return svg.slice(start, end + 4)
}

function flowchartNodeBoundsFromGroup(group) {
  const rectStart = group.indexOf('<rect ')
  if (rectStart < 0) throw new Error('group has no measurable rect')
  const rect = group.slice(rectStart, group.indexOf('>', rectStart) + 1)
  return {
    x: Number(svgAttrValue(rect, 'x')),
    y: Number(svgAttrValue(rect, 'y')),
    w: Number(svgAttrValue(rect, 'width')),
    h: Number(svgAttrValue(rect, 'height')),
  }
}

function flowchartNodeBounds(svg, id) {
  const group = flowchartNodeGroup(svg, id)
  const rectStart = group.indexOf('<rect ')
  if (rectStart >= 0) {
    const rect = group.slice(rectStart, group.indexOf('>', rectStart) + 1)
    return {
      x: Number(svgAttrValue(rect, 'x')),
      y: Number(svgAttrValue(rect, 'y')),
      w: Number(svgAttrValue(rect, 'width')),
      h: Number(svgAttrValue(rect, 'height')),
    }
  }
  const circleStart = group.indexOf('<circle ')
  if (circleStart >= 0) {
    const circle = group.slice(circleStart, group.indexOf('>', circleStart) + 1)
    const cx = Number(svgAttrValue(circle, 'cx'))
    const cy = Number(svgAttrValue(circle, 'cy'))
    const r = Number(svgAttrValue(circle, 'r'))
    return { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }
  }
  const pathStart = group.indexOf('<path ')
  if (pathStart >= 0) {
    const path = group.slice(pathStart, group.indexOf('>', pathStart) + 1)
    const numbers = (svgAttrValue(path, 'd').match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
    const xs = numbers.filter((_, index) => index % 2 === 0)
    const ys = numbers.filter((_, index) => index % 2 === 1)
    if (xs.length && ys.length) {
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
  }
  throw new Error(`flowchart node ${id} has no measurable shape`)
}

function flowchartNodeTextY(svg, id, label) {
  const group = flowchartNodeGroup(svg, id)
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = group.match(new RegExp(`<text\\b[^>]*>${escaped}</text>`))
  if (!match) throw new Error(`flowchart node ${id} missing label ${label}`)
  return Number(svgAttrValue(match[0], 'y'))
}

function assertFlowchartNodeTextCentered(svg, id, label, context) {
  const bounds = flowchartNodeBounds(svg, id)
  const textY = flowchartNodeTextY(svg, id, label)
  const centerY = bounds.y + bounds.h / 2
  if (Math.abs(textY - centerY) > 0.1) {
    throw new Error(`${context}: flowchart node ${id} label not centered ${textY}/${centerY}`)
  }
}

function stateNodeGroup(svg, id) {
  const marker = `<g data-state-node="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing state node ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated state node ${id}`)
  return group
}

function stateNodeBounds(svg, id) {
  const group = stateNodeGroup(svg, id)
  const rectStart = group.indexOf('<rect ')
  if (rectStart < 0) throw new Error(`state node ${id} has no measurable rect`)
  const rect = group.slice(rectStart, group.indexOf('>', rectStart) + 1)
  return {
    x: Number(svgAttrValue(rect, 'x')),
    y: Number(svgAttrValue(rect, 'y')),
    w: Number(svgAttrValue(rect, 'width')),
    h: Number(svgAttrValue(rect, 'height')),
  }
}

function assertStateNodeTextCentered(svg, id, label, context) {
  const bounds = stateNodeBounds(svg, id)
  const textY = svgTextY(stateNodeGroup(svg, id), label)
  const centerY = bounds.y + bounds.h / 2
  if (Math.abs(textY - centerY) > 0.1) {
    throw new Error(`${context}: state node ${id} label not centered ${textY}/${centerY}`)
  }
}

function erEntityGroup(svg, id) {
  const marker = `<g data-er-entity="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing ER entity ${id}`)
  const end = svg.indexOf('</g>', start)
  if (end < 0) throw new Error(`unterminated ER entity ${id}`)
  return svg.slice(start, end + 4)
}

function erRelationshipGroup(svg, id) {
  const marker = `<g data-er-rel="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing ER relationship ${id}`)
  const group = svgGroupAt(svg, start)
  if (!group) throw new Error(`unterminated ER relationship ${id}`)
  return group
}

function erRelationshipRenderSpan(svg, id) {
  const marker = `<g data-er-rel="${id}">`
  const start = svg.indexOf(marker)
  if (start < 0) throw new Error(`missing ER relationship ${id}`)
  const nextRel = svg.indexOf('<g data-er-rel="', start + marker.length)
  const nextEntity = svg.indexOf('<g data-er-entity="', start + marker.length)
  const nextBodyEnd = svg.indexOf('</g></g>', start + marker.length)
  const end = [nextRel, nextEntity, nextBodyEnd, svg.length].filter((pos) => pos >= 0).sort((a, b) => a - b)[0]
  return svg.slice(start, end)
}

function erEntityBounds(svg, id) {
  const group = erEntityGroup(svg, id)
  return flowchartNodeBoundsFromGroup(group)
}

function erRelationshipPaths(svg) {
  const paths = new Map()
  let searchStart = 0
  while (true) {
    const marker = svg.indexOf('data-er-rel="', searchStart)
    if (marker < 0) break
    const idStart = marker + 'data-er-rel="'.length
    const idEnd = svg.indexOf('"', idStart)
    const id = svg.slice(idStart, idEnd)
    const groupEnd = svg.indexOf('</g>', idEnd)
    const pathStart = svg.indexOf('<path ', idEnd)
    if (pathStart >= 0 && pathStart < groupEnd) {
      const pathEnd = svg.indexOf('>', pathStart)
      const pathTag = svg.slice(pathStart, pathEnd + 1)
      paths.set(id, parseSvgPathPoints(svgAttrValue(pathTag, 'd')))
    }
    searchStart = groupEnd + 4
  }
  return paths
}

function parseSvgPathPoints(pathD) {
  const tokens = String(pathD).trim().split(/\s+/)
  const points = []
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index] !== 'M' && tokens[index] !== 'L') continue
    points.push({ x: Number(tokens[index + 1]), y: Number(tokens[index + 2]) })
    index += 2
  }
  return points
}

function flowchartEdgePaths(svg) {
  const paths = new Map()
  const pattern = /<g data-flowchart-edge="([^"]+)">([\s\S]*?)<\/g>/g
  let match
  while ((match = pattern.exec(svg))) {
    const d = match[2].match(/<path d="([^"]+)"/)?.[1]
    if (d) paths.set(match[1], parseSvgPathPoints(d))
  }
  return paths
}

function architectureNodeBodyRects(svg) {
  const rects = new Map()
  const pattern = /<g data-architecture-node="([^"]+)" data-architecture-id="([^"]+)">([\s\S]*?)<\/g>/g
  let match
  while ((match = pattern.exec(svg))) {
    const kind = match[1]
    if (kind !== 'service' && kind !== 'junction') continue
    const rectTag = match[3].match(/<rect\b[^>]*>/)?.[0]
    if (rectTag) {
      const x = Number(svgAttrValue(rectTag, 'x'))
      const y = Number(svgAttrValue(rectTag, 'y'))
      const w = Number(svgAttrValue(rectTag, 'width'))
      const h = Number(svgAttrValue(rectTag, 'height'))
      if ([x, y, w, h].every(Number.isFinite)) rects.set(match[2], { left: x, top: y, right: x + w, bottom: y + h })
      continue
    }
    const circleTag = match[3].match(/<circle\b[^>]*>/)?.[0]
    if (circleTag) {
      const cx = Number(svgAttrValue(circleTag, 'cx'))
      const cy = Number(svgAttrValue(circleTag, 'cy'))
      const r = Number(svgAttrValue(circleTag, 'r'))
      if ([cx, cy, r].every(Number.isFinite)) rects.set(match[2], { left: cx - r, top: cy - r, right: cx + r, bottom: cy + r })
    }
  }
  return rects
}

function architectureJunctionCircles(svg) {
  const circles = new Map()
  const pattern = /<g data-architecture-node="junction" data-architecture-id="([^"]+)">([\s\S]*?)<\/g>/g
  let match
  while ((match = pattern.exec(svg))) {
    const circleTag = match[2].match(/<circle\b[^>]*>/)?.[0]
    if (!circleTag) continue
    const cx = Number(svgAttrValue(circleTag, 'cx'))
    const cy = Number(svgAttrValue(circleTag, 'cy'))
    const r = Number(svgAttrValue(circleTag, 'r'))
    if ([cx, cy, r].every(Number.isFinite)) circles.set(match[1], { cx, cy, r })
  }
  return circles
}

function architectureEdgePaths(svg) {
  const paths = new Map()
  const pattern = /<g data-architecture-edge="([^"]+)">([\s\S]*?)<\/g>/g
  let match
  while ((match = pattern.exec(svg))) {
    const d = match[2].match(/<path d="([^"]+)"/)?.[1]
    if (d) paths.set(match[1].replaceAll('&gt;', '>'), parseSvgPathPoints(d))
  }
  return paths
}

function architectureEdgeEndpointIds(edgeId) {
  const match = edgeId.match(/^([^:]+):[TBLR]->([^:]+):[TBLR]$/)
  return match ? new Set([match[1], match[2]]) : new Set()
}

function architectureEdgeEndpointSides(edgeId) {
  const match = edgeId.match(/^([^:]+):([TBLR])->([^:]+):([TBLR])$/)
  return match ? { fromId: match[1], fromSide: match[2], toId: match[3], toSide: match[4] } : null
}

function architectureJunctionAnchor(circle, side) {
  if (side === 'T') return { x: circle.cx, y: circle.cy - circle.r }
  if (side === 'B') return { x: circle.cx, y: circle.cy + circle.r }
  if (side === 'L') return { x: circle.cx - circle.r, y: circle.cy }
  return { x: circle.cx + circle.r, y: circle.cy }
}

function assertPointClose(actual, expected, label) {
  if (!actual || Math.abs(actual.x - expected.x) > 0.1 || Math.abs(actual.y - expected.y) > 0.1) {
    throw new Error(`${label}: expected (${expected.x}, ${expected.y}), got ${actual ? `(${actual.x}, ${actual.y})` : 'missing point'}`)
  }
}

function assertArchitectureJunctionAnchors(svg, label) {
  const circles = architectureJunctionCircles(svg)
  const paths = architectureEdgePaths(svg)
  for (const [edgeId, points] of paths.entries()) {
    const endpoints = architectureEdgeEndpointSides(edgeId)
    if (!endpoints || points.length < 2) continue
    const fromCircle = circles.get(endpoints.fromId)
    if (fromCircle) {
      assertPointClose(points[0], architectureJunctionAnchor(fromCircle, endpoints.fromSide), `${label}: architecture edge ${edgeId} starts off junction boundary`)
    }
    const toCircle = circles.get(endpoints.toId)
    if (toCircle) {
      assertPointClose(points[points.length - 1], architectureJunctionAnchor(toCircle, endpoints.toSide), `${label}: architecture edge ${edgeId} ends off junction boundary`)
    }
  }
}

function architectureSegmentFromPoints(a, b) {
  if (Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) > 0.1) return { orientation: 'v', axis: a.x, start: Math.min(a.y, b.y), end: Math.max(a.y, b.y) }
  if (Math.abs(a.y - b.y) < 0.1 && Math.abs(a.x - b.x) > 0.1) return { orientation: 'h', axis: a.y, start: Math.min(a.x, b.x), end: Math.max(a.x, b.x) }
  return null
}

function assertArchitectureJunctionRoutesClearBodies(svg, label) {
  const circles = architectureJunctionCircles(svg)
  const paths = architectureEdgePaths(svg)
  for (const [edgeId, points] of paths.entries()) {
    const endpoints = architectureEdgeEndpointSides(edgeId)
    if (!endpoints || points.length < 2) continue
    for (const [junctionId, circleValue] of circles.entries()) {
      const rectValue = {
        left: circleValue.cx - circleValue.r - 3,
        top: circleValue.cy - circleValue.r - 3,
        right: circleValue.cx + circleValue.r + 3,
        bottom: circleValue.cy + circleValue.r + 3,
      }
      for (let index = 0; index < points.length - 1; index += 1) {
        if (junctionId === endpoints.fromId && index === 0) continue
        if (junctionId === endpoints.toId && index === points.length - 2) continue
        const segment = architectureSegmentFromPoints(points[index], points[index + 1])
        if (segment && segmentIntersectsRect(segment, rectValue)) {
          throw new Error(`${label}: architecture edge ${edgeId} crosses junction ${junctionId}`)
        }
      }
    }
  }
}

function assertArchitectureRoutesAvoidNodeBodies(svg, label) {
  const rects = architectureNodeBodyRects(svg)
  const paths = architectureEdgePaths(svg)
  for (const [edgeId, points] of paths.entries()) {
    const endpoints = architectureEdgeEndpointIds(edgeId)
    for (const [nodeId, rectValue] of rects.entries()) {
      if (endpoints.has(nodeId)) continue
      if (segments(points).some((segment) => segmentIntersectsRect(segment, rectValue))) {
        throw new Error(`${label}: architecture edge ${edgeId} intersects ${nodeId}`)
      }
    }
  }
}

function flowchartCollinearOverlapCount(paths) {
  const entries = [...paths.entries()]
  let count = 0
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      if (pathsHaveCollinearOverlap(entries[leftIndex][1], entries[rightIndex][1])) count += 1
    }
  }
  return count
}

function pairedOffsetSymmetryError(offsets) {
  if (!offsets.length) return 0
  const sorted = [...offsets].sort((a, b) => a - b)
  let maxError = 0
  for (let index = 0; index < Math.floor(sorted.length / 2); index += 1) {
    maxError = Math.max(maxError, Math.abs(sorted[index] + sorted[sorted.length - 1 - index]))
  }
  if (sorted.length % 2 === 1) maxError = Math.max(maxError, Math.abs(sorted[Math.floor(sorted.length / 2)]))
  return maxError
}

function routeLength(points) {
  return points.reduce((sum, point, index) => {
    if (index === 0) return 0
    const prev = points[index - 1]
    return sum + Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y)
  }, 0)
}

function bendCount(points) {
  let bends = 0
  let last = ''
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1]
    const point = points[index]
    const orientation = Math.abs(prev.x - point.x) < 0.1 ? 'v' : Math.abs(prev.y - point.y) < 0.1 ? 'h' : ''
    if (!orientation) continue
    if (last && last !== orientation) bends += 1
    last = orientation
  }
  return bends
}

function segments(points) {
  const result = []
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    if (Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) > 0.1) {
      result.push({ orientation: 'v', axis: a.x, start: Math.min(a.y, b.y), end: Math.max(a.y, b.y) })
    } else if (Math.abs(a.y - b.y) < 0.1 && Math.abs(a.x - b.x) > 0.1) {
      result.push({ orientation: 'h', axis: a.y, start: Math.min(a.x, b.x), end: Math.max(a.x, b.x) })
    }
  }
  return result
}

function rectFromBox(box) {
  return { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h }
}

function segmentIntersectsRect(segment, rect) {
  if (segment.orientation === 'h') {
    return segment.start < rect.right && segment.end > rect.left && segment.axis > rect.top && segment.axis < rect.bottom
  }
  return segment.axis > rect.left && segment.axis < rect.right && segment.start < rect.bottom && segment.end > rect.top
}

function assertRoutesAvoidNodeBodies(model, scene, workItems) {
  for (const item of workItems) {
    for (const [id, box] of scene.layouts.entries()) {
      if (id === item.rel.from || id === item.rel.to) continue
      const node = model.nodes.get(id)
      if (!node || /Boundary$/.test(node.kind)) continue
      const rect = rectFromBox(box)
      if (segments(item.route?.points || []).some((segment) => segmentIntersectsRect(segment, rect))) {
        throw new Error(`R1 route ${item.rel.from}->${item.rel.to} intersects ${id}`)
      }
    }
  }
}

function longestVerticalAxis(points) {
  const verticals = segments(points).filter((segment) => segment.orientation === 'v')
  verticals.sort((left, right) => (right.end - right.start) - (left.end - left.start))
  return verticals[0]?.axis ?? null
}

function longestVerticalAxisOverlappingBand(points, bandTop, bandBottom) {
  const verticals = segments(points)
    .filter((segment) => segment.orientation === 'v')
    .map((segment) => ({
      axis: segment.axis,
      overlap: Math.min(segment.end, bandBottom) - Math.max(segment.start, bandTop),
    }))
    .filter((segment) => segment.overlap > 0)
  verticals.sort((left, right) => right.overlap - left.overlap)
  return verticals[0]?.axis ?? null
}

function orthogonalPathCrossingCount(leftPoints, rightPoints) {
  let count = 0
  const leftSegments = segments(leftPoints)
  const rightSegments = segments(rightPoints)
  for (const left of leftSegments) {
    for (const right of rightSegments) {
      if (left.orientation === right.orientation) continue
      const vertical = left.orientation === 'v' ? left : right
      const horizontal = left.orientation === 'h' ? left : right
      if (
        vertical.axis > horizontal.start + 0.1 &&
        vertical.axis < horizontal.end - 0.1 &&
        horizontal.axis > vertical.start + 0.1 &&
        horizontal.axis < vertical.end - 0.1
      ) {
        count += 1
      }
    }
  }
  return count
}

function c4RouteCrossingCount(workItems) {
  const routed = workItems.filter((item) => item.route)
  let count = 0
  for (let leftIndex = 0; leftIndex < routed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routed.length; rightIndex += 1) {
      count += orthogonalPathCrossingCount(routed[leftIndex].route.points, routed[rightIndex].route.points)
    }
  }
  return count
}

function workItemFor(workItems, from, to) {
  const item = workItems.find((candidate) => candidate.rel.from === from && candidate.rel.to === to)
  if (!item?.route) throw new Error(`missing routed work item ${from}->${to}`)
  return item
}

function pathsHaveCollinearOverlap(leftPoints, rightPoints) {
  for (const left of segments(leftPoints)) {
    for (const right of segments(rightPoints)) {
      if (left.orientation !== right.orientation || Math.abs(left.axis - right.axis) > 0.1) continue
      if (Math.max(left.start, right.start) < Math.min(left.end, right.end) - 0.1) return true
    }
  }
  return false
}

function assertNoCollinearRouteOverlap(workItems) {
  const routed = workItems
    .filter((item) => item.route)
    .map((item) => ({
      id: `${item.rel.from}->${item.rel.to}`,
      from: item.rel.from,
      to: item.rel.to,
      points: item.route.points,
    }))
  for (let leftIndex = 0; leftIndex < routed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routed.length; rightIndex += 1) {
      const left = routed[leftIndex]
      const right = routed[rightIndex]
      if (left.from === right.from || left.from === right.to || left.to === right.from || left.to === right.to) continue
      if (pathsHaveCollinearOverlap(left.points, right.points)) {
        throw new Error(`R6 collinear overlap between ${left.id} and ${right.id}`)
      }
    }
  }
}

function assertOrthogonal(points, label) {
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1]
    const point = points[index]
    if (Math.abs(prev.x - point.x) >= 0.1 && Math.abs(prev.y - point.y) >= 0.1) {
      throw new Error(`R7 non-orthogonal segment in ${label}`)
    }
  }
}

function assertC4Exhaustive(sample, model, scene, workItems, renderer) {
  const validation = renderer.c4BuildValidationScene(model, scene, workItems)
  const issues = renderer.c4ValidateScene(validation)
  const labelRouteIssues = issues.filter((issue) => issue.kind === 'LabelCrossesForeignRoute')
  if (labelRouteIssues.length) {
    throw new Error(`${sample.name}: label crosses unrelated route: ${labelRouteIssues.map((issue) => `${issue.relationIndex}->${issue.owner}`).join(', ')}`)
  }
  for (const id of sample.expectedNodes) {
    if (!scene.layouts.has(id)) throw new Error(`${sample.name}: missing node ${id}`)
  }
  const routed = workItems.filter((item) => item.route)
  if (routed.length < sample.expectedRelationCount) {
    throw new Error(`${sample.name}: expected >= ${sample.expectedRelationCount} routed relations, got ${routed.length}`)
  }
  assertRoutesAvoidNodeBodies(model, scene, workItems)
  assertNoCollinearRouteOverlap(workItems)
  for (const item of routed) {
    assertOrthogonal(item.route.points, `${item.rel.from}->${item.rel.to}`)
  }
  for (const [parentId, childIds] of sample.parentChildren) {
    const parent = scene.layouts.get(parentId)
    if (!parent) throw new Error(`${sample.name}: missing parent ${parentId}`)
    const parentRect = rectFromBox(parent)
    for (const childId of childIds) {
      const child = scene.layouts.get(childId)
      if (!child) throw new Error(`${sample.name}: missing child ${childId}`)
      const childRect = rectFromBox(child)
      if (
        childRect.left < parentRect.left - 0.5 ||
        childRect.right > parentRect.right + 0.5 ||
        childRect.top < parentRect.top - 0.5 ||
        childRect.bottom > parentRect.bottom + 0.5
      ) {
        throw new Error(`${sample.name}: ${childId} is outside ${parentId}`)
      }
    }
  }
  const first = renderer.renderMermaidSvg(sample.source)
  const second = renderer.renderMermaidSvg(sample.source)
  if (first !== second) throw new Error(`${sample.name}: output is not deterministic`)
  assertRustSvgShell(first, sample.name)
  sample.check?.({ model, scene, workItems, validation, svg: first })
  sample.checkRoutes?.({ model, scene, workItems, validation, svg: first })
}

function sceneBounds(scene) {
  const boxes = [...scene.layouts.values()]
  if (!boxes.length) return { left: 0, top: 0, right: 0, bottom: 0 }
  return {
    left: Math.min(...boxes.map((box) => box.x)),
    top: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.x + box.w)),
    bottom: Math.max(...boxes.map((box) => box.y + box.h)),
  }
}

function c4Metrics(scene, workItems, validation, issues) {
  const bounds = sceneBounds(scene)
  const contentArea = Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top)
  const canvasArea = scene.width * scene.height
  const totalDetour = workItems.reduce((sum, item) => {
    if (!item.route) return sum
    return sum + Math.max(0, item.pathLength - item.manhattanSpan)
  }, 0)
  return {
    labelCount: workItems.filter((item) => item.labelPlacement).length,
    unroutableCount: workItems.filter((item) => !item.route).length,
    totalDetour,
    totalBends: workItems.reduce((sum, item) => sum + (item.route ? bendCount(item.route.points) : 0), 0),
    avgDetour: totalDetour / Math.max(1, workItems.filter((item) => item.route).length),
    hardIssueCount: issues.filter((issue) => !['DetourTooLarge', 'LabelOverlapsSoftObstacle', 'RouteCrossesForeignRoute'].includes(issue.kind)).length,
    softIssueCount: issues.filter((issue) => ['DetourTooLarge', 'LabelOverlapsSoftObstacle', 'RouteCrossesForeignRoute'].includes(issue.kind)).length,
    labelLaneReservations: validation.labelLaneReservations.length,
    crossingLaneReservations: validation.crossingLaneReservations.length,
    canvasWasteRatio: canvasArea > 0 ? Math.max(0, canvasArea - contentArea) / canvasArea : 0,
    routeLengthTotal: workItems.reduce((sum, item) => sum + (item.route ? routeLength(item.route.points) : 0), 0),
  }
}

function assertC4RepairSummary(summary) {
  if (!summary) throw new Error('C4 repair summary missing')
  const selectedParts = summary.relabelCount + summary.rerouteCount + summary.unroutedRetryCount
  if (summary.selectedStepCount !== selectedParts) {
    throw new Error(`C4 repair selected count mismatch: ${summary.selectedStepCount}/${selectedParts}`)
  }
  if (summary.lookaheadSelectionCount > summary.iterationCount) {
    throw new Error(`C4 repair lookahead exceeds iterations: ${summary.lookaheadSelectionCount}/${summary.iterationCount}`)
  }
  if (summary.clusteredStepCount > summary.selectedStepCount) {
    throw new Error(`C4 repair clustered steps exceed selected steps: ${summary.clusteredStepCount}/${summary.selectedStepCount}`)
  }
  if (summary.totalImpactedRelationCount < summary.selectedStepCount) {
    throw new Error(`C4 repair impacted relation count too low: ${summary.totalImpactedRelationCount}/${summary.selectedStepCount}`)
  }
  if (summary.totalPenaltyImprovement < -0.1) {
    throw new Error(`C4 repair penalty improvement is negative: ${summary.totalPenaltyImprovement}`)
  }
  const parts = summary.relabelPenaltyImprovement + summary.reroutePenaltyImprovement + summary.unroutedRetryPenaltyImprovement
  if (Math.abs(summary.totalPenaltyImprovement - parts) > 0.1) {
    throw new Error(`C4 repair improvement sum mismatch: ${summary.totalPenaltyImprovement}/${parts}`)
  }
  if (summary.selectedStepCount > 0 && summary.maxImpactedRelationCount < 1) {
    throw new Error('C4 repair max impacted relation count missing for selected step')
  }
  if (summary.selectedStepCount === 0 && summary.maxImpactedRelationCount !== 0) {
    throw new Error(`C4 repair max impacted relation count should be zero: ${summary.maxImpactedRelationCount}`)
  }
  if (summary.maxImpactedRelationCount > summary.totalImpactedRelationCount) {
    throw new Error(`C4 repair max impacted exceeds total impacted: ${summary.maxImpactedRelationCount}/${summary.totalImpactedRelationCount}`)
  }
}

function assertC4Quality(type, metrics, relationCount) {
  if (metrics.unroutableCount !== 0) {
    throw new Error(`C4 unroutable routes: ${metrics.unroutableCount}`)
  }
  if (metrics.hardIssueCount !== 0) {
    throw new Error(`C4 hard validation issues: ${metrics.hardIssueCount}`)
  }
  if (type === 'C4Component' && metrics.labelCount !== relationCount) {
    throw new Error(`C4 labeled ${metrics.labelCount}/${relationCount}`)
  }
  if (type === 'C4Component' && metrics.softIssueCount !== 0) {
    throw new Error(`C4Component soft issues: ${metrics.softIssueCount}`)
  }
  if (metrics.labelCount < Math.floor(relationCount * 0.85)) {
    throw new Error(`C4 label count too low: ${metrics.labelCount}/${relationCount}`)
  }
  if (metrics.labelLaneReservations !== metrics.labelCount) {
    throw new Error(`C4 label lane reservation mismatch: ${metrics.labelLaneReservations}/${metrics.labelCount}`)
  }
  if (metrics.avgDetour > 180) {
    throw new Error(`C4 avg detour too high: ${metrics.avgDetour.toFixed(1)}`)
  }
  if (metrics.totalBends > relationCount * 5) {
    throw new Error(`C4 bend count too high: ${metrics.totalBends}/${relationCount}`)
  }
  if (relationCount >= 3 && metrics.canvasWasteRatio > 0.65) {
    throw new Error(`C4 canvas waste too high: ${metrics.canvasWasteRatio.toFixed(3)}`)
  }
}

function main() {
  const rustParity = process.argv.includes('--rust-parity')
  const renderer = loadRenderer()
  const markdown = fs.readFileSync(galleryPath, 'utf8')
  const supported = new Set([
    'flowchart',
    'graph',
    'classDiagram',
    'classDiagram-v2',
    'C4Context',
    'C4Container',
    'C4Component',
    'C4Code',
    'architecture-beta',
    'erDiagram',
    'journey',
    'gantt',
    'block-beta',
    'kanban',
    'packet-beta',
    'pie',
    'quadrantChart',
    'requirementDiagram',
    'sankey',
    'sankey-beta',
    'treemap-beta',
    'gitGraph',
    'mindmap',
    'timeline',
    'zenuml',
    'sequenceDiagram',
    'stateDiagram',
    'stateDiagram-v2',
    'radar-beta',
    'venn-beta',
    'xychart',
    'xychart-beta',
  ])
  const galleryBlocks = mermaidBlocks(markdown)
  assertRequestedDiagramCoverage(galleryBlocks, supported)
  assertGalleryViewBoxes(renderer, galleryBlocks)
  assertGitHubReplacementShell(renderer)
  const blocks = galleryBlocks
    .concat(c4RegressionSamples)
    .concat(c4RustComplexScenarios.map((sample) => sample.source))
    .concat(c4InvariantSamples.map((sample) => sample.source))
    .concat(classRustSamples.map((sample) => sample.source))

  let rendered = 0
  for (const source of blocks) {
    const type = diagramType(source)
    if (!supported.has(type)) continue
    const svg = renderer.renderMermaidSvg(source)
    if (!svg.includes('<svg')) throw new Error(`missing svg for ${type}`)
    if (type !== 'sequenceDiagram') assertRustSvgShell(svg, `gallery ${type}`)
    rendered += 1

    if (type === 'C4Context' || type === 'C4Container' || type === 'C4Component') {
      const model = renderer.parseC4Model(source)
      const scene = renderer.layoutC4Scene(model)
      const workItems = renderer.c4BuildWorkItems(model, scene)
      renderer.c4AssignLabels(workItems, model, scene)
      const repairSummary = renderer.c4RepairWorkItems(model, scene, workItems)
      assertC4RepairSummary(repairSummary)
      const validation = renderer.c4BuildValidationScene(model, scene, workItems)
      const issues = renderer.c4ValidateScene(validation)
      const routed = workItems.filter((item) => item.route).length
      if (routed !== workItems.length) {
        throw new Error(`C4 routed ${routed}/${workItems.length}`)
      }
      const blockingIssues = type === 'C4Component'
        ? issues
        : issues.filter((issue) => !['DetourTooLarge', 'LabelOverlapsSoftObstacle', 'RouteCrossesForeignRoute'].includes(issue.kind))
      if (blockingIssues.length) {
        throw new Error(`C4 validation issues in ${type} ${source.split('\n').slice(0, 2).join(' / ')}: ${issues.map((issue) => issue.kind).join(', ')}`)
      }
      assertRoutesAvoidNodeBodies(model, scene, workItems)
      assertNoCollinearRouteOverlap(workItems)
      assertC4Quality(type, c4Metrics(scene, workItems, validation, issues), workItems.length)
    }
  }

  for (const sample of c4InvariantSamples) {
    const source = sample.source
    const svg = renderer.renderMermaidSvg(source)
    assertRustSvgShell(svg, sample.name)
    const model = renderer.parseC4Model(source)
    const scene = renderer.layoutC4Scene(model)
    const workItems = renderer.c4BuildWorkItems(model, scene)
    renderer.c4AssignLabels(workItems, model, scene)
    const repairSummary = renderer.c4RepairWorkItems(model, scene, workItems)
    assertC4RepairSummary(repairSummary)
    const validation = renderer.c4BuildValidationScene(model, scene, workItems)
    sample.check({ renderer, source, svg, model, scene, workItems, validation })
  }

  for (const sample of c4RustComplexScenarios) {
    const model = renderer.parseC4Model(sample.source)
    const scene = renderer.layoutC4Scene(model)
    const workItems = renderer.c4BuildWorkItems(model, scene)
    renderer.c4AssignLabels(workItems, model, scene)
    const repairSummary = renderer.c4RepairWorkItems(model, scene, workItems)
    assertC4RepairSummary(repairSummary)
    assertC4Exhaustive(sample, model, scene, workItems, renderer)
  }

  for (const sample of classRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of flowchartRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of erRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of journeyRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of ganttRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of pieRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of quadrantRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of requirementRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of gitGraphRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of mindmapRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of timelineRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of zenumlRustSamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    assertRustSvgShell(svg, sample.name)
    sample.check({ svg, renderer })
  }

  for (const sample of sequenceQualitySamples) {
    const svg = renderer.renderMermaidSvg(sample.source)
    if (!svg.includes('<svg')) throw new Error(`${sample.name}: missing svg`)
    sample.check({ svg, renderer })
  }

  if (rustParity) {
    const parityCount = assertRustParity(renderer, galleryBlocks, supported)
    console.log(`verified Rust parity for ${parityCount} supported samples`)
  }

  console.log(`verified ${rendered} supported gallery diagrams`)
}

main()
