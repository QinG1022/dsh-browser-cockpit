import assert from 'node:assert/strict'
import { nextStepForError } from '../lib/tools.js'

const cases = [
  [new Error('ref e12 is not found in the current snapshot'), /browser_snapshot/u],
  [new Error('target is ambiguous: 3 elements match'), /Narrow the target/u],
  [new Error('element is covered by another element'), /coordinate fallback/u],
  [new Error('navigation to http://example.com is not allowed by allowedHosts'), /allowedHosts/u],
  [new Error('Timed out waiting for network idle'), /timeoutMs/u],
  [new Error('Target closed'), /browser_open/u],
  [new Error('browser is not running'), /browser_open/u],
  [new Error('unexpected internal failure'), /browser_snapshot/u],
]

for (const [error, pattern] of cases) {
  const hint = nextStepForError(error)
  assert.match(hint, pattern)
  assert.ok(hint.length > 20)
}

assert.match(nextStepForError('random'), /browser_console/u)
console.log(`ok ${cases.length + 1} error hints`)
