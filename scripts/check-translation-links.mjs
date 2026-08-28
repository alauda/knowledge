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

// [text](target "optional title"), with a leading `!` marking an image.
const LINK_RE = /(!?)\[((?:[^[\]\\]|\\.|\[[^[\]]*\])*)\]\(\s*([^()\s]*)((?:\s+"[^"]*")?)\s*\)/g

/**
 * Internal links and images of a document, in order, with offsets into the raw
 * text. They are kept apart because only one of them has a stable target:
 * normalizeImgSrc rewrites image paths between languages on purpose, so an
 * image src that differs is expected, while a link target that differs is not.
 */
const extractRefs = (content) => {
  const masked = maskNonProse(content)
  const links = []
  const images = []
  for (const match of masked.matchAll(LINK_RE)) {
    const target = match[3]
    // Only internal route links are compared -- exactly the set rspress
    // resolves against the route table and fails the build over. In-page
    // anchors legitimately differ (a translated heading gets a translated
    // slug) and external URLs are never resolved, so neither is our business;
    // both mirror normalizeLink's early returns in @rspress/core.
    if (!isInternalRouteLink(target)) continue
    // Offsets into the raw document -- `masked` preserves every offset, so the
    // indices computed here also address the original content.
    // `![` or `[` + text + `](`, then any padding before the target itself.
    const afterOpen = match[1].length + 1 + match[2].length + 2
    const padding = /^\s*/.exec(match[0].slice(afterOpen))[0].length
    const targetStart = match.index + afterOpen + padding
    const ref = {
      target,
      text: match[2],
      start: targetStart,
      end: targetStart + target.length,
      // The whole `[text](target)` span, needed to demote a hallucinated ref.
      linkStart: match.index,
      linkEnd: match.index + match[0].length,
      line: content.slice(0, match.index).split('\n').length,
    }
    if (match[1] === '!') images.push(ref)
    else links.push(ref)
  }
  return { links, images }
}

/**
 * Longest common subsequence of two target lists, as index pairs. Equal targets
 * are the anchors we trust; everything between two anchors is a gap the caller
 * has to make a decision about.
 */
const lcsPairs = (a, b) => {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i].target === b[j].target
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i].target === b[j].target) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * Does an image src point at a file that actually exists? This is the same
 * question rspack asks, and the reason a bogus src fails the build with
 * "Module not found". Absolute srcs are served out of docs/public.
 */
const imageResolves = (src, fileDir) => {
  const clean = src.split('#')[0].split('?')[0]
  if (!clean) return false
  const candidate = clean.startsWith('/')
    ? path.join(docsDir, 'public', clean.slice(1))
    : path.resolve(fileDir, clean)
  return fs.existsSync(candidate)
}

/**
 * Images cannot be aligned against English the way links are: normalizeImgSrc
 * rewrites their paths on purpose, so the two sides legitimately disagree and
 * there is no stable value to anchor on. Judge them on their own terms instead
 * -- a src that resolves to a file is fine however much it differs from the
 * English one, and a src that resolves to nothing is the model inventing markup
 * (it copied its own prompt's `![alt](src)` example into the prose once), which
 * is exactly what breaks the build. Demote those to their alt text.
 */
const planImageEdits = (targetImages, fileDir) => {
  const edits = []
  const unresolved = []

  for (const image of targetImages) {
    if (imageResolves(image.target, fileDir)) continue
    edits.push({
      kind: 'demote',
      label: 'image',
      start: image.linkStart,
      end: image.linkEnd,
      replacement: image.text,
      line: image.line,
      from: image.target,
      to: null,
    })
  }

  // Same reasoning as the link cap: a flood means the check is wrong, not the
  // translation, and stripping markup wholesale would be worse than failing.
  const cap = Math.max(3, Math.floor(targetImages.length * 0.2))
  if (edits.length > cap) {
    unresolved.push(`${edits.length} unresolvable image(s) exceeds the cap of ${cap} -- refusing to strip that many`)
  }
  return { edits, unresolved }
}

/**
 * Decide what to do with every translated reference, English being the truth.
 *
 * Anchoring on the references both sides agree on leaves gaps, and each gap
 * shape says something different about what the model did:
 *   same count      -> it rewrote targets in place; restore them positionally,
 *                      but only where restoring is meaningful (see `restore`).
 *   nothing in en    -> it invented references that have no original; strip the
 *                       markup and keep the text (a target we cannot source
 *                       from English is a target we must not guess at).
 *   fewer in zh      -> it dropped references; there is no sound place to put
 *                       them back, so the file is left for a human.
 * A mixed gap (some English refs, but more on the translated side) is ambiguous
 * in the same way, and is refused too.
 */
const planEdits = (sourceLinks, targetLinks, { label }) => {
  const edits = []
  const unresolved = []
  const anchors = [...lcsPairs(sourceLinks, targetLinks), [sourceLinks.length, targetLinks.length]]
  let si = 0
  let ti = 0

  for (const [sEnd, tEnd] of anchors) {
    const srcGap = sourceLinks.slice(si, sEnd)
    const tgtGap = targetLinks.slice(ti, tEnd)

    if (srcGap.length === tgtGap.length) {
      for (const [k, link] of tgtGap.entries()) {
        edits.push({
          kind: 'restore',
          label,
          start: link.start,
          end: link.end,
          replacement: srcGap[k].target,
          line: link.line,
          from: link.target,
          to: srcGap[k].target,
        })
      }
    } else if (srcGap.length === 0) {
      for (const link of tgtGap) {
        edits.push({
          kind: 'demote',
          label,
          start: link.linkStart,
          end: link.linkEnd,
          replacement: link.text,
          line: link.line,
          from: link.target,
          to: null,
        })
      }
    } else {
      unresolved.push(
        `${tgtGap.length} translated ${label}(s) against ${srcGap.length} English one(s)` +
          ` around line ${(tgtGap[0] ?? srcGap[0]).line}` +
          ` [${tgtGap.map((l) => l.target).join(', ') || '-'}] vs [${srcGap.map((l) => l.target).join(', ')}]`,
      )
    }

    si = sEnd + 1
    ti = tEnd + 1
  }

  // Demoting is the one edit that removes markup rather than correcting it.
  // A handful is a model slip; a flood means the comparison itself is off.
  const demotions = edits.filter((edit) => edit.kind === 'demote')
  const demotionCap = Math.max(3, Math.floor(sourceLinks.length * 0.2))
  if (demotions.length > demotionCap) {
    unresolved.push(
      `${demotions.length} invented ${label}(s) exceeds the cap of ${demotionCap} -- refusing to strip that many`,
    )
  }

  return { edits, unresolved }
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

  const source = extractRefs(fs.readFileSync(sourceFile, 'utf8'))
  let content = fs.readFileSync(file, 'utf8')
  let target = extractRefs(content)

  const describe = (edit) => {
    const where = `${relative(file)}:${edit.line}`
    if (edit.kind === 'restore') return `${where} "${edit.from}" -> "${edit.to}"`
    return edit.label === 'image'
      ? `${where} "${edit.from}" resolves to no file -- image syntax stripped, alt text kept`
      : `${where} "${edit.from}" has no English original -- link syntax stripped, text kept`
  }

  const linkPlan = planEdits(source.links, target.links, { label: 'link' })
  const imagePlan = planImageEdits(target.images, path.dirname(file))
  const edits = [...linkPlan.edits, ...imagePlan.edits]
  const unresolved = [...linkPlan.unresolved, ...imagePlan.unresolved]

  // An unresolved gap makes the whole alignment suspect, so nothing is written:
  // a partially repaired file is harder to reason about than an untouched one.
  if (unresolved.length > 0) {
    fail++
    console.log(
      `FAIL ${relative(file)} ${target.links.length} link(s) / ${target.images.length} image(s) against` +
        ` ${source.links.length} / ${source.images.length} in ${relative(sourceFile)} -- repair by hand:`,
    )
    for (const problem of unresolved) console.log(`  ${problem}`)
    continue
  }

  if (edits.length === 0) {
    pass++
    console.log(`PASS ${relative(file)} (${source.links.length} links, ${source.images.length} images)`)
    continue
  }

  if (!FIX) {
    fail++
    console.log(`FAIL ${relative(file)} ${edits.length} drifted reference(s):`)
    for (const edit of edits) console.log(`  ${describe(edit)}`)
    continue
  }

  // Apply back-to-front so earlier offsets stay valid.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end)
  }
  fs.writeFileSync(file, content)
  repaired += edits.length

  const after = extractRefs(content)
  const converged =
    after.links.length === source.links.length &&
    source.links.every((link, i) => link.target === after.links[i].target) &&
    after.images.every((image) => imageResolves(image.target, path.dirname(file)))
  if (!converged) {
    fail++
    console.log(`FAIL ${relative(file)} repair did not converge, inspect by hand`)
    continue
  }

  pass++
  console.log(`PASS ${relative(file)} repaired ${edits.length} reference(s):`)
  for (const edit of edits) console.log(`  ${describe(edit)}`)
}

if (FIX && repaired > 0) {
  console.log(`repaired ${repaired} reference(s) against ${SOURCE_LANG}`)
}
console.log(`== result: ${pass} pass / ${fail} fail ==`)
process.exit(fail > 0 ? 1 : 0)
