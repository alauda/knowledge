#!/usr/bin/env node
/**
 * Translate the documentation, then prove the result is complete -- and
 * retranslate the documents that are not.
 *
 * A single translation pass is not trustworthy on its own. The model that
 * produces these pages has swallowed an entire section plus 1177 lines of YAML
 * out of one article, invented a table into another, and left a third short of
 * a heading even on a second attempt. None of that failed the build, because
 * the build only asks whether links resolve.
 *
 * So the pass is no longer the deliverable -- a verified pass is. Translate,
 * check, and hand the failing documents back to the translator with --force so
 * only they are redone. The run fails only if a document is still incomplete
 * after every attempt, and in that case nothing is committed: the workflow
 * stops before the build, so a short page never reaches the site.
 *
 * Environment:
 *   TRANSLATE_ATTEMPTS  how many times to try a document (default 3)
 *   TRANSLATE_CMD       the translate command (default "yarn translate"), so
 *                       the retry loop can be exercised without an API key
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A finite count, always: `attempt <= ATTEMPTS` never ends for Infinity, and a
// typo in the environment would leave the job retranslating until the runner
// times out -- burning the API budget on a document that cannot converge.
const ATTEMPTS = (() => {
  const raw = process.env.TRANSLATE_ATTEMPTS
  if (raw === undefined || raw === '') return 3
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`TRANSLATE_ATTEMPTS must be a whole number of at least 1, got ${JSON.stringify(raw)}`)
    process.exit(1)
  }
  return n
})()
const SOURCE = process.env.TRANSLATE_SOURCE || 'en'
const TARGET = process.env.TRANSLATE_TARGET || 'zh'
const TRANSLATE = (process.env.TRANSLATE_CMD || 'yarn translate').split(' ')
// The check reports paths under the docs root; --docs moves that root, and the
// retry globs are relative to it, so both have to agree on where it is.
const docsArg = process.argv.indexOf('--docs')
const DOCS = docsArg === -1 ? 'docs' : process.argv[docsArg + 1]

const failuresFile = path.join(os.tmpdir(), `translation-failures-${process.pid}.txt`)

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  return spawnSync(cmd, args, { stdio: 'inherit' }).status
}

const translate = (globs) =>
  run(TRANSLATE[0], [
    ...TRANSLATE.slice(1),
    '-s', SOURCE,
    '-t', TARGET,
    '-g', ...globs,
    // Retries target documents that already have a translation on disk; without
    // --force doom skips them, because their sourceSHA still matches.
    ...(globs[0] === '*' ? [] : ['--force']),
  ])

/**
 * Run the integrity check. --fix repairs what is repairable (link and image
 * markup the model invented); documents that lost or gained content come back
 * as failures, because no rewrite here can put back text that is gone.
 */
const verify = () => {
  fs.rmSync(failuresFile, { force: true })
  const status = run('node', [
    'scripts/check-translation-integrity.mjs',
    '--fix',
    '--failures', failuresFile,
    // Anything passed to this script is forwarded to the check, which is how
    // the loop is exercised against a scratch docs tree in the tests.
    ...process.argv.slice(2),
  ])
  const failures = fs.existsSync(failuresFile)
    ? fs.readFileSync(failuresFile, 'utf8').split('\n').filter(Boolean)
    : []
  return { ok: status === 0, failures }
}

if (translate(['*']) !== 0) {
  console.error('\ntranslation command failed -- not retrying, this is not a content problem')
  process.exit(1)
}

let outstanding = []
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const { ok, failures } = verify()
  if (ok) {
    console.log(`\ntranslation verified on attempt ${attempt} of ${ATTEMPTS}`)
    process.exit(0)
  }
  outstanding = failures
  if (!failures.length) {
    // Every document-level failure names its document, so an empty list means
    // the check itself did not get that far -- it crashed, or could not read
    // the tree. Retranslating would not change that.
    console.error('\nintegrity check failed without naming a document -- see the output above')
    process.exit(1)
  }
  if (attempt === ATTEMPTS) break
  console.log(`\nattempt ${attempt} of ${ATTEMPTS}: ${failures.length} document(s) incomplete, retranslating just those`)
  for (const f of failures) console.log(`  ${f}`)
  const globs = failures.map((f) => path.relative(path.join(DOCS, TARGET), f))
  if (translate(globs) !== 0) {
    console.error('\nretranslation command failed')
    process.exit(1)
  }
}

console.error(`\n${outstanding.length} document(s) still incomplete after ${ATTEMPTS} attempts:`)
for (const f of outstanding) console.error(`  ${f}`)

/**
 * Fall back to the translation already committed.
 *
 * Some documents cannot converge no matter how many attempts they get. The
 * clearest case is a source over doom's 60KB limit: it is cut into chunks, a
 * chunk comes back short, and the next attempt cuts it the same way. Failing
 * the whole job over one of those is worse than it sounds -- the job stops
 * before the commit, so every *other* document's good translation is thrown
 * away too, and the pages that were already damaged in the repository never get
 * their fix committed either. That is how one 82KB page kept four others stale.
 *
 * So a document that will not converge keeps the version already in git, if
 * that version is itself complete. The new page is discarded, the fact is
 * logged, and the run carries on. Only a document with no good version to fall
 * back on -- never translated, or committed broken -- still fails the run.
 */
const restoreCommitted = (file) => {
  // Run git where the file is, not where this script was started: --docs can
  // point the whole run at a tree outside this repository, and asking this
  // repository to check out a path it does not track only ever fails.
  const status = spawnSync('git', ['checkout', 'HEAD', '--', path.basename(file)], {
    cwd: path.dirname(file),
    stdio: 'pipe',
  }).status
  return status === 0 && fs.existsSync(file)
}

const restored = []
const unrecoverable = []
for (const file of outstanding) {
  if (!restoreCommitted(file)) {
    unrecoverable.push(file)
    continue
  }
  restored.push(file)
}

if (restored.length) {
  console.log(`\nverifying the committed version of ${restored.length} document(s) that would not converge`)
  const status = run('node', [
    'scripts/check-translation-integrity.mjs',
    '--fix',
    '--failures', failuresFile,
    ...restored.flatMap((file) => ['--only', file]),
    ...process.argv.slice(2),
  ])
  if (status !== 0) {
    const stillBad = fs.existsSync(failuresFile)
      ? fs.readFileSync(failuresFile, 'utf8').split('\n').filter(Boolean)
      : restored
    for (const file of stillBad) {
      unrecoverable.push(file)
      const i = restored.indexOf(file)
      if (i !== -1) restored.splice(i, 1)
    }
  }
}

for (const file of restored) {
  console.log(
    `KEPT ${file} -- the new translation was incomplete, so the committed one stands.` +
      ' It no longer follows the English page; split the source under 60KB, or translate it by hand.',
  )
}

if (unrecoverable.length === 0) {
  console.log(`\n${restored.length} document(s) kept their committed translation; everything else verified`)
  process.exit(0)
}

console.error(`\n${unrecoverable.length} document(s) have no complete translation, committed or new:`)
for (const f of unrecoverable) console.error(`  ${f}`)
console.error('\nNothing is committed. Fix these by hand, or raise TRANSLATE_ATTEMPTS, before the site is rebuilt.')
process.exit(1)
