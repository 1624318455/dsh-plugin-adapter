import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalSessionID, conversationSeed, deriveRequestIDs, disguiseHeaders, mintSessionID, opencodeUserAgent, randomID, resetSessionMemo, stableID } from '../src/adapter/ids.ts'

test('stableID is deterministic and sha256-truncated', () => {
  const first = stableID('ses', 'hello')
  const second = stableID('ses', 'hello')
  assert.equal(first, second)
  assert.ok(first.startsWith('ses_'))
  const hex = first.slice('ses_'.length)
  assert.equal(hex.length, 24, '12 bytes hex')
  const expected = createHash('sha256').update('ses\x00hello').digest().subarray(0, 12).toString('hex')
  assert.equal(hex, expected)
  assert.notEqual(stableID('ses', 'world'), first)
  assert.notEqual(stableID('prj', 'hello'), first, 'prefix is part of the hash input')
})

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('canonicalSessionID passes official sessions through unchanged', () => {
  const official = 'ses_00000000abc0ABCdefGHIjklMN'
  assert.match(official, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(canonicalSessionID(official), official)
  // foreign shapes do NOT match the canonical gate: 24-hex is the wrong length
  assert.doesNotMatch('ses_0123456789abcdef01234567', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('canonicalSessionID mints a timestamped, memoised session for foreign ids', () => {
  // The upstream decodes the 12-hex prefix back into a timestamp and refuses
  // random ones (429), so a foreign signal is minted from the clock instead of
  // hashed, and the same signal keeps answering with the same id.
  resetSessionMemo()
  const minted = canonicalSessionID('"hello"')
  assert.match(minted, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

  assert.equal(canonicalSessionID('"hello"'), minted, 'same conversation keeps one session')
  assert.notEqual(canonicalSessionID('a'), canonicalSessionID('b'), 'distinct identities stay distinct')
  // A pinned canonical id still passes through untouched.
  const pinned = 'ses_00000000abc0ABCdefGHIjklMN'
  assert.equal(canonicalSessionID(pinned), pinned)
})

test('mintSessionID encodes the mint time in the hex prefix', () => {
  // prefix = ~(timeMs * 0x1000 + counter) & ((1<<48)-1); the counter restarts
  // per millisecond, so two mints one second apart differ by exactly 1000*4096.
  const decode = (id: string): bigint => (~BigInt(`0x${id.slice(4, 16)}`)) & ((1n << 48n) - 1n)
  resetSessionMemo()
  const early = decode(mintSessionID(1_000))
  const late = decode(mintSessionID(2_000))
  assert.equal(late - early, 1000n * 0x1000n)
  // The hex string is 'descending' (~time), so a later mint sorts lower.
})

test('mintSessionID keeps ids distinct inside one millisecond', () => {
  resetSessionMemo()
  const fixed = Date.now()
  const first = mintSessionID(fixed)
  const second = mintSessionID(fixed)
  assert.notEqual(first, second, 'the counter separates same-millisecond ids')
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('deriveRequestIDs emits canonical-shape sessions', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  assert.match(ids.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('deriveRequestIDs keeps the session stable across turns and randomizes requests', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.equal(first.project, second.project)
  assert.match(first.project, /^[0-9a-f]{32}$/, 'the CLI sends a bare 32-hex project id')
  assert.equal(first.parentSession, '')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('deriveRequestIDs gives every conversation its own session id', () => {
  // The Zen free lane meters its quota per SESSION id (measured 2026-10-21:
  // a pinned id that ran out kept returning 429 even on a fresh exit IP,
  // while another id answered 200 on the same IP). An unpinned adapter
  // therefore has to spread conversations over distinct ids, and must not
  // let an injected context row move the id of a running conversation.
  const first = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const other = deriveRequestIDs([{ role: 'user', content: 'a different opening' }])
  assert.notEqual(first.session, other.session, 'separate conversations, separate quota pools')

  const withContext = [
    { role: 'system', content: 'Current runtime context. This snapshot supersedes earlier snapshots.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'more' },
  ]
  assert.equal(deriveRequestIDs(withContext).session, first.session, 'context rows do not move the id')
  assert.match(first.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'still the canonical free-tier shape')
})

test('disguiseHeaders carries the CLI-identical correlation set', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = disguiseHeaders(ids)
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['x-session-id'], ids.session)
  assert.equal(headers['x-opencode-session-id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  // v2 channel/version/client shape: the v1 `opencode/1.18.x (os arch; node…)`
  // form is refused by the free tier since 2026-10-14.
  assert.match(headers['user-agent'], /^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i)
})
