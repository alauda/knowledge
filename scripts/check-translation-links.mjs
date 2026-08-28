#!/usr/bin/env node
/**
 * Verify (and optionally repair) link targets in machine-translated docs.
 *
 * `doom translate` sends each document to an LLM with the instruction to keep
 * every link target byte-identical. On very large documents the content is cut
 * into 60KB chunks and the model occasionally rewrites a target -- e.g. it once
 * emitted the literal `URL` copied straight out of the prompt's own example,
 * which then fails the rspress dead-link check at build time.
 *
 * The English document is the ground truth: for every translated file we walk
 * the inline links of both sides in document order and compare targets. With
 * --fix, and only when both sides expose the same number of links (so the
 * positional alignment is sound), a drifted target is restored from English.
 *
 * Usage:
 *   node scripts/check-translation-links.mjs [--fix] [--all] [--source en] [--target zh]
 *
 *   (default scope)  files under docs/<target> that git reports as modified or
 *                    untracked -- i.e. the ones translate just (re)wrote
 *   --all            every file under docs/<target>
 *   --docs <dir>     check a docs tree outside this repo (implies a full scan)
 *
 * Only internal route links are compared -- the exact set rspress resolves
 * against the route table and fails the build over. In-page anchors and
 * external URLs are out of scope: a translated heading legitimately gets a
 * translated slug, and neither kind is ever resolved by the dead-link check.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}

const FIX = hasFlag('--fix')
const ALL = hasFlag('--all')
const SOURCE_LANG = flagValue('--source', 'en')
const TARGET_LANG = flagValue('--target', 'zh')
const DOCS_OVERRIDE = flagValue('--docs', '')

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
// --docs points the checker at a docs tree outside the repo (used by the tests);
// it also switches off git-based scoping, since that tree is not tracked here.
const docsDir = DOCS_OVERRIDE ? path.resolve(DOCS_OVERRIDE) : path.join(repoRoot, 'docs')
const scanAll = ALL || Boolean(DOCS_OVERRIDE)
const sourceDir = path.join(docsDir, SOURCE_LANG)
const targetDir = path.join(docsDir, TARGET_LANG)

const DOC_EXTENSIONS = new Set(['.md', '.mdx'])

/** Recursively collect every markdown file under `dir`. */
const walk = (dir) => {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (DOC_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

/** Files translate touched in this working tree (modified, staged or untracked). */
const changedTargetFiles = () => {
  const stdout = execFileSync(
    'git',
    ['status', '--porcelain', '--', path.relative(repoRoot, targetDir)],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  const files = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    // Porcelain v1: two status chars, a space, then the path; renames use "old -> new".
    let file = line.slice(3).trim()
    const arrow = file.indexOf(' -> ')
    if (arrow !== -1) file = file.slice(arrow + 4)
    if (file.startsWith('"') && file.endsWith('"')) file = JSON.parse(file)
    const abs = path.resolve(repoRoot, file)
    if (DOC_EXTENSIONS.has(path.extname(abs)) && fs.existsSync(abs)) files.push(abs)
  }
  return files
}

/**
 * Blank out everything a markdown link must not be harvested from, keeping the
 * offsets of the remaining text intact so match indices stay usable for --fix:
 * frontmatter, fenced code blocks and inline code spans.
 */
const maskNonProse = (content) => {
  const lines = content.split('\n')
  const masked = lines.slice()
  let inFrontmatter = false
  let fence = null // { char: '`' | '~', length: number }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true
      masked[i] = ' '.repeat(line.length)
      continue
    }
    if (inFrontmatter) {
      masked[i] = ' '.repeat(line.length)
      if (/^---\s*$/.test(line)) inFrontmatter = false
      continue
    }

    // Any indentation counts as a fence, not just CommonMark's 0-3 spaces:
    // these docs nest fences inside JSX (<Tabs><Tab>) where remark still reads
    // them as fences, and en/zh must be masked identically or the link
    // sequences stop lining up.
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      masked[i] = ' '.repeat(line.length)
      // A closing fence is the same character, at least as long, and alone on its line.
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        /^\s*[`~]+\s*$/.test(line)
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      masked[i] = ' '.repeat(line.length)
      continue
    }

    masked[i] = maskInlineCode(line)
  }

  return masked.join('\n')
}

/** Replace `code span` runs with spaces, preserving length. */
const maskInlineCode = (line) => {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i++]
      continue
    }
    let run = 0
    while (line[i + run] === '`') run++
    const delimiter = '`'.repeat(run)
    const close = line.indexOf(delimiter, i + run)
    if (close === -1) {
      // Unterminated span: not a code span at all, keep the backticks as-is.
      out += delimiter
      i += run
      continue
    }
    const end = close + run
    out += ' '.repeat(end - i)
    i = end
  }
  return out
}

/** Mirrors isExternalUrl / normalizeLink's early returns in @rspress/shared. */
const isInternalRouteLink = (target) =>
  target !== '' &&
  !target.startsWith('#') &&
  !target.startsWith('http://') &&
  !target.startsWith('https://') &&
  !target.startsWith('mailto:') &&
  !target.startsWith('tel:') &&
  !/^\s*data:/i.test(target)

// [text](target "optional title") -- the leading `!` marks an image, which we skip:
// normalizeImgSrc legitimately rewrites image paths between languages.
const LINK_RE = /(!?)\[((?:[^[\]\\]|\\.|\[[^[\]]*\])*)\]\(\s*([^()\s]*)((?:\s+"[^"]*")?)\s*\)/g

/** Internal route links of a document, in order, with offsets into the raw text. */
const extractLinks = (content) => {
  const masked = maskNonProse(content)
  const links = []
  for (const match of masked.matchAll(LINK_RE)) {
    if (match[1] === '!') continue
    const target = match[3]
    // Only internal route links are compared -- exactly the set rspress
    // resolves against the route table and fails the build over. In-page
    // anchors legitimately differ (a translated heading gets a translated
    // slug) and external URLs are never resolved, so neither is our business;
    // both mirror normalizeLink's early returns in @rspress/core.
    if (!isInternalRouteLink(target)) continue
    // Offset of the target inside the raw document -- `masked` preserves every
    // offset, so the index computed here also addresses the original content.
    // `![` or `[` + text + `](`, then any padding before the target itself.
    const afterOpen = match[1].length + 1 + match[2].length + 2
    const padding = /^\s*/.exec(match[0].slice(afterOpen))[0].length
    const targetStart = match.index + afterOpen + padding
    links.push({
      target,
      start: targetStart,
      end: targetStart + target.length,
      line: content.slice(0, match.index).split('\n').length,
    })
  }
  return links
}

const relative = (file) => path.relative(repoRoot, file)

const targetFiles = (scanAll ? walk(targetDir) : changedTargetFiles()).filter((file) =>
  file.startsWith(targetDir + path.sep),
)

if (targetFiles.length === 0) {
  console.log(`no ${TARGET_LANG} documents to check (${scanAll ? 'full scan' : 'changed files only'})`)
  console.log('== result: 0 pass / 0 fail ==')
  process.exit(0)
}

let pass = 0
let fail = 0
let repaired = 0

for (const file of targetFiles.sort()) {
  const sourceFile = path.join(sourceDir, path.relative(targetDir, file))
  if (!fs.existsSync(sourceFile)) {
    // translate removes orphan target files itself; nothing to compare against.
    console.log(`SKIP ${relative(file)} (no ${SOURCE_LANG} counterpart)`)
    continue
  }

  const sourceLinks = extractLinks(fs.readFileSync(sourceFile, 'utf8'))
  let content = fs.readFileSync(file, 'utf8')
  let targetLinks = extractLinks(content)

  if (sourceLinks.length !== targetLinks.length) {
    fail++
    console.log(
      `FAIL ${relative(file)} internal link count ${targetLinks.length} != ${sourceLinks.length} in ${relative(sourceFile)}` +
        ' -- cannot align positionally, repair by hand',
    )
    continue
  }

  const drifted = []
  for (let i = 0; i < sourceLinks.length; i++) {
    if (sourceLinks[i].target !== targetLinks[i].target) drifted.push(i)
  }

  if (drifted.length === 0) {
    pass++
    console.log(`PASS ${relative(file)} (${sourceLinks.length} links)`)
    continue
  }

  if (!FIX) {
    fail++
    console.log(`FAIL ${relative(file)} ${drifted.length} drifted internal link target(s):`)
    for (const i of drifted) {
      console.log(
        `  ${relative(file)}:${targetLinks[i].line} got "${targetLinks[i].target}"` +
          ` expected "${sourceLinks[i].target}" (${relative(sourceFile)}:${sourceLinks[i].line})`,
      )
    }
    continue
  }

  // Rewrite back-to-front so earlier offsets stay valid.
  for (const i of [...drifted].reverse()) {
    const { start, end } = targetLinks[i]
    content = content.slice(0, start) + sourceLinks[i].target + content.slice(end)
  }
  fs.writeFileSync(file, content)
  repaired += drifted.length

  const after = extractLinks(content)
  const stillDrifted = sourceLinks.some((link, i) => link.target !== after[i]?.target)
  if (stillDrifted) {
    fail++
    console.log(`FAIL ${relative(file)} repair did not converge, inspect by hand`)
    continue
  }

  pass++
  console.log(`PASS ${relative(file)} repaired ${drifted.length} link target(s):`)
  for (const i of drifted) {
    console.log(`  ${relative(file)}:${targetLinks[i].line} "${targetLinks[i].target}" -> "${sourceLinks[i].target}"`)
  }
}

if (FIX && repaired > 0) {
  console.log(`restored ${repaired} link target(s) from ${SOURCE_LANG}`)
}
console.log(`== result: ${pass} pass / ${fail} fail ==`)
process.exit(fail > 0 ? 1 : 0)
