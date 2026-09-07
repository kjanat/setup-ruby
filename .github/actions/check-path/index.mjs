import { execSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const normalize = value => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
const escapeData = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const setup = process.env.SETUP_RUBY === 'true'
const testCase = `${process.env.EXPERIMENT} / ${setup ? 'select Ruby 3.4' : 'keep original Ruby'}`
const phase = process.env.PATH_TEST_AFTER_ADDED === 'true' ? 'after later PATH addition' : 'before later PATH addition'
const title = escapeData(`${process.env.RUNNER_OS} / ${testCase} / JavaScript / ${phase}`)
  .replaceAll(':', '%3A').replaceAll(',', '%2C')
const entries = process.env.PATH.split(path.delimiter)
const tools = ['old', 'inherited', 'before']
if (process.env.PATH_TEST_AFTER_ADDED === 'true') tools.push('after')
const observations = []
const failures = []
const checks = []

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
  const start = failures.length
  const observed = { tool, entries: [], command: null, output: null, exit: null }
  try {
    const dir = process.env[`PATH_TEST_${tool.toUpperCase()}`]
    observed.entries = entries.flatMap((entry, index) =>
      entry && normalize(entry) === normalize(dir) ? [{ position: index + 1, directory: entry }] : [])
    observed.command = lookup(`path-test-${tool}`)
    if (observed.command) {
      try {
        observed.output = execSync(`"${observed.command}"`, { encoding: 'utf8', stdio: 'pipe' }).trim()
        observed.exit = 0
      } catch (error) {
        observed.output = error.stdout?.toString().trim() ?? null
        observed.exit = error.status
        throw error
      }
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
  checks.push({ check: tool,
    expected: tool === 'old' && setup ? 'Not found; no matching PATH entries' : `Output '${tool}'; exit 0; resolves from its fixture`,
    actual: `${observed.command ? `Output '${observed.output}'; exit ${observed.exit}` : 'Not found'}; ${observed.entries.length} PATH entries`,
    result: failures.length === start ? 'pass' : 'failure' })
}

let start = failures.length
let actual = null
let rubyExit = null
let expected = JSON.parse(process.env.BASELINE_RUBY)
try {
  if (lookup('ruby')) {
    const ruby = spawnSync('ruby', ['-rjson', '-rrbconfig', '-e',
      'puts JSON.generate(version: RUBY_VERSION, executable: RbConfig.ruby)'], { encoding: 'utf8' })
    rubyExit = ruby.status
    if (ruby.error) throw ruby.error
    if (ruby.status !== 0) throw new Error(`Ruby exited with ${ruby.status}: ${ruby.stderr}`)
    actual = JSON.parse(ruby.stdout)
  }
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
checks.push({ check: 'ruby',
  expected: setup ? 'Ruby 3.4 from the selected installation' : expected ? `Ruby ${expected.version}, original interpreter` : 'Not found',
  actual: actual ? `${JSON.stringify(actual)}; exit ${rubyExit}` : 'No Ruby result',
  result: failures.length === start ? 'pass' : 'failure' })

const gem = { installed: null, installedExit: null, command: null, output: null, exit: null }
if (process.env.EXPERIMENT === 'switch') {
  start = failures.length
  try {
    const installed = spawnSync('ruby', ['-rjson', '-e',
      'puts JSON.generate(Gem::Specification.find_all_by_name("ruby-path-fixture").map { |s| s.version.to_s })'], { encoding: 'utf8' })
    gem.installedExit = installed.status
    if (installed.error) throw installed.error
    if (installed.status !== 0) throw new Error(`Could not inspect gems: ${installed.stderr}`)
    gem.installed = JSON.parse(installed.stdout)
    if (setup ? gem.installed.length !== 0 : !gem.installed.includes('0.0.1')) {
      throw new Error(`Unexpected fixture gem installation: ${installed.stdout.trim()}`)
    }
  } catch (error) { failures.push(`Gem installation check: ${error.message}`) }
  checks.push({ check: 'fixture gem installed', expected: setup ? 'Absent from Ruby 3.4' : '0.0.1 in Ruby 3.3',
    actual: JSON.stringify(gem.installed), result: failures.length === start ? 'pass' : 'failure' })
  start = failures.length
  try {
    gem.command = lookup('ruby-path-fixture')
    if (gem.command) {
      try {
        gem.output = execSync(`"${gem.command}"`, { encoding: 'utf8', stdio: 'pipe' }).trim()
        gem.exit = 0
      } catch (error) {
        gem.output = error.stdout?.toString().trim() ?? null
        gem.exit = error.status
        throw error
      }
      const interpreter = JSON.parse(gem.output)
      if (setup) throw new Error(`Old gem command remains available after selecting Ruby 3.4: ${gem.output}; command: ${gem.command}`)
      const baseline = JSON.parse(process.env.BASELINE_RUBY)
      if (interpreter.version !== baseline.version || normalize(interpreter.executable) !== normalize(baseline.executable)) {
        throw new Error(`Gem command changed interpreter: ${gem.output}`)
      }
    } else if (!setup) { throw new Error('Fixture command disappeared without a Ruby switch') }
  } catch (error) { failures.push(`Gem command check: ${error.message}`) }
  checks.push({ check: 'ruby-path-fixture', expected: setup ? 'Not found after selecting Ruby 3.4' : 'Runs the original Ruby 3.3',
    actual: gem.command ? `${gem.output}; exit ${gem.exit}` : 'Not found', result: failures.length === start ? 'pass' : 'failure' })
}

const record = { case: testCase, phase, ruby: actual, rubyExit, tools: observations, gem, checks, failures, path: entries }
const diagnostic = JSON.stringify(record)
console.log(diagnostic)
appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${diagnostic}\n`)
if (failures.length) {
  console.error(`::error title=${title}::${escapeData(failures.join('\n'))}`)
  process.exitCode = 1
} else {
  console.log(`::notice title=${title}::All functional checks passed; duplicate counts are observations.`)
}
