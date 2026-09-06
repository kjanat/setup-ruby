import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const normalize = value => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
const escapeData = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const phase = process.env.PATH_TEST_AFTER_ADDED === 'true' ? 'after later PATH addition' : 'after setup-ruby'
const title = escapeData(`${process.env.RUNNER_LABEL} / JavaScript / ${phase}`)
  .replaceAll(':', '%3A').replaceAll(',', '%2C')
let diagnostic = ''

try {
  const entries = process.env.PATH.split(path.delimiter)
  const dirs = entries.filter(Boolean).map(normalize)
  assert.ok(!dirs.includes(normalize(process.env.PATH_TEST_OLD)), 'Old Ruby entry remains on PATH')
  const old = process.platform === 'win32'
    ? spawnSync('where.exe', ['path-test-old'], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'if command -v path-test-old; then exit 0; else exit 1; fi'], { encoding: 'utf8' })
  assert.ifError(old.error)
  assert.equal(old.status, 1, `Old command lookup should find nothing: ${old.stdout || old.stderr}`)
  const tools = ['inherited', 'before']
  const toolCounts = []
  if (process.env.PATH_TEST_AFTER_ADDED === 'true') tools.push('after')
  for (const tool of tools) {
    const dir = process.env[`PATH_TEST_${tool.toUpperCase()}`]
    const matchingEntries = entries.flatMap((entry, index) =>
      entry && normalize(entry) === normalize(dir) ? [`Entry ${index + 1}: ${entry}`] : [])
    toolCounts.push(`${tool}-tool=${matchingEntries.length}`)
    if (matchingEntries.length !== 1) {
      throw new Error([
        `${tool}-tool: expected 1 PATH entry, found ${matchingEntries.length}.`,
        ...(matchingEntries.length ? matchingEntries : [`Missing: ${dir}`]),
      ].join('\n'))
    }
    const output = execSync(`path-test-${tool}`, { encoding: 'utf8' }).trim()
    assert.equal(output, tool, `${tool} tool did not run correctly`)
  }

  const ruby = spawnSync('ruby', ['-rjson', '-rrbconfig', '-e',
    'puts JSON.generate(version: RUBY_VERSION, executable: RbConfig.ruby)'], { encoding: 'utf8' })
  assert.equal(ruby.status, 0, ruby.error?.message || ruby.stderr)
  const actual = JSON.parse(ruby.stdout)
  const executable = process.platform === 'win32' ? 'ruby.exe' : 'ruby'
  assert.equal(normalize(actual.executable), normalize(path.join(process.env.EXPECTED_RUBY_PREFIX, 'bin', executable)))
  assert.match(actual.version, /^3\.4\./, 'The selected Ruby version must run')
  diagnostic = `Ruby ${actual.version}; PATH entries: ${toolCounts.join(', ')}.\nInterpreter: ${actual.executable}`
  console.log(JSON.stringify({ ruby: actual, tools, path: process.env.PATH }, null, 2))
  console.log(`::notice title=${title}::PATH checks passed.`)
} catch (error) {
  diagnostic = error.message
  console.error(`::error title=${title}::${escapeData(diagnostic)}`)
  console.error(error.stack)
  process.exitCode = 1
} finally {
  appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${JSON.stringify(diagnostic)}\n`)
}
