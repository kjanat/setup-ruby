import { execSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const normalize = value => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
const escapeData = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const setup = process.env.SETUP_RUBY === 'true'
const testCase = setup ? 'with setup-ruby' : 'without setup-ruby'
const phase = process.env.PATH_TEST_AFTER_ADDED === 'true' ? 'after later PATH addition' : 'before later PATH addition'
const title = escapeData(`${process.env.RUNNER_OS} / ${testCase} / JavaScript / ${phase}`)
  .replaceAll(':', '%3A').replaceAll(',', '%2C')
const entries = process.env.PATH.split(path.delimiter)
const tools = ['old', 'inherited', 'before']
if (process.env.PATH_TEST_AFTER_ADDED === 'true') tools.push('after')
const observations = []
const failures = []

function lookup(command) {
  const result = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `if command -v ${command}; then exit 0; else exit 1; fi`], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 1) return null
  if (result.status !== 0) throw new Error(`Lookup exited with ${result.status}: ${result.stderr}`)
  return result.stdout.trim().split(/\r?\n/)[0]
}

for (const tool of tools) {
  const observed = { tool, entries: [], command: null, output: null }
  try {
    const dir = process.env[`PATH_TEST_${tool.toUpperCase()}`]
    observed.entries = entries.flatMap((entry, index) =>
      entry && normalize(entry) === normalize(dir) ? [{ position: index + 1, directory: entry }] : [])
    observed.command = lookup(`path-test-${tool}`)
    if (observed.command) {
      observed.output = execSync(`"${observed.command}"`, { encoding: 'utf8', stdio: 'pipe' }).trim()
    }
    if (tool === 'old' && setup) {
      if (observed.entries.length || observed.command) failures.push('Old Ruby entry or command remains available')
    } else {
      if (!observed.entries.length) failures.push(`${tool} directory is missing from PATH: ${dir}`)
      if (!observed.command) failures.push(`${tool} command was not found`)
      else if (normalize(path.dirname(observed.command)) !== normalize(dir)) {
        failures.push(`${tool} resolved outside its fixture: ${observed.command}`)
      }
      if (observed.output !== tool) failures.push(`${tool} output: expected '${tool}', got '${observed.output}'`)
    }
  } catch (error) { failures.push(`${tool} check: ${error.message}`) }
  observations.push(observed)
}

let actual = null
try {
  if (lookup('ruby')) {
    const ruby = spawnSync('ruby', ['-rjson', '-rrbconfig', '-e',
      'puts JSON.generate(version: RUBY_VERSION, executable: RbConfig.ruby)'], { encoding: 'utf8' })
    if (ruby.error) throw ruby.error
    if (ruby.status !== 0) throw new Error(`Ruby exited with ${ruby.status}: ${ruby.stderr}`)
    actual = JSON.parse(ruby.stdout)
  }
  let expected = JSON.parse(process.env.BASELINE_RUBY)
  if (setup) {
    if (!process.env.EXPECTED_RUBY_PREFIX) throw new Error('setup-ruby did not provide a Ruby installation path')
    expected = { version: '3.4', executable: path.join(process.env.EXPECTED_RUBY_PREFIX, 'bin',
      process.platform === 'win32' ? 'ruby.exe' : 'ruby') }
  }
  if (expected) {
    if (!actual) throw new Error('Ruby was not found')
    if (normalize(actual.executable) !== normalize(expected.executable)) {
      failures.push(`Ruby interpreter: expected ${expected.executable}, got ${actual.executable}`)
    }
    if (setup ? !/^3\.4\./.test(actual.version) : actual.version !== expected.version) {
      failures.push(`Ruby version: expected ${expected.version}, got ${actual.version}`)
    }
  } else if (actual) { failures.push('Ruby appeared in the baseline without setup-ruby') }
} catch (error) { failures.push(`Ruby check: ${error.message}`) }

const record = { case: testCase, phase, ruby: actual, tools: observations, failures, path: entries }
const counts = observations.map(tool => `${tool.tool}=${tool.entries.length}`).join(', ')
const outputs = observations.map(tool => `${tool.tool}=${tool.output ?? '(no output)'}`).join(', ')
const diagnostic = `Ruby: ${actual?.version ?? 'not found'}; command output: ${outputs}; PATH entries: ${counts}.\n${JSON.stringify(record, null, 2)}`
console.log(JSON.stringify(record))
appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${JSON.stringify(diagnostic)}\n`)
if (failures.length) {
  console.error(`::error title=${title}::${escapeData(failures.join('\n'))}`)
  process.exitCode = 1
} else {
  console.log(`::notice title=${title}::All functional checks passed; duplicate counts are observations.`)
}
