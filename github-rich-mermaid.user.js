// ==UserScript==
// @name         GitHub Mermaid Rich Renderer
// @namespace    https://github.com/manji-0/github-mermaid-rich-renderer
// @version      0.3.3
// @description  Replace GitHub Markdown preview Mermaid diagrams with a Rich-style SVG renderer.
// @author       manji0
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/manji-0/github-rich-mermaid-tampermonkey/main/github-rich-mermaid.user.js
// @downloadURL  https://raw.githubusercontent.com/manji-0/github-rich-mermaid-tampermonkey/main/github-rich-mermaid.user.js
// ==/UserScript==

(() => {
  'use strict'

  console.log('[mermaid-rich] script loaded, readyState:', document.readyState)

  const ENHANCED_ATTR = 'data-docattice-mermaid-enhanced'
  const ERROR_ATTR = 'data-docattice-mermaid-error'
  const SOURCE_ATTR = 'data-docattice-mermaid-source'
  const MAX_PARALLEL_RENDERS = 4
  const UI_FONT = "'LINE Seed JP','Hiragino Sans','Yu Gothic UI','Segoe UI Variable',system-ui,sans-serif"

  const SUPPORTED_TYPES = new Set([
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
    'pie',
    'quadrantChart',
    'requirementDiagram',
    'gitGraph',
    'mindmap',
    'timeline',
    'zenuml',
    'sequenceDiagram',
    'stateDiagram',
    'stateDiagram-v2',
    'block-beta',
    'kanban',
    'packet-beta',
    'radar-beta',
    'sankey',
    'sankey-beta',
    'treemap-beta',
    'venn-beta',
    'xychart',
    'xychart-beta',
  ])
  const UNSUPPORTED_GITHUB_TYPES = new Set([
    'venn',
  ])

  const stageCache = new Map()
  const rawMermaidSources = []
  const rawSourceByElement = new WeakMap()
  const renderQueue = []
  let activeRenderCount = 0
  let observer = null
  let scanTimer = null
  let rawMarkdownLoaded = false
  let rawMarkdownLoading = false

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function attr(value) {
    return escapeHtml(value)
  }

  function dataAttr(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function decodeHtmlEntities(value) {
    const text = String(value || '')
    if (!/[&<]/.test(text) || typeof document === 'undefined') return text
    const textarea = document.createElement('textarea')
    textarea.innerHTML = text
    return textarea.value
  }

  function linesOf(source) {
    return source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('%%'))
  }

  function detectMermaidDiagramType(source) {
    for (const line of linesOf(source)) {
      return line.split(/\s+/, 1)[0]
    }
    return ''
  }

  function supportedDiagramType(source) {
    const type = detectMermaidDiagramType(source)
    return SUPPORTED_TYPES.has(type) ? type : ''
  }

  function mermaidHeadingDiagramType(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    const aliases = new Map([
      ['architecture', 'architecture-beta'],
      ['architecturebeta', 'architecture-beta'],
      ['block', 'block-beta'],
      ['blockbeta', 'block-beta'],
      ['c4code', 'C4Code'],
      ['classdiagram', 'classDiagram'],
      ['kanban', 'kanban'],
      ['packet', 'packet-beta'],
      ['packetbeta', 'packet-beta'],
      ['radar', 'radar-beta'],
      ['radarbeta', 'radar-beta'],
      ['sankey', 'sankey'],
      ['statediagram', 'stateDiagram-v2'],
      ['statediagramv2', 'stateDiagram-v2'],
      ['treemap', 'treemap-beta'],
      ['treemapbeta', 'treemap-beta'],
      ['venn', 'venn-beta'],
      ['vennbeta', 'venn-beta'],
      ['xychart', 'xychart'],
    ])
    return aliases.get(normalized) || ''
  }

  function nearestMarkdownHeadingText(element) {
    let current = element
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      let sibling = current.previousElementSibling
      for (let steps = 0; sibling && steps < 8; steps += 1, sibling = sibling.previousElementSibling) {
        if (sibling.matches?.('h1,h2,h3,h4,h5,h6')) return sibling.textContent || ''
      }
    }
    return ''
  }

  function shouldRenderSourceAtElement(element, source) {
    const headingType = mermaidHeadingDiagramType(nearestMarkdownHeadingText(element))
    if (headingType && UNSUPPORTED_GITHUB_TYPES.has(headingType)) return false
    if (headingType && SUPPORTED_TYPES.has(headingType)) return detectMermaidDiagramType(source) === headingType
    return Boolean(supportedDiagramType(source))
  }

  function extractAllMermaidFences(markdown) {
    const sources = []
    const fence = /```mermaid[^\n]*\n([\s\S]*?)```/gi
    let match = fence.exec(markdown)
    while (match) {
      const source = match[1].trim()
      if (source) sources.push(source)
      match = fence.exec(markdown)
    }
    return sources
  }

  function extractMermaidFences(markdown) {
    return extractAllMermaidFences(markdown).filter((source) => supportedDiagramType(source))
  }

  function rememberRawMarkdownSources(markdown) {
    rawMermaidSources.splice(0, rawMermaidSources.length, ...extractAllMermaidFences(markdown))
  }

  function rawMarkdownSourceForElement(element, expectedType = '') {
    if (!element || !rawMermaidSources.length) return null
    if (rawSourceByElement.has(element)) return rawSourceByElement.get(element) || null
    let source = ''
    while (rawMermaidSources.length) {
      const candidate = rawMermaidSources.shift() || ''
      if (!expectedType || detectMermaidDiagramType(candidate) === expectedType) {
        source = candidate
        break
      }
    }
    rawSourceByElement.set(element, source)
    return source || null
  }

  function supportedRoleDiagramType(element) {
    const role = element?.getAttribute?.('aria-roledescription') || ''
    return SUPPORTED_TYPES.has(role) ? role : ''
  }

  function sourceFromGitHubDataContent(element) {
    const raw = element.getAttribute?.('data-content')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      const source = typeof parsed?.data === 'string' ? decodeHtmlEntities(parsed.data) : ''
      if (!supportedDiagramType(source)) return null
      return source
    } catch (_error) {
      return null
    }
  }

  function sourceFromRenderSection(section) {
    // 1. data-plain on .js-render-enrichment-target (post-enrichment state)
    const target = section.querySelector?.('.js-render-enrichment-target')
    if (target) {
      const plain = target.getAttribute('data-plain') || ''
      if (supportedDiagramType(plain)) { return plain }
      const dataJson = target.getAttribute('data-json')
      if (dataJson) {
        try {
          const parsed = JSON.parse(dataJson)
          const source = typeof parsed?.data === 'string' ? decodeHtmlEntities(parsed.data) : ''
          if (supportedDiagramType(source)) { return source }
        } catch (_) {}
      }
    }
    // 2. data-plain directly on the section element (pre-enrichment state)
    const sectionPlain = decodeHtmlEntities(section.getAttribute('data-plain') || '')
    if (supportedDiagramType(sectionPlain)) return sectionPlain
    // 3. iframe data-content inside section (enrichment complete, iframe has JSON payload)
    const iframe = section.querySelector?.('iframe[data-content]')
    if (iframe) {
      const src = sourceFromGitHubDataContent(iframe)
      if (src) return src
    }
    // 4. pre[lang="mermaid"] fallback
    const pre = section.querySelector?.('pre[lang="mermaid"]')
    if (pre) {
      const source = pre.textContent?.trim() || ''
      if (supportedDiagramType(source)) { return source }
    }
    // 5. GitHub-rendered SVG: aria-roledescription matches Mermaid type, find source from siblings
    const renderedSvg = section.querySelector?.('svg[aria-roledescription]')
    if (renderedSvg) {
      const role = renderedSvg.getAttribute('aria-roledescription') || ''
      // aria-roledescription contains the diagram type (e.g., "flowchart", "c4", "sequence")
      // Try to find source from any pre sibling that may have been hidden
      const anyPre = section.querySelector?.('pre')
      if (anyPre) {
        const source = anyPre.textContent?.trim() || ''
        if (supportedDiagramType(source)) { return source }
      }
      console.log('[mermaid-rich] sourceFromRenderSection: SVG found but no source. role=', role, 'section:', section.outerHTML.slice(0, 300))
    }
    return null
  }

  function rawMarkdownUrlFromPage() {
    const rawLink = Array.from(document.querySelectorAll('a[href]'))
      .map((link) => link.href)
      .find((href) => /\/raw\//.test(href) && /\.(md|markdown)(\?|#|$)/i.test(href))
    if (rawLink) return rawLink

    const blobMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
    if (blobMatch) {
      const [, owner, repo, rest] = blobMatch
      const parts = rest.split('/')
      const mdIndex = parts.findIndex((part) => /\.(md|markdown)$/i.test(part))
      if (mdIndex <= 0) return null
      const ref = parts.slice(0, mdIndex).join('/')
      const pathPart = parts.slice(mdIndex).join('/')
      return `/${owner}/${repo}/raw/${ref}/${pathPart}`
    }

    const repoRootMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
    if (repoRootMatch) {
      const [, owner, repo] = repoRootMatch
      return `/${owner}/${repo}/raw/HEAD/README.md`
    }

    const treeMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/(.+)$/)
    if (treeMatch) {
      const [, owner, repo, refAndPath] = treeMatch
      return `/${owner}/${repo}/raw/${refAndPath}/README.md`
    }

    return null
  }

  async function loadRawMarkdownSources() {
    if (rawMarkdownLoaded || rawMarkdownLoading) return
    const rawUrl = rawMarkdownUrlFromPage()
    if (!rawUrl) return
    rawMarkdownLoading = true
    try {
      const response = await fetch(rawUrl, { credentials: 'same-origin' })
      if (!response.ok) return
      const markdown = await response.text()
      rememberRawMarkdownSources(markdown)
      rawMarkdownLoaded = true
      scan()
    } catch (_error) {
      // GitHub comments/previews should still work through DOM capture.
    } finally {
      rawMarkdownLoading = false
    }
  }

  function currentThemeMode() {
    const html = document.documentElement
    const colorMode = html?.getAttribute('data-color-mode')
    if (colorMode === 'dark' || colorMode === 'light') {
      return colorMode
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function theme() {
    if (currentThemeMode() === 'dark') {
      return {
        mode: 'dark',
        bg: '#00000000',
        surface: '#111723',
        surfaceAlt: '#151b26',
        surfaceSoft: '#1a2130',
        border: '#2d3646',
        borderStrong: '#3b465a',
        text: '#edf2ff',
        muted: '#9aa5bb',
        accent: '#7f94ff',
        accentSoft: '#26325f',
        success: '#57c48f',
        danger: '#ff8d8d',
        warn: '#e2b25f',
        link: '#9eb0ff',
        grid: '#252d3b',
      }
    }
    return {
      mode: 'light',
      bg: '#00000000',
      surface: '#ffffff',
      surfaceAlt: '#f1f5ff',
      surfaceSoft: '#e5edff',
      border: '#b6c4dc',
      borderStrong: '#91a4c7',
      text: '#16233a',
      muted: '#4d5f80',
      accent: '#315ae3',
      accentSoft: '#dbe5ff',
      success: '#167a57',
      danger: '#c73535',
      warn: '#a86419',
      link: '#355fe8',
      grid: '#cfd9eb',
    }
  }

  function svg(width, height, body, label = 'Mermaid diagram') {
    const t = theme()
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${attr(label)}" style="font-family:${UI_FONT}"><defs><marker id="docattice-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${t.borderStrong}"/></marker></defs><rect width="${width}" height="${height}" fill="${t.bg}"/>${body}</svg>`
  }

  function rustSvgWithTitle(width, height, title, body, label = 'Mermaid extras diagram') {
    const t = theme()
    const totalHeight = height + 64
    const dividerY = totalHeight - 42
    const titleY = totalHeight - 14
    const titleLayer = `${line(28, dividerY, width - 28, dividerY, t.grid)}<text x="${(width / 2).toFixed(1)}" y="${titleY.toFixed(1)}" fill="${t.text}" text-anchor="middle" font-family="${UI_FONT}" font-size="18.0" font-weight="750">${escapeHtml(title)}</text>`
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${totalHeight.toFixed(1)}" width="${width.toFixed(1)}" height="${totalHeight.toFixed(1)}" role="img" aria-label="${attr(label)}" data-diagram-body-center-x="${(width / 2).toFixed(1)}" data-diagram-body-center-y="${(height / 2).toFixed(1)}" style="font-family:${UI_FONT}"><rect width="${width.toFixed(1)}" height="${totalHeight.toFixed(1)}" fill="${t.bg}"/><g data-diagram-body="true">${body}</g>${titleLayer}</svg>`
  }

  function rustSvg(width, height, body, label = 'Mermaid extras diagram') {
    const t = theme()
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" role="img" aria-label="${attr(label)}" data-diagram-body-center-x="${(width / 2).toFixed(1)}" data-diagram-body-center-y="${(height / 2).toFixed(1)}" style="font-family:${UI_FONT}"><rect width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="${t.bg}"/><g data-diagram-body="true">${body}</g></svg>`
  }

  function analyticsSvgWithTitle(width, height, title, body) {
    const t = theme()
    const totalHeight = height + 64
    const bodyMinX = 28
    const bodyMaxX = width - 28
    const bodyMinY = 28
    const bodyMaxY = totalHeight - 42
    const bottom = `${line(28, totalHeight - 42, width - 28, totalHeight - 42, t.grid)}${text(width / 2, totalHeight - 14, title, 18, 750, t.text)}`
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${totalHeight.toFixed(1)}" width="${width.toFixed(1)}" height="${totalHeight.toFixed(1)}" role="img" aria-label="Mermaid analytics diagram" data-diagram-body-center-x="${((bodyMinX + bodyMaxX) / 2).toFixed(1)}" data-diagram-body-center-y="${((bodyMinY + bodyMaxY) / 2).toFixed(1)}" data-diagram-body-min-x="${bodyMinX.toFixed(1)}" data-diagram-body-max-x="${bodyMaxX.toFixed(1)}" data-diagram-body-min-y="${bodyMinY.toFixed(1)}" data-diagram-body-max-y="${bodyMaxY.toFixed(1)}" style="font-family:${UI_FONT}"><rect width="${width.toFixed(1)}" height="${totalHeight.toFixed(1)}" fill="${t.bg}"/>${line(28, 28, width - 28, 28, t.grid)}<g data-diagram-body="true">${body}</g>${bottom}</svg>`
  }

  function text(x, y, value, size = 13, weight = 500, color = theme().text, anchor = 'middle') {
    return `<text x="${f1(x)}" y="${f1(y)}" fill="${color}" font-family="${UI_FONT}" font-size="${f1(size)}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="middle">${escapeHtml(value)}</text>`
  }

  function c4Text(x, y, value, size, weight, color, anchor = 'start') {
    const anchorAttr = anchor === 'start' ? '' : ` text-anchor="${anchor}"`
    return `<text x="${f1(x)}" y="${f1(y)}" fill="${color}" font-family="${UI_FONT}" font-size="${f1(size)}" font-weight="${weight}"${anchorAttr}>${escapeHtml(value)}</text>`
  }

  function multilineText(x, y, value, width, size = 12, color = theme().text, anchor = 'middle') {
    const maxChars = Math.max(8, Math.floor(width / (size * 0.58)))
    const words = String(value || '').split(/\s+/).filter(Boolean)
    const rows = []
    let row = ''
    for (const word of words) {
      if ((row ? `${row} ${word}` : word).length > maxChars && row) {
        rows.push(row)
        row = word
      } else {
        row = row ? `${row} ${word}` : word
      }
    }
    if (row) rows.push(row)
    if (!rows.length) rows.push('')
    const start = y - ((rows.length - 1) * size * 1.25) / 2
    return rows.slice(0, 4).map((line, index) => (
      `<text x="${f1(x)}" y="${f1(start + index * size * 1.25)}" fill="${color}" font-family="${UI_FONT}" font-size="${f1(size)}" text-anchor="${anchor}" dominant-baseline="middle">${escapeHtml(line)}</text>`
    )).join('')
  }

  function f1(value) {
    return Number(value).toFixed(1)
  }

  function rect(x, y, w, h, r = 8, fill = theme().surface, stroke = theme().border) {
    return `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(r)}" fill="${fill}" stroke="${stroke}"/>`
  }

  function line(x1, y1, x2, y2, color = theme().borderStrong, width = 1.5, arrow = false) {
    return `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${color}" stroke-width="${f1(width)}"${arrow ? ' marker-end="url(#docattice-arrow)"' : ''}/>`
  }

  function path(d, color = theme().borderStrong, width = 1.6, arrow = false, fill = 'none') {
    return `<path d="${attr(d)}" fill="${fill}" stroke="${color}" stroke-width="${f1(width)}" stroke-linecap="round" stroke-linejoin="round"${arrow ? ' marker-end="url(#docattice-arrow)"' : ''}/>`
  }

  function circle(cx, cy, r, fill, stroke) {
    return `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="${fill}" stroke="${stroke}"/>`
  }

  function circleWithAlpha(cx, cy, r, fill, stroke, opacity) {
    return `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="${fill}" fill-opacity="${Number(opacity).toFixed(2)}" stroke="${stroke}" stroke-width="1.5"/>`
  }

  function rustArrowheadPath(from, to, fill) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const arrowSize = 9
    const leftX = to.x - arrowSize * Math.cos(angle) + 4 * Math.cos(angle + Math.PI / 2)
    const leftY = to.y - arrowSize * Math.sin(angle) + 4 * Math.sin(angle + Math.PI / 2)
    const rightX = to.x - arrowSize * Math.cos(angle) + 4 * Math.cos(angle - Math.PI / 2)
    const rightY = to.y - arrowSize * Math.sin(angle) + 4 * Math.sin(angle - Math.PI / 2)
    return `<path d="M ${to.x.toFixed(1)} ${to.y.toFixed(1)} L ${leftX.toFixed(1)} ${leftY.toFixed(1)} L ${rightX.toFixed(1)} ${rightY.toFixed(1)} Z" fill="${fill}"/>`
  }

  function rustArrowLine(x1, y1, x2, y2, stroke, dashed = false) {
    const dash = dashed ? ' stroke-dasharray="7 5"' : ''
    return `<g><line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="2"${dash}/>${rustArrowheadPath({ x: x1, y: y1 }, { x: x2, y: y2 }, stroke)}</g>`
  }

  function rustPolylineArrowheads(points, stroke, dashed = false, startArrow = false, endArrow = true, width = 2) {
    if (points.length < 2) return ''
    const dash = dashed ? ' stroke-dasharray="7 5"' : ''
    const d = points.map((p, index) => `${index ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
    let result = `<g><path d="${attr(d)}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`
    if (startArrow) result += rustArrowheadPath(points[1], points[0], stroke)
    if (endArrow) result += rustArrowheadPath(points[points.length - 2], points[points.length - 1], stroke)
    return `${result}</g>`
  }

  function rustPalette(index) {
    const colors = ['#8ea0ff', '#66d4a4', '#efb56d', '#ff96b7', '#7fd8f3', '#b39cff']
    return colors[index % colors.length]
  }

  function cleanLabel(raw) {
    return decodeHtmlEntities(raw)
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
  }

  function rawMermaidText(raw) {
    return decodeHtmlEntities(raw).trim().replace(/<br\s*\/?>/gi, ' ')
  }

  function rustStripQuotes(raw) {
    const value = rawMermaidText(raw)
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      return value.slice(1, -1)
    }
    return value
  }

  function parseCallArgs(line) {
    const start = line.indexOf('(')
    const end = line.lastIndexOf(')')
    if (start < 0 || end <= start) return []
    const raw = line.slice(start + 1, end)
    const args = []
    let current = ''
    let inQuotes = false
    for (const ch of raw) {
      if (ch === '"') {
        inQuotes = !inQuotes
        current += ch
        continue
      }
      if (ch === ',' && !inQuotes) {
        args.push(rustStripQuotes(current.trim()))
        current = ''
        continue
      }
      current += ch
    }
    if (current.trim()) args.push(rustStripQuotes(current.trim()))
    return args
  }

  function pushUniqueConstraint(constraints, before, after) {
    if (!before || !after || before === after) return
    if (!constraints.some(([left, right]) => left === before && right === after)) {
      constraints.push([before, after])
    }
  }

  function constraintCreatesCycle(constraints, before, after) {
    const adjacency = new Map()
    for (const [left, right] of constraints) {
      if (!adjacency.has(left)) adjacency.set(left, [])
      adjacency.get(left).push(right)
    }
    const stack = [after]
    const seen = new Set()
    while (stack.length) {
      const current = stack.pop()
      if (current === before) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const next of adjacency.get(current) || []) stack.push(next)
    }
    return false
  }

  function pushUniqueAcyclicConstraint(constraints, before, after) {
    if (!before || !after || before === after) return
    if (constraints.some(([left, right]) => left === before && right === after)) return
    if (constraintCreatesCycle(constraints, before, after)) return
    constraints.push([before, after])
  }

  function solveRankConstraints(children, constraints) {
    const adjacency = new Map(children.map((child) => [child, []]))
    const indegree = new Map(children.map((child) => [child, 0]))
    for (const [from, to] of constraints) {
      if (from === to || !indegree.has(from) || !indegree.has(to)) continue
      const edges = adjacency.get(from)
      if (edges.includes(to)) continue
      edges.push(to)
      indegree.set(to, (indegree.get(to) || 0) + 1)
    }
    const queue = children.filter((child) => (indegree.get(child) || 0) === 0)
    const ranks = new Map(children.map((child) => [child, 0]))
    const visited = []
    while (queue.length) {
      const node = queue.shift()
      visited.push(node)
      for (const next of adjacency.get(node) || []) {
        ranks.set(next, Math.max(ranks.get(next) || 0, (ranks.get(node) || 0) + 1))
        indegree.set(next, Math.max(0, (indegree.get(next) || 0) - 1))
        if ((indegree.get(next) || 0) === 0) queue.push(next)
      }
    }
    if (visited.length !== children.length) {
      children.forEach((child) => {
        if (!visited.includes(child)) ranks.set(child, 0)
      })
    }
    return ranks
  }

  function groupRowsByRank(children, rankMap, orderMap) {
    const rows = new Map()
    children.forEach((child) => {
      const rank = rankMap.get(child) || 0
      if (!rows.has(rank)) rows.set(rank, [])
      rows.get(rank).push(child)
    })
    ;[...rows.values()].forEach((row) => row.sort((a, b) => (
      (orderMap.get(a) || 0) - (orderMap.get(b) || 0) || a.localeCompare(b)
    )))
    return rows
  }

  function rowLookup(rows) {
    const lookup = new Map()
    ;[...rows.values()].forEach((row) => row.forEach((child, index) => lookup.set(child, index)))
    return lookup
  }

  function childToRow(rows) {
    const lookup = new Map()
    ;[...rows.entries()].forEach(([rank, row]) => row.forEach((child) => lookup.set(child, rank)))
    return lookup
  }

  function crossingScoreForRow(rowRank, row, rows, relations) {
    const rowSet = new Set(row)
    const order = rowLookup(rows)
    const toRow = childToRow(rows)
    const incident = []
    for (const rel of relations) {
      if (rowSet.has(rel.from) && toRow.get(rel.to) !== rowRank) {
        incident.push({ here: rel.from, other: rel.to, otherRank: toRow.get(rel.to), weight: rel.weight || 1 })
      } else if (rowSet.has(rel.to) && toRow.get(rel.from) !== rowRank) {
        incident.push({ here: rel.to, other: rel.from, otherRank: toRow.get(rel.from), weight: rel.weight || 1 })
      }
    }
    let score = 0
    for (let i = 0; i < incident.length; i += 1) {
      for (let j = i + 1; j < incident.length; j += 1) {
        const a = incident[i]
        const b = incident[j]
        if (a.otherRank !== b.otherRank || a.here === b.here || a.other === b.other) continue
        const hereA = order.get(a.here)
        const hereB = order.get(b.here)
        const otherA = order.get(a.other)
        const otherB = order.get(b.other)
        if (hereA == null || hereB == null || otherA == null || otherB == null) continue
        if ((hereA < hereB && otherA > otherB) || (hereA > hereB && otherA < otherB)) {
          score += a.weight * b.weight
        }
      }
    }
    return score
  }

  function optimizeRowOrder(rows, orderMap, relations, passes = 4) {
    const rowKeys = [...rows.keys()].sort((a, b) => a - b)
    if (rowKeys.length < 2) return
    for (let pass = 0; pass < passes; pass += 1) {
      for (const downward of [true, false]) {
        const keys = downward ? rowKeys : [...rowKeys].reverse()
        for (const rowKey of keys) {
          const row = [...(rows.get(rowKey) || [])]
          if (row.length < 2) continue
          const toRow = childToRow(rows)
          const order = rowLookup(rows)
          const bary = new Map()
          row.forEach((child, index) => {
            let total = 0
            let weight = 0
            for (const rel of relations) {
              const other = rel.from === child ? rel.to : rel.to === child ? rel.from : null
              if (!other) continue
              const otherRow = toRow.get(other)
              if (otherRow == null || otherRow === rowKey) continue
              if (downward && otherRow >= rowKey) continue
              if (!downward && otherRow <= rowKey) continue
              const distance = Math.max(1, Math.abs(rowKey - otherRow))
              const relWeight = (rel.weight || 1) / distance
              total += (order.get(other) ?? index) * relWeight
              weight += relWeight
            }
            if (weight > 0) bary.set(child, total / weight)
          })
          const candidate = [...row].sort((a, b) => {
            const baryDelta = (bary.get(a) ?? (orderMap.get(a) || 0)) - (bary.get(b) ?? (orderMap.get(b) || 0))
            return baryDelta || (orderMap.get(a) || 0) - (orderMap.get(b) || 0) || a.localeCompare(b)
          })
          const before = crossingScoreForRow(rowKey, row, rows, relations)
          const temp = new Map(rows)
          temp.set(rowKey, candidate)
          const after = crossingScoreForRow(rowKey, candidate, temp, relations)
          if (after <= before) rows.set(rowKey, candidate)
        }
      }
    }
  }

  const ORDER_EPSILON = 0.5

  function compareNumberEpsilon(left, right) {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return left - right
    if (Math.abs(left - right) < ORDER_EPSILON) return 0
    return left - right
  }

  function placementRowOrderLookup(rows) {
    const lookup = new Map()
    ;[...rows.values()].forEach((row) => row.forEach((child, index) => lookup.set(child, index)))
    return lookup
  }

  function placementChildToRow(rows) {
    const lookup = new Map()
    ;[...rows.entries()].forEach(([rank, row]) => row.forEach((child) => lookup.set(child, rank)))
    return lookup
  }

  function placementVirtualNodeId(relationIndex, rowRank) {
    return `__virtual_${relationIndex}_${rowRank}`
  }

  function placementCrossingScoreForRow(rowRank, row, rows, childToRow, relations) {
    const rowNodes = new Set(row)
    const order = placementRowOrderLookup(rows)
    const incident = []
    relations.forEach((relation) => {
      if (rowNodes.has(relation.from)) {
        const otherRow = childToRow.get(relation.to)
        if (otherRow != null && otherRow !== rowRank) {
          incident.push({ here: relation.from, other: relation.to, otherRow, weight: relation.weight || 1, subOrder: relation.fromSubOrder })
        }
      } else if (rowNodes.has(relation.to)) {
        const otherRow = childToRow.get(relation.from)
        if (otherRow != null && otherRow !== rowRank) {
          incident.push({ here: relation.to, other: relation.from, otherRow, weight: relation.weight || 1, subOrder: relation.fromSubOrder })
        }
      }
    })
    let score = 0
    for (let i = 0; i < incident.length; i += 1) {
      for (let j = i + 1; j < incident.length; j += 1) {
        const left = incident[i]
        const right = incident[j]
        if (left.otherRow !== right.otherRow) continue
        if (left.here === right.here && left.other === right.other) continue
        if (left.here === right.here || left.other === right.other) {
          if (left.subOrder == null || right.subOrder == null) continue
          const a = left.here === right.here ? order.get(left.other) : order.get(left.here)
          const b = left.here === right.here ? order.get(right.other) : order.get(right.here)
          if (a == null || b == null) continue
          if ((left.subOrder < right.subOrder && a > b) || (left.subOrder > right.subOrder && a < b)) {
            score += left.weight * right.weight
          }
          continue
        }
        const hereA = order.get(left.here)
        const hereB = order.get(right.here)
        const otherA = order.get(left.other)
        const otherB = order.get(right.other)
        if (hereA == null || hereB == null || otherA == null || otherB == null) continue
        if ((hereA < hereB && otherA > otherB) || (hereA > hereB && otherA < otherB)) {
          score += left.weight * right.weight
        }
      }
    }
    return score
  }

  function expandLongEdgesWithVirtualNodes(rows, relations) {
    const childToRowMap = placementChildToRow(rows)
    const order = placementRowOrderLookup(rows)
    const expandedRows = new Map([...rows.entries()].map(([rank, row]) => [rank, [...row]]))
    const expandedRelations = []
    const virtualNodes = new Set()
    const virtualMetadata = new Map()
    relations.forEach((relation) => {
      if (relation.relationIndex == null) {
        expandedRelations.push({ ...relation })
        return
      }
      const fromRow = childToRowMap.get(relation.from)
      const toRow = childToRowMap.get(relation.to)
      if (fromRow == null || toRow == null || Math.abs(fromRow - toRow) <= 1) {
        expandedRelations.push({ ...relation })
        return
      }
      const fromOrder = order.get(relation.from) || 0
      const toOrder = order.get(relation.to) || 0
      const step = toRow > fromRow ? 1 : -1
      const totalSpan = Math.max(1, Math.abs(fromRow - toRow))
      let previous = relation.from
      for (let currentRow = fromRow + step; currentRow !== toRow; currentRow += step) {
        const progress = Math.abs(fromRow - currentRow) / totalSpan
        const desiredOrder = fromOrder + (toOrder - fromOrder) * progress
        const virtualId = placementVirtualNodeId(relation.relationIndex, currentRow)
        if (!virtualNodes.has(virtualId)) {
          virtualNodes.add(virtualId)
          if (!expandedRows.has(currentRow)) expandedRows.set(currentRow, [])
          expandedRows.get(currentRow).push(virtualId)
          virtualMetadata.set(virtualId, { relationIndex: relation.relationIndex, rowRank: currentRow, desiredOrder })
        }
        expandedRelations.push({ ...relation, from: previous, to: virtualId, fromSubOrder: null })
        previous = virtualId
      }
      expandedRelations.push({ ...relation, from: previous, to: relation.to, fromSubOrder: null })
    })
    expandedRows.forEach((row) => {
      const originalOrder = new Map(row.map((child, index) => [child, index]))
      row.sort((left, right) => {
        const leftMeta = virtualMetadata.get(left)
        const rightMeta = virtualMetadata.get(right)
        const leftKey = leftMeta ? [leftMeta.desiredOrder, 1, leftMeta.relationIndex, left] : [originalOrder.get(left) || 0, 0, Number.MAX_SAFE_INTEGER, left]
        const rightKey = rightMeta ? [rightMeta.desiredOrder, 1, rightMeta.relationIndex, right] : [originalOrder.get(right) || 0, 0, Number.MAX_SAFE_INTEGER, right]
        return compareNumberEpsilon(leftKey[0], rightKey[0]) || leftKey[1] - rightKey[1] || leftKey[2] - rightKey[2] || String(leftKey[3]).localeCompare(String(rightKey[3]))
      })
    })
    return { expandedRows, expandedRelations, virtualNodes, virtualMetadata }
  }

  function extractCorridorHints(rows, virtualNodes, virtualMetadata) {
    const hints = []
    ;[...rows.entries()].forEach(([rowRank, row]) => {
      row.forEach((child, index) => {
        if (!virtualNodes.has(child)) return
        const meta = virtualMetadata.get(child)
        if (!meta) return
        const leftIndex = row.slice(0, index).map((value, localIndex) => [value, localIndex]).reverse().find(([value]) => !virtualNodes.has(value))?.[1]
        const rightIndexOffset = row.slice(index + 1).findIndex((value) => !virtualNodes.has(value))
        const rightIndex = rightIndexOffset >= 0 ? index + 1 + rightIndexOffset : null
        const neighborLeft = leftIndex != null ? row[leftIndex] : null
        const neighborRight = rightIndex != null ? row[rightIndex] : null
        if (!neighborLeft && !neighborRight) return
        const leftAnchor = leftIndex ?? 0
        const rightAnchor = rightIndex ?? Math.max(0, row.length - 1)
        const span = Math.max(1, rightAnchor - leftAnchor)
        hints.push({
          relationIndex: meta.relationIndex,
          rowRank,
          columnRatio: Math.max(0, index - leftAnchor) / span,
          neighborLeft,
          neighborRight,
        })
      })
    })
    return hints.sort((a, b) => a.rowRank - b.rowRank || a.relationIndex - b.relationIndex || compareNumberEpsilon(a.columnRatio, b.columnRatio) || String(a.neighborLeft || '').localeCompare(String(b.neighborLeft || '')) || String(a.neighborRight || '').localeCompare(String(b.neighborRight || '')))
  }

  function barycentersForSweep(rows, childToRowMap, relations, sweepRows, downward) {
    const order = placementRowOrderLookup(rows)
    const barycenters = new Map()
    sweepRows.forEach((rowKey) => {
      const row = rows.get(rowKey) || []
      row.forEach((child, index) => {
        let total = 0
        let weight = 0
        relations.forEach((relation) => {
          let other = null
          let subOffset = 0
          if (relation.from === child) {
            other = relation.to
          } else if (relation.to === child) {
            other = relation.from
            subOffset = relation.fromSubOrder || 0
          }
          if (!other) return
          const otherRow = childToRowMap.get(other)
          if (otherRow == null || otherRow === rowKey) return
          if (downward && otherRow >= rowKey) return
          if (!downward && otherRow <= rowKey) return
          const otherIndex = order.get(other)
          if (otherIndex == null) return
          const distance = Math.max(1, Math.abs(rowKey - otherRow))
          const relWeight = (relation.weight || 1) / distance
          total += (otherIndex + subOffset) * relWeight
          weight += relWeight
        })
        if (weight > 0) barycenters.set(child, total / weight)
        else if (!barycenters.has(child)) barycenters.set(child, index)
      })
    })
    return barycenters
  }

  function movableBucketsForRow(row, xRanks, virtualNodes) {
    const buckets = []
    let start = 0
    while (start < row.length) {
      let end = start + 1
      while (end < row.length) {
        const left = row[end - 1]
        const right = row[end]
        const leftVirtual = virtualNodes.has(left)
        const rightVirtual = virtualNodes.has(right)
        const leftRank = xRanks.get(left) || 0
        const rightRank = xRanks.get(right) || 0
        if (!leftVirtual && !rightVirtual && leftRank !== rightRank) break
        end += 1
      }
      buckets.push([start, end])
      start = end
    }
    return buckets
  }

  function placementScoreWithCandidate(rowKey, rows, candidate, childToRowMap, relations) {
    const tempRows = new Map([...rows.entries()].map(([rank, row]) => [rank, [...row]]))
    tempRows.set(rowKey, [...candidate])
    return placementCrossingScoreForRow(rowKey, candidate, tempRows, childToRowMap, relations)
  }

  function rowBarycenterPenalty(row, barycenters) {
    return row.reduce((sum, child, index) => sum + Math.abs(index - (barycenters.get(child) ?? index)), 0)
  }

  function rowStabilityPenalty(row, baselineOrder) {
    return row.reduce((sum, child, index) => sum + Math.abs(index - (baselineOrder.get(child) ?? index)), 0)
  }

  function rowCandidateLexCompare(left, right) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const delta = String(left[index]).localeCompare(String(right[index]))
      if (delta) return delta
    }
    return left.length - right.length
  }

  function rowCandidateIsBetter(current, best, candidate, bestCandidate) {
    const scoreDelta = compareNumberEpsilon(current.score, best.score)
    if (scoreDelta < 0) return true
    if (scoreDelta > 0) return false
    const stabilityDelta = compareNumberEpsilon(current.stabilityPenalty, best.stabilityPenalty)
    if (stabilityDelta < 0) return true
    if (stabilityDelta > 0) return false
    const baryDelta = compareNumberEpsilon(current.barycenterPenalty, best.barycenterPenalty)
    if (baryDelta < 0) return true
    if (baryDelta > 0) return false
    return rowCandidateLexCompare(candidate, bestCandidate) < 0
  }

  function optimizeSinglePlacementRow(rowKey, rows, xRanks, childToRowMap, relations, barycenters, virtualNodes) {
    const original = [...(rows.get(rowKey) || [])]
    const baselineOrder = new Map(original.map((child, index) => [child, index]))
    const row = [...original]
    for (const [start, end] of movableBucketsForRow(row, xRanks, virtualNodes)) {
      if (end - start > 1) {
        const sorted = row.slice(start, end).sort((a, b) => compareNumberEpsilon(barycenters.get(a) ?? Infinity, barycenters.get(b) ?? Infinity) || a.localeCompare(b))
        row.splice(start, end - start, ...sorted)
      }
    }
    rows.set(rowKey, row)
    for (let iter = 0; iter < Math.max(1, row.length * 4); iter += 1) {
      let bestIndex = -1
      let bestScore = placementScoreWithCandidate(rowKey, rows, row, childToRowMap, relations)
      for (let index = 0; index < row.length - 1; index += 1) {
        const left = row[index]
        const right = row[index + 1]
        if (!virtualNodes.has(left) && !virtualNodes.has(right) && (xRanks.get(left) || 0) !== (xRanks.get(right) || 0)) continue
        const candidate = [...row]
        ;[candidate[index], candidate[index + 1]] = [candidate[index + 1], candidate[index]]
        const score = placementScoreWithCandidate(rowKey, rows, candidate, childToRowMap, relations)
        if (compareNumberEpsilon(score, bestScore) < 0) {
          bestScore = score
          bestIndex = index
        }
      }
      if (bestIndex < 0) break
      ;[row[bestIndex], row[bestIndex + 1]] = [row[bestIndex + 1], row[bestIndex]]
      rows.set(rowKey, row)
    }
    const originalScore = placementScoreWithCandidate(rowKey, rows, original, childToRowMap, relations)
    const currentScore = placementScoreWithCandidate(rowKey, rows, row, childToRowMap, relations)
    const originalSummary = {
      score: originalScore,
      stabilityPenalty: rowStabilityPenalty(original, baselineOrder),
      barycenterPenalty: rowBarycenterPenalty(original, barycenters),
    }
    const currentSummary = {
      score: currentScore,
      stabilityPenalty: rowStabilityPenalty(row, baselineOrder),
      barycenterPenalty: rowBarycenterPenalty(row, barycenters),
    }
    if (!rowCandidateIsBetter(currentSummary, originalSummary, row, original)) {
      rows.set(rowKey, original)
      return false
    }
    rows.set(rowKey, row)
    return row.join('\0') !== original.join('\0')
  }

  function optimizeRowOrderWithCorridorHints(rows, xRanks, relations, maxPasses = 4) {
    const { expandedRows, expandedRelations, virtualNodes, virtualMetadata } = expandLongEdgesWithVirtualNodes(rows, relations)
    const childToRowMap = placementChildToRow(expandedRows)
    const rowKeys = [...expandedRows.keys()].sort((a, b) => a - b)
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let improved = false
      const downwardBary = barycentersForSweep(expandedRows, childToRowMap, expandedRelations, rowKeys, true)
      rowKeys.slice(1).forEach((rowKey) => {
        improved = optimizeSinglePlacementRow(rowKey, expandedRows, xRanks, childToRowMap, expandedRelations, downwardBary, virtualNodes) || improved
      })
      const upwardKeys = [...rowKeys].reverse()
      const upwardBary = barycentersForSweep(expandedRows, childToRowMap, expandedRelations, upwardKeys, false)
      upwardKeys.slice(1).forEach((rowKey) => {
        improved = optimizeSinglePlacementRow(rowKey, expandedRows, xRanks, childToRowMap, expandedRelations, upwardBary, virtualNodes) || improved
      })
      if (!improved) break
    }
    const hints = extractCorridorHints(expandedRows, virtualNodes, virtualMetadata)
    expandedRows.forEach((row, rank) => rows.set(rank, row.filter((child) => !virtualNodes.has(child))))
    return hints
  }

  function weightedMedian(samples) {
    const filtered = samples.filter(([, weight]) => Number.isFinite(weight) && weight > 0).sort((a, b) => compareNumberEpsilon(a[0], b[0]) || a[1] - b[1])
    if (!filtered.length) return null
    const total = filtered.reduce((sum, [, weight]) => sum + weight, 0)
    let cumulative = 0
    for (const [value, weight] of filtered) {
      cumulative += weight
      if (cumulative + ORDER_EPSILON >= total / 2) return value
    }
    return filtered[filtered.length - 1][0]
  }

  function corridorHintRowSpan(row, hint) {
    if (!row.length) return null
    const leftIndex = hint.neighborLeft ? row.indexOf(hint.neighborLeft) : -1
    const rightIndex = hint.neighborRight ? row.indexOf(hint.neighborRight) : -1
    const left = leftIndex >= 0 ? leftIndex : 0
    const right = rightIndex >= 0 ? rightIndex : row.length - 1
    return [Math.min(left, right), Math.max(left, right)]
  }

  function relaxRowPositionsWithCorridorHints(layout, positions, relations, corridorHints, config) {
    const baseLefts = new Map([...positions.entries()].map(([child, p]) => [child, p.x]))
    const relationWeights = new Map(relations.filter((relation) => relation.relationIndex != null).map((relation) => [relation.relationIndex, relation.weight || 1]))
    const hintsByRow = new Map()
    corridorHints.forEach((hint) => {
      if (!hintsByRow.has(hint.rowRank)) hintsByRow.set(hint.rowRank, [])
      hintsByRow.get(hint.rowRank).push(hint)
    })
    for (let iter = 0; iter < config.iterations; iter += 1) {
      const centers = new Map([...positions.entries()].map(([child, p]) => [child, p.x + (layout.widths.get(child) || 0) / 2]))
      const nextLefts = new Map()
      let maxDelta = 0
      ;[...layout.rows.entries()].forEach(([rank, row]) => {
        const gaps = layout.rowGaps.get(rank) || Array(Math.max(0, row.length - 1)).fill(0)
        const rowWidths = row.map((child) => layout.widths.get(child) || 0)
        const natural = layout.rowNaturalWidths.get(rank) ?? layout.contentWidth
        const slack = Math.max(0, layout.contentWidth - natural) / 2
        const effectiveMaxShift = config.maxShiftX + Math.max(0, slack - config.maxShiftX) * 0.25
        const currentLefts = row.map((child) => positions.get(child)?.x || 0)
        const targetLefts = [...currentLefts]
        row.forEach((child, index) => {
          const baseLeft = baseLefts.get(child) ?? currentLefts[index]
          const baseCenter = baseLeft + rowWidths[index] / 2
          const samples = [[baseCenter, config.baseAnchorWeight]]
          relations.forEach((relation) => {
            const other = relation.from === child ? relation.to : relation.to === child ? relation.from : null
            if (!other || !centers.has(other)) return
            samples.push([centers.get(other), relation.weight || 1])
          })
          ;(hintsByRow.get(rank) || []).forEach((hint) => {
            const span = corridorHintRowSpan(row, hint)
            if (!span) return
            if (index < span[0] || index > span[1]) return
            const rowLeftEdge = currentLefts[0] || 0
            const rowRightEdge = currentLefts.length ? currentLefts[currentLefts.length - 1] + rowWidths[rowWidths.length - 1] : layout.contentWidth
            const leftCenter = hint.neighborLeft && centers.has(hint.neighborLeft) ? centers.get(hint.neighborLeft) : rowLeftEdge
            const rightCenter = hint.neighborRight && centers.has(hint.neighborRight) ? centers.get(hint.neighborRight) : rowRightEdge
            const targetCenter = leftCenter + (rightCenter - leftCenter) * hint.columnRatio
            const participation = hint.neighborLeft === child || hint.neighborRight === child ? 1 : 0.55
            samples.push([targetCenter, (relationWeights.get(hint.relationIndex) || 1) * config.corridorHintWeight * participation])
          })
          const idealCenter = weightedMedian(samples) ?? baseCenter
          const idealLeft = idealCenter - rowWidths[index] / 2
          targetLefts[index] = Math.max(baseLeft - effectiveMaxShift, Math.min(baseLeft + effectiveMaxShift, idealLeft))
        })
        const legalized = [...targetLefts]
        let minLeft = 0
        for (let index = 0; index < row.length; index += 1) {
          legalized[index] = Math.max(legalized[index], minLeft)
          minLeft = legalized[index] + rowWidths[index] + (gaps[index] || 0)
        }
        for (let index = row.length - 1; index >= 0; index -= 1) {
          legalized[index] = Math.min(legalized[index], layout.contentWidth - rowWidths[index])
          if (index > 0) legalized[index - 1] = Math.min(legalized[index - 1], legalized[index] - (gaps[index - 1] || 0) - rowWidths[index - 1])
        }
        minLeft = 0
        for (let index = 0; index < row.length; index += 1) {
          legalized[index] = Math.max(minLeft, Math.min(layout.contentWidth - rowWidths[index], legalized[index]))
          minLeft = legalized[index] + rowWidths[index] + (gaps[index] || 0)
        }
        row.forEach((child, index) => {
          const blended = currentLefts[index] * (1 - config.blend) + legalized[index] * config.blend
          maxDelta = Math.max(maxDelta, Math.abs(blended - currentLefts[index]))
          nextLefts.set(child, blended)
        })
      })
      nextLefts.forEach((left, child) => {
        const p = positions.get(child)
        if (p) positions.set(child, { ...p, x: left })
      })
      if (maxDelta < 1) break
    }
  }

  function relaxRowPositions(rows, positions, sizes, contentWidth, relations, config = {}) {
    const iterations = config.iterations ?? 6
    const blend = config.blend ?? 0.55
    const maxShift = config.maxShiftX ?? 96
    const maxTotalShift = config.maxTotalShiftX ?? Infinity
    const basePositions = new Map([...positions.entries()].map(([id, p]) => [id, { ...p }]))
    for (let iter = 0; iter < iterations; iter += 1) {
      const next = new Map(positions)
      for (const row of rows.values()) {
        for (const id of row) {
          const peers = []
          for (const rel of relations) {
            if (rel.from === id && positions.has(rel.to)) peers.push(rel.to)
            if (rel.to === id && positions.has(rel.from)) peers.push(rel.from)
          }
          if (!peers.length) continue
          const own = positions.get(id)
          const ownSize = sizes.get(id)
          const peerCenter = peers.reduce((sum, peer) => sum + positions.get(peer).x + sizes.get(peer).w / 2, 0) / peers.length
          const targetX = peerCenter - ownSize.w / 2
          const shift = Math.max(-maxShift, Math.min(maxShift, targetX - own.x)) * blend
          const base = basePositions.get(id) || own
          const shifted = Math.max(base.x - maxTotalShift, Math.min(base.x + maxTotalShift, own.x + shift))
          next.set(id, { ...own, x: Math.max(0, Math.min(contentWidth - ownSize.w, shifted)) })
        }
        if (!config.preserveOrder) {
          row.sort((a, b) => (next.get(a).x - next.get(b).x) || a.localeCompare(b))
        }
        const orderedRow = row
        let cursor = 0
        for (const id of orderedRow) {
          const p = next.get(id)
          const size = sizes.get(id)
          const x = Math.max(p.x, cursor)
          next.set(id, { ...p, x })
          cursor = x + size.w + (config.gapX ?? 56)
        }
      }
      positions.clear()
      next.forEach((value, key) => positions.set(key, value))
    }
  }

  function buildLayeredLayout({ ids, sizes, relations, rankConstraints = [], orderConstraints = [], gapX = 64, gapY = 72 }) {
    const rankMap = solveRankConstraints(ids, rankConstraints)
    const orderMap = solveRankConstraints(ids, orderConstraints)
    const rows = groupRowsByRank(ids, rankMap, orderMap)
    optimizeRowOrder(rows, orderMap, relations, 4)

    const rowKeys = [...rows.keys()].sort((a, b) => a - b)
    let contentWidth = 0
    const rowHeights = new Map()
    for (const rank of rowKeys) {
      const row = rows.get(rank)
      const rowWidth = row.reduce((sum, id) => sum + (sizes.get(id)?.w || 0), 0) + Math.max(0, row.length - 1) * gapX
      const rowHeight = row.reduce((max, id) => Math.max(max, sizes.get(id)?.h || 0), 0)
      contentWidth = Math.max(contentWidth, rowWidth)
      rowHeights.set(rank, rowHeight)
    }

    const positions = new Map()
    let y = 0
    for (const rank of rowKeys) {
      const row = rows.get(rank)
      const rowWidth = row.reduce((sum, id) => sum + (sizes.get(id)?.w || 0), 0) + Math.max(0, row.length - 1) * gapX
      let x = Math.max(0, (contentWidth - rowWidth) / 2)
      const rowHeight = rowHeights.get(rank) || 0
      for (const id of row) {
        const size = sizes.get(id) || { w: 0, h: 0 }
        positions.set(id, { x, y: y + Math.max(0, (rowHeight - size.h) / 2), w: size.w, h: size.h })
        x += size.w + gapX
      }
      y += rowHeight + gapY
    }
    if (rowKeys.length) y -= gapY
    relaxRowPositions(rows, positions, sizes, contentWidth, relations, { gapX, iterations: 5, blend: 0.45 })
    return { width: contentWidth, height: y, positions, rows }
  }

  function sideForBoxes(from, to) {
    const fx = from.x + from.w / 2
    const fy = from.y + from.h / 2
    const tx = to.x + to.w / 2
    const ty = to.y + to.h / 2
    if (fy + from.h / 2 <= ty - to.h / 2 + 1) return ['bottom', 'top']
    if (Math.abs(fx - tx) > Math.abs(fy - ty)) return fx < tx ? ['right', 'left'] : ['left', 'right']
    return fy < ty ? ['bottom', 'top'] : ['top', 'bottom']
  }

  function flowchartSideForBoxes(from, to, direction = 'TD') {
    const fx = from.x + from.w / 2
    const fy = from.y + from.h / 2
    const tx = to.x + to.w / 2
    const ty = to.y + to.h / 2
    if (direction === 'BT') {
      if (fy - from.h / 2 >= ty + to.h / 2 - 1) return ['top', 'bottom']
      if (Math.abs(fx - tx) > Math.abs(fy - ty)) return fx < tx ? ['right', 'left'] : ['left', 'right']
      return fy > ty ? ['top', 'bottom'] : ['bottom', 'top']
    }
    if (direction === 'LR') {
      if (fx + from.w / 2 <= tx - to.w / 2 + 1) return ['right', 'left']
      if (Math.abs(fy - ty) > Math.abs(fx - tx)) return fy < ty ? ['bottom', 'top'] : ['top', 'bottom']
      return fx < tx ? ['right', 'left'] : ['left', 'right']
    }
    if (direction === 'RL') {
      if (fx - from.w / 2 >= tx + to.w / 2 - 1) return ['left', 'right']
      if (Math.abs(fy - ty) > Math.abs(fx - tx)) return fy < ty ? ['bottom', 'top'] : ['top', 'bottom']
      return fx > tx ? ['left', 'right'] : ['right', 'left']
    }
    return sideForBoxes(from, to)
  }

  function anchorOnBox(box, side) {
    if (side === 'top') return { x: box.x + box.w / 2, y: box.y }
    if (side === 'bottom') return { x: box.x + box.w / 2, y: box.y + box.h }
    if (side === 'left') return { x: box.x, y: box.y + box.h / 2 }
    return { x: box.x + box.w, y: box.y + box.h / 2 }
  }

  function sideVector(side) {
    if (side === 'top') return { x: 0, y: -1 }
    if (side === 'bottom') return { x: 0, y: 1 }
    if (side === 'left') return { x: -1, y: 0 }
    return { x: 1, y: 0 }
  }

  function simplifyPolyline(points) {
    const out = []
    for (const point of points) {
      const last = out[out.length - 1]
      if (last && Math.abs(last.x - point.x) < 0.1 && Math.abs(last.y - point.y) < 0.1) continue
      if (out.length >= 2) {
        const prev = out[out.length - 2]
        const sameX = Math.abs(prev.x - last.x) < 0.1 && Math.abs(last.x - point.x) < 0.1
        const sameY = Math.abs(prev.y - last.y) < 0.1 && Math.abs(last.y - point.y) < 0.1
        if (sameX || sameY) out.pop()
      }
      out.push(point)
    }
    for (let index = 1; index < out.length - 1; index += 1) {
      const prev = out[index - 1]
      const current = out[index]
      const next = out[index + 1]
      if (Math.abs(prev.y - current.y) < 0.1 && Math.abs(current.x - next.x) <= 12) next.x = current.x
      if (Math.abs(prev.x - current.x) < 0.1 && Math.abs(current.y - next.y) <= 12) next.y = current.y
      const tinyHorizontal = Math.abs(prev.x - current.x) < 0.1 && Math.abs(current.y - next.y) < 0.1 && Math.abs(current.x - next.x) <= 12
      const tinyVertical = Math.abs(prev.y - current.y) < 0.1 && Math.abs(current.x - next.x) < 0.1 && Math.abs(current.y - next.y) <= 12
      if (tinyHorizontal) {
        const oldX = next.x
        for (let shift = index + 1; shift < out.length && Math.abs(out[shift].x - oldX) < 0.1; shift += 1) {
          out[shift].x = prev.x
        }
        out.splice(index, 1)
        index -= 1
      } else if (tinyVertical) {
        const oldY = next.y
        for (let shift = index + 1; shift < out.length && Math.abs(out[shift].y - oldY) < 0.1; shift += 1) {
          out[shift].y = prev.y
        }
        out.splice(index, 1)
        index -= 1
      }
    }
    const canonical = []
    for (const rawPoint of out) {
      const point = { x: rawPoint.x, y: rawPoint.y }
      const last = canonical[canonical.length - 1]
      if (last && Math.abs(last.x - point.x) > 0.1 && Math.abs(last.y - point.y) > 0.1) {
        const dx = Math.abs(last.x - point.x)
        const dy = Math.abs(last.y - point.y)
        if (dx <= 12) point.x = last.x
        else if (dy <= 12) point.y = last.y
        else canonical.push({ x: last.x, y: point.y })
      }
      const updatedLast = canonical[canonical.length - 1]
      if (updatedLast && Math.abs(updatedLast.x - point.x) < 0.1 && Math.abs(updatedLast.y - point.y) < 0.1) continue
      if (canonical.length >= 2) {
        const prev = canonical[canonical.length - 2]
        const sameX = Math.abs(prev.x - updatedLast.x) < 0.1 && Math.abs(updatedLast.x - point.x) < 0.1
        const sameY = Math.abs(prev.y - updatedLast.y) < 0.1 && Math.abs(updatedLast.y - point.y) < 0.1
        if (sameX || sameY) canonical.pop()
      }
      canonical.push(point)
    }
    return canonical
  }

  function routeOrthogonal(from, to, occupied = [], stub = 24) {
    const [fromSide, toSide] = sideForBoxes(from, to)
    const start = anchorOnBox(from, fromSide)
    const end = anchorOnBox(to, toSide)
    const sv = sideVector(fromSide)
    const ev = sideVector(toSide)
    let s = { x: start.x + sv.x * stub, y: start.y + sv.y * stub }
    let e = { x: end.x + ev.x * stub, y: end.y + ev.y * stub }
    let points
    if (Math.abs(s.x - e.x) < 0.1 || Math.abs(s.y - e.y) < 0.1) {
      points = [start, s, e, end]
    } else {
      const horizontalFirst = Math.abs(s.x - e.x) > Math.abs(s.y - e.y)
      const mid = horizontalFirst ? { x: e.x, y: s.y } : { x: s.x, y: e.y }
      points = [start, s, mid, e, end]
    }
    const laneKey = points.slice(1, -1).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('|')
    const collisions = occupied.filter((key) => key === laneKey).length
    if (collisions) {
      const offset = collisions * 14
      s = { x: s.x + (sv.y ? offset : 0), y: s.y + (sv.x ? offset : 0) }
      e = { x: e.x + (ev.y ? offset : 0), y: e.y + (ev.x ? offset : 0) }
      const mid = Math.abs(s.x - e.x) > Math.abs(s.y - e.y) ? { x: e.x, y: s.y } : { x: s.x, y: e.y }
      points = [start, s, mid, e, end]
    }
    occupied.push(laneKey)
    return simplifyPolyline(points)
  }

  function routeOrthogonalWithSides(from, to, fromSide, toSide, occupied = [], stub = 24) {
    const start = anchorOnBox(from, fromSide)
    const end = anchorOnBox(to, toSide)
    const sv = sideVector(fromSide)
    const ev = sideVector(toSide)
    let s = { x: start.x + sv.x * stub, y: start.y + sv.y * stub }
    let e = { x: end.x + ev.x * stub, y: end.y + ev.y * stub }
    const horizontalFirst = fromSide === 'left' || fromSide === 'right'
    let mid = horizontalFirst ? { x: e.x, y: s.y } : { x: s.x, y: e.y }
    let points = [start, s, mid, e, end]
    const laneKey = points.slice(1, -1).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('|')
    const collisions = occupied.filter((key) => key === laneKey).length
    if (collisions) {
      const offset = collisions * 14
      s = { x: s.x + (sv.y ? offset : 0), y: s.y + (sv.x ? offset : 0) }
      e = { x: e.x + (ev.y ? offset : 0), y: e.y + (ev.x ? offset : 0) }
      mid = horizontalFirst ? { x: e.x, y: s.y } : { x: s.x, y: e.y }
      points = [start, s, mid, e, end]
    }
    occupied.push(laneKey)
    return simplifyPolyline(points)
  }

  function routeFlowchartEdge(from, to, horizontal, sourceLaneOffset = 0, targetLaneOffset = 0) {
    const [fromSide, toSide] = from.flowSides || flowchartSideForBoxes(from, to, horizontal ? 'LR' : 'TD')
    const start = anchorOnBox(from, fromSide)
    const end = anchorOnBox(to, toSide)
    if (!horizontal && (fromSide === 'bottom' || fromSide === 'top') && (toSide === 'top' || toSide === 'bottom')) {
      const fromDir = fromSide === 'bottom' ? 1 : -1
      const toDir = toSide === 'top' ? -1 : 1
      const effectiveStartLaneOffset = sourceLaneOffset || targetLaneOffset
      const startTurnY = start.y + fromDir * 24 + effectiveStartLaneOffset * 0.25
      const endTurnY = end.y + toDir * 24 + targetLaneOffset * 0.5
      if (Math.abs(startTurnY - endTurnY) < 0.1) {
        return simplifyPolyline([start, { x: start.x, y: startTurnY }, { x: end.x, y: endTurnY }, end])
      }
      return simplifyPolyline([start, { x: start.x, y: startTurnY }, { x: end.x, y: startTurnY }, { x: end.x, y: endTurnY }, end])
    }
    if (horizontal && (fromSide === 'right' || fromSide === 'left') && (toSide === 'left' || toSide === 'right')) {
      const fromDir = fromSide === 'right' ? 1 : -1
      const toDir = toSide === 'left' ? -1 : 1
      const effectiveStartLaneOffset = sourceLaneOffset || targetLaneOffset
      const startTurnX = start.x + fromDir * 24 + effectiveStartLaneOffset * 0.25
      const endTurnX = end.x + toDir * 24 + targetLaneOffset * 0.5
      if (Math.abs(startTurnX - endTurnX) < 0.1) {
        return simplifyPolyline([start, { x: startTurnX, y: start.y }, { x: endTurnX, y: end.y }, end])
      }
      return simplifyPolyline([start, { x: startTurnX, y: start.y }, { x: startTurnX, y: end.y }, { x: endTurnX, y: end.y }, end])
    }
    return routeOrthogonal(from, to, [], 24)
  }

  function c4RelationSides(rel, from, to) {
    if (rel.direction === 'right') return ['right', 'left']
    if (rel.direction === 'left') return ['left', 'right']
    if (rel.direction === 'down') return ['bottom', 'top']
    if (rel.direction === 'up') return ['top', 'bottom']
    return sideForBoxes(from, to)
  }

  function routeViaVerticalAxis(start, end, axis, startTurnY, endTurnY) {
    return simplifyPolyline([
      { ...start },
      { x: start.x, y: startTurnY },
      { x: axis, y: startTurnY },
      { x: axis, y: endTurnY },
      { x: end.x, y: endTurnY },
      { ...end },
    ])
  }

  function routeViaHorizontalAxis(start, end, axis, startTurnX, endTurnX) {
    return simplifyPolyline([
      { ...start },
      { x: startTurnX, y: start.y },
      { x: startTurnX, y: axis },
      { x: endTurnX, y: axis },
      { x: endTurnX, y: end.y },
      { ...end },
    ])
  }

  function c4PolylineLength(points) {
    return points.reduce((sum, point, index) => {
      if (!index) return 0
      return sum + Math.abs(point.x - points[index - 1].x) + Math.abs(point.y - points[index - 1].y)
    }, 0)
  }

  function c4PolylineOverlapsSegments(points, occupiedSegments) {
    const segments = c4SegmentsFromRoute(points)
    for (const seg of segments) {
      for (const occupied of occupiedSegments) {
        if (seg.orientation !== occupied.orientation) continue
        if (Math.abs(seg.axis - occupied.axis) > 0.1) continue
        if (Math.max(seg.start, occupied.start) < Math.min(seg.end, occupied.end) - 0.1) return true
      }
    }
    return false
  }

  function c4PolylineCrossesSegments(points, occupiedSegments) {
    const segments = c4SegmentsFromRoute(points)
    for (const seg of segments) {
      for (const occupied of occupiedSegments) {
        if (seg.orientation === occupied.orientation) continue
        const vertical = seg.orientation === 'vertical' ? seg : occupied
        const horizontal = seg.orientation === 'horizontal' ? seg : occupied
        if (
          vertical.axis > horizontal.start + 0.1 &&
          vertical.axis < horizontal.end - 0.1 &&
          horizontal.axis > vertical.start + 0.1 &&
          horizontal.axis < vertical.end - 0.1
        ) return true
      }
    }
    return false
  }

  function routeC4Relation(rel, from, to, occupiedSegments = [], obstacles = [], allowedRegion = null, displayLabel = '', sourcePortOffset = { x: 0, y: 0 }, targetPortOffset = { x: 0, y: 0 }) {
    const [fromSide, toSide] = c4RelationSides(rel, from, to)
    const start = anchorOnBox(from, fromSide)
    const end = anchorOnBox(to, toSide)
    start.x += sourcePortOffset.x || 0
    start.y += sourcePortOffset.y || 0
    end.x += targetPortOffset.x || 0
    end.y += targetPortOffset.y || 0
    if ((fromSide === 'bottom' || fromSide === 'top') && (toSide === 'bottom' || toSide === 'top')) {
      if (start.x >= to.x + 28 && start.x <= to.x + to.w - 28) end.x = start.x
      else if (end.x >= from.x + 28 && end.x <= from.x + from.w - 28) start.x = end.x
    }
    const sv = sideVector(fromSide)
    const ev = sideVector(toSide)
    const startStub = { x: start.x + sv.x * 34, y: start.y + sv.y * 34 }
    const endStub = { x: end.x + ev.x * 34, y: end.y + ev.y * 34 }
    const candidates = []
    const pushCandidate = (points, baseScore = 0) => {
      const simplified = simplifyPolyline(points)
      if (allowedRegion && simplified.some((point) => point.x < allowedRegion.left - 0.1 || point.x > allowedRegion.right + 0.1 || point.y < allowedRegion.top - 0.1 || point.y > allowedRegion.bottom + 0.1)) return
      const obstaclePenalty = obstacles.some((rectValue) => c4PolylineIntersectsRect(simplified, rectValue)) ? 100000 : 0
      const occupiedPenalty = c4PolylineOverlapsSegments(simplified, occupiedSegments) ? 90000 : 0
      const crossingPenalty = c4PolylineCrossesSegments(simplified, occupiedSegments) ? 42000 : 0
      const labelPenalty = displayLabel ? Math.max(0, 180 - Math.max(...c4SegmentsFromRoute(simplified).map((seg) => Math.abs(seg.end - seg.start)), 0)) : 0
      candidates.push({
        points: simplified,
        score: baseScore + c4PolylineLength(simplified) + c4BendCount(simplified) * 28 + obstaclePenalty + occupiedPenalty + crossingPenalty + labelPenalty,
      })
    }

    if (fromSide === 'bottom' || fromSide === 'top') {
      const dir = fromSide === 'bottom' ? 1 : -1
      const endDir = toSide === 'top' ? -1 : 1
      const baseStartY = start.y + dir * 34
      const baseEndY = end.y + endDir * 34
      const startTurnYs = [baseStartY, baseStartY + dir * 18, baseStartY + dir * 36, baseStartY - dir * 18]
      const endTurnYs = [baseEndY, baseEndY + endDir * 18, baseEndY + endDir * 36, baseEndY - endDir * 18]
      const axisCandidates = [
        start.x,
        end.x,
        (start.x + end.x) / 2,
        from.x + from.w / 2,
        to.x + to.w / 2,
        allowedRegion ? allowedRegion.left + 12 : Math.min(start.x, end.x) - 56,
        allowedRegion ? allowedRegion.right - 12 : Math.max(start.x, end.x) + 56,
      ]
      obstacles.forEach((rectValue) => {
        axisCandidates.push(rectValue.left - 16, rectValue.right + 16)
      })
      occupiedSegments.filter((seg) => seg.orientation === 'vertical').forEach((seg) => {
        axisCandidates.push(seg.axis - 18, seg.axis + 18)
      })
      occupiedSegments.filter((seg) => seg.orientation === 'horizontal').forEach((seg) => {
        axisCandidates.push(seg.start - 18, seg.end + 18)
      })
      ;[...new Set(axisCandidates.map((value) => Math.round(value * 10) / 10))]
        .filter((axis) => !allowedRegion || (axis >= allowedRegion.left && axis <= allowedRegion.right))
        .forEach((axis) => {
          ;[...new Set(startTurnYs.map((value) => Math.round(value * 10) / 10))]
            .filter((turnY) => !allowedRegion || (turnY >= allowedRegion.top && turnY <= allowedRegion.bottom))
            .forEach((startTurnY) => {
              ;[...new Set(endTurnYs.map((value) => Math.round(value * 10) / 10))]
                .filter((turnY) => !allowedRegion || (turnY >= allowedRegion.top && turnY <= allowedRegion.bottom))
                .forEach((endTurnY) => pushCandidate(routeViaVerticalAxis(start, end, axis, startTurnY, endTurnY), Math.abs(axis - end.x) * 0.4 + Math.abs(startTurnY - baseStartY) * 1.2 + Math.abs(endTurnY - baseEndY) * 0.8))
            })
        })
    } else {
      const dir = fromSide === 'right' ? 1 : -1
      const endDir = toSide === 'left' ? -1 : 1
      const baseStartX = start.x + dir * 34
      const baseEndX = end.x + endDir * 34
      const startTurnXs = [baseStartX, baseStartX + dir * 18, baseStartX + dir * 36, baseStartX - dir * 18]
      const endTurnXs = [baseEndX, baseEndX + endDir * 18, baseEndX + endDir * 36, baseEndX - endDir * 18]
      const axisCandidates = [
        start.y,
        end.y,
        (start.y + end.y) / 2,
        from.y + from.h / 2,
        to.y + to.h / 2,
        allowedRegion ? allowedRegion.top + 12 : Math.min(start.y, end.y) - 56,
        allowedRegion ? allowedRegion.bottom - 12 : Math.max(start.y, end.y) + 56,
      ]
      obstacles.forEach((rectValue) => {
        axisCandidates.push(rectValue.top - 16, rectValue.bottom + 16)
      })
      occupiedSegments.filter((seg) => seg.orientation === 'horizontal').forEach((seg) => {
        axisCandidates.push(seg.axis - 18, seg.axis + 18)
      })
      occupiedSegments.filter((seg) => seg.orientation === 'vertical').forEach((seg) => {
        axisCandidates.push(seg.start - 18, seg.end + 18)
      })
      ;[...new Set(axisCandidates.map((value) => Math.round(value * 10) / 10))]
        .filter((axis) => !allowedRegion || (axis >= allowedRegion.top && axis <= allowedRegion.bottom))
        .forEach((axis) => {
          ;[...new Set(startTurnXs.map((value) => Math.round(value * 10) / 10))]
            .filter((turnX) => !allowedRegion || (turnX >= allowedRegion.left && turnX <= allowedRegion.right))
            .forEach((startTurnX) => {
              ;[...new Set(endTurnXs.map((value) => Math.round(value * 10) / 10))]
                .filter((turnX) => !allowedRegion || (turnX >= allowedRegion.left && turnX <= allowedRegion.right))
                .forEach((endTurnX) => pushCandidate(routeViaHorizontalAxis(start, end, axis, startTurnX, endTurnX), Math.abs(axis - end.y) * 0.4 + Math.abs(startTurnX - baseStartX) * 1.2 + Math.abs(endTurnX - baseEndX) * 0.8))
            })
        })
    }

    pushCandidate([start, startStub, fromSide === 'left' || fromSide === 'right' ? { x: endStub.x, y: startStub.y } : { x: startStub.x, y: endStub.y }, endStub, end], 80)
    candidates.sort((a, b) => a.score - b.score || c4PolylineLength(a.points) - c4PolylineLength(b.points))
    return candidates[0]?.points || routeOrthogonalWithSides(from, to, fromSide, toSide, [], 34)
  }

  function relationLabelPoint(points) {
    let best = null
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index]
      const b = points[index + 1]
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
      if (!best || length > best.length) {
        best = { a, b, length }
      }
    }
    if (!best) return points[Math.floor(points.length / 2)] || { x: 0, y: 0 }
    const horizontal = Math.abs(best.a.x - best.b.x) >= Math.abs(best.a.y - best.b.y)
    return {
      x: (best.a.x + best.b.x) / 2,
      y: (best.a.y + best.b.y) / 2 + (horizontal ? -13 : 0),
    }
  }

  function c4RectFromBox(box) {
    return { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h }
  }

  function c4RectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }

  function c4InflateRect(rect, x, y = x) {
    return { left: rect.left - x, top: rect.top - y, right: rect.right + x, bottom: rect.bottom + y }
  }

  function c4RectInside(inner, outer) {
    return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
  }

  function c4PathLength(points) {
    let length = 0
    for (let index = 0; index < points.length - 1; index += 1) {
      length += Math.abs(points[index].x - points[index + 1].x) + Math.abs(points[index].y - points[index + 1].y)
    }
    return length
  }

  function c4BendCount(points) {
    let bends = 0
    for (let index = 1; index < points.length - 1; index += 1) {
      const a = points[index - 1]
      const b = points[index]
      const c = points[index + 1]
      if ((Math.abs(a.y - b.y) < 0.1) !== (Math.abs(b.y - c.y) < 0.1)) bends += 1
    }
    return bends
  }

  function c4SegmentToRectDistance(a, b, rect) {
    if (Math.abs(a.y - b.y) < 0.1) {
      const y = a.y
      const left = Math.min(a.x, b.x)
      const right = Math.max(a.x, b.x)
      const overlap = left <= rect.right && right >= rect.left
      if (overlap && y >= rect.top && y <= rect.bottom) return 0
      const dx = overlap ? 0 : Math.min(Math.abs(left - rect.right), Math.abs(right - rect.left))
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
      return Math.hypot(dx, dy)
    }
    const x = a.x
    const top = Math.min(a.y, b.y)
    const bottom = Math.max(a.y, b.y)
    const overlap = top <= rect.bottom && bottom >= rect.top
    if (overlap && x >= rect.left && x <= rect.right) return 0
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
    const dy = overlap ? 0 : Math.min(Math.abs(top - rect.bottom), Math.abs(bottom - rect.top))
    return Math.hypot(dx, dy)
  }

  function c4PolylineIntersectsRect(points, rect) {
    for (let index = 0; index < points.length - 1; index += 1) {
      if (c4SegmentToRectDistance(points[index], points[index + 1], rect) < 0.1) return true
    }
    return false
  }

  function c4SegmentsFromRoute(points) {
    const segments = []
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index]
      const b = points[index + 1]
      if (Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) > 0.1) {
        segments.push({ orientation: 'vertical', axis: a.x, start: Math.min(a.y, b.y), end: Math.max(a.y, b.y) })
      } else if (Math.abs(a.y - b.y) < 0.1 && Math.abs(a.x - b.x) > 0.1) {
        segments.push({ orientation: 'horizontal', axis: a.y, start: Math.min(a.x, b.x), end: Math.max(a.x, b.x) })
      }
    }
    return segments
  }

  function c4MinRectClearanceToSegments(rect, segments) {
    if (!segments.length) return Infinity
    let min = Infinity
    for (const seg of segments) {
      const a = seg.orientation === 'horizontal' ? { x: seg.start, y: seg.axis } : { x: seg.axis, y: seg.start }
      const b = seg.orientation === 'horizontal' ? { x: seg.end, y: seg.axis } : { x: seg.axis, y: seg.end }
      min = Math.min(min, c4SegmentToRectDistance(a, b, rect))
    }
    return min
  }

  function c4LabelClearancePenalty(clearance) {
    if (clearance < 4) return 180
    if (clearance < 10) return 90
    if (clearance < 18) return 36
    return 0
  }

  function c4EstimateTextWidth(value, fontSize = 11, weight = 650) {
    let units = 0
    for (const ch of String(value || '')) {
      if ('il!:;.,'.includes(ch)) units += 0.34
      else if ('mwMW@#'.includes(ch)) units += 0.88
      else if (ch === ' ') units += 0.28
      else if (/^[A-Z]$/.test(ch)) units += 0.66
      else if (/^[\x00-\x7F]$/.test(ch)) units += 0.58
      else units += 1.0
    }
    return units * fontSize * (weight >= 700 ? 1.04 : 1)
  }

  function c4WrapText(value, maxWidth, fontSize = 11, weight = 650) {
    const words = String(value || '').split(/\s+/).filter(Boolean)
    if (!words.length) return [String(value || '')]
    if (words.length === 1) return [String(value || '')]
    const lines = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (c4EstimateTextWidth(candidate, fontSize, weight) <= maxWidth || !current) {
        current = candidate
      } else {
        lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
    return lines
  }

  function c4LabelSize(label, maxWidth = 190) {
    const lines = c4WrapText(label, maxWidth, 11, 600)
    const used = lines.slice(0, 2)
    if (!used.length) used.push('')
    const width = Math.max(...used.map((lineValue) => c4EstimateTextWidth(lineValue, 11, 650)))
    return {
      width,
      height: used.length * 17,
      lines: used,
      truncated: lines.length > used.length,
    }
  }

  function c4LabelPlacementFromCenter(center, label) {
    const size = c4LabelSize(label)
    return {
      rect: {
        left: center.x - size.width / 2 - 6,
        top: center.y - size.height / 2,
        right: center.x + size.width / 2 + 6,
        bottom: center.y + size.height / 2,
      },
      centered: true,
      alignEnd: false,
      lines: size.lines,
    }
  }

  function c4LabelPlacementFromRect(rectValue, label, centered = false, alignEnd = false, lines = null) {
    return {
      rect: rectValue,
      centered,
      alignEnd,
      lines: lines || c4LabelSize(label, Math.max(72, rectValue.right - rectValue.left)).lines,
    }
  }

  function c4LabelCandidates(points, label, allowedRegion, occupiedSegments = [], forbiddenRects = []) {
    if (!label) return []
    const segments = []
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index]
      const b = points[index + 1]
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
      if (length >= 40) segments.push({ a, b, length, index })
    }
    segments.sort((left, right) => right.length - left.length || left.index - right.index)
    const candidates = []
    const fallbackCandidates = []
    const routeCenterX = points.length >= 2 ? (points[0].x + points[points.length - 1].x) / 2 : 0
    const multiSegmentRoute = points.length >= 4
    for (const seg of segments) {
      const horizontal = Math.abs(seg.a.y - seg.b.y) < 0.1
      const cx = (seg.a.x + seg.b.x) / 2
      const cy = (seg.a.y + seg.b.y) / 2
      const maxWidth = horizontal ? Math.max(72, Math.min(220, seg.length - 18)) : 132
      const size = c4LabelSize(label, maxWidth)
      if (horizontal) {
        const minX = Math.min(seg.a.x, seg.b.x)
        const maxX = Math.max(seg.a.x, seg.b.x)
        const centerRatios = [0.5, 0.34, 0.66, 0.22, 0.78]
        const verticalOffsets = [[18, 10], [30, 22], [42, 34], [54, 44], [68, 56], [84, 70], [102, 86]]
        const outsideAnchor = seg.b.x < seg.a.x ? seg.b.x - 8 : seg.b.x + 8
        for (const ratio of centerRatios) {
          const centerX = minX + (maxX - minX) * ratio
          for (const [topGap, bottomGap] of verticalOffsets) {
            const centerPenalty = Math.abs(ratio - 0.5) * 120
            const offsetPenalty = bottomGap + topGap * 0.25
            const placements = [
              c4LabelPlacementFromRect({
                left: centerX - size.width / 2 - 6,
                top: seg.a.y - size.height - topGap,
                right: centerX + size.width / 2 + 6,
                bottom: seg.a.y - bottomGap,
              }, label, true, false, size.lines),
              c4LabelPlacementFromRect({
                left: centerX - size.width / 2 - 6,
                top: seg.a.y + bottomGap,
                right: centerX + size.width / 2 + 6,
                bottom: seg.a.y + size.height + topGap,
              }, label, true, false, size.lines),
            ]
            placements.forEach((placement, placementIndex) => {
              if (allowedRegion && !c4RectInside(placement.rect, allowedRegion)) return
              if (forbiddenRects.some((rectValue) => c4RectsIntersect(placement.rect, rectValue))) return
              const clearance = c4MinRectClearanceToSegments(placement.rect, occupiedSegments)
              const candidate = { placement, score: (multiSegmentRoute ? 180 : 0) + centerPenalty + offsetPenalty + placementIndex * 2 + c4LabelClearancePenalty(clearance), segmentIndex: seg.index }
              if (clearance < 0.1) fallbackCandidates.push({ ...candidate, score: candidate.score + 10000 })
              else candidates.push(candidate)
            })
          }
        }
        for (const [topGap, bottomGap] of verticalOffsets) {
          const outsidePenalty = 140 + bottomGap + topGap * 0.25
          const placements = seg.b.x < seg.a.x
            ? [
                c4LabelPlacementFromRect({ left: outsideAnchor - size.width - 8, top: seg.a.y - size.height - topGap, right: outsideAnchor, bottom: seg.a.y - bottomGap }, label, false, true, size.lines),
                c4LabelPlacementFromRect({ left: outsideAnchor - size.width - 8, top: seg.a.y + bottomGap, right: outsideAnchor, bottom: seg.a.y + size.height + topGap }, label, false, true, size.lines),
              ]
            : [
                c4LabelPlacementFromRect({ left: outsideAnchor, top: seg.a.y - size.height - topGap, right: outsideAnchor + size.width + 8, bottom: seg.a.y - bottomGap }, label, false, false, size.lines),
                c4LabelPlacementFromRect({ left: outsideAnchor, top: seg.a.y + bottomGap, right: outsideAnchor + size.width + 8, bottom: seg.a.y + size.height + topGap }, label, false, false, size.lines),
              ]
          placements.forEach((placement, placementIndex) => {
            if (allowedRegion && !c4RectInside(placement.rect, allowedRegion)) return
            if (forbiddenRects.some((rectValue) => c4RectsIntersect(placement.rect, rectValue))) return
            const clearance = c4MinRectClearanceToSegments(placement.rect, occupiedSegments)
            const candidate = { placement, score: (multiSegmentRoute ? 180 : 0) + outsidePenalty + placementIndex * 2 + c4LabelClearancePenalty(clearance), segmentIndex: seg.index }
            if (clearance < 0.1) fallbackCandidates.push({ ...candidate, score: candidate.score + 10000 })
            else candidates.push(candidate)
          })
        }
      } else {
        const minY = Math.min(seg.a.y, seg.b.y)
        const maxY = Math.max(seg.a.y, seg.b.y)
        for (const ratio of [0.5, 0.34, 0.66, 0.42, 0.58]) {
          const centerY = minY + (maxY - minY) * ratio
          for (const [nearGap, farGap] of [[12, 20], [24, 32], [36, 44], [48, 58], [62, 76], [78, 94]]) {
            const centerPenalty = Math.abs(ratio - 0.5) * 120
            const offsetPenalty = nearGap + farGap * 0.15
            const sidePlacements = [
              c4LabelPlacementFromRect({
                left: seg.a.x + nearGap,
                top: centerY - size.height / 2,
                right: seg.a.x + farGap + size.width,
                bottom: centerY + size.height / 2,
              }, label, false, false, size.lines),
              c4LabelPlacementFromRect({
                left: seg.a.x - size.width - farGap,
                top: centerY - size.height / 2,
                right: seg.a.x - nearGap,
                bottom: centerY + size.height / 2,
              }, label, false, true, size.lines),
            ]
            sidePlacements.forEach((placement, sideIndex) => {
              if (allowedRegion && !c4RectInside(placement.rect, allowedRegion)) return
              if (forbiddenRects.some((rectValue) => c4RectsIntersect(placement.rect, rectValue))) return
              const clearance = c4MinRectClearanceToSegments(placement.rect, occupiedSegments)
              const preferredEndAlign = seg.a.x < routeCenterX
              const alignPenalty = placement.alignEnd === preferredEndAlign ? 0 : 260
              const candidate = { placement, score: centerPenalty + offsetPenalty + alignPenalty + c4LabelClearancePenalty(clearance), segmentIndex: seg.index }
              if (clearance < 0.1) fallbackCandidates.push({ ...candidate, score: candidate.score + 10000 })
              else candidates.push(candidate)
            })
          }
        }
        for (const xOffset of [0, -18, 18, -42, 42, -74, 74, -108, 108]) {
          for (const yOffset of [0, -36, 36, -64, 64]) {
            const center = { x: cx + xOffset, y: cy + yOffset }
            const placement = c4LabelPlacementFromCenter(center, label)
            if (allowedRegion && !c4RectInside(placement.rect, allowedRegion)) continue
            if (forbiddenRects.some((rectValue) => c4RectsIntersect(placement.rect, rectValue))) continue
            const clearance = c4MinRectClearanceToSegments(placement.rect, occupiedSegments)
            const candidate = { placement, score: 520 + (Math.abs(xOffset) + Math.abs(yOffset)) * 1.4 + c4LabelClearancePenalty(clearance), segmentIndex: seg.index }
            if (clearance < 0.1) fallbackCandidates.push({ ...candidate, score: candidate.score + 10000 })
            else candidates.push(candidate)
          }
        }
      }
    }
    return candidates.sort((left, right) => left.score - right.score || left.segmentIndex - right.segmentIndex)
  }

  function c4ReservedLaneRectFromLabelRect(rectValue) {
    return c4InflateRect(rectValue, 8, 5)
  }

  function c4SelectLabelCandidate(candidates, occupiedRects) {
    return candidates.find((candidate) => occupiedRects.every((rectValue) => !c4RectsIntersect(candidate.placement.rect, rectValue))) || null
  }

  function c4PreferredVerticalLabelCandidate(item, occupiedRects) {
    if (!item.route || !['down', 'up'].includes(item.rel.direction)) return null
    const points = item.route.points
    if (!points || points.length < 2) return null
    const segment = { a: points[points.length - 2], b: points[points.length - 1] }
    if (Math.abs(segment.a.x - segment.b.x) > 0.1 || Math.abs(segment.a.y - segment.b.y) < 40) return null
    const sourceX = points[0].x
    const targetX = points[points.length - 1].x
    const alignEnd = targetX < sourceX
    const size = c4LabelSize(item.displayLabel, 104)
    const minY = Math.min(segment.a.y, segment.b.y)
    const maxY = Math.max(segment.a.y, segment.b.y)
    for (const ratio of [0.5, 0.42, 0.58, 0.34, 0.66]) {
      const centerY = minY + (maxY - minY) * ratio
      for (const [nearGap, farGap] of [[12, 20], [24, 32], [36, 44], [48, 58], [62, 76], [78, 94]]) {
        const rectValue = alignEnd
          ? { left: segment.a.x - size.width - farGap, top: centerY - size.height / 2 - 6, right: segment.a.x - nearGap, bottom: centerY + size.height / 2 + 6 }
          : { left: segment.a.x + nearGap, top: centerY - size.height / 2 - 6, right: segment.a.x + farGap + size.width, bottom: centerY + size.height / 2 + 6 }
        if (!c4RectInside(rectValue, item.allowedRegion)) continue
        if (occupiedRects.some((occupied) => c4RectsIntersect(rectValue, occupied))) continue
        return { placement: { rect: rectValue, centered: false, alignEnd, lines: size.lines }, score: 0, segmentIndex: points.length - 2 }
      }
    }
    return null
  }

  function polyline(points, color = theme().borderStrong, width = 1.6, arrow = true) {
    if (arrow) return rustPolylineArrowheads(points, color, false, false, true, width)
    const d = points.map((p, index) => `${index ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
    return path(d, color, width, false)
  }

  function renderMermaidSvg(source) {
    const normalizedSource = decodeHtmlEntities(source)
    const diagramType = supportedDiagramType(normalizedSource)
    if (!diagramType) {
      throw new Error(`unsupported Mermaid diagram type: ${detectMermaidDiagramType(normalizedSource) || 'unknown'}`)
    }
    const cacheKey = `${currentThemeMode()}:${normalizedSource}`
    if (stageCache.has(cacheKey)) {
      return stageCache.get(cacheKey)
    }
    const renderers = {
      flowchart: renderFlowchart,
      graph: renderFlowchart,
      classDiagram: renderClassDiagram,
      'classDiagram-v2': renderClassDiagram,
      C4Context: renderC4Component,
      C4Container: renderC4Component,
      C4Component: renderC4Component,
      C4Code: renderC4CodeDiagram,
      'architecture-beta': renderArchitecture,
      erDiagram: renderErDiagram,
      journey: renderJourney,
      gantt: renderGantt,
      pie: renderPie,
      quadrantChart: renderQuadrantChart,
      requirementDiagram: renderRequirementDiagram,
      gitGraph: renderGitGraph,
      mindmap: renderMindmap,
      timeline: renderTimeline,
      zenuml: renderZenuml,
      sequenceDiagram: renderSequenceDiagram,
      stateDiagram: renderStateDiagram,
      'stateDiagram-v2': renderStateDiagram,
      'block-beta': renderBlockDiagram,
      kanban: renderKanban,
      'packet-beta': renderPacket,
      'radar-beta': renderRadar,
      sankey: renderSankey,
      'sankey-beta': renderSankey,
      'treemap-beta': renderTreemap,
      'venn-beta': renderVenn,
      xychart: renderXyChart,
      'xychart-beta': renderXyChart,
    }
    const rendered = renderers[diagramType](normalizedSource)
    stageCache.set(cacheKey, rendered)
    return rendered
  }

  function renderFlowchart(source) {
    const t = theme()
    const F = {
      nodeW: 160,
      nodeBaseH: 40,
      nodeLineH: 16,
      nodeTextSize: 13,
      nodeTextWeight: 600,
      nodeTextWrapW: 132,
      diamondPadding: 24,
      circleMinD: 48,
      circlePadding: 16,
      rootPadX: 48,
      rootPadY: 36,
      cellGapX: 56,
      cellGapY: 72,
      nodeRx: 6,
      roundedRx: 18,
      portPitch: 20,
    }
    const first = linesOf(source)[0] || 'flowchart TD'
    const direction = first.split(/\s+/)[1] || 'TD'
    const horizontal = direction === 'LR' || direction === 'RL'
    const rows = linesOf(source).slice(1)
    const nodes = new Map()
    const nodeOrder = []
    const edges = []
    const subgraphs = new Map()
    const subgraphStack = []
    const nodeLabel = (id, label = id, shape = 'rect', parent = subgraphStack[subgraphStack.length - 1] || null) => {
      if (!nodes.has(id)) {
        nodes.set(id, { id, label: label == null ? String(id) : String(label), shape, parent })
        nodeOrder.push(id)
      }
      else {
        const current = nodes.get(id)
        if (label != null && label !== id) current.label = String(label)
        if (shape && shape !== 'rect') current.shape = shape
        if (parent && !current.parent) current.parent = parent
      }
    }
    const readNode = (raw) => {
      const value = raw.trim()
      const patterns = [
        [/^([A-Za-z0-9_-]+)\(\((.*)\)\)$/, 'circle'],
        [/^([A-Za-z0-9_-]+)\(\[(.*)\]\)$/, 'stadium'],
        [/^([A-Za-z0-9_-]+)\[\[(.*)\]\]$/, 'subroutine'],
        [/^([A-Za-z0-9_-]+)\[\((.*)\)\]$/, 'cylinder'],
        [/^([A-Za-z0-9_-]+)\{\{(.*)\}\}$/, 'hexagon'],
        [/^([A-Za-z0-9_-]+)\[\/(.*)\\\]$/, 'trapezoid'],
        [/^([A-Za-z0-9_-]+)\[\\(.*)\/\]$/, 'trapezoidInv'],
        [/^([A-Za-z0-9_-]+)\[\/(.*)\/\]$/, 'parallelogramRight'],
        [/^([A-Za-z0-9_-]+)\[\\(.*)\\\]$/, 'parallelogramLeft'],
        [/^([A-Za-z0-9_-]+)>(.*)\]$/, 'asymmetric'],
        [/^([A-Za-z0-9_-]+)\{(.*)\}$/, 'diamond'],
        [/^([A-Za-z0-9_-]+)\((.*)\)$/, 'rounded'],
        [/^([A-Za-z0-9_-]+)\[(.*)\]$/, 'rect'],
        [/^([A-Za-z0-9_-]+)$/, 'rect'],
      ]
      for (const [pattern, shape] of patterns) {
        const match = value.match(pattern)
        if (match) return { id: match[1], label: match[2] == null ? match[1] : rustStripQuotes(match[2]), shape }
      }
      const openTokens = ['((', '([', '[[', '[(', '{{', '[/', '[\\', '>', '{', '(', '[']
      for (const open of openTokens) {
        const pos = value.indexOf(open)
        if (pos >= 0) {
          const id = value.slice(0, pos).trim()
          if (id) return { id, label: id, shape: 'rect' }
        }
      }
      return { id: value, label: value, shape: 'rect' }
    }
    const isFlowchartEdgeStart = (token) => {
      const value = token.trim()
      return value.startsWith('-->')
        || value.startsWith('---')
        || value.startsWith('-.')
        || value.startsWith('==>')
        || value.startsWith('===')
        || value.startsWith('==')
        || value.startsWith('<-->')
        || value.startsWith('<---')
        || value.startsWith('--')
    }
    const tokenizeFlowchartLine = (row) => {
      const tokens = []
      let current = ''
      let depth = 0
      const chars = Array.from(row)
      for (let index = 0; index < chars.length; index += 1) {
        const ch = chars[index]
        if (ch === '(' || ch === '[' || ch === '{') {
          depth += 1
          current += ch
        } else if (ch === ')' || ch === ']' || ch === '}') {
          depth = Math.max(0, depth - 1)
          current += ch
          if (depth === 0) {
            const next = chars[index + 1]
            if (next === ')' || next === ']' || next === '}') continue
            const trimmed = current.trim()
            if (trimmed) tokens.push(trimmed)
            current = ''
          }
        } else if (/\s/.test(ch) && depth === 0) {
          const trimmed = current.trim()
          if (trimmed) tokens.push(trimmed)
          current = ''
        } else {
          current += ch
        }
      }
      const trimmed = current.trim()
      if (trimmed) tokens.push(trimmed)
      return tokens
    }
    const parseFlowchartEdgeSegment = (raw) => {
      const value = raw.trim()
      if (value.startsWith('==')) {
        const rest = value.slice(2)
        if (rest.startsWith('>')) return { style: 'thick', startArrow: false, endArrow: true, label: '' }
        if (rest === '=') return { style: 'thick', startArrow: false, endArrow: false, label: '' }
        let labelEnd = rest.indexOf('==>')
        if (labelEnd >= 0) return { style: 'thick', startArrow: false, endArrow: true, label: rawMermaidText(rest.slice(0, labelEnd)) }
        labelEnd = rest.indexOf('===')
        if (labelEnd >= 0) return { style: 'thick', startArrow: false, endArrow: false, label: rawMermaidText(rest.slice(0, labelEnd)) }
        return { style: 'thick', startArrow: false, endArrow: false, label: '' }
      }
      if (value === '-.->' || value === '-.-' || value === '-.' || value === '.->') {
        return { style: 'dotted', startArrow: false, endArrow: value.endsWith('>'), label: '' }
      }
      if (value.startsWith('-.')) {
        const rest = value.slice(2)
        let labelEnd = rest.indexOf('.->')
        if (labelEnd >= 0) return { style: 'dotted', startArrow: false, endArrow: true, label: rawMermaidText(rest.slice(0, labelEnd)) }
        labelEnd = rest.indexOf('.-')
        if (labelEnd >= 0) return { style: 'dotted', startArrow: false, endArrow: false, label: rawMermaidText(rest.slice(0, labelEnd)) }
        if (rest.endsWith('>')) return { style: 'dotted', startArrow: false, endArrow: true, label: rawMermaidText(rest.replace(/[.>]+$/g, '')) }
      }
      if (value.startsWith('<--')) {
        return { style: 'solid', startArrow: true, endArrow: value.slice(3) === '>', label: '' }
      }
      if (value === '<-->') return { style: 'solid', startArrow: true, endArrow: true, label: '' }
      if (value.startsWith('--')) {
        const rest = value.slice(2)
        if (rest === '>') return { style: 'solid', startArrow: false, endArrow: true, label: '' }
        if (rest === '-') return { style: 'solid', startArrow: false, endArrow: false, label: '' }
        if (rest.startsWith('>|')) {
          const pipeEnd = rest.slice(2).indexOf('|')
          if (pipeEnd >= 0) return { style: 'solid', startArrow: false, endArrow: true, label: rawMermaidText(rest.slice(2, 2 + pipeEnd)) }
        }
        if (rest.startsWith('>') && rest.length > 1) {
          const label = rawMermaidText(rest.slice(1).replace(/-->\s*$/g, ''))
          if (label) return { style: 'solid', startArrow: false, endArrow: true, label }
        }
        if (rest.startsWith('|')) {
          const pipeEnd = rest.slice(1).indexOf('|')
          if (pipeEnd >= 0) {
            const after = rest.slice(2 + pipeEnd).trim()
            return { style: 'solid', startArrow: false, endArrow: after.includes('>'), label: rawMermaidText(rest.slice(1, 1 + pipeEnd)) }
          }
        }
        let labelEnd = rest.indexOf('-->')
        if (labelEnd >= 0) return { style: 'solid', startArrow: false, endArrow: true, label: rawMermaidText(rest.slice(0, labelEnd)) }
        labelEnd = rest.indexOf('---')
        if (labelEnd >= 0) return { style: 'solid', startArrow: false, endArrow: false, label: rawMermaidText(rest.slice(0, labelEnd)) }
        return { style: 'solid', startArrow: false, endArrow: false, label: '' }
      }
      if (value === '-->') return { style: 'solid', startArrow: false, endArrow: true, label: '' }
      if (value === '---') return { style: 'solid', startArrow: false, endArrow: false, label: '' }
      return null
    }
    const parseFlowchartConnection = (row) => {
      const spacedLabel = row.match(/^(.+?)\s+(-\.|--|==)\s+(.+?)\s+(\.-|\.->|---|-->|===|==>)\s+(.+)$/)
      if (spacedLabel) {
        const from = readNode(spacedLabel[1])
        const to = readNode(spacedLabel[5])
        const edge = parseFlowchartEdgeSegment(`${spacedLabel[2]}${spacedLabel[3]}${spacedLabel[4]}`)
          || { style: spacedLabel[2] === '-.' ? 'dotted' : spacedLabel[2] === '==' ? 'thick' : 'solid', startArrow: false, endArrow: spacedLabel[4].includes('>'), label: rawMermaidText(spacedLabel[3]) }
        return [{ from, to, ...edge }]
      }
      const tokens = tokenizeFlowchartLine(row)
      const parsed = []
      let cursor = 0
      let lastNode = null
      while (cursor < tokens.length) {
        const token = tokens[cursor]
        if (isFlowchartEdgeStart(token)) {
          const edge = parseFlowchartEdgeSegment(token)
          if (edge && lastNode) {
            cursor += 1
            if (cursor < tokens.length) {
              let label = edge.label
              if (/^\|.+\|$/.test(tokens[cursor])) {
                label = rawMermaidText(tokens[cursor].slice(1, -1))
                cursor += 1
              }
              if (cursor < tokens.length) {
                const to = readNode(tokens[cursor])
                parsed.push({ from: lastNode, to, ...edge, label })
                lastNode = to
              }
            }
          }
        } else if (token !== '&') {
          lastNode = readNode(token)
        }
        cursor += 1
      }
      if (parsed.length) return parsed

      const compact = row.match(/^(.+?)(<-->|<---|-->|---|-.->|-.-|==>|===)(?:\|(.+?)\|)?(.+)$/)
      if (!compact) return []
      const from = readNode(compact[1])
      const to = readNode(compact[4])
      const edge = parseFlowchartEdgeSegment(compact[2]) || { style: 'solid', startArrow: false, endArrow: compact[2].includes('>'), label: '' }
      return [{ from, to, ...edge, label: rawMermaidText(compact[3] || edge.label || '') }]
    }
    for (const row of rows) {
      if (/^direction\s+/i.test(row)) {
        const parent = subgraphStack[subgraphStack.length - 1]
        if (parent && subgraphs.has(parent)) subgraphs.get(parent).direction = row.replace(/^direction\s+/i, '').trim()
        continue
      }
      if (row === 'end') {
        subgraphStack.pop()
        continue
      }
      if (/^subgraph\s+/i.test(row)) {
        const rest = row.replace(/^subgraph\s+/i, '').trim()
        const bracketStart = rest.indexOf('[')
        const bracketEnd = rest.lastIndexOf(']')
        const hasBracket = bracketStart >= 0 && bracketEnd > bracketStart
        const spaced = !hasBracket ? rest.split(/\s+(.+)/) : null
        const id = hasBracket ? rest.slice(0, bracketStart).trim() : spaced && spaced[1] ? spaced[0] : rest
        const label = hasBracket ? rawMermaidText(rest.slice(bracketStart + 1, bracketEnd)) : spaced && spaced[1] ? rawMermaidText(spaced[1]) : rawMermaidText(id)
        const parent = subgraphStack[subgraphStack.length - 1] || null
        if (!subgraphs.has(id)) {
          nodeOrder.push(id)
          subgraphs.set(id, { id, label, parent, children: [], direction: null })
        } else {
          Object.assign(subgraphs.get(id), { label, parent })
        }
        if (!nodes.has(id)) nodes.set(id, { id, label: '', shape: 'rect', parent })
        subgraphStack.push(id)
        continue
      }
      if (/^(style|class|click|classDef|linkStyle)\s+/i.test(row)) continue
      const parsedEdges = parseFlowchartConnection(row)
      if (parsedEdges.length) {
        parsedEdges.forEach((edge) => {
          nodeLabel(edge.from.id, edge.from.label, edge.from.shape)
          nodeLabel(edge.to.id, edge.to.label, edge.to.shape)
          edges.push({
            from: edge.from.id,
            to: edge.to.id,
            label: edge.label,
            style: edge.style || 'solid',
            startArrow: Boolean(edge.startArrow),
            endArrow: edge.endArrow !== false,
          })
        })
        continue
      }
      const lone = readNode(row)
      nodeLabel(lone.id, lone.label, lone.shape)
    }
    subgraphs.forEach((sg) => { sg.children = [] })
    const rootChildren = []
    for (const id of nodeOrder) {
      if (subgraphs.has(id)) {
        const parent = subgraphs.get(id).parent
        if (parent && subgraphs.has(parent)) subgraphs.get(parent).children.push(id)
        else if (!rootChildren.includes(id)) rootChildren.push(id)
      } else if (nodes.has(id)) {
        const parent = nodes.get(id).parent
        if (parent && subgraphs.has(parent)) subgraphs.get(parent).children.push(id)
        else if (!rootChildren.includes(id)) rootChildren.push(id)
      }
    }
    const ids = nodeOrder.filter((id) => nodes.has(id) || subgraphs.has(id))
    const flowchartWrapLines = (value, wrapW = F.nodeTextWrapW, size = F.nodeTextSize) => {
      return c4WrapText(value, wrapW, size, 600)
    }
    const estimateFlowTextWidth = (value, size = F.nodeTextSize, weight = F.nodeTextWeight) => c4EstimateTextWidth(value, size, weight)
    const measureFlowchartNode = (node) => {
      const lines = flowchartWrapLines(node.label)
      const textHeight = Math.max(1, lines.length) * F.nodeLineH
      if (node.shape === 'diamond') {
        const innerH = F.nodeBaseH + Math.max(0, lines.length - 1) * F.nodeLineH
        const diag = Math.max(F.nodeW, innerH) + F.diamondPadding * 2
        return { w: diag, h: diag }
      }
      if (node.shape === 'circle') {
        const d = Math.max(estimateFlowTextWidth(node.label) + F.circlePadding * 2, textHeight + F.circlePadding * 2, F.circleMinD)
        return { w: d, h: d }
      }
      if (node.shape === 'hexagon' || node.shape === 'parallelogramRight' || node.shape === 'parallelogramLeft' || node.shape === 'trapezoid' || node.shape === 'trapezoidInv') {
        return { w: F.nodeW + 20, h: F.nodeBaseH + Math.max(0, lines.length - 1) * F.nodeLineH }
      }
      if (node.shape === 'cylinder') return { w: F.nodeW, h: F.nodeBaseH + 12 + Math.max(0, lines.length - 1) * F.nodeLineH }
      return { w: F.nodeW, h: F.nodeBaseH + Math.max(0, lines.length - 1) * F.nodeLineH }
    }
    const parentOf = (id) => nodes.get(id)?.parent || subgraphs.get(id)?.parent || null
    const immediateChildFor = (container, nodeId) => {
      let current = nodeId
      while (current && (nodes.has(current) || subgraphs.has(current))) {
        const parent = parentOf(current)
        if (parent === container) return current
        current = parent
      }
      return null
    }
    const collectFlowchartLayoutInputs = (container, childIds, dir = direction) => {
      const rankConstraints = []
      const orderConstraints = []
      const relations = []
      edges.forEach((edge) => {
        const from = immediateChildFor(container, edge.from)
        const to = immediateChildFor(container, edge.to)
        if (!from || !to || from === to || !childIds.includes(from) || !childIds.includes(to)) return
        pushUniqueAcyclicConstraint(rankConstraints, from, to)
        if (!relations.some((relation) => relation.from === from && relation.to === to)) relations.push({ from, to, weight: 1 })
      })
      if (!rankConstraints.length && childIds.length > 1) {
        const localHorizontal = dir === 'LR' || dir === 'RL'
        childIds.slice(1).forEach((id, index) => pushUniqueConstraint(localHorizontal ? rankConstraints : orderConstraints, childIds[index], id))
      }
      return { rankConstraints, orderConstraints, relations }
    }
    const measureFlowchartItem = (id, dir = direction) => {
      if (!subgraphs.has(id)) return measureFlowchartNode(nodes.get(id) || { label: id, shape: 'rect' })
      const sg = subgraphs.get(id)
      const grid = buildFlowchartGrid(id, sg.direction || dir)
      const innerW = Math.max(grid.width, 200 - 24 * 2)
      const innerH = Math.max(grid.height, 60)
      return { w: innerW + 24 * 2, h: 48 + innerH + 24, headerH: 40 }
    }
    function buildFlowchartGrid(container, dir = direction) {
      const childIds = container ? (subgraphs.get(container)?.children || []) : rootChildren
      if (!childIds.length) return { width: 0, height: 0, positions: new Map() }
      const itemSizes = new Map(childIds.map((id) => [id, measureFlowchartItem(id, dir)]))
      const { rankConstraints, orderConstraints, relations } = collectFlowchartLayoutInputs(container, childIds, dir)
      if (dir === 'LR' || dir === 'RL') {
        const rankMap = solveRankConstraints(childIds, rankConstraints)
        const orderMap = solveRankConstraints(childIds, orderConstraints)
        const rows = groupRowsByRank(childIds, rankMap, orderMap)
        optimizeRowOrder(rows, orderMap, relations, 4)
        const rowKeys = [...rows.keys()].sort((a, b) => a - b)
        const maxColHeight = Math.max(0, ...[...rows.values()].map((row) => (
          row.reduce((sum, id) => sum + (itemSizes.get(id)?.h || 0), 0) + Math.max(0, row.length - 1) * F.cellGapX
        )))
        const positions = new Map()
        let xOffset = 0
        rowKeys.forEach((rank, rowIndex) => {
          const row = rows.get(rank)
          const colWidth = Math.max(0, ...row.map((id) => itemSizes.get(id)?.w || 0))
          const colHeight = row.reduce((sum, id) => sum + (itemSizes.get(id)?.h || 0), 0) + Math.max(0, row.length - 1) * F.cellGapX
          let yOffset = Math.max(0, (maxColHeight - colHeight) / 2)
          row.forEach((id, index) => {
            const size = itemSizes.get(id) || { w: 0, h: 0 }
            positions.set(id, {
              x: xOffset + Math.max(0, (colWidth - size.w) / 2),
              y: yOffset,
              w: size.w,
              h: size.h,
            })
            yOffset += size.h
            if (index + 1 < row.length) yOffset += F.cellGapX
          })
          xOffset += colWidth
          if (rowIndex + 1 < rowKeys.length) xOffset += F.cellGapY
        })
        const totalW = Math.max(0, xOffset)
        const totalH = Math.max(0, maxColHeight)
        const swappedPositions = new Map()
        positions.forEach((p, id) => swappedPositions.set(id, { x: p.y, y: p.x, w: p.h, h: p.w }))
        const heightAsWidth = new Map(childIds.map((id) => [id, { w: itemSizes.get(id)?.h || 0, h: itemSizes.get(id)?.w || 0 }]))
        relaxRowPositions(rows, swappedPositions, heightAsWidth, totalH, relations, {
          gapX: F.cellGapX,
          iterations: 6,
          blend: 0.6,
          maxShiftX: 96,
        })
        swappedPositions.forEach((p, id) => {
          const size = itemSizes.get(id) || { w: 0, h: 0 }
          positions.set(id, { x: p.y, y: p.x, w: size.w, h: size.h })
        })
        return { width: totalW, height: totalH, positions }
      }
      const grid = buildLayeredLayout({
        ids: childIds,
        sizes: itemSizes,
        relations,
        rankConstraints,
        orderConstraints,
        gapX: F.cellGapX,
        gapY: F.cellGapY,
      })
      return { width: grid.width, height: grid.height, positions: grid.positions }
    }
    const rootGrid = buildFlowchartGrid(null, direction)
    const padX = F.rootPadX
    const padY = F.rootPadY
    const positions = new Map()
    const layoutFlowchartItem = (id, x, y, dir = direction) => {
      const measured = measureFlowchartItem(id, dir)
      positions.set(id, { x, y, w: measured.w, h: measured.h, headerH: measured.headerH || 0 })
      if (!subgraphs.has(id)) return
      const sg = subgraphs.get(id)
      const subDir = sg.direction || dir
      const grid = buildFlowchartGrid(id, subDir)
      const innerW = Math.max(grid.width, 200 - 24 * 2)
      const innerH = Math.max(grid.height, 60)
      const originX = x + 24 + Math.max(0, innerW - grid.width) / 2
      const originY = y + 48 + Math.max(0, innerH - grid.height) / 2
      for (const childId of sg.children) {
        const child = grid.positions.get(childId)
        if (child) layoutFlowchartItem(childId, originX + child.x, originY + child.y, subDir)
      }
    }
    for (const rootId of rootChildren) {
      const p = rootGrid.positions.get(rootId)
      if (p) layoutFlowchartItem(rootId, padX + p.x, padY + p.y, direction)
    }
    const rowGroups = new Map()
    positions.forEach((box, id) => {
      if (subgraphs.has(id)) return
      const key = horizontal ? Math.round(box.x / 4) : Math.round(box.y / 4)
      if (!rowGroups.has(key)) rowGroups.set(key, [])
      rowGroups.get(key).push(id)
    })
    rowGroups.forEach((row) => {
      if (row.length < 2) return
      row.sort((a, b) => {
        const pa = positions.get(a)
        const pb = positions.get(b)
        return horizontal ? pa.y - pb.y || a.localeCompare(b) : pa.x - pb.x || a.localeCompare(b)
      })
      const neighborCenters = []
      edges.forEach((edge) => {
        const fromInRow = row.includes(edge.from)
        const toInRow = row.includes(edge.to)
        if (fromInRow === toInRow) return
        const other = positions.get(fromInRow ? edge.to : edge.from)
        if (!other) return
        neighborCenters.push(horizontal ? other.y + other.h / 2 : other.x + other.w / 2)
      })
      if (!neighborCenters.length) return
      const targetCenter = neighborCenters.reduce((sum, value) => sum + value, 0) / neighborCenters.length
      const rowBoxes = row.map((id) => positions.get(id)).filter(Boolean)
      const rowStart = Math.min(...rowBoxes.map((box) => horizontal ? box.y : box.x))
      const rowEnd = Math.max(...rowBoxes.map((box) => horizontal ? box.y + box.h : box.x + box.w))
      const delta = targetCenter - (rowStart + rowEnd) / 2
      row.forEach((id) => {
        const box = positions.get(id)
        if (!box) return
        if (horizontal) box.y += delta
        else box.x += delta
      })
    })
    const minX = Math.min(...[...positions.values()].map((p) => p.x), padX)
    const minY = Math.min(...[...positions.values()].map((p) => p.y), padY)
    if (minX < padX || minY < padY) {
      const dx = Math.max(0, padX - minX)
      const dy = Math.max(0, padY - minY)
      positions.forEach((p) => {
        p.x += dx
        p.y += dy
      })
    }
    const width = Math.max(300, rootGrid.width + padX * 2)
    const height = Math.max(200, rootGrid.height + padY * 2)
    const sourcePortOffsets = new Map()
    const targetPortOffsets = new Map()
    const sourceGroups = new Map()
    const targetGroups = new Map()
    const edgeSides = edges.map((edge) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      return from && to ? flowchartSideForBoxes(from, to, direction) : null
    })
    edges.forEach((edge, edgeIndex) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (!from || !to) return
      const sides = edgeSides[edgeIndex]
      if (!sides) return
      const [fromSide, toSide] = sides
      const sourceKey = `${edge.from}:${fromSide}`
      const targetKey = `${edge.to}:${toSide}`
      if (!sourceGroups.has(sourceKey)) sourceGroups.set(sourceKey, [])
      sourceGroups.get(sourceKey).push({
        edgeIndex,
        side: fromSide,
        axis: fromSide === 'top' || fromSide === 'bottom' ? to.x + to.w / 2 : to.y + to.h / 2,
        box: from,
      })
      if (!targetGroups.has(targetKey)) targetGroups.set(targetKey, [])
      targetGroups.get(targetKey).push({
        edgeIndex,
        side: toSide,
        axis: toSide === 'top' || toSide === 'bottom' ? from.x + from.w / 2 : from.y + from.h / 2,
        box: to,
      })
    })
    const assignFlowchartOffsets = (groups, offsets) => {
      groups.forEach((items) => {
        if (items.length <= 1) {
          items.forEach((item) => offsets.set(item.edgeIndex, 0))
          return
        }
        items.sort((left, right) => left.axis - right.axis || left.edgeIndex - right.edgeIndex)
        const side = items[0].side
        const maxSpread = side === 'top' || side === 'bottom'
          ? Math.max(0, items[0].box.w / 2 - 12)
          : Math.max(0, items[0].box.h / 2 - 8)
        const pitch = Math.min(F.portPitch, maxSpread * 2 / Math.max(1, items.length - 1))
        const startOffset = -(pitch * (items.length - 1)) / 2
        items.forEach((item, index) => offsets.set(item.edgeIndex, startOffset + pitch * index))
      })
    }
    assignFlowchartOffsets(sourceGroups, sourcePortOffsets)
    assignFlowchartOffsets(targetGroups, targetPortOffsets)
    const edgeMarkup = edges.map((edge) => {
      const a = positions.get(edge.from)
      const b = positions.get(edge.to)
      if (!a || !b) return ''
      const edgeIndex = edges.indexOf(edge)
      const fromOffset = sourcePortOffsets.get(edgeIndex) || 0
      const toOffset = targetPortOffsets.get(edgeIndex) || 0
      const sides = edgeSides[edgeIndex] || flowchartSideForBoxes(a, b, direction)
      const shiftBoxForSide = (box, side, offset) => side === 'top' || side === 'bottom' ? { ...box, x: box.x + offset } : { ...box, y: box.y + offset }
      const routedA = { ...shiftBoxForSide(a, sides[0], fromOffset), flowSides: sides }
      const routedB = shiftBoxForSide(b, sides[1], toOffset)
      const route = routeFlowchartEdge(routedA, routedB, horizontal, fromOffset, toOffset)
      const mid = route[Math.floor(route.length / 2)]
      const labelMarkup = edge.label
        ? (() => {
            const labelW = c4EstimateTextWidth(edge.label, 11, 500) + 10
            const labelH = 18
            const labelY = mid.y - labelH - 14
            return `${rect(mid.x - labelW / 2, labelY, labelW, labelH, 4, t.surface, t.border)}${text(mid.x, labelY + labelH / 2, edge.label, 11, 500, t.muted)}`
        })()
        : ''
      const dashed = edge.style === 'dotted'
      return `<g data-flowchart-edge="${dataAttr(`${edge.from}->${edge.to}`)}">${rustPolylineArrowheads(route, t.link, dashed, edge.startArrow, edge.endArrow, 2)}${labelMarkup}</g>`
    }).join('')
    const renderFlowchartNodeShape = (id, node, p) => {
      const cx = p.x + p.w / 2
      const cy = p.y + p.h / 2
      if (node.shape === 'diamond') {
        const d = `M ${cx.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${cy.toFixed(1)} L ${cx.toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${p.x.toFixed(1)} ${cy.toFixed(1)} Z`
        return path(d, t.border, 1.5, false, t.surface)
      }
      if (node.shape === 'hexagon') {
        const inset = 16
        const d = `M ${(p.x + inset).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w - inset).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${cy.toFixed(1)} L ${(p.x + p.w - inset).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${(p.x + inset).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${p.x.toFixed(1)} ${cy.toFixed(1)} Z`
        return path(d, t.border, 1.5, false, t.surface)
      }
      if (node.shape === 'circle') return circle(cx, cy, Math.min(p.w, p.h) / 2, t.surface, t.border)
      if (node.shape === 'cylinder') {
        const ry = 6
        const d = `M ${p.x.toFixed(1)} ${(p.y + ry).toFixed(1)} A ${(p.w / 2).toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${(p.x + p.w).toFixed(1)} ${(p.y + ry).toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${(p.y + p.h - ry).toFixed(1)} A ${(p.w / 2).toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${p.x.toFixed(1)} ${(p.y + p.h - ry).toFixed(1)} L ${p.x.toFixed(1)} ${(p.y + ry).toFixed(1)} A ${(p.w / 2).toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${(p.x + p.w).toFixed(1)} ${(p.y + ry).toFixed(1)} Z`
        return `${path(d, t.border, 1.5, false, t.surface)}<ellipse cx="${cx.toFixed(1)}" cy="${(p.y + ry).toFixed(1)}" rx="${(p.w / 2).toFixed(1)}" ry="${ry.toFixed(1)}" fill="${t.surface}" stroke="${t.border}" stroke-width="1.5"/>`
      }
      if (node.shape === 'asymmetric') return path(`M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${p.x.toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${(p.x + 12).toFixed(1)} ${cy.toFixed(1)} Z`, t.border, 1.5, false, t.surface)
      if (node.shape === 'parallelogramRight') return path(`M ${(p.x + 14).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w - 14).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${p.x.toFixed(1)} ${(p.y + p.h).toFixed(1)} Z`, t.border, 1.5, false, t.surface)
      if (node.shape === 'parallelogramLeft') return path(`M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w - 14).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${(p.x + 14).toFixed(1)} ${(p.y + p.h).toFixed(1)} Z`, t.border, 1.5, false, t.surface)
      if (node.shape === 'trapezoid') return path(`M ${(p.x + 16).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w - 16).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${p.x.toFixed(1)} ${(p.y + p.h).toFixed(1)} Z`, t.border, 1.5, false, t.surface)
      if (node.shape === 'trapezoidInv') return path(`M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w).toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + p.w - 16).toFixed(1)} ${(p.y + p.h).toFixed(1)} L ${(p.x + 16).toFixed(1)} ${(p.y + p.h).toFixed(1)} Z`, t.border, 1.5, false, t.surface)
      if (node.shape === 'subroutine') return `${rect(p.x, p.y, p.w, p.h, 9, t.surface, t.border)}${line(p.x + 10, p.y, p.x + 10, p.y + p.h, t.border)}${line(p.x + p.w - 10, p.y, p.x + p.w - 10, p.y + p.h, t.border)}`
      if (node.shape === 'stadium') return rect(p.x, p.y, p.w, p.h, p.h / 2, t.surface, t.border)
      if (node.shape === 'rounded') return rect(p.x, p.y, p.w, p.h, 16, t.surface, t.border)
      return rect(p.x, p.y, p.w, p.h, 9, t.surface, t.border)
    }
    const renderFlowchartItem = (id) => {
      const p = positions.get(id)
      if (!p) return ''
      if (subgraphs.has(id)) {
        const sg = subgraphs.get(id)
        const header = sg.label ? `${text(p.x + 16, p.y + 26, sg.label, 14, 700, t.text, 'start')}${line(p.x + 12, p.y + 40, p.x + p.w - 12, p.y + 40, t.grid)}` : ''
        const children = sg.children.map((childId) => renderFlowchartItem(childId)).join('')
        return `<g data-flowchart-subgraph="${attr(id)}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="12" fill="${t.surfaceAlt}" stroke="${t.border}" stroke-width="1.5" stroke-dasharray="8 4"/>${header}${children}</g>`
      }
      const node = nodes.get(id)
      if (!node) return ''
      const labelLines = flowchartWrapLines(node.label)
      const totalTextH = labelLines.length * F.nodeLineH
      const firstY = p.y + p.h / 2 - totalTextH / 2 + F.nodeTextSize
      const labelMarkup = labelLines.map((lineValue, index) => text(p.x + p.w / 2, firstY + index * F.nodeLineH, lineValue, F.nodeTextSize, F.nodeTextWeight, t.text)).join('')
      return `<g data-flowchart-node="${attr(id)}">${renderFlowchartNodeShape(id, node, p)}${labelMarkup}</g>`
    }
    const nodeMarkup = rootChildren.map((id) => renderFlowchartItem(id)).join('')
    return rustSvg(width, height, `${nodeMarkup}${edgeMarkup}`, 'Flowchart')
  }

  const C4 = {
    rootPadX: 72,
    rootPadY: 46,
    containerPadX: 24,
    containerPadY: 22,
    containerHeaderH: 62,
    rowGap: 116,
    colGap: 30,
    minInlineRelGap: 56,
    maxInlineRelGap: 208,
    inlineRelCongestionStep: 18,
    rowLanePitch: 34,
    minRowLaneH: 40,
    maxRowLaneH: 128,
    inlineLabelWrapW: 156,
    maxRelaxShiftX: 112,
    nodeTextX: 56,
    nodeTextRightMargin: 12,
  }

  function isC4Boundary(node) {
    return node?.kind === 'EnterpriseBoundary' || node?.kind === 'SystemBoundary' || node?.kind === 'ContainerBoundary'
  }

  function isC4DataStore(node) {
    return /Db$/.test(node?.kind || '')
  }

  function isC4Person(node) {
    return node?.kind === 'Person'
  }

  function c4LeafCardWidth(node) {
    return isC4Boundary(node) ? 0 : 240
  }

  function c4NodeBadge(node) {
    if (node.kind === 'Person') return 'Person'
    if (node.kind === 'System') return 'System'
    if (node.kind === 'SystemDb') return 'SystemDb'
    if (node.kind === 'Container') return 'Container'
    if (node.kind === 'ContainerDb') return 'ContainerDb'
    if (node.kind === 'Component') return 'Component'
    if (node.kind === 'ComponentDb') return 'ComponentDb'
    if (node.kind === 'EnterpriseBoundary') return 'Enterprise'
    if (node.kind === 'SystemBoundary') return 'System Boundary'
    if (node.kind === 'ContainerBoundary') return 'Container Boundary'
    return 'Component'
  }

  function c4NodeWeight(node) {
    if (node.external) return 0
    if (isC4Person(node)) return 1
    if (isC4DataStore(node)) return 3
    return 2
  }

  function parseC4NodeKind(name) {
    const external = name.endsWith('_Ext')
    const base = external ? name.slice(0, -'_Ext'.length) : name
    const kindMap = {
      Person: 'Person',
      System: 'System',
      SystemDb: 'SystemDb',
      Container: 'Container',
      ContainerDb: 'ContainerDb',
      Component: 'Component',
      ComponentDb: 'ComponentDb',
    }
    return kindMap[base] ? { kind: kindMap[base], external } : null
  }

  function parseC4BoundaryKind(name) {
    const base = name.replace(/\s*\{$/, '')
    if (base === 'Enterprise_Boundary') return 'EnterpriseBoundary'
    if (base === 'System_Boundary') return 'SystemBoundary'
    if (base === 'Container_Boundary') return 'ContainerBoundary'
    return null
  }

  function parseC4RelationDirection(name) {
    if (name === 'Rel_U') return 'up'
    if (name === 'Rel_D') return 'down'
    if (name === 'Rel_L') return 'left'
    if (name === 'Rel_R') return 'right'
    if (name === 'Rel') return null
    return null
  }

  function c4RelationTag(direction) {
    if (direction === 'up') return 'Rel_U'
    if (direction === 'down') return 'Rel_D'
    if (direction === 'left') return 'Rel_L'
    if (direction === 'right') return 'Rel_R'
    return 'Rel'
  }

  function parseC4Model(source) {
    const diagramType = detectMermaidDiagramType(source)
    let title = diagramType === 'C4Container' ? 'C4 Container' : diagramType === 'C4Component' ? 'C4 Component' : 'C4 Context'
    const nodes = new Map()
    const nodeOrder = []
    const relations = []
    const boundaryStack = []
    for (const row of linesOf(source).slice(1)) {
      if (row === '}') {
        boundaryStack.pop()
        continue
      }
      if (row.startsWith('title ')) {
        title = row.slice('title '.length).trim()
        continue
      }
      const callName = row.split('(', 1)[0].trim().replace(/\s*\{$/, '')
      const boundaryKind = parseC4BoundaryKind(callName)
      if (boundaryKind) {
        const args = parseCallArgs(row)
        if (args.length >= 2) {
          const id = args[0]
          if (!nodes.has(id)) nodeOrder.push(id)
          nodes.set(id, {
            id,
            label: args[1],
            detail: '',
            technology: '',
            parent: boundaryStack[boundaryStack.length - 1] || null,
            external: false,
            kind: boundaryKind,
            children: [],
          })
          boundaryStack.push(id)
        }
        continue
      }
      const nodeKind = parseC4NodeKind(callName)
      if (nodeKind) {
        const args = parseCallArgs(row)
        if (args.length >= 3) {
          const id = args[0]
          if (!nodes.has(id)) nodeOrder.push(id)
          nodes.set(id, {
            id,
            label: args[1],
            technology: args.length >= 4 ? args[2] || '' : '',
            detail: args.length >= 4 ? args[3] || '' : args[2] || '',
            parent: boundaryStack[boundaryStack.length - 1] || null,
            external: nodeKind.external,
            kind: nodeKind.kind,
            children: [],
          })
        }
        continue
      }
      if (['Rel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R'].includes(callName)) {
        const args = parseCallArgs(row)
        if (args.length >= 3) {
          const direction = parseC4RelationDirection(callName)
          relations.push({
            from: args[0],
            to: args[1],
            label: args[2],
            technology: args[3] || '',
            direction,
            tag: c4RelationTag(direction),
          })
        }
      }
    }
    nodeOrder.forEach((id) => {
      const node = nodes.get(id)
      if (node?.parent && nodes.has(node.parent)) nodes.get(node.parent).children.push(id)
    })
    const rootChildren = nodeOrder.filter((id) => !nodes.get(id)?.parent)
    return { title, nodes, nodeOrder, rootChildren, relations }
  }

  function c4Children(parent, model) {
    return parent ? model.nodes.get(parent)?.children || [] : model.rootChildren
  }

  function c4ParentOf(id, model) {
    return model.nodes.get(id)?.parent || null
  }

  function c4ImmediateChildFor(nodeId, parent, model) {
    let current = nodeId
    while (current && model.nodes.has(current)) {
      const nodeParent = c4ParentOf(current, model)
      if (nodeParent === parent) return current
      current = nodeParent
    }
    return null
  }

  function c4DisplayLabel(rel) {
    return rel.technology ? `${rel.label} (${rel.technology})` : rel.label
  }

  function c4WrapNodeLines(value, width, size, maxLines = 2, weight = size >= 15 ? 720 : 500) {
    return c4WrapText(value, width, size, weight).slice(0, maxLines)
  }

  function measureC4Leaf(node) {
    const w = c4LeafCardWidth(node)
    const wrapWidth = Math.max(96, w - C4.nodeTextX - C4.nodeTextRightMargin - 12)
    const titleLines = c4WrapNodeLines(node.label || node.id, wrapWidth, 15, 2).length
    const techLines = node.technology ? c4WrapNodeLines(node.technology, wrapWidth, 11, 2, 650).length : 0
    const detailLines = node.detail ? c4WrapNodeLines(node.detail, wrapWidth, 11, 2, 500).length : 0
    const base = node.kind === 'Person' ? 108 : isC4DataStore(node) ? 126 : node.kind === 'Component' ? 110 : 118
    const h = base + (titleLines - 1) * 18 + Math.max(0, techLines + detailLines - 2) * 14
    return { w, h, headerH: 0, anchorY: h / 2 }
  }

  function collectC4Constraints(parent, children, model) {
    const xConstraints = []
    const yConstraints = []
    for (const rel of model.relations) {
      const from = c4ImmediateChildFor(rel.from, parent, model)
      const to = c4ImmediateChildFor(rel.to, parent, model)
      if (!from || !to || from === to) continue
      if (rel.direction === 'right') pushUniqueConstraint(xConstraints, from, to)
      else if (rel.direction === 'left') pushUniqueConstraint(xConstraints, to, from)
      else if (rel.direction === 'down') pushUniqueConstraint(yConstraints, from, to)
      else if (rel.direction === 'up') pushUniqueConstraint(yConstraints, to, from)
      else {
        const fromNode = model.nodes.get(from)
        const toNode = model.nodes.get(to)
        if (fromNode?.external && !toNode?.external) pushUniqueConstraint(xConstraints, from, to)
        else if (!isC4DataStore(fromNode) && isC4DataStore(toNode)) pushUniqueConstraint(yConstraints, from, to)
        else if (isC4DataStore(fromNode) && !isC4DataStore(toNode)) pushUniqueConstraint(yConstraints, to, from)
      }
    }
    for (const left of children) {
      for (const right of children) {
        if (left === right) continue
        const leftNode = model.nodes.get(left)
        const rightNode = model.nodes.get(right)
        if (!isC4DataStore(leftNode) && isC4DataStore(rightNode)) pushUniqueConstraint(yConstraints, left, right)
        if (leftNode?.external && isC4Boundary(rightNode)) pushUniqueConstraint(xConstraints, left, right)
        if (isC4Person(leftNode) && !isC4Person(rightNode) && rightNode?.external) pushUniqueConstraint(xConstraints, left, right)
      }
    }
    return { xConstraints, yConstraints }
  }

  function c4ScopedRelations(parent, model) {
    const scoped = []
    model.relations.forEach((rel, index) => {
      const from = c4ImmediateChildFor(rel.from, parent, model)
      const to = c4ImmediateChildFor(rel.to, parent, model)
      if (!from || !to || from === to) return
      if (scoped.some((item) => item.from === from && item.to === to)) return
      scoped.push({ index, from, to, rel, label: c4DisplayLabel(rel), originalFrom: rel.from, originalTo: rel.to })
    })
    return scoped
  }

  function c4InnerColumnOrders(children, model) {
    const orders = new Map()
    children.forEach((child) => {
      const node = model.nodes.get(child)
      if (!isC4Boundary(node)) return
      const innerChildren = c4Children(child, model)
      if (!innerChildren.length) return
      const { xConstraints, yConstraints } = collectC4Constraints(child, innerChildren, model)
      const innerXRanks = solveRankConstraints(innerChildren, xConstraints)
      const innerYRanks = solveRankConstraints(innerChildren, yConstraints)
      const innerRows = groupRowsByRank(innerChildren, innerYRanks, innerXRanks)
      innerRows.forEach((row) => row.sort((a, b) => (innerXRanks.get(a) || 0) - (innerXRanks.get(b) || 0) || a.localeCompare(b)))
      const order = new Map()
      innerRows.forEach((row) => {
        const count = Math.max(1, row.length)
        row.forEach((id, index) => order.set(id, index / count))
      })
      orders.set(child, order)
    })
    return orders
  }

  function c4SubOrderFor(originalId, scopedChild, innerColumnOrders, model) {
    if (originalId === scopedChild) return null
    const order = innerColumnOrders.get(scopedChild)
    if (!order) return null
    if (order.has(originalId)) return order.get(originalId)
    let cursor = originalId
    while (cursor && model.nodes.has(cursor)) {
      const node = model.nodes.get(cursor)
      if (node.parent === scopedChild && order.has(cursor)) return order.get(cursor)
      cursor = node.parent
    }
    return null
  }

  function measureC4Node(id, model, cache = new Map(), gapOverrides = new Map()) {
    if (cache.has(id)) return cache.get(id)
    const node = model.nodes.get(id)
    if (!node) return { w: 0, h: 0, headerH: 0, anchorY: 0 }
    if (!isC4Boundary(node)) {
      const measured = measureC4Leaf(node)
      cache.set(id, measured)
      return measured
    }
    const children = c4Children(id, model)
    if (!children.length) {
      const measured = { w: 280, h: 132, headerH: C4.containerHeaderH, anchorY: 66 }
      cache.set(id, measured)
      return measured
    }
    const grid = buildC4Grid(id, model, cache, gapOverrides)
    const anchorCandidates = []
    for (const rel of model.relations) {
      if (rel.direction !== 'left' && rel.direction !== 'right') continue
      const fromChild = c4ImmediateChildFor(rel.from, id, model)
      const toChild = c4ImmediateChildFor(rel.to, id, model)
      const child = fromChild && !toChild ? fromChild : toChild && !fromChild ? toChild : null
      if (!child || !grid.positions.has(child)) continue
      const p = grid.positions.get(child)
      const m = measureC4Node(child, model, cache, gapOverrides)
      anchorCandidates.push(p.y + m.anchorY)
    }
    if (!anchorCandidates.length) {
      const fallback = children.find((child) => !isC4DataStore(model.nodes.get(child))) || children[0]
      const p = grid.positions.get(fallback)
      const m = measureC4Node(fallback, model, cache, gapOverrides)
      if (p) anchorCandidates.push(p.y + m.anchorY)
    }
    const measured = {
      w: grid.width + C4.containerPadX * 2,
      h: grid.height + C4.containerHeaderH + C4.containerPadY * 2,
      headerH: C4.containerHeaderH,
      anchorY: C4.containerHeaderH + C4.containerPadY + anchorCandidates.reduce((sum, value) => sum + value, 0) / Math.max(1, anchorCandidates.length),
    }
    cache.set(id, measured)
    return measured
  }

  function c4GapOverrideKey(parent, left, right) {
    return `${parent || ''}\u0000${left}\u0000${right}`
  }

  function c4HorizontalRelationPeerPressure(relationIndex, relation, relations, parent, childToRank, rank, model) {
    let sourcePeers = 0
    let targetPeers = 0
    relations.forEach((peer, peerIndex) => {
      if (peerIndex === relationIndex || (peer.direction !== 'left' && peer.direction !== 'right')) return
      const fromChild = c4ImmediateChildFor(peer.from, parent, model)
      const toChild = c4ImmediateChildFor(peer.to, parent, model)
      if (!fromChild || !toChild || childToRank.get(fromChild) !== rank || childToRank.get(toChild) !== rank) return
      if (peer.from === relation.from) sourcePeers += 1
      if (peer.to === relation.to) targetPeers += 1
    })
    const sharedPressure = sourcePeers > 0 && targetPeers > 0 ? 18 : 0
    return Math.max(0, Math.min(84, sourcePeers * 20 + targetPeers * 34 + sharedPressure))
  }

  function c4ObservedRouteGapBudget(item) {
    if (!item?.route) return null
    const detourExtra = Math.max(0, item.pathLength - item.manhattanSpan - 40) * 0.16
    const bendExtra = Math.max(0, c4BendCount(item.route.points) - 1) * 10
    return Math.max(C4.colGap, Math.min(C4.maxInlineRelGap, C4.colGap + detourExtra + bendExtra))
  }

  function c4DeriveGapOverrides(model, scene, workItems) {
    const labelRects = new Map(workItems.filter((item) => item.labelPlacement).map((item) => [item.relationIndex, item.labelPlacement.rect]))
    const parents = [null].concat([...model.nodes.values()].filter((node) => isC4Boundary(node)).map((node) => node.id).sort())
    const overrides = new Map()
    parents.forEach((parent) => {
      const children = c4Children(parent, model)
      if (children.length < 2) return
      const { yConstraints } = collectC4Constraints(parent, children, model)
      const yRanks = solveRankConstraints(children, yConstraints)
      const rows = new Map()
      children.forEach((child) => {
        const rank = yRanks.get(child) || 0
        if (!rows.has(rank)) rows.set(rank, [])
        rows.get(rank).push(child)
      })
      ;[...rows.values()].forEach((row) => {
        row.sort((left, right) => {
          const leftX = scene.layouts.get(left)?.x || 0
          const rightX = scene.layouts.get(right)?.x || 0
          return leftX - rightX || left.localeCompare(right)
        })
      })
      const childToRank = childToRow(rows)
      for (const [rank, row] of rows.entries()) {
        if (row.length < 2) continue
        const gapRequirements = Array(row.length - 1).fill(C4.colGap)
        const gapCrossings = Array(row.length - 1).fill(0)
        const observedRouteBudgets = Array(row.length - 1).fill(C4.colGap)
        model.relations.forEach((relation, relationIndex) => {
          const fromChild = c4ImmediateChildFor(relation.from, parent, model)
          const toChild = c4ImmediateChildFor(relation.to, parent, model)
          if (!fromChild || !toChild || childToRank.get(fromChild) !== rank || childToRank.get(toChild) !== rank) return
          if (relation.direction !== 'left' && relation.direction !== 'right') return
          const fromIndex = row.indexOf(fromChild)
          const toIndex = row.indexOf(toChild)
          const startIndex = Math.min(fromIndex, toIndex)
          const endIndex = Math.max(fromIndex, toIndex)
          if (startIndex < 0 || endIndex <= startIndex) return
          const budget = c4ObservedRouteGapBudget(workItems[relationIndex])
          const observedBudget = budget == null
            ? C4.colGap
            : endIndex === startIndex + 1
              ? budget
              : Math.max(C4.colGap, Math.min(C4.maxInlineRelGap, C4.colGap + (budget - C4.colGap) * 0.6))
          for (let gapIndex = startIndex; gapIndex < endIndex; gapIndex += 1) {
            gapCrossings[gapIndex] += 1
            observedRouteBudgets[gapIndex] = Math.max(observedRouteBudgets[gapIndex], observedBudget)
          }
          const pressure = c4HorizontalRelationPeerPressure(relationIndex, relation, model.relations, parent, childToRank, rank, model)
          if (endIndex === startIndex + 1) {
            const rectValue = labelRects.get(relationIndex)
            const labelGap = rectValue
              ? rectValue.right - rectValue.left + 20 + pressure
              : C4.colGap + pressure
            gapRequirements[startIndex] = Math.max(gapRequirements[startIndex], Math.max(C4.colGap, Math.min(C4.maxInlineRelGap, labelGap)))
          }
        })
        gapRequirements.forEach((gap, gapIndex) => {
          let required = gap
          if (gapCrossings[gapIndex] > 1) {
            required = Math.max(required, Math.max(C4.colGap, Math.min(C4.maxInlineRelGap, C4.colGap + (gapCrossings[gapIndex] - 1) * C4.inlineRelCongestionStep)))
          }
          required = Math.max(required, observedRouteBudgets[gapIndex], Math.min(C4.minInlineRelGap, C4.colGap))
          required = Math.max(Math.min(C4.minInlineRelGap, C4.colGap), Math.min(C4.maxInlineRelGap, required))
          const left = row[gapIndex]
          const right = row[gapIndex + 1]
          if (left && right) overrides.set(c4GapOverrideKey(parent, left, right), required)
        })
      }
    })
    return overrides
  }

  function buildC4Grid(parent, model, cache, gapOverrides = new Map()) {
    const children = c4Children(parent, model)
    if (!children.length) return { width: 0, height: 0, positions: new Map(), rows: new Map() }
    const measures = new Map(children.map((child) => [child, measureC4Node(child, model, cache, gapOverrides)]))
    const sizes = new Map(children.map((child) => [child, { w: measures.get(child).w, h: measures.get(child).h }]))
    const { xConstraints, yConstraints } = collectC4Constraints(parent, children, model)
    const xRanks = solveRankConstraints(children, xConstraints)
    const yRanks = solveRankConstraints(children, yConstraints)
    const rows = groupRowsByRank(children, yRanks, xRanks)
    ;[...rows.values()].forEach((row) => row.sort((a, b) => {
      const rankDelta = (xRanks.get(a) || 0) - (xRanks.get(b) || 0)
      return rankDelta || c4NodeWeight(model.nodes.get(a)) - c4NodeWeight(model.nodes.get(b)) || a.localeCompare(b)
    }))
    const scoped = c4ScopedRelations(parent, model)
    const innerColumnOrders = c4InnerColumnOrders(children, model)
    const relations = scoped.map((item) => ({
      from: item.from,
      to: item.to,
      weight: 1,
      relationIndex: item.index,
      fromSubOrder: c4SubOrderFor(item.originalFrom, item.from, innerColumnOrders, model),
    }))
    const corridorHints = optimizeRowOrderWithCorridorHints(rows, xRanks, relations, 4)
    const childRow = childToRow(rows)
    const rowGaps = new Map()
    const rowLaneHeights = new Map()
    for (const [rank, row] of rows.entries()) {
      const gaps = Array(Math.max(0, row.length - 1)).fill(C4.colGap)
      const horizontalRelations = []
      scoped.forEach((item) => {
        const fromIndex = row.indexOf(item.from)
        const toIndex = row.indexOf(item.to)
        if (fromIndex < 0 || toIndex < 0 || childRow.get(item.from) !== rank || childRow.get(item.to) !== rank) return
        if (item.rel.direction !== 'left' && item.rel.direction !== 'right') return
        const start = Math.min(fromIndex, toIndex)
        const end = Math.max(fromIndex, toIndex)
        if (end <= start) return
        const labelLines = c4WrapText(item.label, C4.inlineLabelWrapW, 11, 650).slice(0, 2)
        const labelWidth = Math.max(...(labelLines.length ? labelLines : ['']).map((lineValue) => c4EstimateTextWidth(lineValue, 11, 650)))
        horizontalRelations.push({
          start,
          end,
          labelWidth,
          lineCount: Math.max(1, Math.min(2, labelLines.length)),
          peerPressure: c4HorizontalRelationPeerPressure(item.index, item.rel, model.relations, parent, childRow, rank, model),
        })
      })
      const gapCrossings = Array(Math.max(0, row.length - 1)).fill(0)
      const adjacentLabelWidths = Array(Math.max(0, row.length - 1)).fill(0)
      horizontalRelations.forEach((relation) => {
        for (let gapIndex = relation.start; gapIndex < relation.end; gapIndex += 1) {
          gapCrossings[gapIndex] = (gapCrossings[gapIndex] || 0) + 1
        }
        if (relation.end === relation.start + 1) {
          adjacentLabelWidths[relation.start] = Math.max(
            adjacentLabelWidths[relation.start] || 0,
            relation.labelWidth + 32 + relation.peerPressure,
          )
        }
      })
      gaps.forEach((_, gapIndex) => {
        const congestionBudget = gapCrossings[gapIndex] > 1
          ? C4.colGap + Math.max(0, gapCrossings[gapIndex] - 1) * C4.inlineRelCongestionStep
          : C4.colGap
        const labelBudget = Math.max(C4.minInlineRelGap, Math.min(C4.maxInlineRelGap, adjacentLabelWidths[gapIndex] || 0))
        gaps[gapIndex] = Math.max(gaps[gapIndex], congestionBudget, labelBudget)
      })
      const spanning = horizontalRelations
        .filter((relation) => relation.end > relation.start + 1)
        .map((relation) => ({ start: relation.start, end: relation.end, lineCount: relation.lineCount }))
      let laneHeight = 0
      if (spanning.length) {
        const laneEnds = []
        let maxLines = 1
        let maxSpanCrossings = 0
        spanning.sort((a, b) => a.start - b.start || a.end - b.end)
        spanning.forEach((span) => {
          maxLines = Math.max(maxLines, span.lineCount)
          for (let gapIndex = span.start; gapIndex < span.end; gapIndex += 1) {
            maxSpanCrossings = Math.max(maxSpanCrossings, gapCrossings[gapIndex] || 0)
          }
          let laneIndex = laneEnds.findIndex((end) => end <= span.start)
          if (laneIndex < 0) {
            laneEnds.push(0)
            laneIndex = laneEnds.length - 1
          }
          laneEnds[laneIndex] = span.end
        })
        const effectiveLaneCount = Math.max(laneEnds.length, maxSpanCrossings || 1)
        laneHeight = Math.max(C4.minRowLaneH, Math.min(C4.maxRowLaneH, 18 + maxLines * 16 + Math.max(0, effectiveLaneCount - 1) * C4.rowLanePitch))
      }
      rowGaps.set(rank, gaps.map((gap, gapIndex) => {
        const override = gapOverrides.get(c4GapOverrideKey(parent, row[gapIndex], row[gapIndex + 1]))
        const bounded = Math.max(C4.minInlineRelGap, Math.min(C4.maxInlineRelGap, gap))
        return override == null ? bounded : Math.min(bounded, Math.max(C4.colGap, Math.min(C4.maxInlineRelGap, override)))
      }))
      rowLaneHeights.set(rank, laneHeight)
    }
    const rowKeys = [...rows.keys()].sort((a, b) => a - b)
    const rowWidths = new Map()
    let contentWidth = 240
    rowKeys.forEach((rank) => {
      const row = rows.get(rank)
      const w = row.reduce((sum, child) => sum + measures.get(child).w, 0) + (rowGaps.get(rank) || []).reduce((sum, gap) => sum + gap, 0)
      rowWidths.set(rank, w)
      contentWidth = Math.max(contentWidth, w)
    })
    const positions = new Map()
    let y = 0
    rowKeys.forEach((rank, rowIndex) => {
      const row = rows.get(rank)
      const rowAnchor = row.reduce((max, child) => Math.max(max, measures.get(child).anchorY), 0)
      let rowHeight = 0
      let x = Math.max(0, (contentWidth - rowWidths.get(rank)) / 2)
      row.forEach((child, childIndex) => {
        const m = measures.get(child)
        const childY = y + (rowAnchor - m.anchorY)
        positions.set(child, { x, y: childY, w: m.w, h: m.h })
        rowHeight = Math.max(rowHeight, (rowAnchor - m.anchorY) + m.h)
        x += m.w + ((rowGaps.get(rank) || [])[childIndex] || 0)
      })
      y += rowHeight + (rowLaneHeights.get(rank) || 0)
      if (rowIndex + 1 < rowKeys.length) y += C4.rowGap
    })
    const relationWeights = scoped.map((item) => {
      const sameRow = childRow.get(item.from) === childRow.get(item.to)
      const touchesStore = isC4DataStore(model.nodes.get(item.from)) || isC4DataStore(model.nodes.get(item.to))
      const vertical = item.rel.direction === 'down' || item.rel.direction === 'up'
      const horizontal = item.rel.direction === 'left' || item.rel.direction === 'right'
      const weight = vertical ? (touchesStore ? 3.2 : 2.6) : horizontal ? (sameRow ? 0.7 : 1.4) : touchesStore ? 2.0 : 1.2
      return { from: item.from, to: item.to, weight, relationIndex: item.index, fromSubOrder: null }
    })
    const widths = new Map([...measures.entries()].map(([child, measure]) => [child, measure.w]))
    relaxRowPositionsWithCorridorHints({
      rows,
      widths,
      rowGaps,
      contentWidth,
      rowNaturalWidths: rowWidths,
    }, positions, relationWeights, corridorHints, {
      baseAnchorWeight: 1.4,
      corridorHintWeight: 0.45,
      iterations: 8,
      blend: 0.6,
      maxShiftX: C4.maxRelaxShiftX,
    })
    const actualWidth = Math.max(240, ...[...positions.values()].map((p) => p.x + p.w))
    return { width: actualWidth > 0 && actualWidth < contentWidth ? actualWidth : contentWidth, height: Math.max(140, y), positions, rows }
  }

  function layoutC4Node(id, x, y, model, layouts, cache, gapOverrides = new Map()) {
    const measured = measureC4Node(id, model, cache, gapOverrides)
    layouts.set(id, { x, y, w: measured.w, h: measured.h, headerH: measured.headerH })
    const node = model.nodes.get(id)
    if (!isC4Boundary(node)) return
    const grid = buildC4Grid(id, model, cache, gapOverrides)
    node.children.forEach((child) => {
      const p = grid.positions.get(child)
      if (p) layoutC4Node(child, x + C4.containerPadX + p.x, y + measured.headerH + C4.containerPadY + p.y, model, layouts, cache, gapOverrides)
    })
  }

  function layoutC4Scene(model, gapOverrides = new Map()) {
    const cache = new Map()
    const rootGrid = buildC4Grid(null, model, cache, gapOverrides)
    const layouts = new Map()
    model.rootChildren.forEach((child) => {
      const p = rootGrid.positions.get(child)
      if (p) layoutC4Node(child, C4.rootPadX + p.x, C4.rootPadY + p.y, model, layouts, cache, gapOverrides)
    })
    const width = Math.max(540, rootGrid.width + C4.rootPadX * 2)
    const height = Math.max(340, rootGrid.height + C4.rootPadY * 2)
    return { width, height, layouts, model }
  }

  function c4CommonBoundaryAncestor(rel, model) {
    const fromAncestors = new Set(c4AncestorChain(rel.from, model).slice(1))
    return c4AncestorChain(rel.to, model).slice(1).find((id) => fromAncestors.has(id)) || null
  }

  function c4RelationAllowedRegion(rel, scene, model) {
    const from = scene.layouts.get(rel.from)
    const to = scene.layouts.get(rel.to)
    const canvas = { left: 16, top: 16, right: scene.width - 16, bottom: scene.height - 16 }
    if (!from || !to) return canvas
    const common = model ? c4CommonBoundaryAncestor(rel, model) : null
    const commonBox = common ? scene.layouts.get(common) : null
    if (commonBox) {
      return {
        left: commonBox.x + 12,
        top: commonBox.y + commonBox.headerH + 12,
        right: commonBox.x + commonBox.w - 12,
        bottom: commonBox.y + commonBox.h - 12,
      }
    }
    return {
      left: canvas.left,
      top: canvas.top,
      right: canvas.right,
      bottom: canvas.bottom,
    }
  }

  function c4AncestorChain(id, model) {
    const chain = []
    let current = id
    while (current && model.nodes.has(current)) {
      chain.push(current)
      current = model.nodes.get(current).parent
    }
    return chain
  }

  function c4BoundaryCrossingCount(rel, model) {
    const fromAncestors = new Set(c4AncestorChain(rel.from, model).slice(1))
    return c4AncestorChain(rel.to, model).slice(1).filter((id) => !fromAncestors.has(id)).length
  }

  function c4RelationCrossesBoundaryOwner(rel, owner, model) {
    const fromAncestors = new Set(c4AncestorChain(rel.from, model).slice(1))
    const toAncestors = new Set(c4AncestorChain(rel.to, model).slice(1))
    return fromAncestors.has(owner) !== toAncestors.has(owner)
  }

  function c4CrossedBoundaryIds(rel, model) {
    const fromAncestors = new Set(c4AncestorChain(rel.from, model).slice(1))
    const toAncestors = new Set(c4AncestorChain(rel.to, model).slice(1))
    return [...new Set([...fromAncestors, ...toAncestors])]
      .filter((id) => fromAncestors.has(id) !== toAncestors.has(id))
  }

  function c4CrossingPlanForRelation(rel, model) {
    const sourceChain = c4AncestorChain(rel.from, model).slice(1)
    const targetChain = c4AncestorChain(rel.to, model).slice(1)
    const common = targetChain.find((scopeId) => sourceChain.includes(scopeId)) || null
    const sourceExits = []
    for (const scopeId of sourceChain) {
      if (scopeId === common) break
      sourceExits.push({ scopeId, kind: 'Exit' })
    }
    const targetEnters = []
    for (const scopeId of targetChain) {
      if (scopeId === common) break
      targetEnters.push({ scopeId, kind: 'Enter' })
    }
    return sourceExits.concat(targetEnters.reverse())
  }

  function c4RelationCenterSpan(rel, scene) {
    const from = scene.layouts.get(rel.from)
    const to = scene.layouts.get(rel.to)
    if (!from || !to) return 0
    return Math.abs((from.x + from.w / 2) - (to.x + to.w / 2)) + Math.abs((from.y + from.h / 2) - (to.y + to.h / 2))
  }

  function c4RelationPriorityScore(relationIndex, rel, model, scene) {
    const span = c4RelationCenterSpan(rel, scene)
    const directionWeight = rel.direction === 'down' || rel.direction === 'up' ? 36 : rel.direction === 'left' || rel.direction === 'right' ? 28 : 12
    const labelWeight = Math.min(90, c4DisplayLabel(rel).length * 2.2)
    const crossingWeight = c4BoundaryCrossingCount(rel, model) * 48
    const dataStoreWeight = (isC4DataStore(model.nodes.get(rel.from)) || isC4DataStore(model.nodes.get(rel.to))) ? 18 : 0
    return span * 0.18 + directionWeight + labelWeight + crossingWeight + dataStoreWeight - relationIndex * 0.001
  }

  function c4RelationObstacles(rel, relationIndex, model, scene) {
    const sourceAncestors = new Set(c4AncestorChain(rel.from, model).slice(1))
    const targetAncestors = new Set(c4AncestorChain(rel.to, model).slice(1))
    const obstacles = []
    for (const [id, box] of scene.layouts.entries()) {
      if (id === rel.from || id === rel.to) continue
      const node = model.nodes.get(id)
      if (!node) continue
      if (isC4Boundary(node)) {
        const crossesOwner = c4RelationCrossesBoundaryOwner(rel, id, model)
        if (!crossesOwner) {
          obstacles.push({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.headerH })
          obstacles.push({ left: box.x, top: box.y + box.headerH - 1.5, right: box.x + box.w, bottom: box.y + box.headerH + 1.5 })
        }
        if (sourceAncestors.has(id) || targetAncestors.has(id)) {
          continue
        }
        if (!crossesOwner) {
          obstacles.push(c4InflateRect(c4RectFromBox(box), 12))
        }
      } else {
        obstacles.push(c4RectFromBox(box))
      }
    }
    return obstacles
  }

  function c4BuildRelationCrossingReservations(item, model, scene) {
    if (!item.route) return []
    const routeSegments = c4SegmentsFromRoute(item.route.points)
    const preferredOrientation = item.rel.direction === 'down' || item.rel.direction === 'up'
      ? 'vertical'
      : item.rel.direction === 'left' || item.rel.direction === 'right'
        ? 'horizontal'
        : null
    const plan = c4CrossingPlanForRelation(item.rel, model)
    return plan.flatMap((step) => {
      const scope = scene.layouts.get(step.scopeId)
      if (!scope) return []
      const scopeRect = {
        left: scope.x,
        top: scope.y + scope.headerH,
        right: scope.x + scope.w,
        bottom: scope.y + scope.h,
      }
      const candidates = routeSegments
        .map((segment) => {
          if (segment.orientation === 'vertical') {
            if (segment.axis < scopeRect.left || segment.axis > scopeRect.right) return null
            const overlap = Math.min(segment.end, scopeRect.bottom) - Math.max(segment.start, scopeRect.top)
            return overlap > 0 ? { segment, overlap } : null
          }
          if (segment.axis < scopeRect.top || segment.axis > scopeRect.bottom) return null
          const overlap = Math.min(segment.end, scopeRect.right) - Math.max(segment.start, scopeRect.left)
          return overlap > 0 ? { segment, overlap } : null
        })
        .filter(Boolean)
        .sort((a, b) => b.overlap - a.overlap)
      const preferred = preferredOrientation
        ? candidates.filter((candidate) => candidate.segment.orientation === preferredOrientation).sort((a, b) => b.overlap - a.overlap)[0]?.segment
        : null
      const selected = preferred || candidates[0]?.segment
      if (!selected) return []
      return [{
        ownerRelationIndex: item.relationIndex,
        scopeId: step.scopeId,
        kind: step.kind,
        axisFamily: selected.orientation === 'vertical' ? 'Vertical' : 'Horizontal',
        laneAxis: selected.axis,
      }]
    })
  }

  function c4PointInsideRectStrict(point, rect) {
    return point.x > rect.left + 0.1 && point.x < rect.right - 0.1 && point.y > rect.top + 0.1 && point.y < rect.bottom - 0.1
  }

  function c4TransitionAxisFamilyForSide(side) {
    return side === 'left' || side === 'right' ? 'Horizontal' : 'Vertical'
  }

  function c4TransitionLaneAxisForPoint(side, point) {
    return side === 'left' || side === 'right' ? point.y : point.x
  }

  function c4TransitionFromSegment(scopeId, scopeRect, segmentIndex, start, end) {
    const startInside = c4PointInsideRectStrict(start, scopeRect)
    const endInside = c4PointInsideRectStrict(end, scopeRect)
    if (startInside === endInside) return null
    let transition = null
    if (Math.abs(start.x - end.x) < 0.1) {
      if (end.y > start.y && start.y < scopeRect.top - 0.1 && end.y > scopeRect.top + 0.1 && endInside) {
        transition = { kind: 'Enter', side: 'top', point: { x: start.x, y: scopeRect.top } }
      } else if (end.y > start.y && startInside && end.y > scopeRect.bottom + 0.1) {
        transition = { kind: 'Exit', side: 'bottom', point: { x: start.x, y: scopeRect.bottom } }
      } else if (end.y < start.y && start.y > scopeRect.bottom + 0.1 && end.y < scopeRect.bottom - 0.1 && endInside) {
        transition = { kind: 'Enter', side: 'bottom', point: { x: start.x, y: scopeRect.bottom } }
      } else if (end.y < start.y && startInside && end.y < scopeRect.top - 0.1) {
        transition = { kind: 'Exit', side: 'top', point: { x: start.x, y: scopeRect.top } }
      }
    } else if (Math.abs(start.y - end.y) < 0.1) {
      if (end.x > start.x && start.x < scopeRect.left - 0.1 && end.x > scopeRect.left + 0.1 && endInside) {
        transition = { kind: 'Enter', side: 'left', point: { x: scopeRect.left, y: start.y } }
      } else if (end.x > start.x && startInside && end.x > scopeRect.right + 0.1) {
        transition = { kind: 'Exit', side: 'right', point: { x: scopeRect.right, y: start.y } }
      } else if (end.x < start.x && start.x > scopeRect.right + 0.1 && end.x < scopeRect.right - 0.1 && endInside) {
        transition = { kind: 'Enter', side: 'right', point: { x: scopeRect.right, y: start.y } }
      } else if (end.x < start.x && startInside && end.x < scopeRect.left - 0.1) {
        transition = { kind: 'Exit', side: 'left', point: { x: scopeRect.left, y: start.y } }
      }
    }
    if (!transition) return null
    return {
      segmentIndex,
      distance: Math.abs(transition.point.x - start.x) + Math.abs(transition.point.y - start.y),
      scopeId,
      kind: transition.kind,
      side: transition.side,
      axisFamily: c4TransitionAxisFamilyForSide(transition.side),
      laneAxis: c4TransitionLaneAxisForPoint(transition.side, transition.point),
      point: transition.point,
    }
  }

  function c4ScopeFrameRect(scope) {
    return {
      left: scope.x,
      top: scope.y + scope.headerH,
      right: scope.x + scope.w,
      bottom: scope.y + scope.h,
    }
  }

  function c4CollectScopeTransitions(item, model, scene) {
    if (!item.route) return []
    const scopeIds = c4CrossedBoundaryIds(item.rel, model)
    const transitions = []
    for (let index = 0; index < item.route.points.length - 1; index += 1) {
      const start = item.route.points[index]
      const end = item.route.points[index + 1]
      for (const scopeId of scopeIds) {
        const scope = scene.layouts.get(scopeId)
        if (!scope) continue
        const transition = c4TransitionFromSegment(scopeId, c4ScopeFrameRect(scope), index, start, end)
        if (transition) transitions.push(transition)
      }
    }
    transitions.sort((a, b) => a.segmentIndex - b.segmentIndex || a.distance - b.distance || a.scopeId.localeCompare(b.scopeId))
    return transitions
  }

  function c4ExpectedTransitionSide(rel, kind) {
    if (rel.direction === 'down') return kind === 'Exit' ? 'bottom' : ['top', 'left', 'right']
    if (rel.direction === 'up') return kind === 'Exit' ? 'top' : ['bottom', 'left', 'right']
    if (rel.direction === 'right') return kind === 'Exit' ? 'right' : ['left', 'top', 'bottom']
    if (rel.direction === 'left') return kind === 'Exit' ? 'left' : ['right', 'top', 'bottom']
    return null
  }

  function c4ScopeTransitionMismatch(item, model, scene) {
    const plan = item.crossingReservations || []
    const actual = c4CollectScopeTransitions(item, model, scene)
    if (plan.length !== actual.length) return true
    return plan.some((planned, index) => {
      const observed = actual[index]
      if (!observed) return true
      if (planned.scopeId !== observed.scopeId || planned.kind !== observed.kind || planned.axisFamily !== observed.axisFamily) return true
      const expectedSide = c4ExpectedTransitionSide(item.rel, planned.kind)
      if (Array.isArray(expectedSide)) return !expectedSide.includes(observed.side)
      return expectedSide ? observed.side !== expectedSide : false
    })
  }

  function c4BuildWorkItems(model, scene) {
    const occupiedSegments = []
    const workItems = model.relations.map((rel, relationIndex) => {
      const from = scene.layouts.get(rel.from)
      const to = scene.layouts.get(rel.to)
      const manhattanSpan = from && to
        ? Math.abs((from.x + from.w / 2) - (to.x + to.w / 2)) + Math.abs((from.y + from.h / 2) - (to.y + to.h / 2))
        : 0
      return {
        relationIndex,
        rel,
        displayLabel: c4DisplayLabel(rel),
        allowedRegion: c4RelationAllowedRegion(rel, scene, model),
        route: null,
        pathLength: 0,
        manhattanSpan,
        routingState: 'Unroutable',
        labelPlacement: null,
        crossingReservations: [],
      }
    })
    const sourcePortOffsets = new Map()
    const targetPortOffsets = new Map()
    const portOffsetValue = (map, relationIndex) => map.get(relationIndex) || { x: 0, y: 0 }
    const setPortOffset = (map, relationIndex, axis, value) => {
      const current = portOffsetValue(map, relationIndex)
      map.set(relationIndex, { ...current, [axis]: value })
    }
    const fanoutGroups = new Map()
    const faninGroups = new Map()
    model.relations.forEach((rel, relationIndex) => {
      if (!['down', 'up', 'right', 'left'].includes(rel.direction)) return
      const from = scene.layouts.get(rel.from)
      const to = scene.layouts.get(rel.to)
      if (!from || !to) return
      const horizontal = rel.direction === 'right' || rel.direction === 'left'
      const fanoutKey = `${rel.from}:${rel.direction}`
      if (!fanoutGroups.has(fanoutKey)) fanoutGroups.set(fanoutKey, [])
      fanoutGroups.get(fanoutKey).push({
        relationIndex,
        targetCenter: horizontal ? to.y + to.h / 2 : to.x + to.w / 2,
        sourceSpan: horizontal ? from.h : from.w,
        axis: horizontal ? 'y' : 'x',
      })
      const faninKey = `${rel.to}:${rel.direction}`
      if (!faninGroups.has(faninKey)) faninGroups.set(faninKey, [])
      faninGroups.get(faninKey).push({
        relationIndex,
        sourceCenter: horizontal ? from.y + from.h / 2 : from.x + from.w / 2,
        targetSpan: horizontal ? to.h : to.w,
        axis: horizontal ? 'y' : 'x',
      })
    })
    fanoutGroups.forEach((items) => {
      if (items.length < 2) return
      items.sort((left, right) => left.targetCenter - right.targetCenter || left.relationIndex - right.relationIndex)
      const pitch = Math.max(36, Math.min(42, 96 / Math.max(1, items.length - 1)))
      const maxOffset = Math.max(0, items[0].sourceSpan / 2 - 28)
      const center = (items.length - 1) / 2
      items.forEach((item, index) => {
        setPortOffset(sourcePortOffsets, item.relationIndex, item.axis, Math.max(-maxOffset, Math.min(maxOffset, (index - center) * pitch)))
      })
    })
    faninGroups.forEach((items) => {
      if (items.length < 2) return
      items.sort((left, right) => left.sourceCenter - right.sourceCenter || left.relationIndex - right.relationIndex)
      const pitch = Math.max(36, Math.min(42, 96 / Math.max(1, items.length - 1)))
      const maxOffset = Math.max(0, items[0].targetSpan / 2 - 28)
      const center = (items.length - 1) / 2
      items.forEach((item, index) => {
        setPortOffset(targetPortOffsets, item.relationIndex, item.axis, Math.max(-maxOffset, Math.min(maxOffset, (index - center) * pitch)))
      })
    })
    const orderedIndices = model.relations
      .map((rel, index) => index)
      .sort((left, right) => c4RelationPriorityScore(right, model.relations[right], model, scene) - c4RelationPriorityScore(left, model.relations[left], model, scene) || c4RelationCenterSpan(model.relations[right], scene) - c4RelationCenterSpan(model.relations[left], scene) || left - right)
    orderedIndices.forEach((relationIndex) => {
      const rel = model.relations[relationIndex]
      const from = scene.layouts.get(rel.from)
      const to = scene.layouts.get(rel.to)
      const item = workItems[relationIndex]
      const obstacles = c4RelationObstacles(rel, relationIndex, model, scene)
      const fromOffset = portOffsetValue(sourcePortOffsets, relationIndex)
      const toOffset = portOffsetValue(targetPortOffsets, relationIndex)
      const route = from && to ? routeC4Relation(rel, from, to, occupiedSegments, obstacles, item.allowedRegion, item.displayLabel, fromOffset, toOffset) : null
      if (!route || !item) return
      item.route = { points: route, preferredLabelSegment: null }
      item.pathLength = c4PathLength(route)
      item.routingState = 'Routed'
      item.crossingReservations = c4BuildRelationCrossingReservations(item, model, scene)
      c4SegmentsFromRoute(route).forEach((segment) => occupiedSegments.push(segment))
    })
    return workItems
  }

  function c4BuildValidationScene(model, scene, workItems) {
    const canvas = { left: 0, top: 0, right: scene.width, bottom: scene.height + 42 }
    const hardRects = []
    const softRects = []
    const labelLaneReservations = []
    const crossingLaneReservations = []
    const occupiedSegments = []
    for (const [id, box] of scene.layouts.entries()) {
      const node = model.nodes.get(id)
      if (!node) continue
      if (isC4Boundary(node)) {
        hardRects.push({ owner: id, kind: 'BoundaryHeader', rect: { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.headerH } })
        hardRects.push({ owner: id, kind: 'BoundaryHeader', rect: { left: box.x, top: box.y + box.headerH - 1.5, right: box.x + box.w, bottom: box.y + box.headerH + 1.5 } })
      } else {
        hardRects.push({ owner: id, kind: 'NodeBody', rect: c4RectFromBox(box) })
      }
    }
    for (const item of workItems) {
      if (item.route) {
        c4SegmentsFromRoute(item.route.points).forEach((segment) => occupiedSegments.push({ ownerRelationIndex: item.relationIndex, segment }))
        item.crossingReservations?.forEach((reservation) => crossingLaneReservations.push(reservation))
      }
      if (item.labelPlacement) {
        const reservation = { ownerRelationIndex: item.relationIndex, rect: c4ReservedLaneRectFromLabelRect(item.labelPlacement.rect) }
        labelLaneReservations.push(reservation)
        softRects.push({ owner: String(item.relationIndex), kind: 'ReservedLabelLane', rect: reservation.rect })
      }
    }
    return { canvas, hardRects, softRects, labelLaneReservations, crossingLaneReservations, occupiedSegments, workItems, model, scene }
  }

  function c4SourceSideFromRoute(points) {
    if (!points || points.length < 2) return null
    const a = points[0]
    const b = points[1]
    if (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y)) return b.x >= a.x ? 'right' : 'left'
    return b.y >= a.y ? 'bottom' : 'top'
  }

  function c4TargetSideFromRoute(points) {
    if (!points || points.length < 2) return null
    const a = points[points.length - 2]
    const b = points[points.length - 1]
    if (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y)) return b.x >= a.x ? 'left' : 'right'
    return b.y >= a.y ? 'top' : 'bottom'
  }

  function c4ValidateScene(validation) {
    const issues = []
    for (const item of validation.workItems) {
      const owner = `${item.rel.from}->${item.rel.to}`
      if (!item.route) {
        issues.push({ kind: 'MissingRoute', relationIndex: item.relationIndex, owner })
        continue
      }
      if (item.route.points.some((point) => point.x < item.allowedRegion.left || point.x > item.allowedRegion.right || point.y < item.allowedRegion.top || point.y > item.allowedRegion.bottom)) {
        issues.push({ kind: 'RouteLeavesAllowedRegion', relationIndex: item.relationIndex, owner })
      }
      const fromBox = validation.scene?.layouts?.get(item.rel.from)
      const toBox = validation.scene?.layouts?.get(item.rel.to)
      if (fromBox && toBox) {
        const [expectedSourceSide, expectedTargetSide] = c4RelationSides(item.rel, fromBox, toBox)
        const actualSourceSide = c4SourceSideFromRoute(item.route.points)
        const actualTargetSide = c4TargetSideFromRoute(item.route.points)
        if (actualSourceSide && actualSourceSide !== expectedSourceSide) {
          issues.push({ kind: 'PortDirectionMismatch', relationIndex: item.relationIndex, owner })
        }
        if (actualTargetSide && actualTargetSide !== expectedTargetSide) {
          issues.push({ kind: 'ArrowHeadDirectionMismatch', relationIndex: item.relationIndex, owner })
        }
      }
      if (item.crossingReservations?.length && c4ScopeTransitionMismatch(item, validation.model, validation.scene)) {
        issues.push({ kind: 'ScopeTransitionMismatch', relationIndex: item.relationIndex, owner })
      }
      for (const rectValue of validation.hardRects) {
        if (rectValue.owner === item.rel.from || rectValue.owner === item.rel.to) continue
        if (rectValue.kind === 'BoundaryHeader' && c4RelationCrossesBoundaryOwner(item.rel, rectValue.owner, validation.model)) continue
        if (c4PolylineIntersectsRect(item.route.points, rectValue.rect)) {
          issues.push({ kind: rectValue.kind === 'BoundaryHeader' ? 'RouteCrossesBoundaryHeader' : 'RouteCrossesNodeBody', relationIndex: item.relationIndex, owner: rectValue.owner })
        }
      }
      if (item.pathLength > item.manhattanSpan + 260) {
        issues.push({ kind: 'DetourTooLarge', relationIndex: item.relationIndex, owner })
      }
      const itemSegments = c4SegmentsFromRoute(item.route.points)
      for (const occupied of validation.occupiedSegments) {
        if (occupied.ownerRelationIndex === item.relationIndex) continue
        for (const segment of itemSegments) {
          if (segment.orientation === occupied.segment.orientation) {
            if (Math.abs(segment.axis - occupied.segment.axis) <= 0.1 && Math.max(segment.start, occupied.segment.start) < Math.min(segment.end, occupied.segment.end) - 0.1) {
              issues.push({ kind: 'RouteOverlapsForeignRoute', relationIndex: item.relationIndex, owner: String(occupied.ownerRelationIndex) })
            }
          } else {
            const vertical = segment.orientation === 'vertical' ? segment : occupied.segment
            const horizontal = segment.orientation === 'horizontal' ? segment : occupied.segment
            if (
              vertical.axis > horizontal.start + 0.1 &&
              vertical.axis < horizontal.end - 0.1 &&
              horizontal.axis > vertical.start + 0.1 &&
              horizontal.axis < vertical.end - 0.1
            ) {
              issues.push({ kind: 'RouteCrossesForeignRoute', relationIndex: item.relationIndex, owner: String(occupied.ownerRelationIndex) })
            }
          }
        }
      }
      if (!item.labelPlacement) continue
      const labelRect = item.labelPlacement.rect
      if (!c4RectInside(labelRect, validation.canvas) || !c4RectInside(labelRect, item.allowedRegion)) {
        issues.push({ kind: 'LabelLeavesAllowedRegion', relationIndex: item.relationIndex, owner })
      }
      for (const rectValue of validation.hardRects) {
        if (c4RectsIntersect(labelRect, rectValue.rect)) {
          issues.push({ kind: 'LabelOverlapsHardObstacle', relationIndex: item.relationIndex, owner: rectValue.owner })
        }
      }
      for (const rectValue of validation.softRects) {
        if (rectValue.owner !== String(item.relationIndex) && c4RectsIntersect(labelRect, rectValue.rect)) {
          issues.push({ kind: 'LabelOverlapsSoftObstacle', relationIndex: item.relationIndex, owner: rectValue.owner })
        }
      }
      for (const seg of validation.occupiedSegments) {
        if (seg.ownerRelationIndex === item.relationIndex) continue
        const a = seg.segment.orientation === 'horizontal' ? { x: seg.segment.start, y: seg.segment.axis } : { x: seg.segment.axis, y: seg.segment.start }
        const b = seg.segment.orientation === 'horizontal' ? { x: seg.segment.end, y: seg.segment.axis } : { x: seg.segment.axis, y: seg.segment.end }
        if (c4SegmentToRectDistance(a, b, labelRect) < 0.1) {
          issues.push({ kind: 'LabelCrossesForeignRoute', relationIndex: item.relationIndex, owner: String(seg.ownerRelationIndex) })
        }
      }
    }
    return issues
  }

  function c4IssuePenalty(issue) {
    if (issue.kind === 'LabelOverlapsSoftObstacle') return 120
    if (issue.kind === 'DetourTooLarge') return 96
    return 1000
  }

  function c4LabelForbiddenRects(item, model, scene) {
    const rects = []
    for (const [id, box] of scene.layouts.entries()) {
      const node = model.nodes.get(id)
      if (!node) continue
      if (isC4Boundary(node)) {
        rects.push({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.headerH })
      } else {
        rects.push(c4InflateRect(c4RectFromBox(box), 4))
      }
    }
    return rects
  }

  function c4AssignLabels(workItems, model, scene) {
    const routeSegments = new Map(workItems.map((item) => [item.relationIndex, item.route ? c4SegmentsFromRoute(item.route.points) : []]))
    const pending = workItems
      .filter((item) => item.route && item.displayLabel)
      .map((item) => {
        const otherSegments = [...routeSegments.entries()].filter(([index]) => index !== item.relationIndex).flatMap(([, segments]) => segments)
        const forbiddenRects = model && scene ? c4LabelForbiddenRects(item, model, scene) : []
        const candidates = c4LabelCandidates(item.route.points, item.displayLabel, item.allowedRegion, otherSegments, forbiddenRects)
        const fallbackCandidates = candidates.length ? candidates : c4LabelCandidates(item.route.points, item.displayLabel, item.allowedRegion)
        const relationPriority = model && scene ? c4RelationPriorityScore(item.relationIndex, item.rel, model, scene) : item.manhattanSpan
        const bestScore = fallbackCandidates[0]?.score ?? 500
        return { item, candidates: fallbackCandidates, priority: relationPriority + item.manhattanSpan * 0.1 + (fallbackCandidates.length ? 80 / fallbackCandidates.length : 500) - bestScore * 0.05 }
      })
      .sort((a, b) => b.priority - a.priority || a.item.relationIndex - b.item.relationIndex)
    const laneRects = []
    const labelRects = []
    for (const pendingItem of pending) {
      let candidate = c4SelectLabelCandidate(pendingItem.candidates, laneRects) || c4SelectLabelCandidate(pendingItem.candidates, labelRects)
      const verticalCandidate = c4PreferredVerticalLabelCandidate(pendingItem.item, laneRects)
      if (verticalCandidate && (!candidate || candidate.placement.centered || candidate.placement.alignEnd !== verticalCandidate.placement.alignEnd)) {
        candidate = verticalCandidate
      }
      if (!candidate) continue
      pendingItem.item.labelPlacement = candidate.placement
      laneRects.push(c4ReservedLaneRectFromLabelRect(candidate.placement.rect))
      labelRects.push(candidate.placement.rect)
    }
  }

  function c4WorkItemPenalty(item, validation) {
    const issues = c4ValidateScene(validation).filter((issue) => issue.relationIndex === item.relationIndex)
    const issuePenalty = issues.reduce((sum, issue) => sum + c4IssuePenalty(issue), 0)
    const missingLabel = item.displayLabel && !item.labelPlacement ? 520 : 0
    const routeCost = item.route ? c4BendCount(item.route.points) * 18 + Math.max(0, item.pathLength - item.manhattanSpan) * 0.08 : 500
    return issuePenalty + missingLabel + routeCost
  }

  function c4RepairWorkItems(model, scene, workItems) {
    const summary = {
      iterationCount: 0,
      selectedStepCount: 0,
      relabelCount: 0,
      rerouteCount: 0,
      unroutedRetryCount: 0,
      lookaheadSelectionCount: 0,
      clusteredStepCount: 0,
      totalImpactedRelationCount: 0,
      maxImpactedRelationCount: 0,
      totalPenaltyImprovement: 0,
      relabelPenaltyImprovement: 0,
      reroutePenaltyImprovement: 0,
      unroutedRetryPenaltyImprovement: 0,
    }
    for (let iteration = 0; iteration < Math.min(6, workItems.length); iteration += 1) {
      summary.iterationCount += 1
      let validation = c4BuildValidationScene(model, scene, workItems)
      const problemIds = [...new Set(c4ValidateScene(validation).map((issue) => issue.relationIndex).filter((value) => value != null))]
      let changed = false
      for (const relationIndex of problemIds) {
        const item = workItems[relationIndex]
        if (!item?.route) continue
        const before = c4WorkItemPenalty(item, validation)
        const otherSegments = workItems.filter((candidate) => candidate.relationIndex !== relationIndex && candidate.route).flatMap((candidate) => c4SegmentsFromRoute(candidate.route.points))
        const forbidden = workItems.filter((candidate) => candidate.relationIndex !== relationIndex && candidate.labelPlacement).map((candidate) => c4ReservedLaneRectFromLabelRect(candidate.labelPlacement.rect))
          .concat(c4LabelForbiddenRects(item, model, scene))
        const candidate = c4LabelCandidates(item.route.points, item.displayLabel, item.allowedRegion, otherSegments, forbidden)[0]
        const previous = item.labelPlacement
        if (candidate) {
          item.labelPlacement = candidate.placement
          validation = c4BuildValidationScene(model, scene, workItems)
          const after = c4WorkItemPenalty(item, validation)
          if (after + 0.1 < before) {
            const improvement = before - after
            summary.selectedStepCount += 1
            summary.relabelCount += 1
            summary.totalImpactedRelationCount += 1
            summary.maxImpactedRelationCount = Math.max(summary.maxImpactedRelationCount, 1)
            summary.totalPenaltyImprovement += improvement
            summary.relabelPenaltyImprovement += improvement
            changed = true
            continue
          }
          item.labelPlacement = previous
        }

        const from = scene.layouts.get(item.rel.from)
        const to = scene.layouts.get(item.rel.to)
        if (!from || !to) continue
        const previousRoute = item.route
        const previousPathLength = item.pathLength
        const previousState = item.routingState
        const routeObstacles = c4RelationObstacles(item.rel, relationIndex, model, scene).concat(
          workItems
            .filter((candidateItem) => candidateItem.relationIndex !== relationIndex && candidateItem.labelPlacement)
            .map((candidateItem) => c4ReservedLaneRectFromLabelRect(candidateItem.labelPlacement.rect)),
        )
        const route = routeC4Relation(item.rel, from, to, otherSegments, routeObstacles, item.allowedRegion, item.displayLabel)
        item.route = route ? { points: route, preferredLabelSegment: null } : null
        item.pathLength = route ? c4PathLength(route) : 0
        item.routingState = route ? 'Routed' : 'Unroutable'
        item.crossingReservations = route ? c4BuildRelationCrossingReservations(item, model, scene) : []
        const rerouteForbidden = workItems
          .filter((candidateItem) => candidateItem.relationIndex !== relationIndex && candidateItem.labelPlacement)
          .map((candidateItem) => c4ReservedLaneRectFromLabelRect(candidateItem.labelPlacement.rect))
          .concat(c4LabelForbiddenRects(item, model, scene))
        const rerouteLabel = route ? c4LabelCandidates(route, item.displayLabel, item.allowedRegion, otherSegments, rerouteForbidden)[0] : null
        item.labelPlacement = rerouteLabel?.placement || null
        validation = c4BuildValidationScene(model, scene, workItems)
        const rerouteAfter = c4WorkItemPenalty(item, validation)
        if (rerouteAfter + 0.1 < before) {
          const improvement = before - rerouteAfter
          summary.selectedStepCount += 1
          summary.rerouteCount += 1
          summary.totalImpactedRelationCount += 1
          summary.maxImpactedRelationCount = Math.max(summary.maxImpactedRelationCount, 1)
          summary.totalPenaltyImprovement += improvement
          summary.reroutePenaltyImprovement += improvement
          changed = true
        } else {
          item.route = previousRoute
          item.pathLength = previousPathLength
          item.routingState = previousState
          item.labelPlacement = previous
        }
      }
      if (!changed) break
    }
    return summary
  }

  function c4ValidationSummary(issues) {
    return issues.reduce((summary, issue) => {
      if (issue.kind === 'LabelOverlapsSoftObstacle' || issue.kind === 'DetourTooLarge') {
        summary.softCount += 1
        summary.softPenalty += c4IssuePenalty(issue)
      } else {
        summary.hardCount += 1
      }
      return summary
    }, { hardCount: 0, softCount: 0, softPenalty: 0 })
  }

  function c4SceneContentBounds(scene) {
    const boxes = [...scene.layouts.values()]
    if (!boxes.length) return { left: 0, top: 0, right: 0, bottom: 0 }
    return {
      left: Math.min(...boxes.map((box) => box.x)),
      top: Math.min(...boxes.map((box) => box.y)),
      right: Math.max(...boxes.map((box) => box.x + box.w)),
      bottom: Math.max(...boxes.map((box) => box.y + box.h)),
    }
  }

  function c4SceneQuality(scene, workItems, validation, issues) {
    const bounds = c4SceneContentBounds(scene)
    const contentArea = Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top)
    const canvasArea = Math.max(1, scene.width * scene.height)
    return {
      labelCount: workItems.filter((item) => item.labelPlacement).length,
      unroutableCount: workItems.filter((item) => !item.route).length,
      totalDetour: workItems.reduce((sum, item) => sum + (item.route ? Math.max(0, item.pathLength - item.manhattanSpan) : 0), 0),
      totalBends: workItems.reduce((sum, item) => sum + (item.route ? c4BendCount(item.route.points) : 0), 0),
      canvasWasteArea: Math.max(0, canvasArea - contentArea),
      canvasWasteRatio: Math.max(0, canvasArea - contentArea) / canvasArea,
      summary: c4ValidationSummary(issues),
      labelLaneReservations: validation.labelLaneReservations.length,
      crossingLaneReservations: validation.crossingLaneReservations.length,
    }
  }

  function c4RouteQualityBetter(candidate, current) {
    return candidate.unroutableCount < current.unroutableCount
      || (candidate.unroutableCount === current.unroutableCount && candidate.summary.softPenalty + 0.1 < current.summary.softPenalty)
      || (candidate.unroutableCount === current.unroutableCount && Math.abs(candidate.summary.softPenalty - current.summary.softPenalty) <= 0.1 && candidate.totalDetour + 0.1 < current.totalDetour)
  }

  function c4SceneCandidateBetter(candidate, current) {
    const a = candidate.quality
    const b = current.quality
    if (a.summary.hardCount !== b.summary.hardCount) return a.summary.hardCount < b.summary.hardCount
    if (Math.abs(a.summary.softPenalty - b.summary.softPenalty) > 0.1) return a.summary.softPenalty < b.summary.softPenalty
    if (a.summary.softCount !== b.summary.softCount) return a.summary.softCount < b.summary.softCount
    if (a.labelCount !== b.labelCount) return a.labelCount > b.labelCount
    if (c4RouteQualityBetter(a, b)) return true
    if (b.unroutableCount < a.unroutableCount || b.summary.softPenalty + 0.1 < a.summary.softPenalty) return false
    if (a.crossingLaneReservations !== b.crossingLaneReservations) return a.crossingLaneReservations > b.crossingLaneReservations
    if (Math.abs(a.canvasWasteRatio - b.canvasWasteRatio) > 0.001) return a.canvasWasteRatio < b.canvasWasteRatio
    return a.canvasWasteArea <= b.canvasWasteArea + 0.1
  }

  function buildC4ValidatedScene(model, gapOverrides = new Map()) {
    const scene = layoutC4Scene(model, gapOverrides)
    const workItems = c4BuildWorkItems(model, scene)
    c4AssignLabels(workItems, model, scene)
    const repairSummary = c4RepairWorkItems(model, scene, workItems)
    const validation = c4BuildValidationScene(model, scene, workItems)
    const issues = c4ValidateScene(validation)
    const quality = c4SceneQuality(scene, workItems, validation, issues)
    return { scene, workItems, repairSummary, validation, issues, quality }
  }

  function selectC4ValidatedScene(model) {
    const initial = buildC4ValidatedScene(model)
    const gapOverrides = c4DeriveGapOverrides(model, initial.scene, initial.workItems)
    if (!gapOverrides.size) return initial
    const compact = buildC4ValidatedScene(model, gapOverrides)
    if (c4SceneCandidateBetter(compact, initial)) return compact
    const compactSummary = compact.quality.summary
    const initialSummary = initial.quality.summary
    const widthReduction = initial.scene.width - compact.scene.width
    const substantialWidthReduction = widthReduction >= 70
    const localWidthReduction = widthReduction >= 30
    const preservesRouteQuality = compact.quality.labelCount >= initial.quality.labelCount
      && compact.quality.unroutableCount <= initial.quality.unroutableCount
      && compact.quality.totalDetour <= initial.quality.totalDetour + 0.1
      && compact.quality.totalBends <= initial.quality.totalBends
      && compactSummary.hardCount <= initialSummary.hardCount
      && compactSummary.softPenalty <= initialSummary.softPenalty + 0.1
    const preservesLocalRouteQuality = compact.quality.labelCount >= initial.quality.labelCount
      && compact.quality.unroutableCount <= initial.quality.unroutableCount
      && compact.quality.totalDetour <= initial.quality.totalDetour + 20
      && compact.quality.totalBends <= initial.quality.totalBends
      && compactSummary.hardCount <= initialSummary.hardCount
      && compactSummary.softPenalty <= initialSummary.softPenalty + 0.1
    const verticalRelations = model.relations.filter((rel) => rel.direction === 'down' || rel.direction === 'up')
    const flatFanout = model.relations.length > 0
      && verticalRelations.length === model.relations.length
      && [...model.nodes.values()].every((node) => !isC4Boundary(node) && !node.external)
      && (new Set(model.relations.map((rel) => rel.from)).size === 1 || new Set(model.relations.map((rel) => rel.to)).size === 1)
    const preservesFlatFanoutQuality = compact.quality.labelCount >= initial.quality.labelCount
      && compact.quality.unroutableCount <= initial.quality.unroutableCount
      && compact.quality.totalDetour <= initial.quality.totalDetour + 0.1
      && compact.quality.totalBends <= initial.quality.totalBends
      && compactSummary.hardCount <= initialSummary.hardCount
      && compactSummary.softPenalty <= initialSummary.softPenalty + 0.1
    return (substantialWidthReduction && preservesRouteQuality)
      || (initialSummary.softCount > 0 && localWidthReduction && preservesLocalRouteQuality)
      || (flatFanout && widthReduction >= 20 && preservesFlatFanoutQuality)
      ? compact
      : initial
  }

  function c4Icon(node, box) {
    const t = theme()
    const left = box.x + 18
    const top = box.y + 22
    if (node.kind === 'Person') {
      return `${circle(left + 10, top + 8, 7, 'none', t.accent)}${line(left + 10, top + 16, left + 10, top + 33, t.accent)}${line(left + 1, top + 23, left + 19, top + 23, t.accent)}${line(left + 10, top + 33, left + 2, top + 43, t.accent)}${line(left + 10, top + 33, left + 18, top + 43, t.accent)}`
    }
    if (isC4DataStore(node)) {
      const topD = `M ${f1(left + 2)} ${f1(top + 6)} C ${f1(left + 2)} ${f1(top - 2)}, ${f1(left + 28)} ${f1(top - 2)}, ${f1(left + 28)} ${f1(top + 6)} C ${f1(left + 28)} ${f1(top + 14)}, ${f1(left + 2)} ${f1(top + 14)}, ${f1(left + 2)} ${f1(top + 6)}`
      const bodyD = `M ${f1(left + 2)} ${f1(top + 6)} L ${f1(left + 2)} ${f1(top + 24)} M ${f1(left + 28)} ${f1(top + 6)} L ${f1(left + 28)} ${f1(top + 24)} M ${f1(left + 2)} ${f1(top + 24)} C ${f1(left + 2)} ${f1(top + 32)}, ${f1(left + 28)} ${f1(top + 32)}, ${f1(left + 28)} ${f1(top + 24)}`
      return `${path(topD, t.accent, 1.8)}${path(bodyD, t.accent, 1.8)}`
    }
    return `${rect(left, top, 28, 20, 8, 'none', t.accent)}${line(left + 6, top + 7, left + 22, top + 7, t.accent)}${line(left + 6, top + 13, left + 18, top + 13, t.accent)}`
  }

  function renderC4Node(id, model, layouts) {
    const t = theme()
    const node = model.nodes.get(id)
    const box = layouts.get(id)
    if (!node || !box) return ''
    const fill = t.mode === 'light' && isC4Boundary(node)
      ? 'none'
      : node.external || isC4Boundary(node)
        ? t.surfaceSoft
        : t.mode === 'light' && isC4DataStore(node)
          ? t.surface
          : isC4DataStore(node)
            ? t.surfaceAlt
            : t.surface
    if (isC4Boundary(node)) {
      const children = node.children
        .slice()
        .sort((a, b) => (layouts.get(a)?.y || 0) - (layouts.get(b)?.y || 0) || (layouts.get(a)?.x || 0) - (layouts.get(b)?.x || 0) || a.localeCompare(b))
        .map((child) => renderC4Node(child, model, layouts))
        .join('')
      return `<g data-c4-node="${attr(c4NodeBadge(node))}" data-c4-id="${attr(id)}">${rect(box.x, box.y, box.w, box.h, 22, fill, t.borderStrong)}${c4Text(box.x + 18, box.y + 20, c4NodeBadge(node), 11, 720, t.accent)}${c4Text(box.x + 18, box.y + 46, node.label, 16, 720, t.text)}${line(box.x + 18, box.y + box.headerH, box.x + box.w - 18, box.y + box.headerH, t.grid)}${children}</g>`
    }
    const dash = node.external ? ' stroke-dasharray="8 4"' : ''
    const wrapW = Math.max(96, box.w - C4.nodeTextX - C4.nodeTextRightMargin - 12)
    const titleLines = c4WrapNodeLines(node.label || node.id, wrapW, 15, 2)
    const technologyLines = node.technology ? c4WrapNodeLines(node.technology, wrapW, 11, 2, 650) : []
    const detailLines = node.detail ? c4WrapNodeLines(node.detail, wrapW, 11, 2, 500) : []
    const titleText = titleLines.map((lineValue, index) => c4Text(box.x + C4.nodeTextX, box.y + 47 + index * 17, lineValue, 15, 720, t.text)).join('')
    let metaY = box.y + 70 + Math.max(0, titleLines.length - 1) * 17
    const techText = technologyLines.map((lineValue) => {
      const markup = c4Text(box.x + C4.nodeTextX, metaY, lineValue, 11, 650, t.muted)
      metaY += 17
      return markup
    }).join('')
    const detailText = detailLines.map((lineValue) => {
      const markup = c4Text(box.x + C4.nodeTextX, metaY, lineValue, 11, 500, t.muted)
      metaY += 17
      return markup
    }).join('')
    return `<g data-c4-node="${attr(c4NodeBadge(node))}" data-c4-id="${attr(id)}"><rect x="${f1(box.x)}" y="${f1(box.y)}" width="${f1(box.w)}" height="${f1(box.h)}" rx="18" fill="${fill}" stroke="${t.borderStrong}" stroke-width="1.5"${dash}/>${c4Icon(node, box)}${c4Text(box.x + C4.nodeTextX, box.y + 24, c4NodeBadge(node), 10.5, 720, t.accent)}${titleText}${techText}${detailText}</g>`
  }

  function renderC4RelationLabel(placement, t) {
    return placement.lines.map((lineValue, index) => {
      const y = placement.rect.top + 14 + index * 17
      if (placement.centered) {
        return c4Text((placement.rect.left + placement.rect.right) / 2, y, lineValue, 11, 650, t.muted, 'middle')
      }
      if (placement.alignEnd) {
        return c4Text(placement.rect.right - 6, y, lineValue, 11, 650, t.muted, 'end')
      }
      return c4Text(placement.rect.left + 6, y, lineValue, 11, 650, t.muted)
    }).join('')
  }

  function renderC4Component(source) {
    const t = theme()
    const model = parseC4Model(source)
    if (!model.nodes.size) throw new Error('C4Component diagram requires at least one node')
    const { scene, workItems, repairSummary, validation, issues } = selectC4ValidatedScene(model)
    const edgeLayer = workItems.map((item) => {
      if (!item.route) return ''
      const label = item.displayLabel
      const placement = item.labelPlacement
      const labelMarkup = label && placement ? renderC4RelationLabel(placement, t) : ''
      return `<g data-c4-rel="${dataAttr(item.rel.from)}->${dataAttr(item.rel.to)}:${dataAttr(item.rel.tag || c4RelationTag(item.rel.direction))}">${rustPolylineArrowheads(item.route.points, t.link, false, false, true, 2)}${labelMarkup}</g>`
    }).join('')
    const validationMarkup = issues.length
      ? `<metadata data-c4-validation-issues="${attr(JSON.stringify(issues.slice(0, 20)))}" data-c4-repair-summary="${attr(JSON.stringify(repairSummary))}" data-c4-label-lane-reservations="${attr(String(validation.labelLaneReservations.length))}" data-c4-crossing-lane-reservations="${attr(String(validation.crossingLaneReservations.length))}"></metadata>`
      : `<metadata data-c4-validation-issues="[]" data-c4-repair-summary="${attr(JSON.stringify(repairSummary))}" data-c4-label-lane-reservations="${attr(String(validation.labelLaneReservations.length))}" data-c4-crossing-lane-reservations="${attr(String(validation.crossingLaneReservations.length))}"></metadata>`
    const nodeLayer = model.rootChildren
      .slice()
      .sort((a, b) => (scene.layouts.get(a)?.y || 0) - (scene.layouts.get(b)?.y || 0) || (scene.layouts.get(a)?.x || 0) - (scene.layouts.get(b)?.x || 0) || a.localeCompare(b))
      .map((id) => renderC4Node(id, model, scene.layouts))
      .join('')
    return rustSvgWithTitle(scene.width, scene.height, model.title, `${validationMarkup}${nodeLayer}${edgeLayer}`, 'C4 component diagram')
  }

  function renderErDiagram(source) {
    const t = theme()
    const E = {
      entityW: 200,
      headerH: 32,
      rowH: 22,
      bodyPadY: 10,
      minH: 54,
      rx: 4,
      textSize: 12,
      headerTextSize: 13,
      rootPadX: 48,
      rootPadY: 36,
      gapX: 80,
      gapY: 80,
      portPitch: 20,
      crowsFootSize: 13,
      circleR: 5.5,
    }
    const entities = new Map()
    const entityOrder = []
    const rels = []
    let current = null
    const ensureEntity = (id) => {
      if (!entities.has(id)) {
        entities.set(id, [])
        entityOrder.push(id)
      }
    }
    const parseCardinality = (value) => {
      const hasO = value.includes('o')
      const hasBrace = value.includes('{') || value.includes('}')
      if (!hasO && !hasBrace) return 'one'
      if (hasO && !hasBrace) return 'zeroOne'
      if (!hasO && hasBrace) return 'many'
      return 'zeroMany'
    }
    const parseAttribute = (row) => {
      const tokens = []
      let inQuote = false
      let token = ''
      for (const ch of row.trim()) {
        if (ch === '"') {
          inQuote = !inQuote
          token += ch
        } else if (/\s/.test(ch) && !inQuote) {
          if (token) {
            tokens.push(token)
            token = ''
          }
        } else token += ch
      }
      if (token) tokens.push(token)
      if (tokens.length < 2) return null
      let key = ''
      let comment = ''
      tokens.slice(2).forEach((part) => {
        if (part === 'PK' || part === 'FK' || part === 'UK') key = part
        else if (/^".*"$/.test(part)) comment = part.slice(1, -1)
      })
      return { type: tokens[0], name: tokens[1], key, comment }
    }
    for (const row of linesOf(source).slice(1)) {
      if (row.endsWith('{')) {
        const entityId = row.slice(0, -1).trim()
        if (!entityId) continue
        current = entityId
        ensureEntity(current)
        continue
      }
      if (row === '}') {
        current = null
        continue
      }
      if (current) {
        const attrRow = parseAttribute(row)
        if (attrRow) entities.get(current).push(attrRow)
        continue
      }
      const colon = row.lastIndexOf(':')
      if (colon >= 0) {
        const tokens = row.slice(0, colon).trim().split(/\s+/).filter(Boolean)
        if (tokens.length !== 3) continue
        const connector = tokens[1]
        const split = connector.includes('--') ? connector.split('--') : connector.split('..')
        if (split.length !== 2 || !split[0] || !split[1]) continue
        ensureEntity(tokens[0])
        ensureEntity(tokens[2])
        rels.push({
          from: tokens[0],
          to: tokens[2],
          fromCard: parseCardinality(split[0]),
          toCard: parseCardinality(split[1]),
          dashed: connector.includes('..'),
          label: rawMermaidText(row.slice(colon + 1)),
        })
      }
    }
    const names = entityOrder
    const sizes = new Map(names.map((name) => [name, { w: E.entityW, h: Math.max(E.minH, E.headerH + E.bodyPadY * 2 + entities.get(name).length * E.rowH) }]))
    const rankConstraints = []
    rels.forEach((rel) => pushUniqueConstraint(rankConstraints, rel.from, rel.to))
    const layout = buildLayeredLayout({
      ids: names,
      sizes,
      relations: rels.map((rel) => ({ from: rel.from, to: rel.to, weight: 1 })),
      rankConstraints,
      gapX: E.gapX,
      gapY: E.gapY,
    })
    const positions = new Map()
    layout.positions.forEach((p, id) => positions.set(id, { x: p.x + E.rootPadX, y: p.y + E.rootPadY, w: p.w, h: p.h }))
    const width = Math.max(300, Math.max(...[...positions.values()].map((p) => p.x + p.w), 204) + E.rootPadX)
    const height = Math.max(200, Math.max(...[...positions.values()].map((p) => p.y + p.h), 128) + E.rootPadY)
    const erSideVector = (side) => {
      if (side === 'top') return { x: 0, y: -1 }
      if (side === 'bottom') return { x: 0, y: 1 }
      if (side === 'left') return { x: -1, y: 0 }
      return { x: 1, y: 0 }
    }
    const erAnchorSide = (from, to) => sideForBoxes(from, to)
    const erAnchor = (box, side, offset = 0) => {
      const base = anchorOnBox(box, side)
      return side === 'top' || side === 'bottom' ? { x: base.x + offset, y: base.y } : { x: base.x, y: base.y + offset }
    }
    const erMarkerLine = (base, dx, dy) => {
      const px = -dy
      const py = dx
      const half = E.crowsFootSize / 2
      return line(base.x - px * half, base.y - py * half, base.x + px * half, base.y + py * half, t.link, 1.5)
    }
    const erOneMarker = (point, dx, dy) => `${erMarkerLine({ x: point.x + dx * 3, y: point.y + dy * 3 }, dx, dy)}${erMarkerLine({ x: point.x + dx * 7, y: point.y + dy * 7 }, dx, dy)}`
    const erCrowMarker = (point, dx, dy) => {
      const px = -dy
      const py = dx
      const base = { x: point.x + dx * E.crowsFootSize, y: point.y + dy * E.crowsFootSize }
      const left = { x: base.x - px * E.crowsFootSize / 2, y: base.y - py * E.crowsFootSize / 2 }
      const right = { x: base.x + px * E.crowsFootSize / 2, y: base.y + py * E.crowsFootSize / 2 }
      return `${line(point.x, point.y, base.x, base.y, t.link, 1.5)}${line(point.x, point.y, left.x, left.y, t.link, 1.5)}${line(point.x, point.y, right.x, right.y, t.link, 1.5)}`
    }
    const erCardinalityMarker = (point, side, cardinality) => {
      const v = erSideVector(side)
      const erCircle = (cx, cy) => `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(E.circleR)}" fill="${t.surface}" stroke="${t.link}" stroke-width="1.5"/>`
      if (cardinality === 'one') return erOneMarker(point, v.x, v.y)
      if (cardinality === 'zeroOne') {
        const cx = point.x + v.x * (E.circleR + 2)
        const cy = point.y + v.y * (E.circleR + 2)
        return `${erCircle(cx, cy)}${erMarkerLine({ x: point.x + v.x * (E.circleR * 2 + 4), y: point.y + v.y * (E.circleR * 2 + 4) }, v.x, v.y)}`
      }
      if (cardinality === 'many') return erCrowMarker(point, v.x, v.y)
      const cx = point.x + v.x * (E.circleR + 2)
      const cy = point.y + v.y * (E.circleR + 2)
      return `${erCircle(cx, cy)}${erCrowMarker({ x: point.x + v.x * (E.circleR * 2 + 4), y: point.y + v.y * (E.circleR * 2 + 4) }, v.x, v.y)}`
    }
    const edgeSides = rels.map((rel) => {
      const a = positions.get(rel.from)
      const b = positions.get(rel.to)
      return a && b ? erAnchorSide(a, b) : null
    })
    const offsetGroups = (pickId, pickSide, pickAxis, pickBox) => {
      const groups = new Map()
      rels.forEach((rel, index) => {
        const sides = edgeSides[index]
        if (!sides) return
        const key = `${pickId(rel)}:${pickSide(sides)}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push({ index, side: pickSide(sides), axis: pickAxis(rel), box: pickBox(rel) })
      })
      const offsets = new Map()
      groups.forEach((items) => {
        if (items.length <= 1) {
          items.forEach((item) => offsets.set(item.index, 0))
          return
        }
        items.sort((a, b) => a.axis - b.axis || a.index - b.index)
        const side = items[0].side
        const maxSpread = side === 'top' || side === 'bottom' ? Math.max(0, items[0].box.w / 2 - 12) : Math.max(0, items[0].box.h / 2 - 8)
        const pitch = Math.min(E.portPitch, maxSpread * 2 / Math.max(1, items.length - 1))
        const startOffset = -(pitch * (items.length - 1)) / 2
        items.forEach((item, itemIndex) => offsets.set(item.index, startOffset + pitch * itemIndex))
      })
      return offsets
    }
    const fromOffsets = offsetGroups(
      (rel) => rel.from,
      (sides) => sides[0],
      (rel) => {
        const box = positions.get(rel.to)
        const side = edgeSides[rels.indexOf(rel)]?.[0]
        return side === 'left' || side === 'right' ? box.y + box.h / 2 : box.x + box.w / 2
      },
      (rel) => positions.get(rel.from),
    )
    const toOffsets = offsetGroups(
      (rel) => rel.to,
      (sides) => sides[1],
      (rel) => {
        const box = positions.get(rel.from)
        const side = edgeSides[rels.indexOf(rel)]?.[1]
        return side === 'left' || side === 'right' ? box.y + box.h / 2 : box.x + box.w / 2
      },
      (rel) => positions.get(rel.to),
    )
    const relMarkup = rels.map((rel, index) => {
      const a = positions.get(rel.from)
      const b = positions.get(rel.to)
      if (!a || !b) return ''
      const sides = edgeSides[index] || erAnchorSide(a, b)
      const start = erAnchor(a, sides[0], fromOffsets.get(index) || 0)
      const end = erAnchor(b, sides[1], toOffsets.get(index) || 0)
      const av = erSideVector(sides[0])
      const bv = erSideVector(sides[1])
      const routedA = { x: start.x - a.w / 2 + (sides[0] === 'left' ? 0 : sides[0] === 'right' ? -a.w : 0), y: start.y - a.h / 2 + (sides[0] === 'top' ? 0 : sides[0] === 'bottom' ? -a.h : 0), w: a.w, h: a.h }
      const routedB = { x: end.x - b.w / 2 + (sides[1] === 'left' ? 0 : sides[1] === 'right' ? -b.w : 0), y: end.y - b.h / 2 + (sides[1] === 'top' ? 0 : sides[1] === 'bottom' ? -b.h : 0), w: b.w, h: b.h }
      let route = routeOrthogonalWithSides(routedA, routedB, sides[0], sides[1], [], 24)
      route[0] = start
      route[route.length - 1] = end
      route = simplifyPolyline(route)
      const mid = route[Math.floor(route.length / 2)]
      const d = route.map((p, pointIndex) => `${pointIndex ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
      const dash = rel.dashed ? ' stroke-dasharray="7 5"' : ''
      const label = rel.label
        ? (() => {
            const labelW = c4EstimateTextWidth(rel.label, 11, 500) + 14
            const labelY = mid.y - 24
            return `<rect x="${(mid.x - labelW / 2).toFixed(1)}" y="${labelY.toFixed(1)}" width="${labelW.toFixed(1)}" height="20" rx="10" fill="${t.surface}" stroke="${t.border}" stroke-width="1"/>${text(mid.x, labelY + 10, rel.label, 11, 500, t.muted)}`
          })()
        : ''
      return `<g data-er-rel="${dataAttr(`${rel.from}->${rel.to}`)}"><path d="${attr(d)}" fill="none" stroke="${t.link}" stroke-width="2"${dash} stroke-linecap="round" stroke-linejoin="round"/>${erCardinalityMarker(start, sides[0], rel.fromCard)}${erCardinalityMarker(end, sides[1], rel.toCard)}</g>${label}`
    }).join('')
    const erBadge = (x, y, key) => {
      if (!key) return { markup: '', width: 0 }
      const color = key === 'PK' ? t.success : key === 'FK' ? t.accent : t.warn
      const badgeW = c4EstimateTextWidth(key, E.textSize - 1, 700) + 10
      return {
        markup: `<rect x="${x - 3}" y="${(y - 7.5).toFixed(1)}" width="${badgeW.toFixed(1)}" height="15" rx="3" fill="${color}" fill-opacity="0.18" stroke="none"/>${text(x, y, key, E.textSize - 1, 700, color, 'start')}`,
        width: badgeW + 4,
      }
    }
    const entityMarkup = names.map((name, colorIndex) => {
      const fields = entities.get(name) || []
      const p = positions.get(name)
      const headerTint = [t.accent, t.success, t.warn, t.danger, t.muted][colorIndex % 5]
      const rows = fields.map((field, rowIndex) => {
        const rowY = p.y + E.headerH + E.bodyPadY + rowIndex * E.rowH
        const textY = rowY + E.rowH / 2
        const badge = erBadge(p.x + 12, textY, field.key)
        const attrText = `${field.type} ${field.name}`
        const comment = field.comment ? text(p.x + p.w - 8, textY, field.comment, 11, 400, t.muted, 'end') : ''
        return `${badge.markup}${text(p.x + 12 + badge.width, textY, attrText, E.textSize, 400, t.text, 'start')}${comment}`
      }).join('')
      return `<g data-er-entity="${attr(name)}">${rect(p.x, p.y, p.w, p.h, E.rx, t.surface, t.border)}<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${E.headerH}" rx="${E.rx}" fill="${t.surfaceAlt}" stroke="none"/><rect x="${p.x}" y="${p.y + E.headerH - E.rx}" width="${p.w}" height="${E.rx}" fill="${t.surfaceAlt}" stroke="none"/><rect x="${p.x + 0.5}" y="${p.y + 0.5}" width="${p.w - 1}" height="${E.headerH - 1}" fill="${headerTint}" fill-opacity="0.15" stroke="none"/>${line(p.x, p.y + E.headerH, p.x + p.w, p.y + E.headerH, t.border)}${text(p.x + p.w / 2, p.y + E.headerH / 2, name, E.headerTextSize, 700, t.text)}${rows}</g>`
    }).join('')
    return rustSvg(width, height, `${entityMarkup}${relMarkup}`, 'ER diagram')
  }

  function renderJourney(source) {
    const t = theme()
    const sections = []
    let title = 'Journey'
    let current = { name: '', steps: [] }
    const pushCurrent = () => {
      if (current.name || current.steps.length) sections.push(current)
    }
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title ')) {
        title = row.slice('title '.length).trim()
      } else if (row.startsWith('section ')) {
        pushCurrent()
        current = { name: row.slice('section '.length).trim(), steps: [] }
      } else {
        const parts = row.split(':').map((part) => part.trim())
        if (parts.length >= 2) {
          const actors = parts.pop() || ''
          const rawScore = Number.parseInt(parts.pop() || '', 10)
          const score = Math.max(1, Math.min(5, Number.isFinite(rawScore) ? rawScore : 3))
          current.steps.push({ label: parts.join(': '), score, actors })
        }
      }
    }
    pushCurrent()
    if (!sections.length) throw new Error('journey requires at least one section')

    const width = 920
    const sectionX = 28
    const sectionW = width - 56
    const sectionInnerX = sectionX + 20
    const sectionTitleGap = 52
    const rowGap = 16
    const rowX = sectionInnerX
    const rowW = sectionW - 40
    const ratingMarginRight = 34
    const ratingGap = 24
    const ratingRadius = 7
    const ratingSpan = ratingGap * 4
    const ratingStartX = rowX + rowW - ratingMarginRight - ratingSpan
    const textX = rowX + 18
    const textW = ratingStartX - textX - 42
    let y = 72
    const body = []

    sections.forEach((section) => {
      const rowLayouts = section.steps.map((step) => {
        const labelLines = c4WrapText(step.label, textW, 13, 600)
        const actorLines = step.actors ? c4WrapText(step.actors, textW, 11, 600) : []
        const labelHeight = labelLines.length * 17
        const actorHeight = actorLines.length * 13
        const metaGap = actorLines.length ? 7 : 0
        return {
          labelLines,
          actorLines,
          height: Math.max(62, labelHeight + actorHeight + metaGap + 28),
        }
      })
      const rowsHeight = rowLayouts.reduce((sum, row) => sum + row.height, 0)
      const sectionHeight = 24 + sectionTitleGap + rowsHeight + rowGap * Math.max(0, rowLayouts.length - 1) + 20
      body.push(rect(sectionX, y, sectionW, sectionHeight, 18, t.surfaceAlt, t.border))
      body.push(c4Text(sectionInnerX, y + 34, section.name, 16, 700, t.text))
      let rowY = y + 52
      section.steps.forEach((step, index) => {
        const rowLayout = rowLayouts[index]
        body.push(rect(rowX, rowY, rowW, rowLayout.height, 16, t.surface, t.border))
        const labelBlockH = rowLayout.labelLines.length * 17
        const actorBlockH = rowLayout.actorLines.length * 13
        const actorGap = rowLayout.actorLines.length ? 7 : 0
        const textBlockH = labelBlockH + actorGap + actorBlockH
        const textTop = rowY + Math.max(12, (rowLayout.height - textBlockH) / 2)
        rowLayout.labelLines.forEach((lineValue, lineIndex) => {
          body.push(c4Text(textX, textTop + 12 + lineIndex * 17, lineValue, 13, 650, t.text))
        })
        rowLayout.actorLines.forEach((lineValue, lineIndex) => {
          body.push(c4Text(textX, textTop + labelBlockH + actorGap + 10 + lineIndex * 13, lineValue, 11, 500, t.muted))
        })
        const scoreCenterY = rowY + rowLayout.height / 2
        for (let dot = 0; dot < 5; dot += 1) {
          body.push(circle(ratingStartX + dot * ratingGap, scoreCenterY, ratingRadius, dot < step.score ? t.accent : t.surfaceSoft, 'none'))
        }
        rowY += rowLayout.height + rowGap
      })
      y += sectionHeight + 18
    })
    return rustSvgWithTitle(width, y + 18, title, body.join(''), 'Journey')
  }

  function renderGantt(source) {
    const t = theme()
    const tasks = []
    let section = 'Tasks'
    let title = 'Gantt'
    const palette = Array.from({ length: 6 }, (_, index) => rustPalette(index))
    const parseDate = (value) => {
      const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!match) return null
      const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
      if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null
      return date
    }
    const dayNumber = (d) => {
      const y = d.month <= 2 ? d.year - 1 : d.year
      const m = d.month <= 2 ? d.month + 13 : d.month + 1
      return Math.trunc((1461 * y) / 4) + Math.trunc((153 * m) / 5) + d.day
    }
    const daysBetween = (a, b) => dayNumber(a) - dayNumber(b)
    const addDays = (d, days) => {
      const daysInMonth = (year, month) => {
        if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31
        if ([4, 6, 9, 11].includes(month)) return 30
        if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
        return 30
      }
      let year = d.year
      let month = d.month
      let day = d.day + days
      while (day > daysInMonth(year, month)) {
        day -= daysInMonth(year, month)
        month += 1
        if (month > 12) {
          month = 1
          year += 1
        }
      }
      while (day < 1) {
        if (month === 1) {
          month = 12
          year -= 1
        } else month -= 1
        day += daysInMonth(year, month)
      }
      return { year, month, day }
    }
    const dateLabel = (d) => `${d.month}/${d.day}`
    const truncateLabel = (value, maxWidth = 160) => {
      const textValue = String(value || '')
      if (c4EstimateTextWidth(textValue, 12, 500) <= maxWidth) return textValue
      let truncated = textValue
      while (c4EstimateTextWidth(truncated, 12, 500) > maxWidth - 12 && truncated.length > 1) {
        truncated = truncated.slice(0, -1)
      }
      return `${truncated}…`
    }
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title ')) title = row.slice('title '.length).trim()
      else if (row.startsWith('section ')) section = row.slice('section '.length).trim()
      else if (['dateFormat ', 'axisFormat ', 'todayMarker ', 'excludes ', 'tickInterval '].some((prefix) => row.startsWith(prefix))) continue
      else if (row.includes(':')) {
        const [nameRaw, restRaw] = row.split(/:(.+)/)
        const parts = restRaw.split(',').map((part) => part.trim()).filter(Boolean)
        const durationMatch = parts.map((part) => part.match(/^(\d+)\s*([dw])$/)).find(Boolean)
        const start = parts.map(parseDate).find(Boolean) || null
        tasks.push({
          name: rawMermaidText(nameRaw),
          section,
          state: parts[0] || '',
          start,
          days: durationMatch ? Number(durationMatch[1]) * (durationMatch[2] === 'w' ? 7 : 1) : 3,
        })
      }
    }
    if (!tasks.length) throw new Error('gantt requires at least one task')
    const sections = []
    let currentSection = ''
    tasks.forEach((task, index) => {
      if (task.section !== currentSection) {
        sections.push({ name: task.section, indices: [index] })
        currentSection = task.section
      } else sections[sections.length - 1].indices.push(index)
    })
    const fallbackMin = { year: 2026, month: 1, day: 1 }
    const starts = tasks.map((task) => task.start).filter(Boolean)
    const minDate = starts.length ? starts.reduce((min, d) => dayNumber(d) < dayNumber(min) ? d : min, starts[0]) : fallbackMin
    const totalDays = Math.max(7, Math.max(...tasks.map((task, index) => (task.start ? daysBetween(task.start, minDate) : index * 2) + task.days)))
    const labelW = 200
    const chartLeft = labelW + 18
    const rawChartW = totalDays * 16
    const dayW = rawChartW > 820 ? 820 / totalDays : 16
    const chartW = totalDays * dayW
    const rowH = 36
    const sectionH = 26
    const axisH = 28
    const topY = 76
    const contentY = topY + axisH
    const contentH = sections.reduce((sum, sec) => sum + sectionH + sec.indices.length * rowH, 0)
    const width = Math.max(720, chartLeft + chartW + 40)
    const height = contentY + contentH + 24
    const tickInterval = totalDays > 90 ? 14 : 7
    const gridLayer = []
    const labelLayer = []
    for (let day = 0; day <= totalDays; day += tickInterval) {
      const gx = chartLeft + day * dayW
      if (gx > width - 20) break
      labelLayer.push(text(gx, topY + 18, dateLabel(addDays(minDate, day)), 10, 500, t.muted))
      gridLayer.push(`<line x1="${gx.toFixed(1)}" y1="${contentY.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${(contentY + contentH).toFixed(1)}" stroke="${t.muted}" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.35"/>`)
    }
    gridLayer.push(line(0, contentY, width, contentY, t.border))
    gridLayer.push(line(labelW, topY, labelW, contentY + contentH, t.border))
    let y = contentY
    const backgroundLayer = []
    const foregroundLayer = []
    sections.forEach((sec, secIndex) => {
      const secColor = palette[secIndex % palette.length]
      backgroundLayer.push(`<rect x="0" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${sectionH}" fill="${secColor}" fill-opacity="0.10" stroke="none"/>`)
      foregroundLayer.push(text(16, y + 18, sec.name, 11, 700, secColor, 'start'))
      y += sectionH
      sec.indices.forEach((taskIndex, localIndex) => {
        const task = tasks[taskIndex]
        if (localIndex % 2 === 1) backgroundLayer.push(`<rect x="0" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${rowH}" fill="${t.text}" fill-opacity="0.03" stroke="none"/>`)
        gridLayer.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${width.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${t.muted}" stroke-width="0.5" opacity="0.12"/>`)
        foregroundLayer.push(text(24, y + 22, truncateLabel(task.name, labelW - 40), 12, 500, t.text, 'start'))
        const startDays = task.start ? daysBetween(task.start, minDate) : taskIndex * 2
        const bx = chartLeft + startDays * dayW
        const bw = Math.max(32, Math.max(1, task.days) * dayW)
        const fill = task.state.includes('done') ? t.success : task.state.includes('active') ? t.accent : secColor
        foregroundLayer.push(rect(bx, y + 9, bw, 18, 9, fill, 'none'))
        const durLabel = `${task.days}d`
        if (bw > c4EstimateTextWidth(durLabel, 10, 700) + 12) foregroundLayer.push(text(bx + 8, y + 22, durLabel, 10, 700, t.surface, 'start'))
        y += rowH
      })
    })
    return rustSvgWithTitle(width, height, title, `${backgroundLayer.join('')}${gridLayer.join('')}${labelLayer.join('')}${foregroundLayer.join('')}`, 'Gantt chart')
  }

  function renderPie(source) {
    const t = theme()
    const rows = linesOf(source).slice(1)
    let title = 'Pie'
    const slices = []
    const palette = Array.from({ length: 6 }, (_, index) => rustPalette(index))
    for (const row of rows) {
      if (row.startsWith('title ')) {
        title = row.slice('title '.length).trim()
        continue
      }
      if (row.startsWith('showData')) continue
      const colon = row.indexOf(':')
      if (colon >= 0) {
        const value = Number(row.slice(colon + 1).trim())
        if (Number.isFinite(value) && value > 0) slices.push({ label: rustStripQuotes(row.slice(0, colon).trim()), value })
      }
    }
    if (!slices.length) throw new Error('pie requires at least one slice')
    const total = slices.reduce((sum, item) => sum + item.value, 0) || 1
    let angle = -Math.PI / 2
    const cx = 250
    const cy = 220
    const r = 110
    const arcs = slices.map((slice, index) => {
      const span = (slice.value / total) * Math.PI * 2
      const end = angle + span
      const x1 = cx + Math.cos(angle) * r
      const y1 = cy + Math.sin(angle) * r
      const x2 = cx + Math.cos(end) * r
      const y2 = cy + Math.sin(end) * r
      const large = span > Math.PI ? 1 : 0
      angle = end
      return `<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${palette[index % palette.length]}" stroke="#ffffff" stroke-width="1.5"/>`
    }).join('')
    const legend = slices.map((slice, index) => {
      const y = 132 + index * 32
      return `${rect(500, y - 10, 16, 16, 8, palette[index % palette.length], 'none')}${text(528, y + 2, slice.label, 13, 650, t.text, 'start')}${text(740, y + 2, slice.value.toFixed(0), 13, 700, t.muted, 'start')}`
    }).join('')
    return rustSvgWithTitle(900, 430, title, `${arcs}${legend}`, 'Pie chart')
  }

  function renderQuadrantChart(source) {
    const t = theme()
    let title = 'Quadrant'
    let xAxis = ['Low', 'High']
    let yAxis = ['Low', 'High']
    const quadrants = ['Quadrant 1', 'Quadrant 2', 'Quadrant 3', 'Quadrant 4']
    const points = []
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title ')) {
        title = row.slice('title '.length).trim()
      } else if (row.startsWith('x-axis ')) {
        const parts = row.slice('x-axis '.length).split('-->')
        if (parts.length >= 2) xAxis = [parts[0].trim(), parts.slice(1).join('-->').trim()]
      } else if (row.startsWith('y-axis ')) {
        const parts = row.slice('y-axis '.length).split('-->')
        if (parts.length >= 2) yAxis = [parts[0].trim(), parts.slice(1).join('-->').trim()]
      } else if (row.includes(' ')) {
        const [name, labelRest] = row.split(/ (.*)/)
        const quadrant = name.startsWith('quadrant-') ? Number(name.slice('quadrant-'.length)) : 0
        if (quadrant >= 1 && quadrant <= 4) {
          quadrants[quadrant - 1] = (labelRest || '').trim()
          continue
        }
        const colon = row.indexOf(':')
        if (colon >= 0) {
          const label = rustStripQuotes(row.slice(0, colon).trim())
          const coord = row.slice(colon + 1).trim().replace(/^\[/, '').replace(/\]$/, '')
          const comma = coord.indexOf(',')
          if (comma >= 0) {
            const rawX = Number(coord.slice(0, comma).trim())
            const rawY = Number(coord.slice(comma + 1).trim())
            const x = Math.max(0, Math.min(1, Number.isFinite(rawX) ? rawX : 0.5))
            const y = Math.max(0, Math.min(1, Number.isFinite(rawY) ? rawY : 0.5))
            points.push({ label, x, y })
          }
        }
      }
    }

    const width = 860
    const height = 520
    const left = 110
    const top = 110
    const chartW = 620
    const chartH = 320
    const midX = left + chartW / 2
    const midY = top + chartH / 2
    const halfW = chartW / 2
    const halfH = chartH / 2
    const qText = (x, y, value, size, weight, fill) => `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" font-family="${UI_FONT}" font-size="${f1(size)}" font-weight="${weight}">${escapeHtml(value)}</text>`
    const qTextMiddle = (x, y, value, size, weight, fill) => `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" dominant-baseline="middle" font-family="${UI_FONT}" font-size="${f1(size)}" font-weight="${weight}">${escapeHtml(value)}</text>`
    const qTextEnd = (x, y, value, size, weight, fill) => `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" text-anchor="end" font-size="${f1(size)}" font-weight="${weight}" font-family="${UI_FONT}">${escapeHtml(value)}</text>`
    const body = []
    body.push(`<defs><clipPath id="qclip"><rect x="${f1(left)}" y="${f1(top)}" width="${f1(chartW)}" height="${f1(chartH)}" rx="20.0"/></clipPath></defs>`)
    body.push('<g clip-path="url(#qclip)">')
    ;[
      [left, top, halfW, halfH, rustPalette(1)],
      [midX, top, halfW, halfH, rustPalette(0)],
      [left, midY, halfW, halfH, rustPalette(3)],
      [midX, midY, halfW, halfH, rustPalette(2)],
    ].forEach(([x, y, w, h, fill]) => {
      body.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" fill="${fill}" fill-opacity="0.08"/>`)
    })
    body.push('</g>')
    body.push(rect(left, top, chartW, chartH, 20, 'none', t.border))
    for (let i = 1; i < 4; i += 1) {
      const gx = left + chartW * i / 4
      const gy = top + chartH * i / 4
      if (i !== 2) {
        body.push(`<line x1="${f1(gx)}" y1="${f1(top)}" x2="${f1(gx)}" y2="${f1(top + chartH)}" stroke="${t.muted}" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.35"/>`)
        body.push(`<line x1="${f1(left)}" y1="${f1(gy)}" x2="${f1(left + chartW)}" y2="${f1(gy)}" stroke="${t.muted}" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.35"/>`)
      }
    }
    body.push(line(midX, top, midX, top + chartH, t.borderStrong))
    body.push(line(left, midY, left + chartW, midY, t.borderStrong))
    const axisY = top + chartH + 24
    body.push(qText(left, axisY, xAxis[0], 12, 600, t.muted))
    body.push(qTextEnd(left + chartW, axisY, xAxis[1], 12, 600, t.muted))
    body.push(`<text x="${f1(left + chartW / 2)}" y="${f1(axisY)}" fill="${t.muted}" text-anchor="middle" font-family="${UI_FONT}" font-size="13.0" font-weight="400">→</text>`)
    const yaX = left - 14
    body.push(qTextEnd(yaX, top + chartH - 4, yAxis[0], 12, 600, t.muted))
    body.push(qTextEnd(yaX, top + 14, yAxis[1], 12, 600, t.muted))
    body.push(qText(left + 32, top + 24, quadrants[1], 14, 650, t.text))
    body.push(qText(midX + 18, top + 24, quadrants[0], 14, 650, t.text))
    body.push(qText(left + 32, midY + 24, quadrants[2], 14, 650, t.text))
    body.push(qText(midX + 18, midY + 24, quadrants[3], 14, 650, t.text))
    points.forEach((point, index) => {
      const px = left + point.x * chartW
      const py = top + (1 - point.y) * chartH
      const color = rustPalette(index)
      body.push(`<circle cx="${f1(px)}" cy="${f1(py)}" r="7.0" fill="${color}" stroke="${t.surface}" stroke-width="2"/>`)
      body.push(qText(px + 14, py - 6, point.label, 12, 650, t.text))
    })
    return rustSvgWithTitle(width, height, title, body.join(''), 'Quadrant chart')
  }

  function renderRequirementDiagram(source) {
    const t = theme()
    let diagramTitle = ''
    const items = []
    const relations = []
    let current = null
    const stripOuterQuotes = (value) => rustStripQuotes(value)
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title')) {
        diagramTitle = stripOuterQuotes(row.slice('title'.length).trim())
        continue
      }
      const start = row.endsWith('{') ? row.trim().replace(/\{$/, '').trim().match(/^(\S+)\s+(\S+)/) : null
      if (start) {
        current = { kind: start[1], id: start[2], title: start[2], detail: [start[1]], props: {} }
        continue
      }
      if (row === '}') {
        if (current) items.push(current)
        current = null
        continue
      }
      if (current && row.includes(':')) {
        const [key, value] = row.split(/:(.+)/)
        const k = key.trim()
        const v = rawMermaidText(value)
        current.props[k] = v
        if (k === 'text') current.title = v
        else current.detail.push(`${k}: ${v}`)
        continue
      }
      const arrowIndex = row.indexOf('->')
      if (arrowIndex >= 0) {
        const leftPart = row.slice(0, arrowIndex)
        const from = (leftPart.trim().split(/\s+/)[0] || '').replace(/^-+|-+$/g, '')
        const to = row.slice(arrowIndex + 2).trim()
        const afterLeft = from ? row.slice(row.indexOf(from) + from.length) : leftPart
        const labelPart = afterLeft.split('->')[0] || ''
        const label = labelPart.trim().replace(/^-+|-+$/g, '').trim() || 'rel'
        relations.push({ from, to, label })
      }
    }
    if (!items.length) throw new Error('requirement diagram requires at least one node')
    if (!diagramTitle) diagramTitle = 'Requirement Diagram'
    const palette = Array.from({ length: 6 }, (_, index) => rustPalette(index))
    const kindColors = new Map()
    items.forEach((item) => {
      if (!kindColors.has(item.kind)) kindColors.set(item.kind, kindColors.size)
    })
    const cols = 2
    const cardW = 360
    const gapX = 100
    const gapY = 80
    const padX = 18
    const padTop = 22
    const padBottom = 20
    const wrapRequirementLines = (value, wrapW, size, weight) => c4WrapText(value, wrapW, size, weight)
    const layouts = items.map((item) => {
      const titleLines = wrapRequirementLines(item.title, cardW - padX * 2, 14, 700)
      const detailLines = item.detail.flatMap((detail) => wrapRequirementLines(detail, cardW - padX * 2, 11, 500)).slice(0, 4)
      const h = Math.max(122, padTop + 12 + 20 + titleLines.length * 18 + 12 + detailLines.length * 14 + padBottom)
      return { item, titleLines, detailLines, h }
    })
    const rowCount = Math.ceil(layouts.length / cols)
    const rowHeights = Array.from({ length: rowCount }, (_, row) => Math.max(...layouts.slice(row * cols, row * cols + cols).map((layout) => layout.h)))
    const width = 72 + cols * cardW + (cols - 1) * gapX
    const height = 90 + rowHeights.reduce((sum, value) => sum + value, 0) + gapY * Math.max(0, rowHeights.length - 1) + 20
    const positions = new Map()
    let y = 76
    layouts.forEach((layout, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      if (col === 0 && row > 0) y += rowHeights[row - 1] + gapY
      positions.set(layout.item.id, { x: 36 + col * (cardW + gapX), y, w: cardW, h: rowHeights[row] })
    })
    const requirementRelationPoints = (sourceBox, targetBox) => {
      const sourceCx = sourceBox.x + sourceBox.w / 2
      const sourceCy = sourceBox.y + sourceBox.h / 2
      const targetCx = targetBox.x + targetBox.w / 2
      const targetCy = targetBox.y + targetBox.h / 2
      if (Math.abs(sourceCx - targetCx) >= Math.abs(sourceCy - targetCy)) {
        return sourceCx <= targetCx
          ? { x1: sourceBox.x + sourceBox.w, y1: sourceCy, x2: targetBox.x, y2: targetCy }
          : { x1: sourceBox.x, y1: sourceCy, x2: targetBox.x + targetBox.w, y2: targetCy }
      }
      return sourceCy <= targetCy
        ? { x1: sourceCx, y1: sourceBox.y + sourceBox.h, x2: targetCx, y2: targetBox.y }
        : { x1: sourceCx, y1: sourceBox.y, x2: targetCx, y2: targetBox.y + targetBox.h }
    }
    const relationLabel = (label, points) => {
      const pillW = c4EstimateTextWidth(label, 11, 650) + 16
      const pillH = 20
      if (Math.abs(points.y1 - points.y2) <= 1) {
        const cx = (points.x1 + points.x2) / 2
        const cy = points.y1 - 16
        return `${rect(cx - pillW / 2, cy - pillH / 2 - 2, pillW, pillH, 10, t.surface, t.border)}${text(cx, cy, label, 11, 650, t.muted)}`
      }
      const lx = points.x1 + 18
      const ly = (points.y1 + points.y2) / 2
      return `${rect(lx - 6, ly - pillH / 2 - 4, pillW, pillH, 10, t.surface, t.border)}${text(lx, ly - 2, label, 11, 650, t.muted, 'start')}`
    }
    const edgeLayer = relations.map((rel) => {
      const source = positions.get(rel.from)
      const target = positions.get(rel.to)
      if (!source || !target) return ''
      const p = requirementRelationPoints(source, target)
      return `${rustArrowLine(p.x1, p.y1, p.x2, p.y2, t.link, false)}${relationLabel(rel.label, p)}`
    }).join('')
    const cardLayer = layouts.map((layout) => {
      const item = layout.item
      const p = positions.get(item.id)
      const kindColor = palette[kindColors.get(item.kind) % palette.length]
      const badgeW = c4EstimateTextWidth(item.kind, 10, 700) + 14
      const titleText = layout.titleLines.map((lineText, index) => text(p.x + padX, p.y + padTop + 26 + index * 18, lineText, 14, 700, t.text, 'start')).join('')
      const detailStart = p.y + padTop + 26 + layout.titleLines.length * 18 + 12
      const detailText = layout.detailLines.map((lineText, index) => text(p.x + padX, detailStart + index * 14, lineText, 11, 500, t.muted, 'start')).join('')
      return `${rect(p.x, p.y, p.w, p.h, 18, t.surfaceAlt, t.border)}<rect x="${p.x.toFixed(1)}" y="${(p.y + 12).toFixed(1)}" width="4.0" height="${(p.h - 24).toFixed(1)}" rx="2.0" fill="${kindColor}"/><rect x="${(p.x + padX).toFixed(1)}" y="${(p.y + padTop - 12).toFixed(1)}" width="${badgeW.toFixed(1)}" height="18.0" rx="9.0" fill="${kindColor}" fill-opacity="0.18"/>${text(p.x + padX + 7, p.y + padTop, item.kind, 10, 700, kindColor, 'start')}${titleText}${detailText}`
    }).join('')
    return rustSvgWithTitle(width, height, diagramTitle, `${edgeLayer}${cardLayer}`, 'Requirement diagram')
  }

  function renderGitGraph(source) {
    const t = theme()
    let title = ''
    const branches = ['main']
    const events = []
    let current = 'main'
    const ensureBranch = (name) => {
      if (!branches.includes(name)) branches.push(name)
    }
    const stripOuterQuotes = (value) => rustStripQuotes(value)
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title')) {
        title = stripOuterQuotes(row.slice('title'.length).trim())
        continue
      }
      const branch = row.match(/^branch\s+(.+)$/)
      const checkout = row.match(/^checkout\s+(.+)$/)
      const commit = row.match(/^commit\b(.*)$/)
      const merge = row.match(/^merge\s+(.+)$/)
      if (branch) {
        const name = rawMermaidText(branch[1])
        ensureBranch(name)
        events.push({ type: 'branch', name })
      } else if (checkout) {
        current = rawMermaidText(checkout[1])
        ensureBranch(current)
        events.push({ type: 'checkout', name: current })
      } else if (commit) {
        const idIndex = commit[1].indexOf('id:')
        const label = idIndex >= 0 ? rustStripQuotes(commit[1].slice(idIndex + 3).trim()) : 'commit'
        events.push({ type: 'commit', branch: current, label })
      } else if (merge) {
        events.push({ type: 'merge', from: rawMermaidText(merge[1]) })
      }
    }
    if (!events.length) throw new Error('gitGraph requires at least one event')
    if (!title) title = 'Git Graph'
    const palette = Array.from({ length: 6 }, (_, index) => rustPalette(index))
    const width = 220 + events.length * 140
    const height = 120 + branches.length * 72
    const branchY = new Map(branches.map((branch, index) => [branch, 94 + index * 72]))
    const branchColor = new Map(branches.map((branch, index) => [branch, palette[index % palette.length]]))
    const laneMarkup = branches.map((branch) => {
      const y = branchY.get(branch)
      const color = branchColor.get(branch)
      return `${text(34, y + 4, branch, 12, 700, color, 'start')}<line x1="142.0" y1="${y.toFixed(1)}" x2="${(width - 28).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.5" opacity="0.45"/>`
    }).join('')
    let active = 'main'
    const eventMarkup = events.map((event, index) => {
      const x = 178 + index * 140
      if (event.type === 'branch') {
        const y = branchY.get(event.name)
        const sourceY = branchY.get(active)
        const color = branchColor.get(event.name) || t.accent
        return y != null && sourceY != null ? rustArrowLine(x, sourceY, x, y, color, true) : ''
      }
      if (event.type === 'checkout') {
        active = event.name
        const y = branchY.get(event.name)
        const color = branchColor.get(event.name) || t.accent
        return y != null ? circleWithAlpha(x, y, 14, color, 'none', 0.20) : ''
      }
      if (event.type === 'commit') {
        const y = branchY.get(active)
        const color = branchColor.get(active) || t.accent
        return y != null ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10.0" fill="${color}" stroke="${t.surface}" stroke-width="2"/>${text(x + 18, y + 4, event.label, 12, 650, t.text, 'start')}` : ''
      }
      const y1 = branchY.get(event.from)
      const y2 = branchY.get(active)
      const color = branchColor.get(event.from) || t.link
      return y1 != null && y2 != null ? `${rustArrowLine(x, y1, x, y2, color, false)}${text(x + 12, (y1 + y2) / 2 - 6, `merge ${event.from}`, 11, 650, t.muted, 'start')}` : ''
    }).join('')
    return rustSvgWithTitle(width, height, title, `${laneMarkup}${eventMarkup}`, 'Git graph')
  }

  function renderMindmap(source) {
    const t = theme()
    const nodes = []
    for (const raw of source.split(/\r?\n/).slice(1)) {
      const trimmedEnd = raw.trimEnd()
      const row = trimmedEnd.trim()
      if (!row || row.startsWith('%%')) continue
      const indent = Math.floor((trimmedEnd.match(/^\s*/)?.[0].length || 0) / 2)
      nodes.push({
        label: rustStripQuotes(row).replace(/^[()]+/, '').replace(/[()]+$/, ''),
        depth: indent,
      })
    }
    if (!nodes.length) throw new Error('mindmap requires at least one node')
    const width = 920
    const height = 120 + nodes.length * 48
    const coords = []
    const body = nodes.map((node, index) => {
      const x = 80 + node.depth * 160
      const y = 94 + index * 48
      coords.push({ x, y })
      let markup = `${rect(x, y - 16, 136, 32, 16, t.surfaceAlt, t.border)}${c4Text(x + 16, y + 5, node.label, 13, 650, t.text)}`
      if (index > 0) {
        let parentIndex = -1
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          if (nodes[candidate].depth + 1 === node.depth || (node.depth === 0 && candidate === 0)) {
            parentIndex = candidate
            break
          }
        }
        if (parentIndex >= 0) {
          const parent = coords[parentIndex]
          const d = `M ${parent.x + 136} ${parent.y} C ${parent.x + 156} ${parent.y}, ${x - 20} ${y}, ${x} ${y}`
          markup += path(d, t.link, 2)
        }
      }
      return markup
    }).join('')
    return rustSvgWithTitle(width, height, 'Mindmap', body, 'Mindmap')
  }

  function renderTimeline(source) {
    const t = theme()
    let title = 'Timeline'
    const sections = []
    let current = { name: '', items: [] }
    const pushCurrent = () => {
      if (current.items.length || current.name) sections.push(current)
    }
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('title ')) {
        title = row.slice('title '.length).trim()
      } else if (row.startsWith('section ')) {
        pushCurrent()
        current = { name: row.slice('section '.length).trim(), items: [] }
      } else if (row.includes(':')) {
        const [time, label] = row.split(/:(.+)/)
        current.items.push({ time: rawMermaidText(time), label: rawMermaidText(label) })
      }
    }
    if (current.items.length) sections.push(current)
    const totalItems = sections.reduce((sum, section) => sum + section.items.length, 0)
    if (!totalItems) throw new Error('timeline requires at least one item')
    const sectionCount = sections.filter((section) => section.name).length
    const width = 860
    const height = 100 + totalItems * 92 + sectionCount * 36
    const axisX = 164
    const wrapTimelineLines = (value) => c4WrapText(value, 540, 13, 600).slice(0, 2)
    const body = [line(axisX, 86, axisX, height - 28, t.borderStrong, 1.6)]
    let y = 118
    sections.forEach((section) => {
      if (section.name) {
        body.push(circle(axisX, y, 5, t.accent, 'none'))
        body.push(text(206, y, section.name, 14, 700, t.accent, 'start'))
        y += 36
      }
      section.items.forEach((item) => {
        const cardCenterY = y + 2
        body.push(circle(axisX, y, 7, t.accent, 'none'))
        body.push(text(38, y, item.time, 12, 700, t.accent, 'middle'))
        body.push(rect(206, y - 26, 580, 56, 18, t.surfaceAlt, t.border))
        const lines = wrapTimelineLines(item.label)
        const firstLineY = cardCenterY - (Math.max(0, lines.length - 1) * 8)
        lines.forEach((lineText, lineIndex) => {
          body.push(text(226, firstLineY + lineIndex * 16, lineText, 13, 650, t.text, 'start'))
        })
        y += 92
      })
    })
    return rustSvgWithTitle(width, height, title, body.join(''), 'Timeline')
  }

  function renderZenuml(source) {
    const t = theme()
    const actors = []
    const actorIndex = new Map()
    const messages = []
    const ensureActor = (id) => {
      if (!actorIndex.has(id)) {
        actorIndex.set(id, actors.length)
        actors.push({ id })
      }
    }
    for (const row of linesOf(source).slice(1)) {
      if (row.startsWith('@')) {
        const space = row.indexOf(' ')
        if (space >= 0) ensureActor(rustStripQuotes(row.slice(space + 1).trim()))
      } else {
        const colon = row.indexOf(':')
        if (colon >= 0) {
          const edge = row.slice(0, colon)
          const arrow = edge.indexOf('->')
          if (arrow >= 0) {
            const from = rustStripQuotes(edge.slice(0, arrow).trim())
            const to = rustStripQuotes(edge.slice(arrow + 2).trim())
            ensureActor(from)
            ensureActor(to)
            messages.push({ from, to, label: row.slice(colon + 1).trim() })
          }
        }
      }
    }
    if (!actors.length) throw new Error('zenuml requires at least one actor')
    const width = 160 + actors.length * 170
    const height = 130 + messages.length * 74
    const centers = actors.map((_, index) => 110 + index * 170)
    const centeredText = (x, y, value, size, weight, fill) => `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" text-anchor="middle" font-family="${UI_FONT}" font-size="${f1(size)}" font-weight="${weight}">${escapeHtml(value)}</text>`
    const body = []
    actors.forEach((actor, index) => {
      const cx = centers[index]
      body.push(rect(cx - 58, 82, 116, 42, 16, t.surfaceAlt, t.border))
      body.push(centeredText(cx, 108, actor.id, 14, 700, t.text))
      body.push(line(cx, 124, cx, height - 24, t.border))
    })
    messages.forEach((msg, index) => {
      const y = 156 + index * 74
      const x1 = centers[actorIndex.get(msg.from)]
      const x2 = centers[actorIndex.get(msg.to)]
      body.push(rustArrowLine(x1, y, x2, y, t.link, false))
      body.push(rect(Math.min(x1, x2) + 18, y - 24, Math.max(Math.abs(x2 - x1), 120) - 36, 28, 14, t.surface, t.border))
      body.push(centeredText((x1 + x2) / 2, y - 6, msg.label, 12, 650, t.text))
    })
    return rustSvgWithTitle(width, height, 'ZenUML', body.join(''), 'ZenUML')
  }

  function parseSquareNode(line) {
    const split = String(line || '').indexOf('[')
    if (split < 0 || !String(line).endsWith(']')) return null
    return { id: line.slice(0, split).trim(), label: stripOuterQuotes(line.slice(split + 1, -1).trim()) }
  }

  function arrowLineSvg(x1, y1, x2, y2, stroke, dashed = false) {
    const dash = dashed ? ' stroke-dasharray="7 5"' : ''
    return `<g><line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${stroke}" stroke-width="2"${dash}/>${rustArrowheadPath({ x: x1, y: y1 }, { x: x2, y: y2 }, stroke)}</g>`
  }

  function polylineArrowSvg(points, stroke, dashed = false) {
    if (points.length < 2) return ''
    const dash = dashed ? ' stroke-dasharray="7 5"' : ''
    const d = points.map((p, index) => `${index ? 'L' : 'M'} ${f1(p.x)} ${f1(p.y)}`).join(' ')
    return `<g><path d="${d}" fill="none" stroke="${stroke}" stroke-width="2"${dash} stroke-linecap="round" stroke-linejoin="round"/>${rustArrowheadPath(points[points.length - 2], points[points.length - 1], stroke)}</g>`
  }

  function contrastTextColor(fill) {
    const t = theme()
    const parseHex = (value) => {
      const match = String(value || '').match(/^#([0-9a-f]{6})$/i)
      if (!match) return null
      return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16))
    }
    const luminance = (rgb) => {
      if (!rgb) return 0
      const linear = rgb.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }
    const ratio = (left, right) => {
      const l1 = luminance(parseHex(left))
      const l2 = luminance(parseHex(right))
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    return ratio(fill, t.text) >= ratio(fill, t.surface) ? t.text : t.surface
  }

  function blockArrow(x1, y1, x2, y2, nodeW, nodeH, stroke) {
    if (Math.abs(y1 - y2) < Number.EPSILON) {
      return x1 <= x2
        ? arrowLineSvg(x1 + nodeW, y1 + nodeH / 2, x2, y2 + nodeH / 2, stroke)
        : arrowLineSvg(x1, y1 + nodeH / 2, x2 + nodeW, y2 + nodeH / 2, stroke)
    }
    const startX = x1 + nodeW / 2
    const startY = y1 < y2 ? y1 + nodeH : y1
    const endX = x2 + nodeW / 2
    const endY = y1 < y2 ? y2 : y2 + nodeH
    const midY = (startY + endY) / 2
    return polylineArrowSvg([{ x: startX, y: startY }, { x: startX, y: midY }, { x: endX, y: midY }, { x: endX, y: endY }], stroke)
  }

  function renderBlockDiagram(source) {
    const t = theme()
    let cols = 3
    const nodes = []
    const edges = []
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('columns ')) cols = Math.max(1, Number.parseInt(row.slice('columns '.length).trim(), 10) || 3)
      else if (row.includes('-->')) {
        const parts = row.split('-->').map((part) => part.trim())
        for (let index = 0; index + 1 < parts.length; index += 1) edges.push([parts[index], parts[index + 1]])
      } else {
        const node = parseSquareNode(row)
        if (node) nodes.push(node)
      }
    })
    if (!nodes.length) throw new Error('block-beta requires at least one node')
    const width = 220 + cols * 200
    const rows = Math.ceil(nodes.length / cols)
    const height = 120 + rows * 104
    const nodeW = 136
    const nodeH = 52
    const positions = new Map()
    const body = []
    nodes.forEach((node, index) => {
      const x = 90 + (index % cols) * 200
      const y = 106 + Math.floor(index / cols) * 104
      positions.set(node.id, { x, y })
      body.push(rect(x, y, nodeW, nodeH, 16, t.surfaceAlt, t.border))
      body.push(text(x + nodeW / 2, y + 31, node.label, 13, 650, t.text))
    })
    edges.forEach(([from, to]) => {
      const a = positions.get(from)
      const b = positions.get(to)
      if (a && b) body.push(blockArrow(a.x, a.y, b.x, b.y, nodeW, nodeH, t.link))
    })
    return rustSvgWithTitle(width, height, 'Block Diagram', body.join(''), 'Block diagram')
  }

  function sankeyBand(source, target, fill, opacity) {
    const curve = Math.max((target.x - source.x) * 0.42, 48)
    return `<path d="M ${f1(source.x)} ${f1(source.y1)} C ${f1(source.x + curve)} ${f1(source.y1)}, ${f1(target.x - curve)} ${f1(target.y1)}, ${f1(target.x)} ${f1(target.y1)} L ${f1(target.x)} ${f1(target.y2)} C ${f1(target.x - curve)} ${f1(target.y2)}, ${f1(source.x + curve)} ${f1(source.y2)}, ${f1(source.x)} ${f1(source.y2)} Z" fill="${fill}" fill-opacity="${Number(opacity).toFixed(2)}" stroke="none"/>`
  }

  function renderSankey(source) {
    const t = theme()
    const edges = []
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('source,target')) return
      const parts = row.split(',').map((part) => part.trim())
      if (parts.length === 3) edges.push({ source: parts[0], target: parts[1], value: Number(parts[2]) || 1 })
    })
    if (!edges.length) throw new Error('sankey requires at least one edge')
    const nodeOrder = []
    const incoming = new Map()
    const outgoing = new Map()
    const indegree = new Map()
    const adjacency = new Map()
    const addNode = (name) => { if (!nodeOrder.includes(name)) nodeOrder.push(name) }
    edges.forEach((edge) => {
      addNode(edge.source); addNode(edge.target)
      outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + edge.value)
      incoming.set(edge.target, (incoming.get(edge.target) || 0) + edge.value)
      if (!indegree.has(edge.source)) indegree.set(edge.source, 0)
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, [])
      adjacency.get(edge.source).push(edge.target)
    })
    const layers = new Map()
    const pending = new Map(indegree)
    const queue = nodeOrder.filter((name) => (pending.get(name) || 0) === 0)
    let cursor = 0
    const processed = new Set()
    while (processed.size < nodeOrder.length) {
      if (cursor >= queue.length) {
        const name = nodeOrder.find((candidate) => !processed.has(candidate))
        if (!name) break
        const fallback = Math.max(-1, ...edges.filter((edge) => edge.target === name).map((edge) => layers.get(edge.source)).filter((value) => value != null)) + 1
        if (!layers.has(name)) layers.set(name, fallback)
        queue.push(name)
      }
      const name = queue[cursor++]
      if (processed.has(name)) continue
      processed.add(name)
      const layer = layers.get(name) || 0
      ;(adjacency.get(name) || []).forEach((target) => {
        layers.set(target, Math.max(layers.get(target) || 0, layer + 1))
        pending.set(target, Math.max(0, (pending.get(target) || 0) - 1))
        if ((pending.get(target) || 0) === 0) queue.push(target)
      })
    }
    const byLayer = new Map()
    const nodeFlow = new Map()
    nodeOrder.forEach((name) => {
      const layer = layers.get(name) || 0
      if (!byLayer.has(layer)) byLayer.set(layer, [])
      byLayer.get(layer).push(name)
      nodeFlow.set(name, Math.max(incoming.get(name) || 0, outgoing.get(name) || 0, 1))
    })
    const layerKeys = [...byLayer.keys()].sort((a, b) => a - b)
    const layerCount = Math.max(...layerKeys) + 1
    const nodeW = 132
    const width = Math.max(760 + Math.max(0, layerCount - 1) * 220, 900)
    const height = 460
    const top = 104
    const bottom = height - 34
    const availableH = bottom - top
    const gapY = 24
    const scale = Math.max(12, Math.min(32, Math.min(...[...byLayer.values()].map((names) => (Math.max(64, availableH - gapY * Math.max(0, names.length - 1)) / Math.max(1, names.reduce((sum, name) => sum + (nodeFlow.get(name) || 1), 0)))))))
    const placements = new Map()
    byLayer.forEach((names, layer) => {
      const heights = names.map((name) => Math.max((nodeFlow.get(name) || 1) * scale, 28))
      const totalH = heights.reduce((sum, value) => sum + value, 0) + gapY * Math.max(0, names.length - 1)
      let y = top + Math.max(0, availableH - totalH) / 2
      const x = layerCount === 1 ? (width - nodeW) / 2 : 96 + layer * ((width - 192 - nodeW) / (layerCount - 1))
      names.forEach((name, index) => {
        placements.set(name, { x, y, h: heights[index] })
        y += heights[index] + gapY
      })
    })
    const body = []
    const sourceOffsets = new Map()
    const targetOffsets = new Map()
    nodeOrder.forEach((name) => {
      const p = placements.get(name)
      if (!p) return
      sourceOffsets.set(name, Math.max(0, p.h - (outgoing.get(name) || 0) * scale) / 2)
      targetOffsets.set(name, Math.max(0, p.h - (incoming.get(name) || 0) * scale) / 2)
    })
    edges.map((edge, index) => ({ edge, index })).sort((a, b) => (placements.get(a.edge.source)?.y || 0) - (placements.get(b.edge.source)?.y || 0) || (placements.get(a.edge.target)?.y || 0) - (placements.get(b.edge.target)?.y || 0)).forEach(({ edge }, colorIndex) => {
      const sourceNode = placements.get(edge.source)
      const targetNode = placements.get(edge.target)
      if (!sourceNode || !targetNode) return
      const thickness = Math.max(edge.value * scale, 10)
      const sy1 = sourceNode.y + (sourceOffsets.get(edge.source) || 0)
      const ty1 = targetNode.y + (targetOffsets.get(edge.target) || 0)
      sourceOffsets.set(edge.source, (sourceOffsets.get(edge.source) || 0) + thickness)
      targetOffsets.set(edge.target, (targetOffsets.get(edge.target) || 0) + thickness)
      body.push(sankeyBand({ x: sourceNode.x + nodeW, y1: sy1, y2: sy1 + thickness }, { x: targetNode.x, y1: ty1, y2: ty1 + thickness }, rustPalette(colorIndex), 0.86))
    })
    nodeOrder.forEach((name) => {
      const p = placements.get(name)
      if (!p) return
      body.push(rect(p.x, p.y, nodeW, p.h, 14, t.surfaceAlt, t.border))
      body.push(c4Text(p.x + 16, p.y + p.h / 2 + 4, name, 12, 650, t.text))
      body.push(c4Text(p.x + 16, p.y + p.h - 12, (nodeFlow.get(name) || 1).toFixed(0), 11, 500, t.muted))
    })
    return rustSvgWithTitle(width, height, 'Sankey', body.join(''), 'Sankey')
  }

  function renderPacket(source) {
    const t = theme()
    let title = ''
    const fields = []
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('title')) title = stripOuterQuotes(row.slice('title'.length).trim())
      else if (row.includes(':')) {
        const [range, labelRaw] = row.split(/:(.+)/)
        const [s, e] = range.trim().split('-')
        const start = Number.parseInt(s, 10) || 0
        const end = Number.parseInt(e, 10) || start
        fields.push({ start, end, label: stripOuterQuotes(labelRaw.trim()) })
      }
    })
    if (!fields.length) throw new Error('packet requires at least one field')
    if (!title) title = 'Packet'
    const bpr = 32
    const maxBit = Math.max(...fields.map((field) => field.end), 31)
    const numRows = Math.floor(maxBit / bpr) + 1
    const rows = Array.from({ length: numRows }, () => [])
    fields.forEach((field, idx) => {
      const sr = Math.floor(field.start / bpr)
      const er = Math.floor(field.end / bpr)
      const rangeLabel = `${field.start}-${field.end}`
      if (sr === er) rows[sr].push({ colStart: field.start % bpr, colEnd: field.end % bpr, label: field.label, rangeLabel, idx })
      else {
        rows[sr].push({ colStart: field.start % bpr, colEnd: bpr - 1, label: field.label, rangeLabel, idx })
        for (let r = sr + 1; r < er; r += 1) rows[r].push({ colStart: 0, colEnd: bpr - 1, label: '', rangeLabel: '', idx })
        rows[er].push({ colStart: 0, colEnd: field.end % bpr, label: '', rangeLabel: '', idx })
      }
    })
    const bitW = 26, rowH = 36, hdrH = 28, gx = 48, gy = 16, gw = bpr * bitW
    const width = gx + gw + 20
    const height = gy + hdrH + numRows * rowH + 16
    const body = []
    for (let bit = 0; bit < bpr; bit += 1) body.push(text(gx + bit * bitW + bitW / 2, gy + hdrH - 10, String(bit), 9, 400, t.muted))
    body.push(line(gx, gy + hdrH, gx + gw, gy + hdrH, t.border))
    ;[0, 8, 16, 24, 32].forEach((oct) => body.push(`<line x1="${f1(gx + oct * bitW)}" y1="${f1(gy + hdrH - 4)}" x2="${f1(gx + oct * bitW)}" y2="${f1(gy + hdrH)}" stroke="${t.border}" stroke-width="1"/>`))
    const bodyTop = gy + hdrH
    const bodyBot = bodyTop + numRows * rowH
    body.push(line(gx, bodyTop, gx, bodyBot, t.border))
    body.push(line(gx + gw, bodyTop, gx + gw, bodyBot, t.border))
    ;[8, 16, 24].forEach((oct) => body.push(`<line x1="${f1(gx + oct * bitW)}" y1="${f1(bodyTop)}" x2="${f1(gx + oct * bitW)}" y2="${f1(bodyBot)}" stroke="${t.muted}" stroke-width="0.5" stroke-dasharray="3 3" opacity="0.30"/>`))
    rows.forEach((row, ri) => {
      const ry = bodyTop + ri * rowH
      body.push(`<text x="${f1(gx - 6)}" y="${f1(ry + rowH / 2 + 4)}" fill="${t.muted}" text-anchor="end" font-size="10" font-weight="500">${ri * bpr}</text>`)
      row.forEach((field) => {
        const fx = gx + field.colStart * bitW
        const fw = (field.colEnd - field.colStart + 1) * bitW
        const fill = rustPalette(field.idx)
        const textFill = contrastTextColor(fill)
        body.push(rect(fx, ry, fw, rowH, 2, fill, t.border))
        if (field.label) {
          const avail = fw - 8
          const lw = analyticsEstimateTextWidth(field.label, 12, 600)
          const fs = avail > 0 && lw > avail ? Math.max(12 * avail / lw, 8) : 12
          const showRange = fw >= 52 && field.rangeLabel
          body.push(text(fx + fw / 2, showRange ? ry + rowH / 2 : ry + rowH / 2 + 4, field.label, fs, 600, textFill))
          if (showRange) body.push(text(fx + fw / 2, ry + rowH / 2 + 12, field.rangeLabel, 8, 400, textFill))
        }
      })
      body.push(line(gx, ry + rowH, gx + gw, ry + rowH, t.border))
    })
    return rustSvgWithTitle(width, height, title, body.join(''), 'Packet')
  }

  function renderKanban(source) {
    const t = theme()
    const columns = []
    let current = null
    let columnIndent = null
    source.split(/\r?\n/).slice(1).forEach((raw) => {
      const trimmed = raw.trim()
      if (!trimmed || trimmed.startsWith('%%')) return
      const indent = raw.match(/^\s*/)[0].length
      const isColumn = columnIndent == null ? (columnIndent = indent, true) : indent <= columnIndent
      const node = parseSquareNode(trimmed)
      const label = node ? node.label : trimmed
      if (isColumn) {
        if (current) columns.push(current)
        current = { title: label, cards: [] }
      } else if (current) current.cards.push(label)
    })
    if (current) columns.push(current)
    if (!columns.length) throw new Error('kanban requires at least one column')
    const colW = 220, gap = 24
    const width = 60 + columns.length * (colW + gap)
    const maxCards = Math.max(0, ...columns.map((column) => column.cards.length))
    const height = 130 + maxCards * 94
    const columnH = maxCards === 0 ? 60 : 34 + maxCards * 94
    const body = []
    columns.forEach((column, index) => {
      const x = 36 + index * (colW + gap)
      body.push(rect(x, 86, colW, columnH, 20, t.surfaceAlt, t.border))
      body.push(c4Text(x + 18, 114, column.title, 15, 700, t.text))
      column.cards.forEach((card, cardIndex) => {
        const y = 132 + cardIndex * 94
        body.push(rect(x + 14, y, colW - 28, 68, 16, t.surface, t.border))
        c4WrapText(card, colW - 52, 12, 600).slice(0, 3).forEach((lineText, lineIndex) => {
          body.push(c4Text(x + 28, y + 24 + lineIndex * 16, lineText, 12, 650, t.text))
        })
      })
    })
    return rustSvgWithTitle(width, height, 'Kanban', body.join(''), 'Kanban')
  }

  function renderTreemap(source) {
    const t = theme()
    let title = ''
    const root = { label: '', value: 0, children: [] }
    const stack = []
    let baseIndent = null
    const parentForDepth = (depth) => {
      while (stack.length > depth) stack.pop()
      let current = root
      stack.forEach((index) => { current = current.children[index] })
      return current
    }
    source.split(/\r?\n/).slice(1).forEach((raw) => {
      const trimmed = raw.trim()
      if (!trimmed || trimmed.startsWith('%%')) return
      if (trimmed.startsWith('title')) {
        title = stripOuterQuotes(trimmed.slice('title'.length).trim())
        return
      }
      const indent = raw.match(/^\s*/)[0].length
      if (baseIndent == null) baseIndent = indent
      const depth = Math.floor(Math.max(0, indent - baseIndent) / 2)
      const colon = trimmed.indexOf(':')
      const entry = colon >= 0
        ? { label: stripOuterQuotes(trimmed.slice(0, colon).trim()), value: Number(trimmed.slice(colon + 1).trim()) || 0, children: [] }
        : { label: stripOuterQuotes(trimmed), value: 0, children: [] }
      const parent = parentForDepth(depth)
      parent.children.push(entry)
      stack.push(parent.children.length - 1)
    })
    let tree = root.label === '' && root.children.length === 1 ? root.children[0] : root
    if (!tree.label && !tree.children.length) throw new Error('treemap-beta requires at least one entry')
    if (!title) title = 'Treemap'
    const rollup = (node) => {
      if (!node.children.length) {
        node.value = Math.max(node.value, 1)
        return node.value
      }
      node.value = Math.max(node.children.reduce((sum, child) => sum + rollup(child), 0), 1)
      return node.value
    }
    rollup(tree)
    const width = 900
    const height = 480
    let colorCounter = 0
    const body = []
    const layout = (node, area, vertical, branchColor, depth) => {
      if (area.w <= 0 || area.h <= 0) return
      const isLeaf = !node.children.length
      if (depth === 0) body.push(rect(area.x, area.y, area.w, area.h, 4, t.surfaceAlt, t.border))
      else {
        const color = rustPalette(branchColor || 0)
        body.push(`<rect x="${f1(area.x)}" y="${f1(area.y)}" width="${f1(area.w)}" height="${f1(area.h)}" rx="4.0" fill="${color}" fill-opacity="${isLeaf ? '0.38' : '0.14'}" stroke="${t.border}"/>`)
      }
      body.push(c4Text(area.x + 12, area.y + 20, node.label, 12, 700, t.text))
      if (isLeaf) {
        body.push(c4Text(area.x + 12, area.y + 38, node.value.toFixed(0), 11, 650, t.muted))
        return
      }
      const content = { x: area.x + 8, y: area.y + 28, w: Math.max(0, area.w - 16), h: Math.max(0, area.h - 36) }
      let offset = 0
      node.children.forEach((child, index) => {
        const childBranch = branchColor != null ? branchColor : colorCounter++
        const ratio = child.value / Math.max(node.value, 1)
        if (vertical) {
          const remaining = Math.max(0, content.w - offset)
          const childW = index + 1 === node.children.length ? remaining : content.w * ratio
          layout(child, { x: content.x + offset, y: content.y, w: Math.min(childW, remaining), h: content.h }, !vertical, childBranch, depth + 1)
          offset += childW
        } else {
          const remaining = Math.max(0, content.h - offset)
          const childH = index + 1 === node.children.length ? remaining : content.h * ratio
          layout(child, { x: content.x, y: content.y + offset, w: content.w, h: Math.min(childH, remaining) }, !vertical, childBranch, depth + 1)
          offset += childH
        }
      })
    }
    layout(tree, { x: 34, y: 86, w: width - 68, h: height - 120 }, true, null, 0)
    return rustSvgWithTitle(width, height, title, body.join(''), 'Treemap')
  }

  function parseClassIdentifier(raw, lineNumber = 0) {
    const token = String(raw || '').trim().split(/\s+/, 1)[0].split('[', 1)[0].replace(/^["`]+|["`]+$/g, '').trim()
    if (!token) throw new Error(`line ${lineNumber}: class identifier is required`)
    return token
  }

  function parseClassEndpoint(raw, lineNumber) {
    let cardinality = null
    let cleaned = ''
    const chars = Array.from(String(raw || ''))
    for (let index = 0; index < chars.length; index += 1) {
      const ch = chars[index]
      if (ch === '"') {
        let quoted = ''
        index += 1
        while (index < chars.length && chars[index] !== '"') {
          quoted += chars[index]
          index += 1
        }
        if (quoted.trim()) cardinality = quoted.trim()
      } else cleaned += ch
    }
    return { id: parseClassIdentifier(cleaned.trim(), lineNumber), cardinality }
  }

  function parseClassRelation(row, lineNumber) {
    const colon = row.indexOf(':')
    const edge = (colon >= 0 ? row.slice(0, colon) : row).trim()
    const label = colon >= 0 ? row.slice(colon + 1).trim() : ''
    const operators = ['<|..', '..|>', '<|--', '--|>', '*--', '--*', 'o--', '--o', '<..', '..>', '<--', '-->', '..', '--']
    for (const operator of operators) {
      const pos = edge.indexOf(operator)
      if (pos < 0) continue
      const left = edge.slice(0, pos).trim()
      const right = edge.slice(pos + operator.length).trim()
      if (!left || !right) throw new Error(`line ${lineNumber}: invalid class relationship \`${row}\``)
      const leftEndpoint = parseClassEndpoint(left, lineNumber)
      const rightEndpoint = parseClassEndpoint(right, lineNumber)
      const reverse = operator.includes('<') && !operator.includes('>')
      return reverse
        ? { from: rightEndpoint.id, to: leftEndpoint.id, fromCardinality: rightEndpoint.cardinality, toCardinality: leftEndpoint.cardinality, label: label || null, dashed: operator.includes('.') }
        : { from: leftEndpoint.id, to: rightEndpoint.id, fromCardinality: leftEndpoint.cardinality, toCardinality: rightEndpoint.cardinality, label: label || null, dashed: operator.includes('.') }
    }
    return null
  }

  function parseClassDiagram(source) {
    const rows = source.split(/\r?\n/).map((line, index) => ({ line: line.trim(), lineNumber: index + 1 })).filter((row) => row.line && !row.line.startsWith('%%'))
    if (!rows.length) throw new Error('class diagram source is empty')
    const directive = rows[0].line.split(/\s+/, 1)[0]
    if (directive !== 'classDiagram' && directive !== 'classDiagram-v2') throw new Error(`line ${rows[0].lineNumber}: expected \`classDiagram\` as the first directive`)
    const classes = []
    const classIndex = new Map()
    const relations = []
    const registerClass = (id, members = []) => {
      if (classIndex.has(id)) {
        if (members.length) classes[classIndex.get(id)].members = members
        return
      }
      classIndex.set(id, classes.length)
      classes.push({ id, members })
    }
    let title = null
    let direction = 'LR'
    let index = 1
    while (index < rows.length) {
      const { line, lineNumber } = rows[index]
      if (line.startsWith('direction ')) {
        const raw = line.slice('direction '.length).trim()
        if (!['LR', 'RL', 'TB', 'TD', 'BT'].includes(raw)) throw new Error(`line ${lineNumber}: unsupported class diagram direction \`${raw}\``)
        direction = raw === 'TD' ? 'TB' : raw
        index += 1
        continue
      }
      if (line.startsWith('title ')) {
        title = line.slice('title '.length).trim()
        index += 1
        continue
      }
      if (line.startsWith('class ')) {
        const trimmed = line.slice('class '.length).trim()
        if (trimmed.endsWith('{')) {
          const id = parseClassIdentifier(trimmed.replace(/\{$/, '').trim(), lineNumber)
          const members = []
          index += 1
          let closed = false
          while (index < rows.length) {
            const nested = rows[index].line
            if (nested === '}') { closed = true; index += 1; break }
            if (nested.endsWith('}')) {
              const content = nested.slice(0, -1).trim()
              if (content) members.push(content)
              closed = true
              index += 1
              break
            }
            members.push(nested)
            index += 1
          }
          if (!closed) throw new Error(`line ${lineNumber}: class \`${id}\` block is not closed`)
          registerClass(id, members)
          continue
        }
        if (trimmed.includes('{')) {
          const [namePart, tail] = trimmed.split(/\{(.+)/)
          const id = parseClassIdentifier(namePart.trim(), lineNumber)
          const member = (tail || '').replace(/\}$/, '').trim()
          registerClass(id, member ? [member] : [])
          index += 1
          continue
        }
        registerClass(parseClassIdentifier(trimmed, lineNumber), [])
        index += 1
        continue
      }
      const relation = parseClassRelation(line, lineNumber)
      if (relation) {
        registerClass(relation.from, [])
        registerClass(relation.to, [])
        relations.push(relation)
      }
      index += 1
    }
    if (!classes.length) throw new Error('class diagram must declare or reference at least one class')
    return { title, direction, classes, relations }
  }

  function classDirectionHorizontal(direction) {
    return direction === 'LR' || direction === 'RL'
  }

  function classRelationPoints(source, target, direction) {
    if (classDirectionHorizontal(direction)) {
      const sc = source.x + source.w / 2
      const tc = target.x + target.w / 2
      return sc <= tc
        ? { x1: source.x + source.w, y1: source.y + source.h / 2, x2: target.x, y2: target.y + target.h / 2 }
        : { x1: source.x, y1: source.y + source.h / 2, x2: target.x + target.w, y2: target.y + target.h / 2 }
    }
    const sc = source.y + source.h / 2
    const tc = target.y + target.h / 2
    return sc <= tc
      ? { x1: source.x + source.w / 2, y1: source.y + source.h, x2: target.x + target.w / 2, y2: target.y }
      : { x1: source.x + source.w / 2, y1: source.y, x2: target.x + target.w / 2, y2: target.y + target.h }
  }

  function classRelationRoute(source, target, layouts, direction, dashed, options) {
    const points = classRelationPoints(source, target, direction)
    const sourceCx = source.x + source.w / 2
    const sourceCy = source.y + source.h / 2
    const targetCx = target.x + target.w / 2
    const targetCy = target.y + target.h / 2
    const intermediateCount = classDirectionHorizontal(direction)
      ? layouts.filter((layout) => {
          const centerX = layout.x + layout.w / 2
          return centerX > Math.min(sourceCx, targetCx) + 0.1 && centerX < Math.max(sourceCx, targetCx) - 0.1
        }).length
      : layouts.filter((layout) => {
          const centerY = layout.y + layout.h / 2
          return centerY > Math.min(sourceCy, targetCy) + 0.1 && centerY < Math.max(sourceCy, targetCy) - 0.1
        }).length
    if (!intermediateCount) return { points: [{ x: points.x1, y: points.y1 }, { x: points.x2, y: points.y2 }], labelFrom: { x: points.x1, y: points.y1 }, labelTo: { x: points.x2, y: points.y2 }, labelCenter: null, start: { x: points.x1, y: points.y1 }, end: { x: points.x2, y: points.y2 } }
    if (classDirectionHorizontal(direction)) {
      const laneStep = Math.max(options.laneStep, options.labelGap * 2 + 8)
      const laneY = Math.min(source.y, target.y) - options.laneClearance - Math.max(0, intermediateCount - 1) * laneStep
      const portOffset = 22
      const startX = source.x + source.w / 2 + (dashed ? portOffset : -portOffset)
      const endX = target.x + target.w / 2 + (dashed ? -portOffset : portOffset)
      return { points: [{ x: startX, y: source.y }, { x: startX, y: laneY }, { x: endX, y: laneY }, { x: endX, y: target.y }], labelFrom: { x: startX, y: laneY }, labelTo: { x: endX, y: laneY }, labelCenter: { x: (startX + endX) / 2, y: laneY - options.labelGap }, start: { x: startX, y: source.y }, end: { x: endX, y: target.y } }
    }
    const laneStep = Math.max(options.laneStep, options.labelGap * 2 + 8)
    const laneX = Math.min(source.x, target.x) - options.laneClearance - Math.max(0, intermediateCount - 1) * laneStep
    const portOffset = 16
    const startY = source.y + source.h / 2 + (dashed ? portOffset : -portOffset)
    const endY = target.y + target.h / 2 + (dashed ? -portOffset : portOffset)
    return { points: [{ x: source.x, y: startY }, { x: laneX, y: startY }, { x: laneX, y: endY }, { x: target.x, y: endY }], labelFrom: { x: laneX, y: startY }, labelTo: { x: laneX, y: endY }, labelCenter: { x: laneX + options.labelGap, y: (startY + endY) / 2 }, start: { x: source.x, y: startY }, end: { x: target.x, y: endY } }
  }

  function classRelationCardinality(value, endpoints, sourceSide, direction) {
    const t = theme()
    const width = analyticsEstimateTextWidth(value, 11, 650)
    if (classDirectionHorizontal(direction)) {
      const leftToRight = endpoints.x1 <= endpoints.x2
      const x = sourceSide ? (leftToRight ? endpoints.x1 - width - 8 : endpoints.x1 + 8) : (leftToRight ? endpoints.x2 + 8 : endpoints.x2 - width - 8)
      return c4Text(x, endpoints.y1 - 10, value, 11, 650, t.text)
    }
    const topToBottom = endpoints.y1 <= endpoints.y2
    const y = sourceSide ? (topToBottom ? endpoints.y1 - 8 : endpoints.y1 + 14) : (topToBottom ? endpoints.y2 + 14 : endpoints.y2 - 8)
    return c4Text(endpoints.x1 + 10, y, value, 11, 650, t.text)
  }

  function classRelationLabel(value, x, y) {
    const t = theme()
    return text(x, y, value, 11, 650, t.text)
  }

  function renderClassDiagram(source, renderOptions) {
    const t = theme()
    const diagram = parseClassDiagram(source)
    const options = renderOptions || { margin: 32, origin: 64, laneClearance: 10, laneStep: 18, labelGap: 10 }
    const layouts = diagram.classes.map((node) => {
      const titleLines = c4WrapText(node.id, 220, 15, 600)
      const headerH = 20 + titleLines.length * 18
      const titleW = Math.max(0, ...titleLines.map((lineText) => analyticsEstimateTextWidth(lineText, 15, 700)))
      const memberW = Math.max(0, ...node.members.map((member) => analyticsEstimateTextWidth(member, 12, 600)))
      const w = Math.max(Math.max(titleW, memberW) + 32, 160)
      const memberH = node.members.length ? 16 + node.members.length * 16 : 0
      return { x: 0, y: 0, w, h: Math.max(headerH + memberH + 18, 64), headerH }
    })
    const order = (diagram.direction === 'RL' || diagram.direction === 'BT') ? layouts.map((_, index) => index).reverse() : layouts.map((_, index) => index)
    let width
    let height
    if (classDirectionHorizontal(diagram.direction)) {
      let cursor = options.margin
      let maxH = 0
      order.forEach((classIndex) => {
        layouts[classIndex].x = cursor
        layouts[classIndex].y = options.origin
        cursor += layouts[classIndex].w + 64
        maxH = Math.max(maxH, layouts[classIndex].h)
      })
      width = cursor - 64 + options.margin
      height = options.origin + maxH + options.margin
    } else {
      let cursor = options.origin
      let maxW = 0
      order.forEach((classIndex) => {
        layouts[classIndex].x = options.margin
        layouts[classIndex].y = cursor
        cursor += layouts[classIndex].h + 64
        maxW = Math.max(maxW, layouts[classIndex].w)
      })
      width = options.margin + maxW + options.margin
      height = cursor - 64 + options.margin
    }
    const lookup = new Map(diagram.classes.map((node, index) => [node.id, layouts[index]]))
    const routes = diagram.relations.map((relation) => {
      const sourceLayout = lookup.get(relation.from)
      const targetLayout = lookup.get(relation.to)
      return sourceLayout && targetLayout ? classRelationRoute(sourceLayout, targetLayout, layouts, diagram.direction, relation.dashed, options) : null
    })
    const body = []
    diagram.relations.forEach((relation, index) => {
      const route = routes[index]
      if (!route) return
      const edge = route.points.length === 2
        ? arrowLineSvg(route.start.x, route.start.y, route.end.x, route.end.y, t.text, relation.dashed)
        : polylineArrowSvg(route.points, t.text, relation.dashed)
      const endpoints = { x1: route.start.x, y1: route.start.y, x2: route.end.x, y2: route.end.y }
      const labelMarkup = relation.label
        ? (() => {
            if (route.labelCenter) return classRelationLabel(relation.label, route.labelCenter.x, route.labelCenter.y)
            const labelW = analyticsEstimateTextWidth(relation.label, 11, 650) + 18
            const x = classDirectionHorizontal(diagram.direction) ? (route.labelFrom.x + route.labelTo.x) / 2 : route.labelFrom.x + 12 + labelW / 2
            const y = classDirectionHorizontal(diagram.direction) ? Math.min(route.labelFrom.y, route.labelTo.y) - 18.5 : (route.labelFrom.y + route.labelTo.y) / 2 + 3.5
            return classRelationLabel(relation.label, x, y)
          })()
        : ''
      body.push(`<g data-class-rel="${dataAttr(`${relation.from}->${relation.to}`)}">${edge}${relation.fromCardinality ? classRelationCardinality(relation.fromCardinality, endpoints, true, diagram.direction) : ''}${relation.toCardinality ? classRelationCardinality(relation.toCardinality, endpoints, false, diagram.direction) : ''}${labelMarkup}</g>`)
    })
    diagram.classes.forEach((node, index) => {
      const layout = layouts[index]
      body.push(rect(layout.x, layout.y, layout.w, layout.h, 0, t.surface, t.borderStrong))
      body.push(line(layout.x, layout.y + layout.headerH, layout.x + layout.w, layout.y + layout.headerH, t.border))
      c4WrapText(node.id, layout.w - 24, 15, 600).forEach((lineText, lineIndex) => {
        body.push(text(layout.x + layout.w / 2, layout.y + 26 + lineIndex * 18, lineText, 15, 700, t.text))
      })
      node.members.forEach((member, memberIndex) => {
        body.push(c4Text(layout.x + 14, layout.y + layout.headerH + 18 + memberIndex * 16, member, 12, 600, t.muted))
      })
    })
    return diagram.title ? rustSvgWithTitle(width, height, diagram.title, body.join(''), 'Class diagram') : rustSvg(width, height, body.join(''), 'Class diagram')
  }

  function renderC4CodeDiagram(source) {
    const classSource = `classDiagram\n${source.split(/\r?\n/).slice(1).join('\n')}\n`
    return renderClassDiagram(classSource, { margin: 64, origin: 108, laneClearance: 28, laneStep: 30, labelGap: 18 })
  }

  function architectureBracketLabel(spec) {
    const open = String(spec || '').indexOf('[')
    const close = String(spec || '').lastIndexOf(']')
    return open >= 0 && close > open ? stripOuterQuotes(spec.slice(open + 1, close).trim()) : null
  }

  function architectureDeclId(spec) {
    const textValue = String(spec || '').trim()
    const candidates = ['(', '[', ' '].map((ch) => textValue.indexOf(ch)).filter((index) => index >= 0)
    return (candidates.length ? textValue.slice(0, Math.min(...candidates)) : textValue).trim()
  }

  function architectureDeclIcon(spec) {
    const match = String(spec || '').match(/\(([^)]*)\)/)
    return match && match[1].trim() ? match[1].trim() : null
  }

  function architectureSplitParent(raw) {
    const parts = String(raw || '').split(/\s+in\s+/)
    return { spec: parts[0].trim(), parent: parts[1] ? parts[1].trim() : null }
  }

  function parseArchitectureEndpoint(raw, left) {
    const textValue = String(raw || '').trim()
    const split = left ? textValue.lastIndexOf(':') : textValue.indexOf(':')
    if (split < 0) return null
    const idPart = left ? textValue.slice(0, split).trim() : textValue.slice(split + 1).trim()
    const side = left ? textValue.slice(split + 1).trim() : textValue.slice(0, split).trim()
    const useParentGroup = idPart.endsWith('{group}')
    const id = (useParentGroup ? idPart.slice(0, -'{group}'.length) : idPart).trim()
    const sideMap = { T: 'top', B: 'bottom', L: 'left', R: 'right' }
    return id && sideMap[side] ? { id, side: sideMap[side], sideCode: side, useParentGroup } : null
  }

  function parseArchitectureEdge(row) {
    const dash = row.indexOf('--')
    if (dash < 0) return null
    let left = row.slice(0, dash).trim()
    let right = row.slice(dash + 2).trim()
    const startArrow = left.endsWith('<')
    if (startArrow) left = left.slice(0, -1).trim()
    const endArrow = right.startsWith('>')
    if (endArrow) right = right.slice(1).trim()
    const from = parseArchitectureEndpoint(left, true)
    const to = parseArchitectureEndpoint(right, false)
    return from && to ? { from, to, startArrow, endArrow } : null
  }

  function architectureIcon(icon, x, y, size) {
    const t = theme()
    if (icon === 'database') {
      const topD = `M ${f1(x)} ${f1(y + size * 0.25)} C ${f1(x)} ${f1(y - size * 0.05)}, ${f1(x + size)} ${f1(y - size * 0.05)}, ${f1(x + size)} ${f1(y + size * 0.25)} C ${f1(x + size)} ${f1(y + size * 0.55)}, ${f1(x)} ${f1(y + size * 0.55)}, ${f1(x)} ${f1(y + size * 0.25)}`
      const bodyD = `M ${f1(x)} ${f1(y + size * 0.25)} L ${f1(x)} ${f1(y + size * 0.86)} M ${f1(x + size)} ${f1(y + size * 0.25)} L ${f1(x + size)} ${f1(y + size * 0.86)} M ${f1(x)} ${f1(y + size * 0.86)} C ${f1(x)} ${f1(y + size * 1.16)}, ${f1(x + size)} ${f1(y + size * 1.16)}, ${f1(x + size)} ${f1(y + size * 0.86)}`
      return `${path(topD, t.accent, 1.7)}${path(bodyD, t.accent, 1.7)}`
    }
    if (icon === 'disk') return `${rect(x, y + size * 0.1, size, size * 0.8, 4, 'none', t.accent)}${line(x + size * 0.2, y + size * 0.32, x + size * 0.8, y + size * 0.32, t.accent)}${line(x + size * 0.2, y + size * 0.58, x + size * 0.65, y + size * 0.58, t.accent)}`
    if (icon === 'cloud' || icon === 'internet') return `${path(`M ${f1(x + size * 0.18)} ${f1(y + size * 0.68)} C ${f1(x - size * 0.04)} ${f1(y + size * 0.65)}, ${f1(x)} ${f1(y + size * 0.28)}, ${f1(x + size * 0.28)} ${f1(y + size * 0.34)} C ${f1(x + size * 0.38)} ${f1(y)}, ${f1(x + size * 0.86)} ${f1(y + size * 0.12)}, ${f1(x + size * 0.82)} ${f1(y + size * 0.46)} C ${f1(x + size * 1.08)} ${f1(y + size * 0.48)}, ${f1(x + size * 1.05)} ${f1(y + size * 0.86)}, ${f1(x + size * 0.78)} ${f1(y + size * 0.84)} L ${f1(x + size * 0.18)} ${f1(y + size * 0.84)}`, t.accent, 1.7)}`
    return `${rect(x, y + size * 0.12, size, size * 0.72, 5, 'none', t.accent)}${line(x + size * 0.2, y + size * 0.36, x + size * 0.8, y + size * 0.36, t.accent)}${line(x + size * 0.2, y + size * 0.6, x + size * 0.66, y + size * 0.6, t.accent)}`
  }

  function parseArchitecture(source) {
    const nodes = new Map()
    const order = []
    const edges = []
    const addNode = (node) => {
      if (nodes.has(node.id)) return
      nodes.set(node.id, { children: [], ...node })
      order.push(node.id)
    }
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('group ')) {
        const { spec, parent } = architectureSplitParent(row.slice('group '.length))
        const id = architectureDeclId(spec)
        if (id) addNode({ id, type: 'group', label: architectureBracketLabel(spec) || id, icon: architectureDeclIcon(spec) || 'cloud', parent })
      } else if (row.startsWith('service ')) {
        const { spec, parent } = architectureSplitParent(row.slice('service '.length))
        const id = architectureDeclId(spec)
        if (id) addNode({ id, type: 'service', label: architectureBracketLabel(spec) || id, icon: architectureDeclIcon(spec) || 'server', parent })
      } else if (row.startsWith('junction ')) {
        const { spec, parent } = architectureSplitParent(row.slice('junction '.length))
        const id = architectureDeclId(spec)
        if (id) addNode({ id, type: 'junction', label: id, icon: null, parent })
      } else if (row.includes('--')) {
        const edge = parseArchitectureEdge(row)
        if (edge) edges.push(edge)
      }
    })
    if (!nodes.size) throw new Error('architecture-beta requires at least one group or service')
    const roots = []
    order.forEach((id) => {
      const node = nodes.get(id)
      if (node.parent && nodes.has(node.parent)) nodes.get(node.parent).children.push(id)
      else roots.push(id)
    })
    return { nodes, roots, edges }
  }

  function architectureNodeSize(id, model) {
    const node = model.nodes.get(id)
    if (!node) return { w: 196, h: 56 }
    if (node.type === 'service') return { w: 196, h: 56 }
    if (node.type === 'junction') return { w: 22, h: 22 }
    const childSizes = node.children.map((child) => architectureNodeSize(child, model))
    const cols = Math.min(2, Math.max(1, childSizes.length))
    const rows = Math.max(1, Math.ceil(childSizes.length / cols))
    const colW = Math.max(196, ...childSizes.map((size) => size.w))
    const rowH = Math.max(56, ...childSizes.map((size) => size.h))
    return {
      w: Math.max(312, 48 + cols * colW + Math.max(0, cols - 1) * 56),
      h: Math.max(150, 58 + 24 + rows * rowH + Math.max(0, rows - 1) * 44 + 24),
    }
  }

  function layoutArchitectureNode(id, model, layouts, x, y) {
    const node = model.nodes.get(id)
    const size = architectureNodeSize(id, model)
    layouts.set(id, { x, y, w: size.w, h: size.h })
    if (!node || node.type !== 'group') return
    const children = node.children
    const cols = Math.min(2, Math.max(1, children.length))
    const childSizes = children.map((child) => architectureNodeSize(child, model))
    const colW = Math.max(196, ...childSizes.map((child) => child.w))
    const rowH = Math.max(56, ...childSizes.map((child) => child.h))
    const gridW = cols * colW + Math.max(0, cols - 1) * 56
    const startX = x + (size.w - gridW) / 2
    const startY = y + 58 + 24
    children.forEach((child, index) => {
      const childSize = childSizes[index]
      const col = index % cols
      const row = Math.floor(index / cols)
      layoutArchitectureNode(child, model, layouts, startX + col * (colW + 56) + (colW - childSize.w) / 2, startY + row * (rowH + 44))
    })
  }

  function architectureAnchor(box, side) {
    if (side === 'top') return { x: box.x + box.w / 2, y: box.y }
    if (side === 'bottom') return { x: box.x + box.w / 2, y: box.y + box.h }
    if (side === 'left') return { x: box.x, y: box.y + box.h / 2 }
    return { x: box.x + box.w, y: box.y + box.h / 2 }
  }

  function architectureEndpointBox(endpoint, model, layouts) {
    const node = model.nodes.get(endpoint.id)
    const parent = endpoint.useParentGroup && node && node.parent ? node.parent : endpoint.id
    return layouts.get(parent) || layouts.get(endpoint.id)
  }

  function architectureRouteFallback(start, startSide, end, endSide, stub = 24) {
    const vector = (side) => side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 } : side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 }
    const sv = vector(startSide), ev = vector(endSide)
    const startStub = { x: start.x + sv.x * stub, y: start.y + sv.y * stub }
    const endStub = { x: end.x + ev.x * stub, y: end.y + ev.y * stub }
    const points = [start, startStub]
    const startHorizontal = sv.x !== 0
    const endHorizontal = ev.x !== 0
    if (startHorizontal === endHorizontal) {
      if (startHorizontal) {
        const midX = (startStub.x + endStub.x) / 2
        points.push({ x: midX, y: startStub.y }, { x: midX, y: endStub.y })
      } else {
        const midY = (startStub.y + endStub.y) / 2
        points.push({ x: startStub.x, y: midY }, { x: endStub.x, y: midY })
      }
    } else if (startHorizontal) points.push({ x: endStub.x, y: startStub.y })
    else points.push({ x: startStub.x, y: endStub.y })
    points.push(endStub, end)
    return points.filter((point, index, items) => !index || Math.abs(point.x - items[index - 1].x) > 0.1 || Math.abs(point.y - items[index - 1].y) > 0.1)
  }

  function architectureRoute(start, startSide, end, endSide, occupiedSegments = [], obstacles = [], width = 0, height = 0, options = {}) {
    const startStubLength = options.startStub ?? 24
    const endStubLength = options.endStub ?? 24
    const candidates = []
    const scoreRoute = (points, baseScore = 0) => {
      const routeStart = { ...start }
      const routeEnd = { ...end }
      const simplified = simplifyPolyline(points.map((point) => ({ ...point })))
      if (simplified.length) simplified[0] = routeStart
      if (!simplified.length || Math.abs(simplified[simplified.length - 1].x - routeEnd.x) > 0.1 || Math.abs(simplified[simplified.length - 1].y - routeEnd.y) > 0.1) {
        simplified.push(routeEnd)
      } else simplified[simplified.length - 1] = routeEnd
      const obstaclePenalty = obstacles.some((rectValue) => c4PolylineIntersectsRect(simplified, rectValue)) ? 100000 : 0
      const occupiedPenalty = c4PolylineOverlapsSegments(simplified, occupiedSegments) ? 25000 : 0
      const canvasPenalty = simplified.some((point) => point.x < 0 || point.y < 0 || (width && point.x > width) || (height && point.y > height)) ? 50000 : 0
      candidates.push({
        points: simplified,
        score: baseScore + c4PolylineLength(simplified) + c4BendCount(simplified) * 28 + obstaclePenalty + occupiedPenalty + canvasPenalty,
      })
    }
    const verticalStart = startSide === 'top' || startSide === 'bottom'
    if (verticalStart) {
      const startDir = startSide === 'bottom' ? 1 : -1
      const endDir = endSide === 'top' ? -1 : endSide === 'bottom' ? 1 : 0
      const startTurnY = start.y + startDir * startStubLength
      const endTurnY = end.y + endDir * endStubLength
      const axes = [start.x, end.x, (start.x + end.x) / 2, Math.min(start.x, end.x) - 48, Math.max(start.x, end.x) + 48]
      obstacles.forEach((rectValue) => axes.push(rectValue.left - 16, rectValue.right + 16))
      occupiedSegments.filter((segment) => segment.orientation === 'vertical').forEach((segment) => axes.push(segment.axis - 18, segment.axis + 18))
      ;[...new Set(axes.map((value) => Math.round(value * 10) / 10))]
        .filter((axis) => axis >= 12 && (!width || axis <= width - 12))
        .forEach((axis) => scoreRoute(routeViaVerticalAxis(start, end, axis, startTurnY, endTurnY), Math.abs(axis - end.x) * 0.4))
    } else {
      const startDir = startSide === 'right' ? 1 : -1
      const endDir = endSide === 'left' ? -1 : endSide === 'right' ? 1 : 0
      const startTurnX = start.x + startDir * startStubLength
      const endTurnX = end.x + endDir * endStubLength
      const axes = [start.y, end.y, (start.y + end.y) / 2, Math.min(start.y, end.y) - 48, Math.max(start.y, end.y) + 48]
      obstacles.forEach((rectValue) => axes.push(rectValue.top - 16, rectValue.bottom + 16))
      occupiedSegments.filter((segment) => segment.orientation === 'horizontal').forEach((segment) => axes.push(segment.axis - 18, segment.axis + 18))
      ;[...new Set(axes.map((value) => Math.round(value * 10) / 10))]
        .filter((axis) => axis >= 12 && (!height || axis <= height - 12))
        .forEach((axis) => scoreRoute(routeViaHorizontalAxis(start, end, axis, startTurnX, endTurnX), Math.abs(axis - end.y) * 0.4))
    }
    scoreRoute(architectureRouteFallback(start, startSide, end, endSide, Math.max(startStubLength, endStubLength)), 80)
    candidates.sort((a, b) => a.score - b.score || c4PolylineLength(a.points) - c4PolylineLength(b.points))
    return candidates[0]?.points || architectureRouteFallback(start, startSide, end, endSide, Math.max(startStubLength, endStubLength))
  }

  function architectureEdgeObstacles(edge, model, layouts) {
    const sourceNode = model.nodes.get(edge.from.id)
    const targetNode = model.nodes.get(edge.to.id)
    const sourceParent = edge.from.useParentGroup && sourceNode && sourceNode.parent ? sourceNode.parent : edge.from.id
    const targetParent = edge.to.useParentGroup && targetNode && targetNode.parent ? targetNode.parent : edge.to.id
    const excluded = new Set([sourceParent, targetParent, edge.from.id, edge.to.id])
    const obstacles = []
    layouts.forEach((box, id) => {
      const node = model.nodes.get(id)
      if (!node || excluded.has(id)) return
      if (node.type === 'group') {
        obstacles.push({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + 58 })
      } else {
        obstacles.push(c4InflateRect(c4RectFromBox(box), 10))
      }
    })
    return obstacles
  }

  function renderArchitectureNode(id, model, layouts) {
    const t = theme()
    const node = model.nodes.get(id)
    const box = layouts.get(id)
    if (!node || !box) return ''
    if (node.type === 'group') {
      const childMarkup = node.children.map((child) => renderArchitectureNode(child, model, layouts)).join('')
      return `<g data-architecture-node="group" data-architecture-id="${attr(id)}">${rect(box.x, box.y, box.w, box.h, 26, t.surfaceAlt, t.border)}${architectureIcon(node.icon || 'cloud', box.x + 20, box.y + 18, 18)}${text(box.x + 50, box.y + 34, node.label, 15, 720, t.text, 'start')}${line(box.x + 18, box.y + 58, box.x + box.w - 18, box.y + 58, t.grid)}${childMarkup}</g>`
    }
    if (node.type === 'junction') {
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      return `<g data-architecture-node="junction" data-architecture-id="${attr(id)}">${circle(cx, cy, box.w / 2, t.accent, t.border)}${circle(cx, cy, box.w / 2 + 5, `${t.accent}2e`, 'none')}</g>`
    }
    const labelLines = c4WrapText(node.label, box.w - 68, 12, 650).slice(0, 2)
    const firstY = box.y + 27 - Math.max(0, labelLines.length - 1) * 7
    return `<g data-architecture-node="service" data-architecture-id="${attr(id)}">${rect(box.x, box.y, box.w, box.h, 18, t.surface, t.border)}${architectureIcon(node.icon || 'server', box.x + 16, box.y + 14, 16)}${labelLines.map((lineText, index) => c4Text(box.x + 48, firstY + index * 14, lineText, 12, 650, t.text)).join('')}</g>`
  }

  function renderArchitecture(source) {
    const t = theme()
    const model = parseArchitecture(source)
    const rootSizes = model.roots.map((id) => architectureNodeSize(id, model))
    const rootW = rootSizes.reduce((sum, size) => sum + size.w, 0) + Math.max(0, rootSizes.length - 1) * 92
    const rootH = Math.max(0, ...rootSizes.map((size) => size.h))
    const width = Math.max(420, rootW + 112)
    const height = Math.max(220, rootH + 80)
    const layouts = new Map()
    let x = 56
    model.roots.forEach((id, index) => {
      layoutArchitectureNode(id, model, layouts, x, 40)
      x += rootSizes[index].w + 92
    })
    const nodeLayer = model.roots.map((id) => renderArchitectureNode(id, model, layouts)).join('')
    const occupiedSegments = []
    const edgeLayer = model.edges.map((edge) => {
      const aBox = architectureEndpointBox(edge.from, model, layouts)
      const bBox = architectureEndpointBox(edge.to, model, layouts)
      if (!aBox || !bBox) return ''
      const start = architectureAnchor(aBox, edge.from.side)
      const end = architectureAnchor(bBox, edge.to.side)
      const route = architectureRoute(start, edge.from.side, end, edge.to.side, occupiedSegments, architectureEdgeObstacles(edge, model, layouts), width, height, {
        startStub: model.nodes.get(edge.from.id)?.type === 'junction' ? 10 : 24,
        endStub: model.nodes.get(edge.to.id)?.type === 'junction' ? 10 : 24,
      })
      c4SegmentsFromRoute(route).forEach((segment) => occupiedSegments.push(segment))
      return `<g data-architecture-edge="${attr(`${edge.from.id}:${edge.from.sideCode}->${edge.to.id}:${edge.to.sideCode}`)}">${rustPolylineArrowheads(route, t.link, false, edge.startArrow, edge.endArrow, 2)}</g>`
    }).join('')
    return rustSvgWithTitle(width, height, 'Architecture', `${nodeLayer}${edgeLayer}`, 'Architecture')
  }

  function parseStateDiagram(source) {
    const states = new Map()
    const order = []
    const transitions = []
    let startCount = 0
    let endCount = 0
    const ensureState = (id, label = id, kind = 'regular') => {
      if (!states.has(id)) {
        order.push(id)
        states.set(id, { id, label, kind })
      }
    }
    const resolvePseudo = (token, isSource) => {
      if (token !== '[*]') {
        ensureState(token)
        return token
      }
      if (isSource) {
        startCount += 1
        const id = `_start_${startCount}`
        ensureState(id, '', 'start')
        return id
      }
      endCount += 1
      const id = `_end_${endCount}`
      ensureState(id, '', 'end')
      return id
    }
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('direction ') || row === '}' || /^(style|class|click|classDef)\s+/.test(row)) return
      if (row.startsWith('state ')) {
        const rest = row.slice('state '.length).trim()
        if (rest.startsWith('"')) {
          const close = rest.slice(1).indexOf('"')
          if (close >= 0) {
            const label = rest.slice(1, 1 + close)
            const after = rest.slice(2 + close).trim()
            if (after.startsWith('as ')) ensureState(after.slice('as '.length).replace(/\{$/, '').trim(), label)
          }
        } else ensureState(rest.replace(/\{$/, '').trim())
        return
      }
      const arrow = row.indexOf('-->')
      if (arrow < 0) return
      const lhs = row.slice(0, arrow).trim()
      const rhsFull = row.slice(arrow + 3).trim()
      const colon = rhsFull.indexOf(':')
      const rhs = (colon >= 0 ? rhsFull.slice(0, colon) : rhsFull).trim()
      const label = colon >= 0 ? rhsFull.slice(colon + 1).trim() : ''
      if (!lhs || !rhs) return
      transitions.push({ from: resolvePseudo(lhs, true), to: resolvePseudo(rhs, false), label: label || null })
    })
    if (!states.size) throw new Error('state diagram requires at least one state or transition')
    return { states, order, transitions }
  }

  function renderStateShape(box, state) {
    const t = theme()
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    if (state.kind === 'start') return `<g data-state-node="${attr(state.id)}"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="14.0" fill="${t.text}" stroke="none"/></g>`
    if (state.kind === 'end') return `<g data-state-node="${attr(state.id)}"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="14.0" fill="none" stroke="${t.text}" stroke-width="2"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="7.0" fill="${t.text}" stroke="none"/></g>`
    return `<g data-state-node="${attr(state.id)}">${rect(box.x, box.y, box.w, box.h, 12, t.surface, t.border)}<rect x="${f1(box.x)}" y="${f1(box.y)}" width="${f1(box.w)}" height="${f1(box.h)}" rx="12" fill="${t.accent}" fill-opacity="0.08" stroke="none"/>${text(cx, cy + 13 * 0.35, state.label, 13, 500, t.text)}</g>`
  }

  function renderStateEdgeLabel(points, label) {
    if (!label || points.length < 2) return ''
    const t = theme()
    let best = null
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index], b = points[index + 1]
      const horizontal = Math.abs(a.y - b.y) < 0.1
      const length = horizontal ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y)
      if (!best || length > best.length) best = { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, horizontal, length }
    }
    if (!best) return ''
    const labelW = analyticsEstimateTextWidth(label, 11, 500) + 14
    const labelH = 20
    if (best.horizontal) {
      const lx = best.midpoint.x - labelW / 2
      const ly = best.midpoint.y - labelH - 4
      return `${rect(lx, ly, labelW, labelH, 10, t.surface, t.border)}${text(best.midpoint.x, ly + labelH / 2, label, 11, 500, t.muted)}`
    }
    const lx = best.midpoint.x + 6
    const ly = best.midpoint.y - labelH / 2
    return `${rect(lx, ly, labelW, labelH, 10, t.surface, t.border)}${text(lx + 7, ly + labelH / 2, label, 11, 500, t.muted, 'start')}`
  }

  function renderStateDiagram(source) {
    const t = theme()
    const diagram = parseStateDiagram(source)
    const sizes = new Map()
    diagram.order.forEach((id) => {
      const state = diagram.states.get(id)
      if (state.kind === 'start' || state.kind === 'end') sizes.set(id, { w: 28, h: 28 })
      else sizes.set(id, { w: Math.max(analyticsEstimateTextWidth(state.label, 13, 500) + 32, 160), h: 40 })
    })
    const rankConstraints = []
    diagram.transitions.forEach((transition) => pushUniqueAcyclicConstraint(rankConstraints, transition.from, transition.to))
    const rankMap = solveRankConstraints(diagram.order, rankConstraints)
    const ranks = new Map()
    diagram.order.forEach((id) => {
      const rank = rankMap.get(id) || 0
      if (!ranks.has(rank)) ranks.set(rank, [])
      ranks.get(rank).push(id)
    })
    const rowKeys = [...ranks.keys()].sort((a, b) => a - b)
    const contentW = Math.max(...[...ranks.values()].map((ids) => ids.reduce((sum, id) => sum + sizes.get(id).w, 0) + Math.max(0, ids.length - 1) * 56))
    const positions = new Map()
    let y = 0
    rowKeys.forEach((rank, rowIndex) => {
      const row = ranks.get(rank).sort()
      const rowH = Math.max(...row.map((id) => sizes.get(id).h))
      const rowW = row.reduce((sum, id) => sum + sizes.get(id).w, 0) + Math.max(0, row.length - 1) * 56
      let x = Math.max(0, (contentW - rowW) / 2)
      row.forEach((id, index) => {
        const size = sizes.get(id)
        positions.set(id, { x: 48 + x, y: 36 + y + Math.max(0, (rowH - size.h) / 2), w: size.w, h: size.h })
        x += size.w + (index + 1 < row.length ? 56 : 0)
      })
      y += rowH + (rowIndex + 1 < rowKeys.length ? 72 : 0)
    })
    const width = Math.max(300, contentW + 96)
    const height = Math.max(200, y + 72)
    const edgeLayer = diagram.transitions.map((transition) => {
      const a = positions.get(transition.from)
      const b = positions.get(transition.to)
      if (!a || !b) return ''
      const start = { x: a.x + a.w / 2, y: a.y + a.h }
      const end = { x: b.x + b.w / 2, y: b.y }
      const route = [start, end]
      return `${rustPolylineArrowheads(route, t.link, false, false, true, 2)}${renderStateEdgeLabel(route, transition.label)}`
    }).join('')
    const nodeLayer = diagram.order.map((id) => renderStateShape(positions.get(id), diagram.states.get(id))).join('')
    return rustSvg(width, height, `${edgeLayer}${nodeLayer}`, 'State diagram')
  }

  function analyticsEstimateTextWidth(value, fontSize, weight) {
    let units = 0
    for (const ch of String(value || '')) {
      if ('il!:;.,'.includes(ch)) units += 0.34
      else if ('mwMW@#'.includes(ch)) units += 0.88
      else if (ch === ' ') units += 0.28
      else if (/^[A-Z]$/.test(ch)) units += 0.66
      else if (/^[\x00-\x7F]$/.test(ch)) units += 0.58
      else units += 1
    }
    return units * fontSize * (weight >= 700 ? 1.04 : 1)
  }

  function analyticsPalette(index) {
    return rustPalette(index)
  }

  function stripOuterQuotes(value) {
    const textValue = String(value || '').trim()
    if (textValue.length >= 2 && ((textValue.startsWith('"') && textValue.endsWith('"')) || (textValue.startsWith("'") && textValue.endsWith("'")))) {
      return textValue.slice(1, -1)
    }
    return textValue
  }

  function splitQuotedCsv(raw) {
    const items = []
    let current = ''
    let inQuotes = false
    for (const ch of String(raw || '')) {
      if (ch === '"') {
        inQuotes = !inQuotes
        current += ch
      } else if (ch === ',' && !inQuotes) {
        const item = current.trim()
        if (item) items.push(item)
        current = ''
      } else {
        current += ch
      }
    }
    const item = current.trim()
    if (item) items.push(item)
    return items
  }

  function formatChartValue(value) {
    return Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1)
  }

  function smoothSvgPath(points) {
    if (!points.length) return ''
    if (points.length === 1) return `M ${f1(points[0].x)} ${f1(points[0].y)}`
    let d = `M ${f1(points[0].x)} ${f1(points[0].y)}`
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = index === 0 ? points[0] : points[index - 1]
      const p1 = points[index]
      const p2 = points[index + 1]
      const p3 = index + 2 < points.length ? points[index + 2] : points[index + 1]
      const cp1x = p1.x + (p2.x - p0.x) / 6
      const cp1y = p1.y + (p2.y - p0.y) / 6
      const cp2x = p2.x - (p3.x - p1.x) / 6
      const cp2y = p2.y - (p3.y - p1.y) / 6
      d += ` C ${f1(cp1x)} ${f1(cp1y)}, ${f1(cp2x)} ${f1(cp2y)}, ${f1(p2.x)} ${f1(p2.y)}`
    }
    return d
  }

  function pointOnPolygon(cx, cy, radius, count, index) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  }

  function polygonPoints(cx, cy, radius, count) {
    return Array.from({ length: count }, (_, index) => pointOnPolygon(cx, cy, radius, count, index))
  }

  function polygonSvg(points, fill, stroke, width, opacity) {
    const pointText = points.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ')
    return `<polygon points="${pointText}" fill="${fill}" fill-opacity="${Number(opacity).toFixed(2)}" stroke="${stroke}" stroke-width="${f1(width)}" stroke-linejoin="round"/>`
  }

  function parseXyChartLabel(raw) {
    return stripOuterQuotes(raw)
  }

  function parseXyChartSeries(raw) {
    const bracketStart = raw.indexOf('[')
    const bracketEnd = raw.lastIndexOf(']')
    if (bracketStart < 0) throw new Error('series requires `[...]` values')
    if (bracketEnd < 0) throw new Error('series requires closing `]`')
    if (bracketEnd <= bracketStart) throw new Error('series value list is malformed')
    const label = raw.slice(0, bracketStart).trim()
    const values = splitQuotedCsv(raw.slice(bracketStart + 1, bracketEnd)).map((part) => {
      const value = Number(part)
      if (!Number.isFinite(value)) throw new Error(`series value \`${part}\` must be numeric`)
      return value
    })
    return { label: label ? parseXyChartLabel(label) : null, values }
  }

  function parseXyChartXAxis(raw) {
    const bracketStart = raw.indexOf('[')
    const bracketEnd = raw.lastIndexOf(']')
    if (bracketStart < 0) throw new Error('x-axis requires `[...]` labels')
    if (bracketEnd < 0) throw new Error('x-axis requires closing `]`')
    if (bracketEnd <= bracketStart) throw new Error('x-axis label list is malformed')
    const title = raw.slice(0, bracketStart).trim()
    return {
      title: title ? parseXyChartLabel(title) : null,
      labels: splitQuotedCsv(raw.slice(bracketStart + 1, bracketEnd)).map(parseXyChartLabel),
    }
  }

  function parseXyChartYAxis(raw) {
    const parts = raw.split('-->')
    if (parts.length < 2) throw new Error('y-axis requires `min --> max`')
    const max = Number(parts.slice(1).join('-->').trim())
    if (!Number.isFinite(max)) throw new Error('y-axis max must be numeric')
    const leftParts = parts[0].trim().split(/\s+/).filter(Boolean)
    const minRaw = leftParts.pop()
    const min = Number(minRaw)
    if (!Number.isFinite(min)) throw new Error('y-axis min must be numeric')
    const title = leftParts.join(' ')
    return { title: title ? parseXyChartLabel(title) : null, min, max }
  }

  function parseXyChart(source) {
    const rows = source.split(/\r?\n/).map((line, index) => ({ line: line.trim(), lineNumber: index + 1 })).filter((row) => row.line && !row.line.startsWith('%%'))
    if (!rows.length) throw new Error('xychart source is empty')
    const directive = rows[0].line.split(/\s+/, 1)[0]
    if (directive !== 'xychart' && directive !== 'xychart-beta') throw new Error(`line ${rows[0].lineNumber}: expected \`xychart\` as the first directive`)
    const chart = { title: null, xAxisTitle: null, xLabels: [], yAxisTitle: null, yMin: 0, yMax: 100, yAxisSeen: false, barSeries: [], lineSeries: [] }
    rows.slice(1).forEach(({ line, lineNumber }) => {
      try {
        if (line.startsWith('title ')) chart.title = parseXyChartLabel(line.slice('title '.length).trim())
        else if (line.startsWith('x-axis ')) {
          const axis = parseXyChartXAxis(line.slice('x-axis '.length).trim())
          chart.xAxisTitle = axis.title
          chart.xLabels = axis.labels
        } else if (line.startsWith('y-axis ')) {
          const axis = parseXyChartYAxis(line.slice('y-axis '.length).trim())
          chart.yAxisTitle = axis.title
          chart.yMin = axis.min
          chart.yMax = axis.max
          chart.yAxisSeen = true
        } else if (line.startsWith('bar ')) chart.barSeries.push(parseXyChartSeries(line.slice('bar '.length).trim()))
        else if (line.startsWith('line ')) chart.lineSeries.push(parseXyChartSeries(line.slice('line '.length).trim()))
      } catch (error) {
        throw new Error(`line ${lineNumber}: ${error.message}`)
      }
    })
    if (!chart.barSeries.length && !chart.lineSeries.length) throw new Error('xychart requires at least one `bar` or `line` series')
    const allValues = chart.barSeries.concat(chart.lineSeries).flatMap((series) => series.values)
    if (!chart.yAxisSeen) {
      chart.yMin = Math.min(...allValues, 0)
      chart.yMax = Math.max(...allValues, 0)
      if (Math.abs(chart.yMax - chart.yMin) < Number.EPSILON) chart.yMax = chart.yMin + 1
    } else if (Math.abs(chart.yMax - chart.yMin) < Number.EPSILON) {
      chart.yMax = chart.yMin + 1
    }
    const pointCount = Math.max(0, ...chart.barSeries.concat(chart.lineSeries).map((series) => series.values.length))
    chart.barSeries.concat(chart.lineSeries).forEach((series) => {
      if (series.values.length !== pointCount) throw new Error('xychart series lengths must match')
    })
    return chart
  }

  function renderXyChart(source) {
    const t = theme()
    const chart = parseXyChart(source)
    const pointCount = Math.max(chart.xLabels.length, ...chart.barSeries.concat(chart.lineSeries).map((series) => series.values.length))
    if (!pointCount) throw new Error('xychart requires at least one data point')
    const xLabels = chart.xLabels.length ? chart.xLabels : Array.from({ length: pointCount }, (_, index) => String(index + 1))
    if (xLabels.length !== pointCount) throw new Error(`xychart x-axis label count ${xLabels.length} does not match data length ${pointCount}`)
    const width = 860
    const height = 376
    const plotX = 128
    const plotY = 88
    const plotW = 620
    const plotH = 214
    const ySpan = Math.max(chart.yMax - chart.yMin, 1)
    const groupStep = plotW / pointCount
    const scaleY = (value) => plotY + plotH - Math.max(0, Math.min(1, (value - chart.yMin) / ySpan)) * plotH
    const plot = []
    for (let row = 0; row <= 10; row += 1) {
      const y = plotY + plotH * row / 10
      for (let col = 0; col <= 31; col += 1) {
        const x = plotX + plotW * col / 31
        plot.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="1.7" fill="${t.grid}" fill-opacity="0.56"/>`)
      }
    }
    const barSlotCount = Math.max(chart.barSeries.length, 1)
    const barGroupWidth = Math.min(groupStep * 0.7, 86)
    const barWidth = Math.max(barGroupWidth / barSlotCount * 0.74, 12)
    chart.barSeries.forEach((series, seriesIndex) => {
      const color = analyticsPalette(seriesIndex)
      series.values.forEach((value, index) => {
        const centerX = plotX + groupStep * (index + 0.5)
        const slotWidth = barGroupWidth / barSlotCount
        const x = centerX - barGroupWidth / 2 + slotWidth * seriesIndex + (slotWidth - barWidth) / 2
        const y = scaleY(value)
        const barH = Math.max(plotY + plotH - y, 0)
        plot.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(barWidth)}" height="${f1(barH)}" rx="10.0" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>`)
      })
    })
    chart.lineSeries.forEach((series, seriesIndex) => {
      const stroke = analyticsPalette(seriesIndex + chart.barSeries.length)
      const points = series.values.map((value, index) => ({ x: plotX + groupStep * (index + 0.5), y: scaleY(value) }))
      if (points.length >= 2) {
        const d = smoothSvgPath(points)
        plot.push(`<path d="${attr(d)}" fill="none" stroke="${stroke}" stroke-opacity="0.16" stroke-width="6.0" stroke-linecap="round" stroke-linejoin="round"/>`)
        plot.push(`<path d="${attr(d)}" fill="none" stroke="${stroke}" stroke-width="3.0" stroke-linecap="round" stroke-linejoin="round"/>`)
      }
      points.forEach((p) => plot.push(`<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="5.2" fill="${stroke}" stroke="${t.surface}" stroke-width="2.8"/>`))
    })
    const body = [`<g data-diagram-center-target="true">${plot.join('')}</g>`]
    for (let tick = 0; tick < 5; tick += 1) {
      const ratio = tick / 4
      body.push(text(plotX - 32, plotY + plotH - plotH * ratio, formatChartValue(chart.yMin + ySpan * ratio), 13, 550, t.muted, 'middle'))
    }
    xLabels.forEach((label, index) => body.push(text(plotX + groupStep * (index + 0.5), plotY + plotH + 28, label, 13, 550, t.muted)))
    if (chart.xAxisTitle) body.push(c4Text(plotX + plotW / 2, plotY + plotH + 58, chart.xAxisTitle, 12, 600, t.muted, 'middle'))
    if (chart.yAxisTitle) body.push(`<text x="38.0" y="${f1(plotY + plotH / 2)}" fill="${t.muted}" text-anchor="middle" transform="rotate(-90 38.0 ${f1(plotY + plotH / 2)})" font-family="${UI_FONT}" font-size="12.0" font-weight="650">${escapeHtml(chart.yAxisTitle)}</text>`)
    const totalSeries = chart.barSeries.length + chart.lineSeries.length
    if (totalSeries > 1) {
      const legendEntries = chart.barSeries.map((series, index) => ({ paletteIndex: index, kind: 'bar', label: series.label || `Bar ${index + 1}` }))
        .concat(chart.lineSeries.map((series, index) => ({ paletteIndex: index + chart.barSeries.length, kind: 'line', label: series.label || `Line ${index + 1}` })))
      const legendWidth = legendEntries.reduce((sum, entry) => sum + (entry.kind === 'bar' ? 32 : 40) + analyticsEstimateTextWidth(entry.label, 12, 600), 0) + 22 * Math.max(0, legendEntries.length - 1)
      let cursorX = plotX + (plotW - legendWidth) / 2
      const legendY = 54
      legendEntries.forEach((entry) => {
        const color = analyticsPalette(entry.paletteIndex)
        if (entry.kind === 'bar') {
          body.push(`<rect x="${f1(cursorX)}" y="${f1(legendY - 11)}" width="20.0" height="14.0" rx="4.0" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>`)
          body.push(c4Text(cursorX + 30, legendY - 1, entry.label, 12, 600, t.muted))
          cursorX += 32 + analyticsEstimateTextWidth(entry.label, 12, 600) + 22
        } else {
          body.push(`<g><line x1="${f1(cursorX)}" y1="${f1(legendY - 1)}" x2="${f1(cursorX + 28)}" y2="${f1(legendY - 1)}" stroke="${color}" stroke-width="3.0" stroke-linecap="round"/><circle cx="${f1(cursorX + 14)}" cy="${f1(legendY - 1)}" r="4.6" fill="${color}" stroke="${t.surface}" stroke-width="2.4"/></g>`)
          body.push(c4Text(cursorX + 38, legendY - 1, entry.label, 12, 600, t.muted))
          cursorX += 40 + analyticsEstimateTextWidth(entry.label, 12, 600) + 22
        }
      })
    }
    return analyticsSvgWithTitle(width, height, chart.title || 'XY Chart', body.join(''))
  }

  function renderRadar(source) {
    const t = theme()
    let title = ''
    let axes = []
    const curves = []
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('title')) {
        title = stripOuterQuotes(row.slice('title'.length).trim())
      } else if (row.startsWith('axis ')) {
        axes = row.slice('axis '.length).split(',').map((value) => value.trim())
      } else if (row.startsWith('curve ')) {
        const rest = row.slice('curve '.length)
        const split = rest.indexOf('{')
        if (split >= 0) {
          curves.push({
            name: rest.slice(0, split).trim(),
            values: rest.slice(split + 1).replace(/\}$/, '').split(',').map((value) => Number(value.trim())).filter(Number.isFinite),
          })
        }
      }
    })
    if (!axes.length || !curves.length) throw new Error('radar-beta requires axis and at least one curve')
    if (!title) title = 'Radar'
    const width = 840
    const height = 520
    const cx = 320
    const cy = 270
    const radius = 138
    const radarBody = []
    const body = []
    for (let ring = 1; ring <= 5; ring += 1) {
      const r = radius * ring / 5
      radarBody.push(polygonSvg(polygonPoints(cx, cy, r, axes.length), 'none', t.grid, 1, 0))
      radarBody.push(`<text x="${f1(cx - 6)}" y="${f1(cy - r)}" fill="${t.muted}" font-size="9" text-anchor="end" dominant-baseline="middle" opacity="0.7">${ring}</text>`)
    }
    const axisPoints = polygonPoints(cx, cy, radius, axes.length)
    axes.forEach((axisLabel, index) => {
      const p = axisPoints[index]
      radarBody.push(line(cx, cy, p.x, p.y, t.grid))
      const textWidth = analyticsEstimateTextWidth(axisLabel, 11, 650)
      const labelRadius = radius + 26 + Math.min(textWidth * 0.12, 18)
      const lp = pointOnPolygon(cx, cy, labelRadius, axes.length, index)
      const dx = lp.x - cx
      const dy = lp.y - cy
      const x = dx > 0 ? lp.x + 10 : dx < 0 ? lp.x - 10 : lp.x
      const y = dy > 0 ? lp.y + 10 : dy < 0 ? lp.y - 10 : lp.y
      const anchor = dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle'
      const baseline = dy > 0 ? 'hanging' : dy < 0 ? 'auto' : 'middle'
      body.push(`<text x="${f1(x)}" y="${f1(y)}" fill="${t.text}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-family="${UI_FONT}" font-size="11.0" font-weight="650">${escapeHtml(axisLabel)}</text>`)
    })
    curves.forEach((curve, index) => {
      const color = analyticsPalette(index)
      const points = curve.values.map((value, axisIndex) => pointOnPolygon(cx, cy, radius * Math.max(0, Math.min(1, value / 5)), axes.length, axisIndex))
      radarBody.push(polygonSvg(points, color, color, 2, 0.18))
      points.forEach((p) => radarBody.push(`<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="4.0" fill="${color}" stroke="${t.surface}" stroke-width="1.5"/>`))
      const legendY = 116 + index * 26
      body.push(`<circle cx="636.0" cy="${f1(legendY - 1)}" r="5.0" fill="${color}"/>`)
      body.push(c4Text(648, legendY, curve.name, 12, 700, color))
    })
    body.push(`<g data-diagram-center-target="true">${radarBody.join('')}</g>`)
    return analyticsSvgWithTitle(width, height, title, body.join(''))
  }

  function pointInCircle(x, y, cx, cy, r) {
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= r * r
  }

  function vennExclusiveRegionCentroid(circles, targetIndex) {
    const [cx, cy, r] = circles[targetIndex]
    let sumX = 0
    let sumY = 0
    let count = 0
    for (let y = cy - r; y <= cy + r; y += 4) {
      for (let x = cx - r; x <= cx + r; x += 4) {
        if (pointInCircle(x, y, cx, cy, r) && circles.every((circle, index) => index === targetIndex || !pointInCircle(x, y, circle[0], circle[1], circle[2]))) {
          sumX += x
          sumY += y
          count += 1
        }
      }
    }
    return count > 0 ? { x: sumX / count, y: sumY / count } : { x: cx, y: cy - r * 0.42 }
  }

  function vennLabelBlock(cx, cy, label, value) {
    const t = theme()
    return `${text(cx, cy - 12, label, 16, 700, t.text)}${text(cx, cy + 12, value, 12, 650, t.muted)}`
  }

  function renderVenn(source) {
    const t = theme()
    const sets = []
    const unions = []
    linesOf(source).slice(1).forEach((row) => {
      if (row.startsWith('set ')) {
        const rest = row.slice('set '.length)
        const colon = rest.lastIndexOf(':')
        if (colon >= 0) {
          const name = rest.slice(0, colon)
          const bracket = name.match(/\[(.*)\]/)
          const label = stripOuterQuotes((bracket ? bracket[1] : name).trim())
          sets.push([label, Number(rest.slice(colon + 1).trim()) || 0])
        }
      } else if (row.startsWith('union ')) {
        const rest = row.slice('union '.length)
        const labelMatch = rest.match(/\[(.*?)\]/)
        const label = stripOuterQuotes(labelMatch ? labelMatch[1].trim() : 'Overlap')
        const colon = rest.lastIndexOf(':')
        const value = colon >= 0 ? Number(rest.slice(colon + 1).trim()) || 0 : 0
        unions.push([label, value])
      }
    })
    if (sets.length < 2) throw new Error('venn-beta requires at least two sets')
    const width = 760
    const height = 420
    const circles = [
      [300, 220, 110, analyticsPalette(0)],
      [420, 220, 110, analyticsPalette(1)],
      [360, 140, 96, analyticsPalette(2)],
    ]
    const activeCircleCount = Math.min(sets.length, circles.length)
    const body = []
    sets.slice(0, 3).forEach(([label, value], index) => {
      const [cx, cy, r, fill] = circles[index]
      const centroid = vennExclusiveRegionCentroid(circles.slice(0, activeCircleCount), index)
      body.push(circleWithAlpha(cx, cy, r, fill, t.border, 0.28))
      body.push(vennLabelBlock(centroid.x, centroid.y, label, value.toFixed(0)))
    })
    unions.slice(0, 2).forEach(([label, value]) => body.push(vennLabelBlock(360, 220, label, value.toFixed(0))))
    return analyticsSvgWithTitle(width, height, 'Venn', body.join(''))
  }

  function renderSequenceDiagram(source) {
    const themeMode = currentThemeMode()
    const sequenceTheme = themeMode === 'dark'
      ? {
        background: '#00000000',
        actorFill: '#0f172a',
        actorStroke: '#94a3b8',
        actorText: '#e5e7eb',
        line: '#cbd5e1',
        lifeline: '#94a3b8',
        labelText: '#e5e7eb',
      }
      : {
        background: '#00000000',
        actorFill: '#ffffff',
        actorStroke: '#4b5563',
        actorText: '#111827',
        line: '#374151',
        lifeline: '#6b7280',
        labelText: '#111827',
      }
    const participants = []
    const participantIndex = new Map()
    const messages = []
    const registerParticipant = (id, label = id) => {
      const key = rawMermaidText(id)
      const display = rustStripQuotes(label)
      if (!key) return ''
      if (participantIndex.has(key)) {
        const existing = participants[participantIndex.get(key)]
        if (existing.label === existing.id && display !== key) existing.label = display
        return key
      }
      participantIndex.set(key, participants.length)
      participants.push({ id: key, label: display || key })
      return key
    }
    const parseParticipantDecl = (row) => {
      const match = row.match(/^(participant|actor)\s+(.+)$/i)
      if (!match) return null
      const declaration = match[2].trim()
      const alias = declaration.match(/^(.+?)\s+as\s+(.+)$/i)
      return alias ? { id: alias[1].trim(), label: alias[2].trim() } : { id: declaration, label: declaration }
    }
    const parseSequenceMessage = (row) => {
      const decoded = decodeHtmlEntities(row)
      const colon = decoded.indexOf(':')
      if (colon < 0) return null
      const edge = decoded.slice(0, colon)
      const label = decoded.slice(colon + 1).trim()
      if (!label) return null
      for (const [operator, style] of [['-->>', 'dashed'], ['->>', 'solid'], ['-->', 'dashed'], ['->', 'solid']]) {
        const operatorIndex = edge.indexOf(operator)
        if (operatorIndex < 0) continue
        const from = edge.slice(0, operatorIndex).trim()
        const to = edge.slice(operatorIndex + operator.length).trim()
        if (!from || !to) return null
        return { from, to, label, style }
      }
      return null
    }
    for (const row of linesOf(source).slice(1)) {
      const part = parseParticipantDecl(row)
      const msg = parseSequenceMessage(row)
      if (part) {
        registerParticipant(part.id, part.label)
      } else if (msg) {
        const from = registerParticipant(msg.from, msg.from)
        const to = registerParticipant(msg.to, msg.to)
        messages.push({ ...msg, from, to })
      }
    }
    if (!participants.length) throw new Error('sequenceDiagram requires at least one participant')
    const sequenceEstimateTextWidth = (value, fontSize, weight) => {
      let width = 0
      for (const ch of String(value || '')) {
        if (ch === ' ') width += fontSize * 0.34
        else if (/^[A-Z]$/.test(ch)) width += fontSize * 0.68
        else if (/^[a-z0-9]$/.test(ch)) width += fontSize * 0.58
        else if ("-_/:.,()".includes(ch)) width += fontSize * 0.42
        else if (/^[\x00-\x7F]$/.test(ch) && /[^\w\s]/.test(ch)) width += fontSize * 0.48
        else width += fontSize * 0.94
      }
      return width * (weight >= 600 ? 1.03 : 1)
    }
    const sequenceWrapLongToken = (token, fontSize, maxWidth) => {
      const parts = []
      let current = ''
      for (const ch of token) {
        const candidate = `${current}${ch}`
        if (current && sequenceEstimateTextWidth(candidate, fontSize, 500) > maxWidth) {
          parts.push(current)
          current = ch
        } else {
          current = candidate
        }
      }
      if (current) parts.push(current)
      return parts
    }
    const sequenceWrapText = (value, fontSize, maxWidth) => {
      const boundedWidth = Math.max(maxWidth, fontSize * 4)
      const lines = []
      let current = ''
      for (const token of String(value || '').split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${token}` : token
        if (sequenceEstimateTextWidth(candidate, fontSize, 500) <= boundedWidth) {
          current = candidate
          continue
        }
        if (current) lines.push(current)
        if (sequenceEstimateTextWidth(token, fontSize, 500) <= boundedWidth) {
          current = token
        } else {
          const wrapped = sequenceWrapLongToken(token, fontSize, boundedWidth)
          current = wrapped.pop() || ''
          lines.push(...wrapped)
        }
      }
      if (current) lines.push(current)
      return lines.length ? lines : ['']
    }
    const sequenceWrapTextPreferLines = (value, fontSize, maxWidth, preferredMaxLines) => {
      const boundedWidth = Math.max(maxWidth, fontSize * 4)
      const naturalWidth = sequenceEstimateTextWidth(value, fontSize, 500)
      if (!/\s/.test(value) && naturalWidth <= boundedWidth + fontSize * 6) return [value]
      const minimumWidth = Math.max(fontSize * 8, Math.min(boundedWidth * 0.58, boundedWidth))
      let widthCandidate = boundedWidth
      let best = sequenceWrapText(value, fontSize, widthCandidate)
      while (widthCandidate > minimumWidth) {
        const nextWidth = Math.max(minimumWidth, widthCandidate - fontSize * 2)
        const candidate = sequenceWrapText(value, fontSize, nextWidth)
        if (candidate.length > preferredMaxLines) break
        best = candidate
        if (Math.abs(nextWidth - minimumWidth) < Number.EPSILON) break
        widthCandidate = nextWidth
      }
      return best.length <= preferredMaxLines || naturalWidth <= boundedWidth
        ? best
        : sequenceWrapText(value, fontSize, boundedWidth)
    }
    const longestLineWidth = (lines, fontSize, weight) => lines.reduce((max, lineValue) => Math.max(max, sequenceEstimateTextWidth(lineValue, fontSize, weight)), 0)
    const effectiveLabelWidth = (textBlockWidth, maxLabelWidth, fontSize, lineCount, labelPaddingX) => {
      const naturalWidth = textBlockWidth + labelPaddingX * 2
      if (lineCount === 1) return Math.min(naturalWidth, maxLabelWidth + fontSize * 6)
      return Math.min(naturalWidth, maxLabelWidth)
    }
    const stableHash64 = (value, mode) => {
      let hash = 0xcbf29ce484222325n
      const prime = 0x100000001b3n
      const utf8Bytes = (textValue) => {
        const encoded = encodeURIComponent(String(textValue))
        const bytes = []
        for (let index = 0; index < encoded.length; index += 1) {
          if (encoded[index] === '%') {
            bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16))
            index += 2
          } else {
            bytes.push(encoded.charCodeAt(index))
          }
        }
        return bytes
      }
      const bytes = utf8Bytes(value).concat([0xff], utf8Bytes(mode))
      for (const byte of bytes) {
        hash ^= BigInt(byte)
        hash = (hash * prime) & 0xffffffffffffffffn
      }
      return hash.toString(16).padStart(16, '0')
    }
    const actorFontSize = 15
    const messageFontSize = 13
    const actorPaddingX = 26
    const actorBoxHeight = 56
    const actorGap = 72
    const laneMinWidth = 196
    const marginX = 28
    const marginTop = 20
    const marginBottom = 24
    const actorToMessageGap = 30
    const rowGap = 28
    const selfLoopWidth = 44
    const selfLoopHeight = 28
    const messageLabelPaddingX = 12
    const messageLabelPaddingY = 7
    const lineEndpointPadding = 8
    const actorWidths = participants.map((participant) => Math.max(104, sequenceEstimateTextWidth(participant.label, actorFontSize, 600) + actorPaddingX * 2))
    const laneWidths = actorWidths.map((widthValue) => Math.max(widthValue, laneMinWidth))
    const centers = []
    let cursor = marginX
    laneWidths.forEach((laneWidth) => {
      centers.push(cursor + laneWidth / 2)
      cursor += laneWidth + actorGap
    })
    const width = Math.max(480, cursor - actorGap + marginX)
    const actorBoxY = marginTop
    const lifelineTop = actorBoxY + actorBoxHeight
    let currentY = lifelineTop + actorToMessageGap
    const markerId = `doc-seq-${stableHash64(source, themeMode)}-arrow`
    const renderTspans = (className, x, y, anchor, lines, lineHeight) => {
      const spans = lines.map((lineValue, index) => `<tspan x="${f1(x)}" dy="${f1(index === 0 ? 0 : lineHeight)}">${escapeHtml(lineValue)}</tspan>`).join('')
      return `<text class="${className}" x="${f1(x)}" y="${f1(y)}" text-anchor="${anchor}">${spans}</text>`
    }
    const messageMarkup = []
    messages.forEach((message) => {
      const fromIndex = participantIndex.get(message.from)
      const toIndex = participantIndex.get(message.to)
      const fromX = centers[fromIndex]
      const toX = centers[toIndex]
      const classSuffix = message.style === 'dashed' ? ' is-dashed' : ''
      const strokeDash = message.style === 'dashed' ? ' stroke-dasharray="7 7"' : ''
      if (fromIndex === toIndex) {
        const loopExtent = fromX + selfLoopWidth
        const diagramRight = width - marginX
        const maxLabelWidth = Math.max(messageFontSize * 10, diagramRight - (loopExtent + 6))
        const lines = sequenceWrapTextPreferLines(message.label, messageFontSize, maxLabelWidth - messageLabelPaddingX * 2, 2)
        const textBlockWidth = longestLineWidth(lines, messageFontSize, 500)
        const textLineHeight = messageFontSize * 1.24
        const textBlockHeight = lines.length * textLineHeight
        const labelWidth = effectiveLabelWidth(textBlockWidth, maxLabelWidth, messageFontSize, lines.length, messageLabelPaddingX)
        const labelHeight = textBlockHeight + messageLabelPaddingY * 2
        const contentHeight = Math.max(selfLoopHeight, labelHeight)
        const loopTop = currentY
        const loopBottom = currentY + contentHeight
        const contentCenterY = currentY + contentHeight / 2
        const labelTextY = contentCenterY - (lines.length - 1) * textLineHeight / 2 + messageFontSize * 0.35
        const labelTextX = loopExtent + 6 + labelWidth / 2
        messageMarkup.push(`<g class="doc-sequence-message${classSuffix}">${renderTspans('doc-sequence-label', labelTextX, labelTextY, 'middle', lines, textLineHeight)}<path class="doc-sequence-line${classSuffix}" d="M ${f1(fromX)} ${f1(loopTop)} H ${f1(loopExtent)} V ${f1(loopBottom)} H ${f1(fromX)}" marker-end="url(#${attr(markerId)})"${strokeDash}/></g>`)
        currentY = loopBottom
      } else {
        const arrowSpan = Math.abs(toX - fromX)
        const maxLabelWidth = Math.max(messageFontSize * 10, arrowSpan - lineEndpointPadding * 2)
        const lines = sequenceWrapTextPreferLines(message.label, messageFontSize, maxLabelWidth - messageLabelPaddingX * 2, 2)
        const textBlockWidth = longestLineWidth(lines, messageFontSize, 500)
        const textLineHeight = messageFontSize * 1.24
        const textBlockHeight = lines.length * textLineHeight
        const labelWidth = effectiveLabelWidth(textBlockWidth, maxLabelWidth, messageFontSize, lines.length, messageLabelPaddingX)
        const labelHeight = textBlockHeight + messageLabelPaddingY * 2
        const midpointX = (fromX + toX) / 2
        const labelX = midpointX - labelWidth / 2
        const lineY = currentY + labelHeight
        const labelTextX = labelX + labelWidth / 2
        const labelTextY = currentY + messageFontSize * 0.92
        messageMarkup.push(`<g class="doc-sequence-message${classSuffix}">${renderTspans('doc-sequence-label', labelTextX, labelTextY, 'middle', lines, textLineHeight)}<line class="doc-sequence-line${classSuffix}" x1="${f1(fromX)}" y1="${f1(lineY)}" x2="${f1(toX)}" y2="${f1(lineY)}" marker-end="url(#${attr(markerId)})"${strokeDash}/></g>`)
        currentY = lineY
      }
      currentY += rowGap
    })
    const lifelineBottom = Math.max(currentY - rowGap + 8, lifelineTop + 140)
    const height = lifelineBottom + marginBottom
    const lifelineMarkup = participants.map((participant, index) => {
      const centerX = centers[index]
      return `<line class="doc-sequence-lifeline" x1="${f1(centerX)}" y1="${f1(lifelineTop)}" x2="${f1(centerX)}" y2="${f1(lifelineBottom)}" />`
    }).join('')
    const actorMarkup = participants.map((participant, index) => {
      const centerX = centers[index]
      const actorWidth = actorWidths[index]
      const rectX = centerX - actorWidth / 2
      return `<g class="doc-sequence-actor" data-id="${attr(participant.id)}"><rect class="doc-sequence-actor-box" x="${f1(rectX)}" y="${f1(actorBoxY)}" width="${f1(actorWidth)}" height="${f1(actorBoxHeight)}" /><text class="doc-sequence-actor-label" x="${f1(centerX)}" y="${f1(actorBoxY + actorBoxHeight / 2 + 5.4)}" text-anchor="middle">${escapeHtml(participant.label)}</text></g>`
    }).join('')
    const scopeId = markerId.replace(/-arrow$/, '')
    return `<svg xmlns="http://www.w3.org/2000/svg" class="doc-sequence-svg" data-sequence-scope="${attr(scopeId)}" viewBox="0 0 ${f1(width)} ${f1(height)}" width="${f1(width)}" height="${f1(height)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Sequence diagram" data-diagram-body-center-x="${f1(width / 2)}" data-diagram-body-center-y="${f1(height / 2)}"><style>.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}']{background:${sequenceTheme.background};font-family:'LINE Seed JP','Hiragino Sans','Yu Gothic UI','Segoe UI',sans-serif}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-actor-box{fill:${sequenceTheme.actorFill};stroke:${sequenceTheme.actorStroke};stroke-width:1.5}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-actor-label{fill:${sequenceTheme.actorText};font-size:${actorFontSize}px;font-weight:700}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-lifeline{stroke:${sequenceTheme.lifeline};stroke-width:1.25;stroke-dasharray:7 7}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-line{stroke:${sequenceTheme.line};stroke-width:1.6;fill:none}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-line.is-dashed{stroke-dasharray:7 7}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-arrow{fill:${sequenceTheme.line};stroke:none}.doc-sequence-svg[data-sequence-scope='${attr(scopeId)}'] .doc-sequence-label{fill:${sequenceTheme.labelText};font-size:${messageFontSize}px;font-weight:500}</style><defs><marker id="${attr(markerId)}" markerWidth="10" markerHeight="8" refX="8.5" refY="4" orient="auto"><path class="doc-sequence-arrow" d="M 0 0 L 8.5 4 L 0 8 z" /></marker></defs><g data-diagram-body="true">${lifelineMarkup}${messageMarkup.join('')}${actorMarkup}</g></svg>`
  }

  function sourceFromCodeBlock(codeElement) {
    const className = codeElement.className || ''
    if (!/(^|\s)language-mermaid(\s|$)/.test(className) && !className.includes('highlight-source-mermaid')) {
      return null
    }
    const source = codeElement.textContent || ''
    if (!supportedDiagramType(source)) return null
    return source
  }

  function sourceFromMermaidElement(element) {
    const stored = element.getAttribute(SOURCE_ATTR)
    if (stored) return stored
    const githubDataContent = sourceFromGitHubDataContent(element)
    if (githubDataContent) return githubDataContent
    if (element instanceof HTMLIFrameElement) {
      loadRawMarkdownSources()
      return null
    }
    const textContent = element.textContent || ''
    if (supportedDiagramType(textContent)) return textContent
    const ownRoleType = supportedRoleDiagramType(element)
    if (ownRoleType) {
      const source = rawMarkdownSourceForElement(element, ownRoleType)
      return supportedDiagramType(source) ? source : null
    }
    if (element.querySelector?.('svg')) {
      const nestedRoleType = supportedRoleDiagramType(element.querySelector('svg[aria-roledescription]'))
      if (!nestedRoleType) {
        loadRawMarkdownSources()
        return null
      }
      const source = rawMarkdownSourceForElement(element, nestedRoleType)
      if (supportedDiagramType(source)) return source
    }
    loadRawMarkdownSources()
    return null
  }

  function replacementHtml(source, renderedSvg) {
    return `
      <figure class="docattice-github-mermaid" data-docattice-diagram-type="${attr(detectMermaidDiagramType(source))}">
        <div class="docattice-github-mermaid__stage">${renderedSvg}</div>
        <details class="docattice-github-mermaid__source">
          <summary>Mermaid source</summary>
          <pre><code>${escapeHtml(source)}</code></pre>
        </details>
      </figure>
    `
  }

  function errorHtml(source, error) {
    return `
      <aside class="docattice-github-mermaid-error">
        <strong>Docattice Mermaid render failed</strong>
        <span>${escapeHtml(error?.message || String(error))}</span>
      </aside>
      <pre><code>${escapeHtml(source)}</code></pre>
    `
  }

  function githubRenderTargetFor(element) {
    return element.closest?.('.render-container.js-render-target, .render-container, [data-identity="mermaid"]') || element
  }

  function removeGitHubRichDisplaySiblings(element) {
    const removeAround = (target) => {
      if (!target?.parentElement) return
      const previous = target.previousElementSibling
      if (previous?.classList?.contains('js-render-block-actions')) previous.remove()
      let next = target.nextElementSibling
      while (
        next?.classList?.contains('js-render-enrichment-loader')
        || next?.classList?.contains('js-render-enrichment-fallback')
        || next?.classList?.contains('js-render-enrichment-fallback-error')
      ) {
        const current = next
        next = next.nextElementSibling
        current.remove()
      }
      target.querySelectorAll?.('.js-render-enrichment-loader, .js-render-enrichment-fallback, .js-render-enrichment-fallback-error').forEach((node) => node.remove())
    }
    removeAround(element)
    let current = element.parentElement
    for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
      removeAround(current)
    }
  }

  async function replaceElement(element, source) {
    if (!source || element.getAttribute(ENHANCED_ATTR) === 'rendered') return
    element.setAttribute(ENHANCED_ATTR, 'rendering')
    element.setAttribute(SOURCE_ATTR, source)
    removeGitHubRichDisplaySiblings(element)
    try {
      const rendered = renderMermaidSvg(source)
      const wrapper = document.createElement('div')
      wrapper.innerHTML = replacementHtml(source, rendered)
      element.replaceWith(wrapper.firstElementChild)
    } catch (error) {
      element.setAttribute(ERROR_ATTR, 'true')
      const wrapper = document.createElement('div')
      wrapper.innerHTML = errorHtml(source, error)
      element.replaceWith(wrapper)
    }
  }

  function enqueueRender(element, source) {
    if (element.getAttribute(ENHANCED_ATTR)) return
    element.setAttribute(ENHANCED_ATTR, 'queued')
    renderQueue.push({ element, source })
    drainRenderQueue()
  }

  function drainRenderQueue() {
    while (activeRenderCount < MAX_PARALLEL_RENDERS && renderQueue.length > 0) {
      const item = renderQueue.shift()
      if (!item.element.isConnected) continue
      activeRenderCount += 1
      replaceElement(item.element, item.source).finally(() => {
        activeRenderCount -= 1
        drainRenderQueue()
      })
    }
  }

  function scanCodeBlocks(root) {
    root.querySelectorAll?.('pre > code.language-mermaid, pre > code.highlight-source-mermaid').forEach((codeElement) => {
      const pre = codeElement.closest('pre')
      if (!pre || pre.closest('.docattice-github-mermaid')) return
      const source = sourceFromCodeBlock(codeElement)
      if (source) enqueueRender(pre, source)
    })
  }

  function scanMermaidElements(root) {
    // Strategy 1: section.js-render-needs-enrichment with data-plain (GitHub's lazy Mermaid rendering)
    root.querySelectorAll?.('section.js-render-needs-enrichment, section.render-needs-enrichment').forEach((section) => {
      if (section.closest('.docattice-github-mermaid')) return
      if (section.getAttribute(ENHANCED_ATTR)) return
      const source = sourceFromRenderSection(section)
      if (source && shouldRenderSourceAtElement(section, source)) {
        console.log('[mermaid-rich] section: replacing', detectMermaidDiagramType(source), section)
        enqueueRender(section, source)
      }
    })

    // Strategy 2: GitHub has already rendered Mermaid to SVG inside the section
    root.querySelectorAll?.(
      'section.js-render-needs-enrichment svg[aria-roledescription], section.render-needs-enrichment svg[aria-roledescription]'
    ).forEach((svgElement) => {
      if (svgElement.closest('.docattice-github-mermaid')) return
      const section = svgElement.closest('section.js-render-needs-enrichment, section.render-needs-enrichment')
      if (!section || section.getAttribute(ENHANCED_ATTR)) return
      const source = sourceFromRenderSection(section)
      if (source && shouldRenderSourceAtElement(section, source)) {
        console.log('[mermaid-rich] svg-in-section: replacing', detectMermaidDiagramType(source), section)
        enqueueRender(section, source)
      }
    })

    const selectors = [
      '.mermaid',
      'pre.mermaid',
      'div[data-processed="true"].mermaid',
      '[data-identity="mermaid"]',
      '[data-testid="mermaid-diagram"]',
      'div[id^="user-content-mermaid-"]',
      'svg[id^="mermaid-"]',
      'svg[aria-roledescription]',
      'iframe[src*="mermaid"]',
      'iframe[src*="viewscreen"]',
    ].join(',')
    root.querySelectorAll?.(selectors).forEach((element) => {
      if (element.closest('.docattice-github-mermaid')) return
      const source = sourceFromMermaidElement(element)
      const viewer = githubRenderTargetFor(element)
      if (source && shouldRenderSourceAtElement(viewer, source)) enqueueRender(viewer, source)
    })
    root.querySelectorAll?.('svg').forEach((svgElement) => {
      if (svgElement.closest('.docattice-github-mermaid')) return
      if (!svgElement.closest('.markdown-body, article, [data-testid="file-rendered"]')) return
      const bounds = svgElement.getBoundingClientRect?.()
      if (bounds && (bounds.width < 120 || bounds.height < 80)) return
      const roleType = supportedRoleDiagramType(svgElement)
      if (!roleType) return
      if (!rawMermaidSources.length) {
        loadRawMarkdownSources()
        return
      }
      const viewer = githubRenderTargetFor(svgElement.closest('clipboard-copy, div, figure, pre') || svgElement)
      if (!viewer || viewer.getAttribute?.(ENHANCED_ATTR)) return
      const source = rawMarkdownSourceForElement(viewer, roleType)
      if (shouldRenderSourceAtElement(viewer, source)) enqueueRender(viewer, source)
    })
    root.querySelectorAll?.('iframe').forEach((iframe) => {
      if (iframe.closest('.docattice-github-mermaid')) return
      if (!iframe.closest('.markdown-body, article, [data-testid="file-rendered"]')) return
      const src = iframe.getAttribute('src') || ''
      const title = iframe.getAttribute('title') || ''
      if (!/mermaid|viewscreen/i.test(`${src} ${title}`)) return
      loadRawMarkdownSources()
    })
  }

  function scanNodeNow(node) {
    if (!(node instanceof Element)) return
    if (node.matches?.('pre > code.language-mermaid, pre > code.highlight-source-mermaid')) {
      const source = sourceFromCodeBlock(node)
      const pre = node.closest('pre')
      if (source && pre) enqueueRender(pre, source)
      return
    }
    if (node.matches?.('section.js-render-needs-enrichment, section.render-needs-enrichment')) {
      if (!node.getAttribute(ENHANCED_ATTR)) {
        const source = sourceFromRenderSection(node)
        if (source && shouldRenderSourceAtElement(node, source)) enqueueRender(node, source)
      }
      return
    }
    // When GitHub adds .js-render-enrichment-target (with data-plain) to a section,
    // try the parent section immediately instead of waiting for the scheduled scan.
    if (node.matches?.('.js-render-enrichment-target')) {
      const section = node.closest('section.js-render-needs-enrichment, section.render-needs-enrichment')
      if (section && !section.getAttribute(ENHANCED_ATTR)) {
        const source = sourceFromRenderSection(section)
        if (source && shouldRenderSourceAtElement(section, source)) enqueueRender(section, source)
        return
      }
    }
    scanCodeBlocks(node)
    scanMermaidElements(node)
  }

  function scan() {
    if (!document.body) return
    loadRawMarkdownSources()
    scanCodeBlocks(document)
    scanMermaidElements(document)
  }

  function scheduleScan() {
    if (scanTimer) window.clearTimeout(scanTimer)
    scanTimer = window.setTimeout(() => {
      scanTimer = null
      scan()
    }, 0)
  }

  function installStyles() {
    if (document.getElementById('docattice-github-mermaid-style')) return
    const style = document.createElement('style')
    style.id = 'docattice-github-mermaid-style'
    style.textContent = `
      .docattice-github-mermaid {
        border: 1px solid var(--borderColor-default, #d0d7de);
        border-radius: 6px;
        margin: 16px 0;
        overflow: hidden;
        background: var(--bgColor-default, #ffffff);
      }
      .docattice-github-mermaid__stage {
        overflow: auto;
        padding: 16px;
      }
      .docattice-github-mermaid__stage svg {
        display: block;
        margin: 0 auto;
        max-width: 100%;
        height: auto;
      }
      .docattice-github-mermaid__source {
        border-top: 1px solid var(--borderColor-muted, #d8dee4);
        padding: 8px 12px;
      }
      .docattice-github-mermaid__source > summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--fgColor-muted, #57606a);
      }
      .docattice-github-mermaid__source pre {
        margin: 8px 0 0;
      }
      .docattice-github-mermaid-error {
        border: 1px solid var(--borderColor-danger-muted, #ff818266);
        border-radius: 6px;
        color: var(--fgColor-danger, #cf222e);
        display: grid;
        gap: 4px;
        margin: 12px 0;
        padding: 8px 12px;
      }
      .docattice-github-mermaid ~ .js-render-enrichment-loader,
      .docattice-github-mermaid ~ .js-render-enrichment-fallback,
      .docattice-github-mermaid ~ .js-render-enrichment-fallback-error {
        display: none !important;
      }
    `
    document.head.appendChild(style)
  }

  function startObserver() {
    if (observer || !document.documentElement) return
    observer = new MutationObserver((mutations) => {
      let shouldScan = false
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => scanNodeNow(node))
          if (mutation.addedNodes.length > 0) shouldScan = true
        } else if (mutation.type === 'attributes') {
          // data-plain was added/changed — try the owning section immediately
          const el = mutation.target
          const section = el.matches?.('section.js-render-needs-enrichment, section.render-needs-enrichment')
            ? el
            : el.closest?.('section.js-render-needs-enrichment, section.render-needs-enrichment')
          if (section && !section.getAttribute(ENHANCED_ATTR)) {
            const source = sourceFromRenderSection(section)
            if (source) enqueueRender(section, source)
          }
          shouldScan = true
        }
      }
      if (shouldScan) scheduleScan()
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-plain', 'data-json', 'data-content'],
    })
  }

  function bootstrap() {
    console.log('[mermaid-rich] bootstrap')
    installStyles()
    startObserver()
    loadRawMarkdownSources()
    scheduleScan()
  }

  if (document.readyState === 'loading') {
    console.log('[mermaid-rich] waiting for DOMContentLoaded')
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true })
    startObserver()
  } else {
    bootstrap()
  }
})()
