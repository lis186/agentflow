'use strict'

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const metrics = require('./metrics.js')
const runner = require('./external-runner.js')
const settings = require('./ag-settings.js')

describe('ccxray telemetry integration', () => {
  describe('worker_environment telemetry injection', () => {
    it('injects CCXRAY_TASK, CCXRAY_ROLE, and ANTHROPIC_CUSTOM_HEADERS when task and role provided', () => {
      const command = { executable: 'claude', args: [] }
      const env = runner.worker_environment(command, {}, { task: 'A-012', role: 'cross-check', project: 'ipadpos' })

      assert.equal(env.CCXRAY_TASK, 'A-012')
      assert.equal(env.CCXRAY_ROLE, 'cross-check')
      assert.equal(env.CCXRAY_PROJECT, 'ipadpos')
      assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-ccxray-task=A-012/)
      assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-ccxray-role=cross-check/)
      assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-ccxray-project=ipadpos/)
    })

    it('preserves existing ANTHROPIC_CUSTOM_HEADERS while appending telemetry', () => {
      const command = { executable: 'claude', args: [] }
      const initialEnv = { ANTHROPIC_CUSTOM_HEADERS: 'my-custom=header' }
      const env = runner.worker_environment(command, initialEnv, { task: 'B-001', role: 'worker' })

      assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /^my-custom=header,x-ccxray-task=B-001,x-ccxray-role=worker/)
    })

    it('reads from existing process env if telemetry object is empty', () => {
      const command = { executable: 'codex', args: [] }
      const env = runner.worker_environment(command, { CCXRAY_TASK: 'C-003', CCXRAY_ROLE: 'spike' }, {})

      assert.equal(env.CCXRAY_TASK, 'C-003')
      assert.equal(env.CCXRAY_ROLE, 'spike')
    })
  })

  describe('ag-settings allows "metrics": "ccxray" and "auto"', () => {
    it('accepts ccxray and auto as valid metrics switch settings', () => {
      assert.equal(metrics.metrics_enabled('ccxray'), true)
      assert.equal(metrics.metrics_enabled('auto'), true)
      assert.equal(metrics.metrics_enabled({ switches: { metrics: 'ccxray' } }), true)
      assert.equal(metrics.metrics_enabled({ switches: { metrics: 'auto' } }), true)
      assert.equal(metrics.metrics_enabled({ switches: { metrics: 'on' } }), true)
      assert.equal(metrics.metrics_enabled({ switches: { metrics: 'off' } }), false)
    })
  })

  describe('auto-detection and transparent proxying', () => {
    it('detects ccxray port from hub.json', () => {
      const fs = require('node:fs')
      const os = require('node:os')
      const path = require('node:path')
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'test-hub-'))
      try {
        fs.writeFileSync(path.join(tmpHome, 'hub.json'), JSON.stringify({ port: 8999, pid: process.pid }))
        const prevHome = process.env.CCXRAY_HOME
        process.env.CCXRAY_HOME = tmpHome
        try {
          const detected = metrics.detect_ccxray_endpoint()
          assert.equal(detected, 'http://127.0.0.1:8999')
        } finally {
          if (prevHome) process.env.CCXRAY_HOME = prevHome
          else delete process.env.CCXRAY_HOME
        }
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true })
      }
    })

    it('injects OPENAI_BASE_URL for codex when endpoint is detected', () => {
      const command = { executable: 'codex', args: ['exec'] }
      const env = runner.worker_environment(command, {}, { task: 'A-001', role: 'worker', endpoint: 'http://127.0.0.1:8999' })
      assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:8999/v1')
    })
  })

  describe('fetch_ccxray_metrics and enrich_stage_with_ccxray', () => {
    let mockServer
    let serverPort

    before(async () => {
      mockServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`)
        if (url.pathname === '/api/task-summary') {
          const task = url.searchParams.get('task')
          if (task === 'TASK-FOUND') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              task: 'TASK-FOUND',
              calls: 5,
              cost_usd: 0.1234,
              tokens: {
                input: 1200,
                output: 340,
                cache_read: 8000,
                cache_create: 500,
                reasoning: 80,
                total: 10120,
              },
              cache_hit_rate: 0.825,
              tools: { Bash: 4, Edit: 2 },
              tool_failures: 1,
              skills: { agentflow: 1 },
            }))
            return
          }
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        res.writeHead(404)
        res.end()
      })

      await new Promise(resolve => mockServer.listen(0, '127.0.0.1', () => {
        serverPort = mockServer.address().port
        resolve()
      }))
    })

    after(async () => {
      if (mockServer) {
        await new Promise(resolve => mockServer.close(resolve))
      }
    })

    it('returns null on invalid task or unreachable server', async () => {
      const result = await metrics.fetch_ccxray_metrics('', { endpoint: `http://127.0.0.1:${serverPort}` })
      assert.equal(result, null)

      const unreachable = await metrics.fetch_ccxray_metrics('TASK-1', { endpoint: 'http://127.0.0.1:1' })
      assert.equal(unreachable, null)
    })

    it('fetches and normalizes tokens and cost from mock ccxray server', async () => {
      const endpoint = `http://127.0.0.1:${serverPort}`
      const result = await metrics.fetch_ccxray_metrics('TASK-FOUND', { endpoint })

      assert.ok(result)
      assert.equal(result.task, 'TASK-FOUND')
      assert.equal(result.calls, 5)
      assert.equal(result.cost_usd, 0.1234)
      assert.equal(result.cache_hit_rate, 0.825)
      assert.deepEqual(result.tools, { Bash: 4, Edit: 2 })
      assert.equal(result.tool_failures, 1)
      assert.deepEqual(result.skills, { agentflow: 1 })
      assert.equal(result.tokens.input, 1200)
      assert.equal(result.tokens.output, 340)
      assert.equal(result.tokens.cache, 8500)
      assert.equal(result.tokens.reasoning, 80)
      assert.equal(result.tokens.total, 10120)
    })

    it('enriches stage metrics with fetched ccxray data', async () => {
      const endpoint = `http://127.0.0.1:${serverPort}`
      const stageInput = {
        stage_id: 'TASK-FOUND',
        stage_kind: 'cross-check',
        started_at: '2026-09-19T10:00:00.000Z',
        ended_at: '2026-09-19T10:00:05.000Z',
      }

      const stage = await metrics.enrich_stage_with_ccxray(stageInput, { endpoint })
      assert.equal(stage.stage_id, 'TASK-FOUND')
      assert.equal(stage.cost_usd, 0.1234)
      assert.equal(stage.cache_hit_rate, 0.825)
      assert.deepEqual(stage.tools, { Bash: 4, Edit: 2 })
      assert.equal(stage.tool_failures, 1)
      assert.deepEqual(stage.skills, { agentflow: 1 })
      assert.equal(stage.provider_tokens.input, 1200)
      assert.equal(stage.provider_tokens.total, 10120)
      assert.equal(stage.provider_tokens.cache, 8500)
    })

    it('gracefully falls back to default unavailable stage metrics if ccxray returns 404', async () => {
      const endpoint = `http://127.0.0.1:${serverPort}`
      const stageInput = {
        stage_id: 'TASK-MISSING',
        stage_kind: 'explore',
        started_at: '2026-09-19T10:00:00.000Z',
        ended_at: '2026-09-19T10:00:02.000Z',
      }

      const stage = await metrics.enrich_stage_with_ccxray(stageInput, { endpoint })
      assert.equal(stage.stage_id, 'TASK-MISSING')
      assert.equal(stage.provider_tokens.total, 'unavailable')
      assert.equal(stage.cost_usd, undefined)
    })
  })
})
