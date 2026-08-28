#!/usr/bin/env node
/**
 * Tests for translate-verified.mjs.
 *
 * The retry loop cannot be exercised in CI without an API key and forty
 * minutes, so until now nothing checked it at all: whether it retries the
 * documents that failed rather than the whole library, whether it stops as soon
 * as one attempt verifies, whether it fails when none of them do.
 *
 * TRANSLATE_CMD exists for this. A throwaway script stands in for the
 * translator and returns a scripted sequence of versions, so the loop's real
 * behaviour is asserted here, on a pull request, rather than on main.
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

/** The same tree, but its own git repository, so a committed version exists. */
const makeGitRoot = () => {
  const root = makeRoot()
  const git = (...args) => spawnSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  return root
}

/** Commit `content` as the translation, the way a previous green run would have. */
const commitTranslation = (root, content) => {
  fs.mkdirSync(path.join(root, 'zh'), { recursive: true })
  fs.writeFileSync(path.join(root, 'zh', 'a.md'), content)
  const git = (...args) => spawnSync('git', args, { cwd: root, stdio: 'pipe' })
  git('add', '-A')
  git('commit', '-qm', 'translation')
}

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-verified-'))
  fs.mkdirSync(path.join(root, 'en'), { recursive: true })
  fs.writeFileSync(path.join(root, 'en', 'a.md'), EN)
  return root
}

// ---------------------------------------------------------------------------
// Nothing is committed unless a translation verifies. The loop spends its
// attempts and fails, which is what keeps a short page off the site.
// ---------------------------------------------------------------------------
{
  const root = makeRoot()
  const damaged = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}`
  const { fake, state } = makeFakeTranslator(root, [damaged])

  const { status, out } = runLoop(root, fake)
  ok(status === 1, 'the loop fails when no attempt is complete', out)
  ok(Number(fs.readFileSync(state, 'utf8')) === 3, 'the translator is called once per attempt', out)
  ok(out.includes('still incomplete after 3 attempts'), 'it names the documents it gave up on', out)
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

// ---------------------------------------------------------------------------
// A document that will not converge keeps the translation already committed,
// and the run carries on. This is the 82KB-source case: doom cuts it into
// chunks, a chunk comes back short, and every attempt cuts it the same way.
// Failing the whole job over it threw away every other document's good
// translation too, because the job stops before the commit.
// ---------------------------------------------------------------------------
{
  const root = makeGitRoot()
  const good = `${FRONTMATTER}# 标题\n\n一些足够长的正文，用来度量体积。\n\n${block('one')}\n${block('two')}\n${block('three')}`
  commitTranslation(root, good)
  const damaged = `${FRONTMATTER}# 标题\n\n短。\n\n${block('one')}`
  const { fake } = makeFakeTranslator(root, [damaged])

  const { status, out } = runLoop(root, fake, 2)
  ok(status === 0, 'the run succeeds when the committed translation is complete', out)
  ok(out.includes('KEPT'), 'the kept document is named', out)
  ok(
    fs.readFileSync(path.join(root, 'zh', 'a.md'), 'utf8') === good,
    'the committed translation is what is left on disk',
    out,
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// With nothing good to fall back on, the run still fails. Keeping a damaged
// page because it was damaged before would publish the very thing this script
// exists to stop.
// ---------------------------------------------------------------------------
{
  const root = makeGitRoot()
  const alsoDamaged = `${FRONTMATTER}# 标题\n\n短。\n\n${block('one')}`
  commitTranslation(root, alsoDamaged)
  const { fake } = makeFakeTranslator(root, [alsoDamaged])

  const { status, out } = runLoop(root, fake, 2)
  ok(status === 1, 'the run fails when the committed translation is damaged too', out)
  ok(out.includes('no complete translation, committed or new'), 'the reason says both were bad', out)
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// A retry count that is not a whole number would never end: `attempt <=
// Infinity` is always true, and the job would retranslate until the runner
// times out.
// ---------------------------------------------------------------------------
{
  const root = makeRoot()
  const { fake } = makeFakeTranslator(root, [EN])
  const run = spawnSync('node', [loop, '--docs', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TRANSLATE_CMD: `node ${fake}`, TRANSLATE_ATTEMPTS: 'Infinity' },
  })
  const out = `${run.stdout}${run.stderr}`
  ok(run.status === 1, 'a non-integer attempt count is refused', out)
  ok(out.includes('whole number of at least 1'), 'the refusal says what is wrong', out)
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`== result: ${pass} pass / ${fail} fail ==`)
process.exit(fail > 0 ? 1 : 0)
