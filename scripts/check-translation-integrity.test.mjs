#!/usr/bin/env node
/**
 * Tests for check-translation-integrity.mjs.
 *
 * Every case builds a throwaway docs tree, runs the real script against it with
 * --docs, and asserts on what it printed, what it exited with, and what it left
 * on disk. Nothing is mocked: the thing under test is the same file CI runs.
 *
 * The cases are the failures actually seen in production -- a link target
 * rewritten to the literal `URL` from the translation prompt, an invented
 * image, a section silently dropped, a page never translated at all -- plus the
 * things that legitimately differ between languages and must be left alone.
 *
 * Usage: node scripts/check-translation-integrity.test.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const checker = path.join(scriptDir, 'check-translation-integrity.mjs')

let pass = 0
let fail = 0

const ok = (condition, label, detail = '') => {
  if (condition) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    console.log(`FAIL ${label}${detail ? `\n  ${detail}` : ''}`)
  }
}

/** A docs tree with one en/zh pair, plus whatever extra files a case needs. */
const makeTree = ({ en, zh, extra = {} }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-check-'))
  for (const [lang, files] of Object.entries({ en, zh })) {
    for (const [name, content] of Object.entries(files || {})) {
      const file = path.join(root, lang, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  for (const [name, content] of Object.entries(extra)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

const check = (root, ...args) => {
  const run = spawnSync('node', [checker, '--docs', root, ...args], { encoding: 'utf8' })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

const read = (root, lang, name) => fs.readFileSync(path.join(root, lang, name), 'utf8')

const FRONTMATTER = '---\nid: KB1\n---\n'

// ---------------------------------------------------------------------------
// A clean pair, and the kinds of difference that are not drift.
// ---------------------------------------------------------------------------
{
  const en = `${FRONTMATTER}# Title {#title}

See [the guide](./guide.md) and [the site](https://example.com/en) and [above](#title).

\`\`\`bash
curl "[not](a-link)"
\`\`\`

Inline \`[not](a-link)\` too.
`
  const zh = `${FRONTMATTER}# 标题 {#title}

参见 [指南](./guide.md) 和 [站点](https://example.com/en) 以及 [上文](#标题)。

\`\`\`bash
curl "[不是](链接)"
\`\`\`

行内 \`[不是](链接)\` 同样。
`
  const root = makeTree({ en: { 'a.md': en }, zh: { 'a.md': zh } })
  const before = read(root, 'zh', 'a.md')
  const { status, out } = check(root, '--fix')
  ok(status === 0, 'clean pair exits 0', out)
  ok(out.includes('== result: 1 pass / 0 fail =='), 'clean pair counts one pass', out)
  ok(read(root, 'zh', 'a.md') === before, 'clean pair is not rewritten')
  ok(!out.includes('#标题'), 'translated in-page anchor is not compared')
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The production failure: the model recites its own prompt and the target
// becomes the literal string URL.
// ---------------------------------------------------------------------------
{
  const en = `${FRONTMATTER}# T

[one](./one.md) then [two](./two.md).
`
  const zhBroken = `${FRONTMATTER}# T

[一](URL) 然后 [二](./two.md)。
`
  const zhGood = zhBroken.replace('(URL)', '(./one.md)')
  const root = makeTree({ en: { 'a.md': en }, zh: { 'a.md': zhBroken } })

  const detect = check(root)
  ok(detect.status === 1, 'drifted target fails without --fix', detect.out)
  ok(
    detect.out.includes('"URL" -> "./one.md"'),
    'drifted target names the old and the new value',
    detect.out,
  )
  ok(read(root, 'zh', 'a.md') === zhBroken, 'no --fix leaves the file untouched')

  const repair = check(root, '--fix')
  ok(repair.status === 0, 'drifted target is repaired', repair.out)
  ok(read(root, 'zh', 'a.md') === zhGood, 'repair restores the English target byte for byte')

  const again = check(root, '--fix')
  ok(again.status === 0 && read(root, 'zh', 'a.md') === zhGood, 'repair is idempotent', again.out)
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Fences nested in JSX, and frontmatter that looks like markup.
// ---------------------------------------------------------------------------
{
  const body = (linkText) => `---
pattern: ^feat[/-](?<BranchName>.+)
---
# T

<Tabs>
<Tab label="a">

  \`\`\`yaml
  ref: "[x](SHOULD-NOT-BE-SEEN)"
  \`\`\`

</Tab>
</Tabs>

[${linkText}](./real.md)
`
  const root = makeTree({ en: { 'a.md': body('real') }, zh: { 'a.md': body('真实') } })
  const { status, out } = check(root, '--fix')
  ok(status === 0, 'JSX-nested fence and frontmatter do not break the scan', out)
  ok(!out.includes('SHOULD-NOT-BE-SEEN'), 'link inside an indented fence is masked out', out)
  ok(out.includes('(1 links, 0 images)'), 'only the prose link is counted', out)
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Gaps that cannot be aligned: refuse, do not guess.
// ---------------------------------------------------------------------------
{
  const en = `${FRONTMATTER}# T

[one](./one.md), [two](./two.md), [three](./three.md).
`
  const zhFewer = `${FRONTMATTER}# T

[一](./one.md), 二, [三](./three.md)。
`
  const root = makeTree({ en: { 'a.md': en }, zh: { 'a.md': zhFewer } })
  const { status, out } = check(root, '--fix')
  ok(status === 1, 'a dropped link fails', out)
  ok(out.includes('repair by hand'), 'a dropped link is handed to a human', out)
  ok(read(root, 'zh', 'a.md') === zhFewer, 'a dropped link leaves the file untouched')
  fs.rmSync(root, { recursive: true, force: true })
}

{
  const en = `${FRONTMATTER}# T

[one](./one.md), [two](./two.md), [three](./three.md).
`
  // Same set, two of them swapped: positional repair here would silently point
  // each link at the other one's target, so the file must be refused instead.
  const zhSwapped = `${FRONTMATTER}# T

[一](./one.md), [二](./three.md), [三](./two.md)。
`
  const root = makeTree({ en: { 'a.md': en }, zh: { 'a.md': zhSwapped } })
  const { status } = check(root, '--fix')
  ok(status === 1, 'reordered links fail rather than being rewritten')
  ok(read(root, 'zh', 'a.md') === zhSwapped, 'reordered links leave the file untouched')
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Images are judged on whether they resolve, not against English.
// ---------------------------------------------------------------------------
{
  const en = `${FRONTMATTER}# T

![shot](./shot.png)
`
  const zh = `${FRONTMATTER}# T

![截图](./shot.png)

![说明](src)
`
  const root = makeTree({
    en: { 'a.md': en },
    zh: { 'a.md': zh, 'shot.png': 'x' },
  })
  fs.writeFileSync(path.join(root, 'en', 'shot.png'), 'x')
  const { status, out } = check(root, '--fix')
  ok(status === 0, 'an unresolvable image is repaired', out)
  const after = read(root, 'zh', 'a.md')
  ok(after.includes('![截图](./shot.png)'), 'a resolvable image is left alone')
  ok(after.includes('\n说明\n') || after.includes('\n说明'), 'an invented image is demoted to its alt text', after)
  ok(!after.includes('](src)'), 'the invented image markup is gone', after)
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Content loss: reported, never rewritten.
// ---------------------------------------------------------------------------
{
  const en = `${FRONTMATTER}# T

\`\`\`bash
one
\`\`\`

\`\`\`bash
two
\`\`\`

[link](./a.md)
`
  const zh = `${FRONTMATTER}# T

\`\`\`bash
one
\`\`\`

[链接](URL)
`
  const root = makeTree({ en: { 'a.md': en }, zh: { 'a.md': zh } })
  const { status, out } = check(root, '--fix')
  ok(status === 1, 'a lost code block fails', out)
  ok(out.includes('fenced code blocks 1 vs 2 -- 1 lost'), 'the lost code block is named', out)
  ok(read(root, 'zh', 'a.md') === zh, 'a document that lost content is never rewritten')
  ok(
    !out.includes('"URL" ->'),
    'link repair does not run on a document that lost content',
    out,
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// A page that was never translated at all -- invisible to a target-driven scan.
// ---------------------------------------------------------------------------
{
  const root = makeTree({
    en: {
      'a.md': `${FRONTMATTER}# A\n`,
      'never.md': `${FRONTMATTER}# Never\n`,
      'optout.md': '---\nid: KB2\ni18n:\n  disableAutoTranslation: true\n---\n# Opt out\n',
    },
    zh: { 'a.md': `${FRONTMATTER}# A\n` },
  })
  const { status, out } = check(root, '--fix')
  ok(status === 1, 'a missing translation fails', out)
  ok(out.includes('never.md was never produced'), 'the missing translation is named', out)
  ok(out.includes('optout.md (i18n.disableAutoTranslation)'), 'an opted-out page is skipped', out)
  ok(!out.includes('optout.md was never produced'), 'an opted-out page is not a failure', out)
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// --failures must name every failing document: translate-verified.mjs retries
// exactly what is on that list, so anything missing from it is never retried.
// ---------------------------------------------------------------------------
{
  const root = makeTree({
    en: {
      'lost.md': `${FRONTMATTER}# T\n\n\`\`\`bash\na\n\`\`\`\n\n\`\`\`bash\nb\n\`\`\`\n`,
      'gap.md': `${FRONTMATTER}# T\n\n[one](./one.md), [two](./two.md).\n`,
      'never.md': `${FRONTMATTER}# Never\n`,
      'fine.md': `${FRONTMATTER}# T\n`,
    },
    zh: {
      'lost.md': `${FRONTMATTER}# T\n\n\`\`\`bash\na\n\`\`\`\n`,
      'gap.md': `${FRONTMATTER}# T\n\n[一](./one.md), 二。\n`,
      'fine.md': `${FRONTMATTER}# T\n`,
    },
  })
  const listFile = path.join(root, 'failures.txt')
  const { status } = check(root, '--fix', '--failures', listFile)
  const listed = fs
    .readFileSync(listFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => path.basename(line))
    .sort()
  ok(status === 1, 'a mixed run of failures exits 1')
  ok(
    JSON.stringify(listed) === JSON.stringify(['gap.md', 'lost.md', 'never.md']),
    'every failing document reaches --failures, whatever the reason',
    `got ${JSON.stringify(listed)}`,
  )
  ok(!listed.includes('fine.md'), 'a healthy document is not listed for retranslation')
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`== result: ${pass} pass / ${fail} fail ==`)
process.exit(fail > 0 ? 1 : 0)
