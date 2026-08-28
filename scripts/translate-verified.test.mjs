#!/usr/bin/env node
/**
 * Tests for translate-verified.mjs.
 *
 * The retry loop is the part of the pipeline that cannot be exercised in CI
 * without an API key and forty minutes, which is precisely why it went two
 * weeks carrying a defect nobody could see: every attempt overwrote the last,
 * so a document that came back nearly complete on attempt 1 and at half its
 * length on attempt 3 ended up on disk as the half-length one.
 *
 * TRANSLATE_CMD exists for this. A throwaway script stands in for the
 * translator and returns a scripted sequence of versions, so the loop's real
 * behaviour -- what it retries, what it keeps, what it leaves behind when it
 * gives up -- is asserted here, on a PR, rather than discovered on main.
 *
 * Usage: node scripts/translate-verified.test.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const loop = path.join(scriptDir, 'translate-verified.mjs')

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

const FRONTMATTER = '---\nid: KB1\n---\n'
const block = (body) => '```bash\n' + body + '\n```\n'
/** An English original with three code blocks, so damage is easy to grade. */
const EN = `${FRONTMATTER}# Title

Some prose that is long enough to measure.

${block('one')}
${block('two')}
${block('three')}`

/**
 * A stand-in translator that returns the versions it is given, one per call.
 * It writes the same file the real one would, so the loop cannot tell them
 * apart -- TRANSLATE_CMD is the seam the loop was built with.
 */
const makeFakeTranslator = (root, versions) => {
  const state = path.join(root, 'calls.txt')
  const fake = path.join(root, 'fake-translate.mjs')
  fs.writeFileSync(
    fake,
    `import fs from 'node:fs'
import path from 'node:path'
const versions = ${JSON.stringify(versions)}
const state = ${JSON.stringify(state)}
const call = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0
fs.writeFileSync(state, String(call + 1))
const target = path.join(${JSON.stringify(root)}, 'zh', 'a.md')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, versions[Math.min(call, versions.length - 1)])
`,
  )
  return { fake, state }
}

const runLoop = (root, fake, attempts = 3) => {
  const run = spawnSync('node', [loop, '--docs', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TRANSLATE_CMD: `node ${fake}`,
      TRANSLATE_ATTEMPTS: String(attempts),
    },
  })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-verified-'))
  fs.mkdirSync(path.join(root, 'en'), { recursive: true })
  fs.writeFileSync(path.join(root, 'en', 'a.md'), EN)
  return root
}

// ---------------------------------------------------------------------------
// The defect this file exists for: attempts get worse, and the best one has to
// survive. Grading is by structure, so dropping code blocks makes each version
// measurably further from the original than the one before it.
// ---------------------------------------------------------------------------
{
  const root = makeRoot()
  const best = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}\n${block('two')}`
  const worse = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}`
  const worst = `${FRONTMATTER}# 标题\n`
  const { fake, state } = makeFakeTranslator(root, [best, worse, worst])

  const { status, out } = runLoop(root, fake)
  ok(status === 1, 'the loop fails when no attempt is complete', out)
  ok(Number(fs.readFileSync(state, 'utf8')) === 3, 'the translator is called once per attempt', out)
  ok(out.includes('restored the best attempt'), 'the loop says it restored an earlier attempt', out)
  ok(
    fs.readFileSync(path.join(root, 'zh', 'a.md'), 'utf8') === best,
    'the least damaged attempt is what stays on disk',
    `on disk: ${JSON.stringify(fs.readFileSync(path.join(root, 'zh', 'a.md'), 'utf8').slice(0, 120))}`,
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// A retry that succeeds must stop the loop and leave its own result alone --
// keeping the "best" version must never mean reverting a good translation.
// ---------------------------------------------------------------------------
{
  const root = makeRoot()
  const damaged = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}`
  const good = `${FRONTMATTER}# 标题

一些足够长的正文，用来度量体积。

${block('one')}
${block('two')}
${block('three')}`
  const { fake, state } = makeFakeTranslator(root, [damaged, good])

  const { status, out } = runLoop(root, fake)
  ok(status === 0, 'the loop succeeds once an attempt verifies', out)
  ok(Number(fs.readFileSync(state, 'utf8')) === 2, 'it stops translating as soon as it passes', out)
  ok(!out.includes('restored the best attempt'), 'nothing is restored over a passing translation', out)
  ok(
    fs.readFileSync(path.join(root, 'zh', 'a.md'), 'utf8') === good,
    'the passing translation is the one left on disk',
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Only the documents that failed are handed back to the translator. Retrying
// the whole library would cost hours; in run 33160218909 one document alone
// took forty minutes per attempt.
// ---------------------------------------------------------------------------
{
  const root = makeRoot()
  fs.writeFileSync(path.join(root, 'en', 'healthy.md'), EN)
  fs.mkdirSync(path.join(root, 'zh'), { recursive: true })
  fs.writeFileSync(path.join(root, 'zh', 'healthy.md'), EN)
  const damaged = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}`
  const { fake } = makeFakeTranslator(root, [damaged])

  const { out } = runLoop(root, fake, 2)
  const retryLine = out.split('\n').find((line) => line.startsWith('$ node ') && line.includes('--force'))
  ok(Boolean(retryLine), 'a retry is issued with --force', out)
  ok(
    retryLine.includes('-g a.md') && !retryLine.includes('healthy.md'),
    'the retry names only the failing document',
    retryLine,
  )
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`== result: ${pass} pass / ${fail} fail ==`)
process.exit(fail > 0 ? 1 : 0)
