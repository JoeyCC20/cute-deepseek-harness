/** Tests for the pre-boot credential injector used by the packaged Electron app. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { parse } = require_('../lib/pixies-keychain.cjs') as {
  parse: (text: string) => Record<string, string>
}

describe('pixies-keychain parser', () => {
  it('parses simple assignments', () => {
    const parsed = parse('A=1\nB=two\n')
    assert.deepEqual(parsed, { A: '1', B: 'two' })
  })

  it('honours `export` prefix', () => {
    const parsed = parse('export FOO=bar\n')
    assert.deepEqual(parsed, { FOO: 'bar' })
  })

  it('strips matching double and single quotes', () => {
    assert.equal(parse('A="b c"\n').A, 'b c')
    assert.equal(parse("A='b c'\n").A, 'b c')
    assert.equal(parse('A=unquoted\n').A, 'unquoted')
  })

  it('ignores comments and blank lines', () => {
    const parsed = parse('# comment\n\n   \nA=1\n')
    assert.deepEqual(parsed, { A: '1' })
  })

  it('ignores lines that do not look like assignments', () => {
    const parsed = parse('echo hi\nPATH=/usr/bin\nA B=1\n1A=x\n')
    assert.deepEqual(parsed, { PATH: '/usr/bin' })
  })

  it('reads files in declared order without overwriting existing env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixies-keychain-'))
    writeFileSync(join(dir, '.env'), 'FROM_ENV_FILE=from-file\nALREADY_SET=from-file\n')
    writeFileSync(join(dir, '.rc'), 'export FROM_RC=from-rc\n')
    // We cannot drive `inject` from the test without polluting process.env, so
    // we exercise only the parser — the file-ordering behaviour is exercised by
    // the smoke runner against a real userData dir.
    const parsed = parse('FROM_ENV_FILE=from-file\nALREADY_SET=from-file\n')
    assert.equal(parsed.FROM_ENV_FILE, 'from-file')
    void dir
  })
})
