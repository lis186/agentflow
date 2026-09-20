'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const child_process = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const metrics = require('./metrics.js')
const runner = require('./external-runner.js')
const settings = require('./ag-settings.js')

const make_temp_dir = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
const remove_temp_dir = directory => fs.rmSync(directory, { recursive: true, force: true })
const git = (directory, args) => child_process.execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
const run_metrics_cli = (args, env = {}) => new Promise((resolve, reject) => {
  const child = child_process.spawn(process.execPath, [path.join(__dirname, 'metrics.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
})

const make_source_repo = () => {
  const root = make_temp_dir('agentflow-ccxray-source-')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'telemetry@example.test'])
  git(root, ['config', 'user.name', 'Telemetry Test'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'source content\n')
  git(root, ['add', 'tracked.txt'])
  git(root, ['commit', '-qm', 'initial'])
  return root
}

const make_stage = (stage_id = 'cross-check', overrides = {}) => ({
  stage_id,
  stage_kind: 'review',
  started_at: '2026-09-19T10:00:00.000Z',
  ended_at: '2026-09-19T10:00:05.000Z',
  ...overrides,
})

const make_work_item = overrides => ({
  work_item_id: 'WORK-001',
  completed_at: '2026-09-19T10:01:00.000Z',
  acceptance_result: 'passed',
  stages: [make_stage()],
  ...overrides,
})

const start_server = handler => new Promise((resolve, reject) => {
  const server = http.createServer(handler)
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject)
    resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` })
  })
})

const close_server = server => new Promise(resolve => server.close(resolve))

test('builds one encoded attribution path segment and applies value rules', () => {
  assert.equal(
    metrics.build_ccxray_attribution_prefix({ task: 'A-012', role: 'cross-check', project: 'ipadpos' }),
    '/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos',
  )
  assert.equal(
    metrics.build_ccxray_attribution_prefix({ task: 'A-012', role: 'cross-check', project: 'ipad pos/north&east=1' }),
    '/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipad%2Bpos%252Fnorth%2526east%253D1',
  )
  assert.equal(metrics.build_ccxray_attribution_prefix({}), '')
  assert.equal(
    metrics.build_ccxray_attribution_prefix({ task: ' A\u0000-012\n', role: 'x'.repeat(129), project: '\u0001\u007f' }),
    '/_ccxray/attr/task%3DA-012',
  )
})

test('places codex overrides after the subcommand so exec-level -c flags cannot drop them', () => {
  // Regression, found only by a live run: codex 0.154 ignores root-level `-c`
  // overrides once the subcommand carries its own `-c`. Worker commands always
  // do (reasoning effort), so root-level injection reported `active` while every
  // request bypassed ccxray.
  const context = { task: 'A-1', endpoint: 'http://127.0.0.1:5577' }
  const shape = args => {
    const injection = runner.ccxray_worker_injection({ executable: 'codex', args }, {}, context)
    return runner.apply_injection_args(args, injection).map(argument => argument.startsWith('openai_base_url=')
      ? '<openai>'
      : argument.startsWith('chatgpt_base_url=') ? '<chatgpt>' : argument)
  }
  const overrides = ['-c', '<openai>', '-c', '<chatgpt>']
  assert.deepEqual(shape(['exec', '--model', 'm', '-c', 'model_reasoning_effort="high"', 'prompt']),
    ['exec', ...overrides, '--model', 'm', '-c', 'model_reasoning_effort="high"', 'prompt'])
  assert.deepEqual(shape(['-m', 'm', 'exec', 'prompt']), ['-m', 'm', 'exec', ...overrides, 'prompt'])
  assert.deepEqual(shape(['-c', 'a=1', 'e', 'prompt']), ['-c', 'a=1', 'e', ...overrides, 'prompt'])
  // No subcommand (interactive, or a bare prompt): root level is the only level.
  assert.deepEqual(shape(['prompt']), [...overrides, 'prompt'])
  assert.deepEqual(shape([]), overrides)
  // A literal `exec` after `--` is a prompt word, not a subcommand.
  assert.deepEqual(shape(['--', 'exec']), [...overrides, '--', 'exec'])
  // Non-codex injections leave the argument list untouched.
  const claude_args = ['-p', 'hi']
  assert.deepEqual(runner.apply_injection_args(claude_args, runner.ccxray_worker_injection({ executable: 'claude', args: claude_args }, {}, context)), claude_args)
  assert.deepEqual(runner.apply_injection_args(claude_args, undefined), claude_args)
})

test('injects the ccxray carrier for claude, codex, and grok without mutating inputs', () => {
  const endpoint = 'http://127.0.0.1:5577'
  const context = { task: 'A-012', role: 'cross-check', project: 'ipadpos', endpoint }

  const claude_command = { executable: 'claude', args: ['-p'] }
  const claude_environment = { EXISTING: 'yes' }
  const claude = runner.ccxray_worker_injection(claude_command, claude_environment, context)
  assert.equal(claude.status, 'active')
  assert.equal(claude.reason, null)
  assert.equal(claude.env_updates.ANTHROPIC_BASE_URL, `${endpoint}/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos`)
  assert.deepEqual(claude.arg_prefix, [])

  const codex_command = { executable: 'codex', args: ['exec'] }
  const codex_environment = {}
  const codex = runner.ccxray_worker_injection(codex_command, codex_environment, context)
  assert.equal(codex.status, 'active')
  assert.deepEqual(codex.arg_prefix, [])
  assert.deepEqual(codex.arg_insert, {
    index: 1,
    args: [
      '-c', 'openai_base_url="http://127.0.0.1:5577/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos/v1"',
      '-c', 'chatgpt_base_url="http://127.0.0.1:5577/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos/v1"',
    ],
  })

  const grok = runner.ccxray_worker_injection({ executable: '/usr/local/bin/grok', args: [] }, {}, context)
  assert.equal(grok.status, 'active')
  assert.equal(grok.env_updates.GROK_CLI_CHAT_PROXY_BASE_URL, `${endpoint}/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos/v1`)
  assert.deepEqual(grok.arg_prefix, [])

  assert.deepEqual(claude_command, { executable: 'claude', args: ['-p'] })
  assert.deepEqual(claude_environment, { EXISTING: 'yes' })
  assert.deepEqual(codex_command, { executable: 'codex', args: ['exec'] })
  assert.deepEqual(codex_environment, {})
})

test('reports unsupported executables and leaves custom base URLs untouched', () => {
  const context = { task: 'A-012', role: 'worker', endpoint: 'http://127.0.0.1:5577' }
  const unsupported = runner.ccxray_worker_injection({ executable: 'other-cli', args: [] }, {}, context)
  assert.equal(unsupported.status, 'skipped')
  assert.equal(unsupported.reason, 'unsupported_executable')
  assert.deepEqual(unsupported.arg_prefix, [])
  assert.equal(unsupported.env_updates.ANTHROPIC_BASE_URL, undefined)

  const foreign = 'https://corporate-gateway.example/v1'
  const claude = runner.ccxray_worker_injection(
    { executable: 'claude', args: [] },
    { ANTHROPIC_BASE_URL: foreign },
    context,
  )
  assert.equal(claude.status, 'skipped')
  assert.equal(claude.reason, 'custom_base_url')
  assert.equal(claude.env_updates.ANTHROPIC_BASE_URL, undefined)

  const codex = runner.ccxray_worker_injection(
    { executable: 'codex', args: ['-c', 'openai_base_url="https://custom.example/v1"'] },
    {},
    context,
  )
  assert.equal(codex.status, 'skipped')
  assert.equal(codex.reason, 'custom_base_url')
  assert.deepEqual(codex.arg_prefix, [])
})

test('replaces inherited attribution while preserving a same-origin client path', () => {
  const inherited = 'http://localhost:5577/_ccxray/client/4242/_ccxray/attr/task%3Dold%26role%3Dold'
  const result = runner.ccxray_worker_injection(
    { executable: 'claude', args: [] },
    { ANTHROPIC_BASE_URL: inherited },
    { task: 'A-012', role: 'cross-check', endpoint: 'http://127.0.0.1:5577' },
  )
  assert.equal(result.status, 'active')
  assert.equal(result.reason, null)
  assert.equal(result.env_updates.ANTHROPIC_BASE_URL, 'http://localhost:5577/_ccxray/client/4242/_ccxray/attr/task%3DA-012%26role%3Dcross-check')
})

test('worker_environment without telemetry preserves the upstream environment contract', () => {
  const environment = runner.worker_environment(
    { executable: 'claude', args: [] },
    { ANTHROPIC_BASE_URL: 'https://gateway.example', CCXRAY_TASK: 'existing-task' },
  )
  assert.deepEqual(environment, {
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    CCXRAY_TASK: 'existing-task',
  })
  const empty = runner.worker_environment({ executable: 'codex', args: [] }, {})
  assert.equal(Object.hasOwn(empty, 'CCXRAY_TASK'), false)
  assert.equal(Object.hasOwn(empty, 'CCXRAY_ROLE'), false)
  assert.equal(Object.hasOwn(empty, 'CCXRAY_PROJECT'), false)
  assert.equal(Object.hasOwn(empty, 'ANTHROPIC_BASE_URL'), false)
  assert.equal(Object.hasOwn(empty, 'OPENAI_BASE_URL'), false)
  assert.equal(Object.hasOwn(empty, 'GROK_CLI_CHAT_PROXY_BASE_URL'), false)
})

test('resolves ccxray mode from switch strings, config objects, and ag.json paths', () => {
  assert.equal(metrics.ccxray_mode('off'), 'off')
  assert.equal(metrics.ccxray_mode('on'), 'off')
  assert.equal(metrics.ccxray_mode('auto'), 'auto')
  assert.equal(metrics.ccxray_mode('ccxray'), 'ccxray')
  assert.equal(metrics.ccxray_mode({ switches: { metrics: 'off' } }), 'off')
  assert.equal(metrics.ccxray_mode({ switches: { metrics: 'on' } }), 'off')
  assert.equal(metrics.ccxray_mode({ switches: { metrics: 'auto' } }), 'auto')
  assert.equal(metrics.ccxray_mode({ switches: { metrics: 'ccxray' } }), 'ccxray')
  assert.equal(metrics.ccxray_executable_available({ env: { PATH: '' } }), false)
  assert.equal(metrics.ccxray_executable_available({ executable_available: executable => executable === 'ccxray' }), true)

  const directory = make_temp_dir('agentflow-ccxray-mode-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'ccxray' } }))
    assert.equal(metrics.ccxray_mode(config_path), 'ccxray')
  } finally {
    remove_temp_dir(directory)
  }
})

test('fetches task summaries through the capability-gated API and filters empty tasks', async () => {
  const queries = []
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.searchParams.get('task') === 'EMPTY') {
        res.end(JSON.stringify({ task: 'EMPTY', calls: 0 }))
        return
      }
      res.end(JSON.stringify({
        task: 'TASK-FOUND',
        role: 'cross-check',
        project: 'ipadpos',
        calls: 3,
        cost_usd: 0.0421,
        tokens: { input: 300, output: 45, cache_read: 1500, cache_create: 0, reasoning: 20, total: 1845 },
        cache_hit_rate: 0.833,
        tools: { Bash: 2 },
        tool_failures: 0,
        skills: { agentflow: 1 },
        models: ['gpt-5.5'],
        agents: ['codex'],
        sessions: 1,
        by_role: { 'cross-check': { calls: 3 } },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const result = await metrics.fetch_ccxray_metrics('TASK-FOUND', { endpoint, role: 'cross-check', project: 'ipadpos' })
    assert.ok(result)
    assert.equal(queries[0].searchParams.get('task'), 'TASK-FOUND')
    assert.equal(queries[0].searchParams.get('role'), 'cross-check')
    assert.equal(queries[0].searchParams.get('project'), 'ipadpos')
    assert.equal(result.role, 'cross-check')
    assert.deepEqual(result.models, ['gpt-5.5'])
    assert.deepEqual(result.agents, ['codex'])
    assert.equal(result.sessions, 1)
    assert.deepEqual(result.by_role, { 'cross-check': { calls: 3 } })
    assert.equal(result.tokens.cache, 1500)
    assert.equal(await metrics.fetch_ccxray_metrics('EMPTY', { endpoint }), null)
  } finally {
    await close_server(server)
  }
})

test('CLI emits paste-ready ccxray devlog lines for found, empty, and unreachable tasks', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.searchParams.get('task') === 'TASK-EMPTY') {
        res.end(JSON.stringify({ task: 'TASK-EMPTY', calls: 0 }))
        return
      }
      res.end(JSON.stringify({
        task: 'TASK-FOUND',
        role: 'cross-check',
        calls: 3,
        cost_usd: 0.0421,
        cache_hit_rate: 0.833,
        tokens: { input: 300, output: 45, cache_read: 1500, cache_create: 0, total: 1845 },
        tools: {},
        tool_failures: 0,
        models: ['gpt-5.5'],
        agents: ['codex'],
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-cli-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto' } }))
    const common = ['ccxray-summary', '--config', config_path, '--format', 'devlog']
    const found = await run_metrics_cli([...common, '--task', 'TASK-FOUND', '--role', 'cross-check', '--project', 'agentflow'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(found.status, 0)
    assert.equal(found.stderr, '')
    assert.equal(found.stdout, '- ccxray TASK-FOUND/cross-check: 3 calls · $0.0421 · tokens in 300 / out 45 / cache 1500 (hit 83.3%) / total 1845 · gpt-5.5 via codex\n')

    const json_args = ['ccxray-summary', '--config', config_path, '--task', 'TASK-FOUND', '--role', 'cross-check', '--project', 'agentflow']
    const implicit_json = await run_metrics_cli(json_args, { CCXRAY_ENDPOINT: endpoint })
    const explicit_json = await run_metrics_cli([...json_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(implicit_json.status, 0)
    assert.equal(explicit_json.status, 0)
    assert.equal(explicit_json.stdout, implicit_json.stdout)
    assert.equal(JSON.parse(implicit_json.stdout).task, 'TASK-FOUND')

    const empty = await run_metrics_cli([...common, '--task', 'TASK-EMPTY'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(empty.status, 0)
    assert.equal(empty.stdout, '- ccxray TASK-EMPTY: unavailable (no_data)\n')

    const unreachable = await run_metrics_cli([...common, '--task', 'TASK-UNREACHABLE'], { CCXRAY_ENDPOINT: 'http://127.0.0.1:1' })
    assert.equal(unreachable.status, 0)
    assert.equal(unreachable.stdout, '- ccxray TASK-UNREACHABLE: unavailable (ccxray_not_found)\n')
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('CLI keeps JSON output and exits successfully for disabled or unreadable configs', async () => {
  const directory = make_temp_dir('agentflow-ccxray-cli-config-')
  try {
    const disabled_config = path.join(directory, 'disabled-ag.json')
    const invalid_config = path.join(directory, 'invalid-ag.json')
    fs.writeFileSync(disabled_config, JSON.stringify({ switches: { metrics: 'off' } }))
    fs.writeFileSync(invalid_config, 'not json')

    const disabled = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--config', disabled_config, '--format', 'devlog'])
    assert.equal(disabled.status, 0)
    assert.equal(disabled.stdout, '- ccxray A-012: unavailable (metrics_disabled)\n')

    const default_json = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--config', disabled_config])
    assert.equal(default_json.status, 0)
    assert.deepEqual(JSON.parse(default_json.stdout), { available: false, reason: 'metrics_disabled' })

    const unreadable_devlog = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--config', invalid_config, '--format', 'devlog'])
    assert.equal(unreadable_devlog.status, 0)
    assert.equal(unreadable_devlog.stdout, '- ccxray A-012: unavailable (config_unreadable)\n')

    const unreadable_json = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--config', invalid_config, '--format', 'json'])
    assert.equal(unreadable_json.status, 0)
    assert.deepEqual(JSON.parse(unreadable_json.stdout), { available: false, reason: 'config_unreadable' })

    const unknown = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--config', disabled_config, '--format', 'table'])
    assert.equal(unknown.status, 1)
    assert.equal(unknown.stdout, '')
    assert.match(unknown.stderr, /unknown format: table/)
  } finally {
    remove_temp_dir(directory)
  }
})

test('rejects a reachable endpoint whose health app is not ccxray', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    if (req.url === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'other', capabilities: ['task-attribution'] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    assert.deepEqual(await metrics.resolve_ccxray_endpoint({ endpoint }), { endpoint: null, reason: 'ccxray_not_found' })
  } finally {
    await close_server(server)
  }
})

test('discovers a healthy endpoint from an isolated hub file', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    if (req.url === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const home = make_temp_dir('agentflow-ccxray-home-')
  try {
    fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({ port: server.address().port, pid: process.pid }))
    assert.deepEqual(await metrics.resolve_ccxray_endpoint({
      env: { CCXRAY_HOME: home },
      probe_endpoint: false,
    }), { endpoint, reason: null })
  } finally {
    remove_temp_dir(home)
    await close_server(server)
  }
})

test('enriches stages and never substitutes stage_id for the ccxray task id', async () => {
  const queries = []
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.searchParams.get('task') !== 'TASK-FOUND') {
        res.end(JSON.stringify({ calls: 0 }))
        return
      }
      res.end(JSON.stringify({
        task: 'TASK-FOUND', calls: 2, cost_usd: 0.02, cache_hit_rate: 0.5,
        tokens: { output: 340, cache_read: 8, cache_create: 2, reasoning: 4 },
        tools: { Bash: 1 }, tool_failures: 1, skills: { test: 1 }, role: 'cross-check',
        models: [], agents: [], sessions: 1, by_role: {},
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const input = make_stage('cross-check', { task: 'TASK-FOUND', provider_tokens: { input: 7, output: 9, total: 16 } })
    const enriched = await metrics.enrich_stage_with_ccxray(input, { endpoint, project: 'ipadpos' })
    assert.equal(queries[0].searchParams.get('task'), 'TASK-FOUND')
    assert.equal(queries[0].searchParams.get('role'), 'cross-check')
    assert.equal(queries[0].searchParams.get('project'), 'ipadpos')
    assert.equal(enriched.provider_tokens.input, 7)
    assert.equal(enriched.provider_tokens.output, 340)
    assert.equal(enriched.provider_tokens.cache, 10)
    assert.equal(enriched.provider_calls, 2)
    assert.equal(enriched.telemetry_source, 'ccxray')

    const no_task = await metrics.enrich_stage_with_ccxray(make_stage('stage-only'), { endpoint })
    assert.equal(no_task.provider_tokens.total, 'unavailable')
    assert.equal(queries.length, 1)
  } finally {
    await close_server(server)
  }
})

test('enriches work items with one return contract for off, auto, and ccxray modes', async () => {
  const queries = []
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ task: 'WORK-001', calls: 1, tokens: { input: 1, output: 2, total: 3 }, models: [], agents: [], sessions: 1, by_role: {} }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const input = make_work_item({ task_id: 'WORK-001', project: 'ipadpos', stages: [make_stage('cross-check', { role: 'implementation' })] })
    const off = await metrics.enrich_work_item_with_ccxray(input, { metrics: 'off', endpoint })
    assert.equal(off.telemetry.status, 'off')
    assert.equal(off.telemetry.reason, null)
    assert.equal(off.work_item.stages[0].provider_tokens.total, 'unavailable')

    const auto = await metrics.enrich_work_item_with_ccxray(input, { metrics: 'auto', endpoint, project: 'ipadpos' })
    assert.equal(auto.telemetry.status, 'active')
    assert.equal(auto.work_item.stages[0].provider_calls, 1)
    assert.equal(queries[0].searchParams.get('role'), 'implementation')

    const strict = await metrics.enrich_work_item_with_ccxray(input, { metrics: 'ccxray', endpoint })
    assert.equal(strict.telemetry.status, 'active')
    assert.equal(strict.telemetry.guidance, null)
  } finally {
    await close_server(server)
  }
})

test('ccxray mode returns guidance without changing a work item when the endpoint is too old or missing', async () => {
  const input = make_work_item({ task_id: 'WORK-001' })
  const missing = await metrics.enrich_work_item_with_ccxray(input, {
    metrics: 'ccxray',
    ccxray_endpoint: 'http://127.0.0.1:1',
  })
  assert.equal(missing.telemetry.status, 'unavailable')
  assert.equal(missing.telemetry.reason, 'ccxray_not_found')
  assert.match(missing.telemetry.guidance, /npm install -g ccxray/)
  assert.equal(missing.work_item.stages[0].telemetry_source, undefined)

  const { server, endpoint } = await start_server((req, res) => {
    if (req.url === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: [] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const too_old = await metrics.enrich_work_item_with_ccxray(input, { metrics: 'ccxray', endpoint })
    assert.equal(too_old.telemetry.reason, 'ccxray_too_old')
    assert.match(too_old.telemetry.guidance, /ccxray@latest/)
  } finally {
    await close_server(server)
  }
})

test('runs workers normally with off telemetry and reports optional ccxray unavailability', async () => {
  const source = make_source_repo()
  const disposable = make_temp_dir('agentflow-ccxray-runner-')
  const worker = path.join(disposable, 'fake-worker.js')
  fs.writeFileSync(worker, "process.stdout.write(process.env.CCXRAY_TASK || '')\n")
  const base = {
    source_directory: source,
    clone_directory: path.join(disposable, 'clone'),
    command: [process.execPath, worker],
    timeout_ms: 2_000,
    termination_grace_ms: 100,
    max_output_bytes: 4_096,
    env: {},
  }
  try {
    const off = await runner.run_external_command(base)
    assert.equal(off.telemetry.status, 'off')
    assert.equal(off.result.value, '')

    const home = make_temp_dir('agentflow-ccxray-empty-home-')
    try {
      const unavailable = await runner.run_external_command({
        ...base,
        clone_directory: path.join(disposable, 'strict-clone'),
        task: 'A-012',
        role: 'implementation',
        project: 'agentflow',
        metrics: 'ccxray',
        ccxray_endpoint: 'http://127.0.0.1:1',
        env: { CCXRAY_HOME: home },
      })
      assert.equal(unavailable.telemetry.status, 'unavailable')
      assert.equal(unavailable.telemetry.reason, 'ccxray_not_found')
      assert.equal(unavailable.result.value, '')
      assert.match(unavailable.telemetry.guidance, /ccxray/)
    } finally {
      remove_temp_dir(home)
    }
  } finally {
    remove_temp_dir(source)
    remove_temp_dir(disposable)
  }
})

test('unreadable telemetry configuration never prevents the worker from running', async () => {
  const source = make_source_repo()
  const disposable = make_temp_dir('agentflow-ccxray-config-')
  const worker = path.join(disposable, 'fake-worker.js')
  const invalid_config = path.join(disposable, 'invalid-ag.json')
  fs.writeFileSync(worker, "process.stdout.write('worker ran')")
  fs.writeFileSync(invalid_config, 'not json')
  const base = {
    source_directory: source,
    command: [process.execPath, worker],
    timeout_ms: 2_000,
    termination_grace_ms: 100,
    max_output_bytes: 4_096,
    env: {},
    task: 'A-012',
    role: 'cross-check',
    project: 'agentflow',
  }
  try {
    for (const [index, config_path] of [
      path.join(disposable, 'missing-ag.json'),
      invalid_config,
    ].entries()) {
      const result = await runner.run_external_command({
        ...base,
        clone_directory: path.join(disposable, `clone-${index}`),
        config_path,
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.exit_code, 0)
      assert.equal(result.telemetry.status, 'off')
      assert.equal(result.telemetry.reason, 'config_unreadable')
      assert.equal(result.result.value, 'worker ran')
    }
  } finally {
    remove_temp_dir(source)
    remove_temp_dir(disposable)
  }
})

test('unexpected telemetry errors leave the worker un-injected and running', async () => {
  const source = make_source_repo()
  const disposable = make_temp_dir('agentflow-ccxray-error-')
  const worker = path.join(disposable, 'fake-worker.js')
  fs.writeFileSync(worker, "process.stdout.write(process.env.CCXRAY_TASK || 'no-injection')")
  const bad_task = { toString: () => { throw new Error('bad telemetry value') } }
  try {
    const result = await runner.run_external_command({
      source_directory: source,
      clone_directory: path.join(disposable, 'clone'),
      command: [process.execPath, worker],
      timeout_ms: 2_000,
      termination_grace_ms: 100,
      max_output_bytes: 4_096,
      env: {},
      task: bad_task,
      metrics: 'auto',
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.exit_code, 0)
    assert.equal(result.telemetry.status, 'unavailable')
    assert.equal(result.telemetry.reason, 'telemetry_error')
    assert.equal(result.result.value, 'no-injection')
  } finally {
    remove_temp_dir(source)
    remove_temp_dir(disposable)
  }
})

test('settings warns only when required ccxray is not installed', () => {
  const config = settings.make_template('codex')
  config.switches.metrics = 'ccxray'
  // An empty CCXRAY_HOME keeps the hub-lockfile probe off the developer's real ~/.ccxray.
  const empty_home = make_temp_dir('ccxray-settings-home-')
  try {
    const no_ccxray = { CCXRAY_HOME: empty_home }
    const missing = settings.validate_config(config, { active_host: 'codex', executables: ['codex', 'claude'], env: no_ccxray })
    assert.deepEqual(missing.warnings, ['warning: metrics=ccxray but the ccxray executable is not installed; run: npm install -g ccxray (or set metrics: auto)'])

    const available = settings.validate_config(config, { active_host: 'codex', executables: ['codex', 'claude', 'ccxray'], env: no_ccxray })
    assert.equal(available.warnings.some(warning => warning.includes('metrics=ccxray')), false)

    // Found by a live run: ccxray started through npx is never on PATH. A declared
    // endpoint, or a live hub lockfile, means one is in use — no install warning.
    const declared = settings.validate_config(config, { active_host: 'codex', executables: ['codex', 'claude'], env: { ...no_ccxray, CCXRAY_ENDPOINT: 'http://127.0.0.1:5612' } })
    assert.equal(declared.warnings.some(warning => warning.includes('metrics=ccxray')), false)
    fs.writeFileSync(path.join(empty_home, 'hub.json'), JSON.stringify({ port: 5577, pid: process.pid }))
    const live_hub = settings.validate_config(config, { active_host: 'codex', executables: ['codex', 'claude'], env: no_ccxray })
    assert.equal(live_hub.warnings.some(warning => warning.includes('metrics=ccxray')), false)
    fs.unlinkSync(path.join(empty_home, 'hub.json'))

    config.switches.metrics = 'auto'
    const optional = settings.validate_config(config, { active_host: 'codex', executables: ['codex', 'claude'], env: no_ccxray })
    assert.equal(optional.warnings.some(warning => warning.includes('metrics=ccxray')), false)
  } finally {
    remove_temp_dir(empty_home)
  }
})
