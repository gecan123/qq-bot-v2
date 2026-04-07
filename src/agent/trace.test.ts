import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createTraceRecorder } from './trace.js'

describe('createTraceRecorder', () => {
  test('appends ordered phase, think, and loop events', () => {
    const recorder = createTraceRecorder({
      runId: 'run_1',
      groupId: 42,
      senderName: 'tester',
      userMessage: 'hi',
    })

    recorder.phaseStarted('plan', 'planning started')
    recorder.think({
      phase: 'plan',
      summary: 'need memory',
      raw: 'I should inspect memory first',
    })
    recorder.loopStarted(1)
    recorder.decision({
      phase: 'loop',
      loopIndex: 1,
      summary: 'call db_read',
      raw: { tool: 'db_read' },
    })

    const trace = recorder.finish({
      finalState: 'final',
      finalAnswer: 'done',
      terminationReason: 'final_answer',
    })

    assert.deepEqual(trace.events.map((event) => event.type), [
      'run_started',
      'phase_started',
      'think',
      'loop_started',
      'decision',
      'run_finished',
    ])
  })

  test('includes required event fields and termination metadata', () => {
    const recorder = createTraceRecorder({
      runId: 'run_1',
      groupId: 42,
      senderName: 'tester',
      userMessage: 'hi',
    })

    recorder.phaseStarted('receive', 'request accepted')
    recorder.phaseFinished({ phase: 'receive', summary: 'message accepted' })

    const trace = recorder.finish({
      finalState: 'aborted',
      terminationReason: 'max_steps_exceeded',
    })

    assert.equal(trace.terminationReason, 'max_steps_exceeded')
    const event = trace.events[0]
    assert.ok(event?.id)
    assert.equal(typeof event?.timestamp, 'number')
    assert.equal(typeof event?.elapsedMs, 'number')
    assert.equal(typeof event?.title, 'string')
    assert.equal(typeof event?.summary, 'string')
    assert.ok('raw' in (event ?? {}))
  })
})
