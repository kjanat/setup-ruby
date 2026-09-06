import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const normalize = value => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

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
  if (process.env.PATH_TEST_AFTER_ADDED === 'true') tools.push('after')
  for (const tool of tools) {
    const dir = process.env[`PATH_TEST_${tool.toUpperCase()}`]
    const matchingEntries = entries.flatMap((entry, index) =>
      entry && normalize(entry) === normalize(dir) ? [`PATH[${index + 1}]: ${entry}`] : [])
    if (matchingEntries.length !== 1) {
      throw new Error([
        `${tool} tool entry occurs ${matchingEntries.length} times on PATH (expected 1).`,
        `Expected directory: ${dir}`,
        'Matching PATH entries (positions start at 1):',
        ...(matchingEntries.length ? matchingEntries : ['(none)']),
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
  console.log(JSON.stringify({ ruby: actual, tools, path: process.env.PATH }, null, 2))
  console.log('::notice title=PATH check passed::Selected Ruby and unrelated tools are available in the JavaScript action')
} catch (error) {
  const message = error.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.error(`::error title=PATH check failed::${message}`)
  console.error(error.stack)
  process.exitCode = 1
}
