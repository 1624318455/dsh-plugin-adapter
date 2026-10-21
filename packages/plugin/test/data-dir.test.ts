import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  dataDirPath,
  legacyDataDirPath,
  resolveDataDir,
} from '../src/data-dir.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-plugin-adapter-datadir-'))
}

function seedLegacy(root: string): string {
  const legacy = join(root, LEGACY_DATA_DIR_NAME)
  mkdirSync(join(legacy, 'singbox'), { recursive: true })
  writeFileSync(join(legacy, 'adapter-status.json'), '{"status":"ready"}')
  writeFileSync(join(legacy, 'gateway-session.txt'), 'ses_abc')
  writeFileSync(join(legacy, 'singbox', 'config.json'), '{"inbounds":[]}')
  return legacy
}

test('fresh install: neither directory exists -> the new one is created', () => {
  const root = home()
  try {
    const result = resolveDataDir({ home: root })
    assert.equal(result.dir, dataDirPath(root))
    assert.equal(result.migrated, false)
    assert.equal(result.legacyFallback, false)
    assert.ok(existsSync(dataDirPath(root)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('only the legacy directory exists -> content is copied and the old one is parked', () => {
  const root = home()
  try {
    const legacy = seedLegacy(root)
    const result = resolveDataDir({ home: root, now: new Date('2026-10-22T10:00:00Z') })
    assert.equal(result.dir, dataDirPath(root))
    assert.equal(result.migrated, true)
    assert.equal(result.legacyFallback, false)
    assert.equal(result.backup, `${legacy}.bak-20261022`)
    // content landed
    assert.equal(readFileSync(join(dataDirPath(root), 'adapter-status.json'), 'utf8'), '{"status":"ready"}')
    assert.equal(readFileSync(join(dataDirPath(root), 'gateway-session.txt'), 'utf8'), 'ses_abc')
    assert.equal(readFileSync(join(dataDirPath(root), 'singbox', 'config.json'), 'utf8'), '{"inbounds":[]}')
    // the old directory is a complete rollback path, not deleted
    assert.ok(existsSync(result.backup!))
    assert.equal(readFileSync(join(result.backup!, 'adapter-status.json'), 'utf8'), '{"status":"ready"}')
    assert.ok(!existsSync(legacy))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('only the new directory exists -> used as is, the legacy one is untouched', () => {
  const root = home()
  try {
    const legacy = seedLegacy(root)
    mkdirSync(dataDirPath(root), { recursive: true })
    writeFileSync(join(dataDirPath(root), 'adapter-status.json'), '{"status":"new"}')
    const result = resolveDataDir({ home: root })
    assert.equal(result.dir, dataDirPath(root))
    assert.equal(result.migrated, false)
    assert.equal(result.backup, undefined)
    assert.equal(readFileSync(join(dataDirPath(root), 'adapter-status.json'), 'utf8'), '{"status":"new"}')
    assert.ok(existsSync(legacy), 'the legacy directory is never touched when the new one exists')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('both directories exist -> the new one wins, the legacy one stays put', () => {
  const root = home()
  try {
    const legacy = seedLegacy(root)
    mkdirSync(dataDirPath(root), { recursive: true })
    writeFileSync(join(dataDirPath(root), 'adapter-status.json'), '{"status":"new"}')
    const result = resolveDataDir({ home: root })
    assert.equal(result.dir, dataDirPath(root))
    assert.equal(result.migrated, false)
    assert.ok(existsSync(legacy))
    assert.equal(readFileSync(join(legacy, 'adapter-status.json'), 'utf8'), '{"status":"ready"}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migration is idempotent: a second start neither copies nor backs up again', () => {
  const root = home()
  try {
    seedLegacy(root)
    const first = resolveDataDir({ home: root, now: new Date('2026-10-22T10:00:00Z') })
    const second = resolveDataDir({ home: root, now: new Date('2026-10-22T11:00:00Z') })
    assert.equal(first.migrated, true)
    assert.equal(second.migrated, false)
    assert.equal(second.backup, undefined)
    assert.equal(second.dir, dataDirPath(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed migration keeps the legacy directory in use instead of crashing', () => {
  const root = home()
  try {
    const legacy = seedLegacy(root)
    // A non-empty backup directory makes the final rename fail (ENOTEMPTY),
    // which is the worst realistic case: the copy succeeded but the old
    // directory cannot be parked.
    const blocked = `${legacy}.bak-20261022`
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'keep'), 'x')
    const result = resolveDataDir({ home: root, now: new Date('2026-10-22T10:00:00Z') })
    assert.equal(result.legacyFallback, true)
    assert.equal(result.dir, legacy)
    assert.ok(result.reason && result.reason.length > 0)
    assert.ok(existsSync(legacy))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unusable home never throws', () => {
  const root = home()
  try {
    // a file where the home directory should be: every mkdir fails
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const result = resolveDataDir({ home: blocked })
    assert.equal(result.dir, dataDirPath(blocked))
    assert.equal(result.legacyFallback, false)
    assert.ok(result.reason && result.reason.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the directory names are the documented ones', () => {
  assert.equal(DATA_DIR_NAME, '.dsh-plugin-adapter')
  assert.equal(LEGACY_DATA_DIR_NAME, '.opencode2dsh')
  assert.ok(legacyDataDirPath('/home/x').endsWith('.opencode2dsh'))
})
