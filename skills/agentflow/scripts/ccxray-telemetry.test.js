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
const { live_summary_fixture, live_mixed_summary_fixture, live_open_mixed_summary_fixture } = require('./ccxray-test-fixtures.js')

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
const run_metrics_file = (file, args, env = {}) => new Promise((resolve, reject) => {
  const child = child_process.spawn(process.execPath, [file, ...args], {
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

const summary_request = url => ({
  task: url.searchParams.get('task'),
  project: url.searchParams.get('project'),
  role: url.searchParams.get('role'),
  session_specs: url.searchParams.getAll('session'),
  from: url.searchParams.has('from') ? Number(url.searchParams.get('from')) : null,
  to: url.searchParams.has('to') ? Number(url.searchParams.get('to')) : null,
  window_requested: url.searchParams.has('from') || url.searchParams.has('to'),
})

const start_server = (handler, { validate_summary_bodies = false } = {}) => new Promise((resolve, reject) => {
  const summary_bodies = []
  const server = http.createServer((req, res) => {
    if (!validate_summary_bodies) return handler(req, res)
    const url = new URL(req.url, `http://${req.headers.host}`)
    let response_body = ''
    const append = chunk => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return
      response_body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
    }
    const write = res.write.bind(res)
    res.write = (...args) => {
      append(args[0])
      return write(...args)
    }
    const end = res.end.bind(res)
    res.end = (...args) => {
      append(args[0])
      if (url.pathname === '/_api/task-summary' && res.statusCode === 200 && response_body !== '') summary_bodies.push({ url: `${url.pathname}${url.search}`, request: { ...summary_request(url), received_ms: Date.now() }, body: JSON.parse(response_body) })
      return end(...args)
    }
    return handler(req, res)
  })
  server.summary_bodies = summary_bodies
  server.validate_summary_bodies = validate_summary_bodies
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject)
    resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` })
  })
})

const start_validated_server = handler => start_server(handler, { validate_summary_bodies: true })

const close_server = server => new Promise((resolve, reject) => {
  try {
    if (server.validate_summary_bodies) {
      for (const served of server.summary_bodies) {
        assert.equal(metrics.validate_ccxray_summary_body(served.body), null, `invalid success-path mock body at ${served.url}`)
        assert.equal(metrics.check_ccxray_invariants(served.body, served.request), null, `invariant-invalid success-path mock body at ${served.url}`)
      }
    }
  } catch (error) {
    reject(error)
    return
  }
  server.close(error => error ? reject(error) : resolve())
})

test('live summary fixtures match the strict ccxray body validator', () => {
  const fixtures = [
    [live_summary_fixture({ role: null, by_role: { review: live_summary_fixture().by_role.review } }), {}],
    [live_summary_fixture({ role: 'review' }), { selected: { role: 'review' } }],
    [live_summary_fixture({ role: 'coordinator', by_role: { coordinator: live_summary_fixture({ role: 'coordinator' }).by_role.coordinator }, coordinator: true }), { selected: { role: 'coordinator', session: 'host@100-200' } }],
    [live_summary_fixture({ calls: 0, cost_usd: 0, role: 'review', window: { from: 0, to: 1 } }), { selected: { role: 'review' } }],
  ]
  for (const [body, options] of fixtures) assert.equal(metrics.validate_ccxray_summary_body(body, options), null)
  assert.deepEqual(live_summary_fixture({ from: '100', to: '200' }).window, { from: 100, to: 200 })
  assert.equal(live_summary_fixture().window, null)
})

test('real live-shaped bodies for labelled, role, coordinator, and window queries pass all invariants', () => {
  const live_shapes_path = '/private/tmp/claude-501/-Users-justinlee-dev/3d5f0785-1b90-4c88-b1f9-63d4117b18b5/scratchpad/verify/run9/live-shapes.json'
  const live_shapes = fs.existsSync(live_shapes_path)
    ? JSON.parse(fs.readFileSync(live_shapes_path, 'utf8'))
    : {
      labelled: { url: 'http://127.0.0.1/_api/task-summary?task=A-001&project=p', body: live_summary_fixture({ request: { role: null, session_specs: [], from: null, to: null, window_requested: false }, role: null }) },
      role: { url: 'http://127.0.0.1/_api/task-summary?task=A-001&role=review', body: live_summary_fixture({ request: { role: 'review', session_specs: [], from: null, to: null, window_requested: false }, role: 'review' }) },
      coordinator: { url: 'http://127.0.0.1/_api/task-summary?task=A-001&role=coordinator&session=host%40100-200', body: live_summary_fixture({ request: { role: 'coordinator', session_specs: ['host@100-200'], from: null, to: null, window_requested: false }, role: 'coordinator', coordinator: true }) },
      window: { url: 'http://127.0.0.1/_api/task-summary?task=A-001&role=review&from=0&to=1', body: live_summary_fixture({ request: { role: 'review', session_specs: [], from: 0, to: 1, window_requested: true }, role: 'review' }) },
    }
  for (const name of ['codex-labelled', 'codex-role', 'codex-coordinator', 'codex-window']) {
    const shape = live_shapes[name] || live_shapes[name.replace('codex-', '')]
    const request = summary_request(new URL(shape.url))
    assert.equal(metrics.validate_ccxray_summary_body(shape.body), null, `${name} shape`)
    assert.equal(metrics.check_ccxray_invariants(shape.body, request), null, `${name} invariants`)
  }
})

test('request-aware success mocks serve bodies that pass shape and invariant checks', async () => {
  const paths = [
    '/_api/task-summary?task=A-011&project=p',
    '/_api/task-summary?task=A-011&project=p&role=review',
    '/_api/task-summary?task=A-011&role=coordinator&session=host%40100-200',
    '/_api/task-summary?task=A-011&project=p&role=review&from=0&to=1',
  ]
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== '/_api/task-summary') {
      res.writeHead(404)
      res.end()
      return
    }
    const request = summary_request(url)
    const coordinator = request.session_specs.length > 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(live_summary_fixture({
      request,
      task: 'A-011',
      role: request.role,
      calls: 1,
      cost_usd: 0.1,
      coordinator,
    })))
  })
  try {
    for (const request_path of paths) {
      const response = await fetch(`${endpoint}${request_path}`)
      assert.equal(response.status, 200)
      await response.json()
    }
    assert.equal(server.summary_bodies.length, paths.length)
    for (const served of server.summary_bodies) {
      assert.equal(metrics.validate_ccxray_summary_body(served.body), null)
      assert.equal(metrics.check_ccxray_invariants(served.body, served.request), null)
    }
  } finally {
    await close_server(server)
  }
})

test('round-11 named consumer trust cases reject contradictions and project only whitelisted fields', () => {
  const review_request = { role: 'review', session_specs: [], from: null, to: null, window_requested: false }
  const coordinator_request = { role: 'coordinator', session_specs: ['host@100-200'], from: null, to: null, window_requested: false }
  const review_body = () => live_summary_fixture({ request: review_request, role: 'review', calls: 1, cost_usd: 0.1 })
  const coordinator_body = () => live_summary_fixture({ request: coordinator_request, role: 'coordinator', calls: 1, cost_usd: 0.1, coordinator: true })
  const nested_object = depth => {
    const root = {}
    let current = root
    for (let index = 0; index < depth; index += 1) {
      current.child = {}
      current = current.child
    }
    return root
  }
  const expected_invariant = (name, body, request, invariant) => {
    const result = metrics.check_ccxray_invariants(body, request)
    assert.match(result, new RegExp(`^invariant ${invariant} violated:`), name)
  }

  const contradictions = [
    ['coordinatorMissingZero', () => { const body = coordinator_body(); delete body.coordinator; return [body, coordinator_request, 'I1'] }],
    ['roleMissing', () => { const body = review_body(); delete body.by_role.review; return [body, review_request, 'I1'] }],
    ['coordinatorWrongSession', () => { const body = coordinator_body(); body.coordinator.sessions[0].session = 'other'; return [body, coordinator_request, 'I2'] }],
    ['coordinatorWrongInterval', () => { const body = coordinator_body(); body.coordinator.sessions[0].from = 101; return [body, coordinator_request, 'I2'] }],
    ['coordinatorSessionsString', () => { const body = coordinator_body(); body.coordinator.sessions = 'bad'; return [body, coordinator_request, 'I2'] }],
    ['coordinatorCallsInflated', () => { const body = coordinator_body(); body.coordinator.calls = 999; return [body, coordinator_request, 'I3'] }],
    ['selectedCallsZero', () => { const body = review_body(); body.by_role.review.calls = 0; return [body, review_request, 'I3'] }],
    ['selectedCallsInflated', () => { const body = review_body(); body.by_role.review.calls = 999; return [body, review_request, 'I3'] }],
    ['chargeFallbackCounterZero', () => { const body = review_body(); body.charges[0].basis = 'fallback'; return [body, review_request, 'I5'] }],
    ['zeroQuantity', () => { const body = review_body(); body.charges[0].quantity = '0'; return [body, review_request, 'I5'] }],
    ['zeroQuantityConsistent', () => { const body = review_body(); body.charges[0].quantity = '0'; body.by_role.review.charges[0].quantity = '0'; return [body, review_request, 'I5'] }],
  ]
  for (const [name, make_case] of contradictions) {
    const [body, request, invariant] = make_case()
    assert.equal(metrics.validate_ccxray_summary_body(body), null, `${name} shape`)
    expected_invariant(name, body, request, invariant)
  }

  const deep_cases = [
    ['deepExtra', body => { body.extra = nested_object(9) }],
    ['deepSelectedExtra', body => { body.by_role.review.extra = nested_object(9) }],
    ['deepCoverage', body => { body.coverage = 'bad' }],
    ['deepWindow', body => { body.window = 'bad' }],
    ['deepCoverageObject', body => { body.coverage = { entries_in_memory: 1, max_entries: 2, extra: nested_object(8) } }],
    ['deepWindowObject', body => { body.window = { from: 0, to: 1, extra: nested_object(8) } }],
  ]
  for (const [name, mutate] of deep_cases) {
    const body = review_body()
    mutate(body)
    if (name === 'deepCoverage' || name === 'deepWindow') {
      assert.equal(metrics.validate_ccxray_summary_body(body), null, `${name} shape`)
      expected_invariant(name, body, review_request, 'I6')
    } else {
      assert.notEqual(metrics.validate_ccxray_summary_body(body), null, `${name} must fail validation`)
    }
  }

  for (const name of ['aliasesTop', 'aliasesSelected', 'aliasesCharge', 'aliasesConfidence', 'aliasesCoordinator', 'protoExtras', 'metadataExtras', 'hugeValidExtra']) {
    const coordinator_case = name === 'aliasesCoordinator'
    const body = coordinator_case ? coordinator_body() : review_body()
    if (name === 'aliasesTop' || name === 'hugeValidExtra') body.extra = name === 'hugeValidExtra' ? 'X'.repeat(2 * 1024 * 1024) : { injected: true }
    if (name === 'aliasesSelected') body.by_role.review.extra = { injected: true }
    if (name === 'aliasesCharge') body.charges[0].extra = { injected: true }
    if (name === 'aliasesConfidence') body.cost_confidence.extra = { injected: true }
    if (name === 'aliasesCoordinator') body.coordinator.extra = { injected: true }
    if (name === 'protoExtras') {
      for (const key of ['__proto__', 'constructor', 'toString']) {
        Object.defineProperty(body, key, { value: { injected: true }, enumerable: true, configurable: true })
        Object.defineProperty(body.by_role.review, key, { value: { injected: true }, enumerable: true, configurable: true })
        Object.defineProperty(body.charges[0], key, { value: { injected: true }, enumerable: true, configurable: true })
        Object.defineProperty(body.cost_confidence, key, { value: { injected: true }, enumerable: true, configurable: true })
      }
    }
    if (name === 'metadataExtras') {
      body.window = { from: 0, to: 1, summary: { secret: 'drop' } }
      body.coverage = { entries_in_memory: 1, max_entries: 2, credentials: { token: 'drop' } }
    }
    assert.equal(metrics.validate_ccxray_summary_body(body), null, `${name} shape`)
    const request = name === 'metadataExtras' ? { role: 'review', session_specs: [], from: 0, to: 1, window_requested: true } : coordinator_case ? coordinator_request : review_request
    assert.equal(metrics.check_ccxray_invariants(body, request), null, `${name} invariants`)
    const projected = metrics.project_ccxray_summary(body)
    assert.equal(Object.hasOwn(projected, 'extra'), false, `${name} top projection`)
    const projected_selected = coordinator_case ? projected.coordinator : projected.by_role.review
    assert.equal(Object.hasOwn(projected_selected, 'extra'), false, `${name} selected projection`)
    assert.deepEqual(projected.window, body.window === null ? null : { from: body.window.from, to: body.window.to })
    assert.deepEqual(projected.coverage, body.coverage === null ? null : { entries_in_memory: body.coverage.entries_in_memory, max_entries: body.coverage.max_entries })
  }

  const prototype_roles = Object.create(null)
  for (const role of ['__proto__', 'constructor', 'toString']) {
    Object.defineProperty(prototype_roles, role, {
      value: live_summary_fixture({ role, calls: 1, cost_usd: 0.1 }).by_role[role],
      enumerable: true,
      configurable: true,
    })
  }
  const prototype_body = live_summary_fixture({
    request: { role: null, session_specs: [], from: null, to: null, window_requested: false },
    role: null,
    calls: 3,
    cost_usd: 0.3,
    by_role: prototype_roles,
  })
  assert.equal(metrics.check_ccxray_invariants(prototype_body, { role: null }), null)
  const projected = metrics.project_ccxray_summary(prototype_body)
  for (const role of ['__proto__', 'constructor', 'toString']) {
    assert.equal(Object.hasOwn(projected.by_role, role), true)
    assert.equal(projected.by_role[role].requests, 1)
  }

  const duplicate_roles = ['Review', 'review', 'réview', 'réview']
  const duplicate_receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-ROUND-11',
    project: 'p',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: duplicate_roles.map((role, index) => ({
      id: `attempt-${index + 1}`,
      role,
      attempt: index + 1,
      selector: { start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' },
    })),
    summaries: duplicate_roles.map((role, index) => ({
      scope_id: `attempt-${index + 1}`,
      ...live_summary_fixture({ role, calls: 1, cost_usd: 0.1 + index / 10 }).by_role[role],
    })),
  })
  const duplicate_lines = metrics.format_ccxray_devlog_lines(duplicate_receipt)
  for (const role of duplicate_roles) assert.equal(duplicate_lines.some(line => line.includes(`- ${role}:`)), true, role)
})

test('I9-I11 reject identity, filtered-summary, and exact-charge contradictions', () => {
  const request = {
    task: 'A-ROUND-12',
    project: 'project-12',
    role: 'review',
    session_specs: [],
    from: null,
    to: null,
    window_requested: false,
  }
  const make_body = () => live_summary_fixture({ request, task: 'A-ROUND-12', project: 'project-12', role: 'review', calls: 1, cost_usd: 0.1 })
  const expect_invariant = (body, invariant) => {
    assert.equal(metrics.validate_ccxray_summary_body(body), null)
    assert.match(metrics.check_ccxray_invariants(body, request), new RegExp(`^invariant ${invariant} violated:`))
  }

  const wrong_identity = make_body()
  wrong_identity.task = 'OTHER-TASK'
  expect_invariant(wrong_identity, 'I9')

  const wrong_confidence = make_body()
  wrong_confidence.by_role.review.cost_confidence = { priced: 0, unknown: 1, fallback: 0, no_usage: 0 }
  expect_invariant(wrong_confidence, 'I10')

  const wrong_buckets = make_body()
  wrong_buckets.by_role.review.charges = [{ ...wrong_buckets.by_role.review.charges[0], quantity: '2000000', usd: '0.2' }]
  expect_invariant(wrong_buckets, 'I10')

  const wrong_usd = make_body()
  wrong_usd.charges[0].usd = '0.100001'
  expect_invariant(wrong_usd, 'I11')

  assert.equal(metrics.check_ccxray_invariants(make_body(), request), null)
  const no_project = { ...request, project: null, role: null }
  assert.equal(metrics.check_ccxray_invariants(live_summary_fixture({ request: no_project, task: 'A-ROUND-12', project: null, role: null }), no_project), null)
})

test('I12 rejects filtered counter disagreement and treats omitted zero counters as equal', () => {
  const request = { task: 'A-I12', project: 'p', role: 'review', session_specs: [], from: null, to: null, window_requested: false }
  const make_body = () => live_summary_fixture({ request, task: 'A-I12', project: 'p', role: 'review', calls: 1, cost_usd: 0.1 })
  const wrapper_uncomputable = make_body()
  wrapper_uncomputable.uncomputable_requests = 1
  assert.match(metrics.check_ccxray_invariants(wrapper_uncomputable, request), /^invariant I12 violated:/u)

  const selected_pending = make_body()
  selected_pending.by_role.review.pending_requests = 1
  assert.match(metrics.check_ccxray_invariants(selected_pending, request), /^invariant I12 violated:/u)

  const omitted_selected = make_body()
  delete omitted_selected.by_role.review.uncomputable_requests
  assert.equal(metrics.check_ccxray_invariants(omitted_selected, request), null)
  const omitted_wrapper = make_body()
  delete omitted_wrapper.pending_requests
  assert.equal(metrics.check_ccxray_invariants(omitted_wrapper, request), null)
})

test('mixed session queries use wrapper union invariants and preserve validated session entries', () => {
  const mixed_request = { task: 'A-MIXED', project: 'p', role: null, session_specs: ['host@100-200'], from: null, to: null, window_requested: false }
  const mixed_body = live_mixed_summary_fixture({ request: mixed_request })
  assert.equal(metrics.validate_ccxray_summary_body(mixed_body), null)
  assert.equal(metrics.check_ccxray_invariants(mixed_body, mixed_request), null)
  assert.equal(mixed_body.calls, 2)
  assert.equal(mixed_body.cost_usd, 0.3)
  assert.deepEqual(Object.keys(mixed_body.by_role).sort(), ['coordinator', 'review'])

  const mixed_mismatch = JSON.parse(JSON.stringify(mixed_body))
  mixed_mismatch.by_role.review.calls = 2
  assert.match(metrics.check_ccxray_invariants(mixed_mismatch, mixed_request), /^invariant I3 violated:/u)

  const filtered_request = { ...mixed_request, role: 'coordinator' }
  const filtered_body = live_summary_fixture({ request: filtered_request, role: 'coordinator', calls: 2, cost_usd: 0.3, coordinator: true, session_calls: 2 })
  filtered_body.coordinator.calls = 1
  filtered_body.coordinator.sessions[0].calls = 1
  assert.match(metrics.check_ccxray_invariants(filtered_body, filtered_request), /^invariant I3 violated:/u)

  const inflated_session_calls = JSON.parse(JSON.stringify(mixed_body))
  inflated_session_calls.coordinator.sessions[0].calls = 999
  assert.match(metrics.check_ccxray_invariants(inflated_session_calls, mixed_request), /^invariant I13 violated:/u)

  const missing_session_calls = JSON.parse(JSON.stringify(mixed_body))
  delete missing_session_calls.coordinator.sessions[0].calls
  assert.match(metrics.check_ccxray_invariants(missing_session_calls, mixed_request), /^invariant I13 violated:/u)

  const two_entry_request = { ...mixed_request, session_specs: ['host@100-200', 'host@300-400'] }
  const two_entry_body = live_mixed_summary_fixture({ request: two_entry_request, coordinator_calls: 2 })
  assert.equal(metrics.check_ccxray_invariants(two_entry_body, two_entry_request), null)
  assert.deepEqual(two_entry_body.coordinator.sessions.map(session => [session.session, session.from, session.to, session.calls]), [
    ['host', 100, 200, 2],
    ['host', 300, 400, 2],
  ])
})

test('I2 accepts bounded echoed ends only for open session specs', () => {
  const received_ms = 2_000
  const open_request = { task: 'A-I2-OPEN', project: 'p', role: null, session_specs: ['host@100-'], received_ms }
  const open_body = live_mixed_summary_fixture({ request: open_request })
  open_body.coordinator.sessions[0].to = received_ms - 5
  assert.equal(metrics.check_ccxray_invariants(open_body, open_request), null)

  for (const echoed_to of [99, received_ms + 60_001, received_ms - 5.5, String(received_ms - 5)]) {
    const invalid_body = JSON.parse(JSON.stringify(open_body))
    invalid_body.coordinator.sessions[0].to = echoed_to
    assert.match(metrics.check_ccxray_invariants(invalid_body, open_request), /^invariant I2 violated:/u)
  }

  const closed_request = { task: 'A-I2-CLOSED', project: 'p', role: null, session_specs: ['host@100-200'], received_ms }
  const closed_body = live_mixed_summary_fixture({ request: closed_request })
  closed_body.coordinator.sessions[0].to = 201
  assert.match(metrics.check_ccxray_invariants(closed_body, closed_request), /^invariant I2 violated:/u)
})

test('conversionTokens remains a failed scope conversion rather than trusted output', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    const body = live_summary_fixture({ request: summary_request(url), role: 'review', calls: 1, cost_usd: 0.1 })
    body.tokens.cache_read = { toString: {} }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  try {
    await assert.rejects(
      metrics.fetch_ccxray_metrics('A-ROUND-11', { endpoint, role: 'review', from_ms: 0, to_ms: 1 }),
      /Cannot convert object to primitive value/u,
    )
  } finally {
    await close_server(server)
  }
})

test('detects the host session id with current and legacy environment names', () => {
  assert.deepEqual(metrics.host_session({ CODEX_THREAD_ID: 'thread', CODEX_SESSION_ID: 'session' }), { host: 'codex', session_id: 'thread' })
  assert.deepEqual(metrics.host_session({ CODEX_SESSION_ID: 'session' }), { host: 'codex', session_id: 'session' })
  assert.deepEqual(metrics.host_session({ CLAUDE_CODE_SESSION_ID: 'current' }), { host: 'claude', session_id: 'current' })
  assert.deepEqual(metrics.host_session({ CLAUDE_SESSION_ID: 'legacy' }), { host: 'claude', session_id: 'legacy' })
  assert.deepEqual(metrics.host_session({ CODEX_SESSION_ID: 'codex', CLAUDE_CODE_SESSION_ID: 'claude' }), { host: 'codex', session_id: 'codex' })
  assert.deepEqual(metrics.host_session({}), { host: null, session_id: null })
})

test('records host touches only for ccxray modes and never throws on an unusable log path', () => {
  const directory = make_temp_dir('agentflow-host-touch-')
  const config = { switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }
  const environment = { CODEX_THREAD_ID: 'codex-session' }
  fs.writeFileSync(path.join(directory, 'ag.json'), JSON.stringify(config))
  try {
    assert.equal(metrics.record_host_touch({
      repo_root: directory,
      config,
      env: environment,
      ask: 'A-012',
      event: 'start',
      ts: 1000,
    }), true)
    assert.equal(metrics.record_host_touch({
      repo_root: directory,
      config,
      env: { CLAUDE_CODE_SESSION_ID: 'claude-session' },
      ask: 'A-012',
      event: 'append-run',
      ts: 2000,
    }), true)
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    assert.deepEqual(fs.readFileSync(log_path, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
      { ask: 'A-012', session_id: 'codex-session', host: 'codex', ts: 1000, event: 'start' },
      { ask: 'A-012', session_id: 'claude-session', host: 'claude', ts: 2000, event: 'append-run' },
    ])

    assert.equal(metrics.record_host_touch({
      repo_root: directory,
      config: { switches: { metrics: 'off', 'workspace-dir': '.agentflow-off' } },
      env: environment,
      ask: 'A-012',
      event: 'start',
      ts: 3000,
    }), false)

    const blocked = path.join(directory, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    assert.doesNotThrow(() => metrics.record_host_touch({
      repo_root: directory,
      config: { switches: { metrics: 'ccxray', 'workspace-dir': 'blocked' } },
      env: environment,
      ask: 'A-012',
      event: 'close',
      ts: 4000,
    }))
  } finally {
    remove_temp_dir(directory)
  }
})

test('records worker project labels and carries them into worker scopes and gaps', () => {
  const directory = make_temp_dir('agentflow-host-touch-project-')
  const config = { switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }
  fs.writeFileSync(path.join(directory, 'ag.json'), JSON.stringify(config))
  try {
    assert.equal(metrics.record_host_touch({
      repo_root: directory,
      config,
      env: { CODEX_THREAD_ID: 'worker-session' },
      ask: 'A-012',
      event: 'attempt',
      role: 'cross-check',
      project: 'slug-e2e-codex',
      attempt: 1,
      outcome: 'succeeded',
      started_ms: 100,
      ended_ms: 200,
      ts: 200,
    }), true)
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    const record = JSON.parse(fs.readFileSync(log_path, 'utf8'))
    assert.equal(record.project, 'slug-e2e-codex')
    const scopes = metrics.build_ccxray_scopes({
      ask: 'A-012', project: 'directory-project', records: [record], cutoff: 1_000, kind: 'attempt', role: 'cross-check', attempt: true,
    })
    assert.equal(scopes[0].selector.labels.project, 'slug-e2e-codex')
    const receipt = metrics.build_ccxray_receipt({
      kind: 'attempt', ask: 'A-012', project: 'directory-project', cutoff: 1_000, scopes,
      summaries: [{ scope_id: scopes[0].id, requests: 1, cost_usd: '0', charges: [] }],
    })
    assert.deepEqual(receipt.gaps.filter(gap => gap.code === 'project_label_mismatch').map(gap => gap.scope_id), [scopes[0].id])
    const mismatch_detail = receipt.gaps.find(gap => gap.code === 'project_label_mismatch').detail
    assert.equal(mismatch_detail, 'recorded project label slug-e2e-codex differs from resolved project directory-project')
    assert.doesNotMatch(mismatch_detail, /[\u0000-\u001f\u007f]/u)
  } finally {
    remove_temp_dir(directory)
  }
})

test('numbers coordinator scopes by interval start order', () => {
  const records = [
    { ask: 'A-013', session_id: 'host-1', ts: 100_000, event: 'start' },
    { ask: 'A-013', session_id: 'host-1', ts: 101_000, event: 'close' },
    { ask: 'A-013', session_id: 'host-2', ts: 300_000, event: 'start' },
  ]
  const scopes = metrics.build_ccxray_scopes({ ask: 'A-013', project: 'agentflow', records, cutoff: 500_000 })
  assert.deepEqual(scopes.map(scope => ({ id: scope.id, session: scope.selector.session_id })), [
    { id: 'coordinator#1', session: 'host-1' },
    { id: 'coordinator#2', session: 'host-2' },
  ])
})

test('derives clipped, open-ended, malformed-safe, and capped host session intervals', () => {
  const records = [
    JSON.stringify({ ask: 'A-012', session_id: 's1', ts: 1_000, event: 'start' }),
    JSON.stringify({ ask: 'A-012', session_id: 's2', ts: 1_500, event: 'start' }),
    JSON.stringify({ ask: 'A-013', session_id: 's1', ts: 3_000, event: 'start' }),
    JSON.stringify({ ask: 'A-012', session_id: 's1', ts: 2_000, event: 'close' }),
    JSON.stringify({ ask: 'A-013', session_id: 's1', ts: 5_000, event: 'close-round' }),
    JSON.stringify({ ask: 'A-012', session_id: 's2', ts: 6_000, event: 'close-round' }),
    JSON.stringify({ ask: 'A-012', session_id: 's3', ts: 7_000, event: 'start' }),
    '{malformed',
    JSON.stringify({ ask: 'A-012', session_id: 's4', ts: 'bad', event: 'start' }),
    JSON.stringify({ ask: 'A-012', session_id: 's5', ts: 9_000 }),
  ]
  // s1: A-012 closes at 2_000 and A-013 starts at 3_000; the boundary is the
  // midpoint 2_500, applied identically from both sides (no double count).
  assert.deepEqual(metrics.host_session_intervals('A-012', records, 10_000), [
    { session: 's1', from: 0, to: 2_499 },
    { session: 's2', from: 0, to: 126_000 },
    { session: 's3', from: 0, to: null },
  ])

  const many = Array.from({ length: 33 }, (_, index) => [
    JSON.stringify({ ask: 'A-012', session_id: `s${index}`, ts: 20_000 + index, event: 'start' }),
    JSON.stringify({ ask: 'A-012', session_id: `s${index}`, ts: 30_000 + index, event: 'close' }),
  ]).flat()
  const capped = metrics.host_session_intervals('A-012', many, 40_000)
  assert.equal(capped.length, 32)
  assert.equal(capped[0].session, 's1')
  assert.equal(capped.at(-1).session, 's32')

  assert.deepEqual(metrics.host_session_intervals('A-014', [
    JSON.stringify({ ask: 'A-014', session_id: 'shared', ts: 50_000, event: 'start' }),
    JSON.stringify({ ask: 'A-015', session_id: 'shared', ts: 51_000, event: 'start' }),
  ]), [{ session: 'shared', from: 0, to: 50_999 }])
})

test('builds worker attempt and coordinator scopes from the touch log and records missing scopes', () => {
  const records = [
    JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 100, event: 'start' }),
    JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 200, event: 'attempt', role: 'review', attempt: 1, outcome: 'failed', started_ms: 110, ended_ms: 150 }),
    JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 220, ended_ms: 260 }),
    JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 400, event: 'close' }),
  ]
  const scopes = metrics.build_ccxray_scopes({ ask: 'A-012', project: 'agentflow', records, cutoff: '1970-01-01T00:00:01.000Z' })
  assert.deepEqual(scopes.slice(0, 2).map(scope => ({ id: scope.id, role: scope.role, attempt: scope.attempt, outcome: scope.outcome, selector: scope.selector })), [
    { id: 'attempt-review-1', role: 'review', attempt: 1, outcome: 'failed', selector: { labels: { task: 'A-012', role: 'review', project: 'agentflow' }, start_inclusive: '1970-01-01T00:00:00.110Z', end_exclusive: '1970-01-01T00:00:00.151Z' } },
    { id: 'attempt-review-2', role: 'review', attempt: 2, outcome: 'succeeded', selector: { labels: { task: 'A-012', role: 'review', project: 'agentflow' }, start_inclusive: '1970-01-01T00:00:00.220Z', end_exclusive: '1970-01-01T00:00:00.261Z' } },
  ])
  assert.equal(scopes.some(scope => scope.role === 'coordinator' && scope.selector.session_id === 'worker-1'), true)
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative', ask: 'A-012', project: 'agentflow', cutoff: '1970-01-01T00:00:01.000Z', scopes,
    summaries: scopes.map(scope => ({ scope_id: scope.id, requests: scope.role === 'coordinator' ? 1 : scope.attempt === 1 ? 0 : 1, charges: scope.attempt === 1 ? [] : [{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' }] })),
    source: { instance_id: 'i', ccxray_version: 'v', exporter_version: 'e', query: {} },
  })
  assert.deepEqual(receipt.gaps.filter(gap => gap.code === 'missing_scope').map(gap => gap.scope_id), ['attempt-review-1'])
})

test('partitions overlapping attempts of one role and keeps an empty clipped scope', () => {
  const records = [
    JSON.stringify({ ask: 'A-CLIP', session_id: 'worker-1', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 500 }),
    JSON.stringify({ ask: 'A-CLIP', session_id: 'worker-2', ts: 200, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 200, ended_ms: 300 }),
  ]
  const scopes = metrics.build_ccxray_scopes({ ask: 'A-CLIP', project: 'agentflow', records, cutoff: 1000, kind: 'cumulative' }).filter(scope => scope.role === 'review')
  assert.deepEqual(scopes.map(scope => [scope.selector.start_inclusive, scope.selector.end_exclusive]), [
    ['1970-01-01T00:00:00.100Z', '1970-01-01T00:00:00.501Z'],
    ['1970-01-01T00:00:00.501Z', '1970-01-01T00:00:00.501Z'],
  ])

  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-CLIP',
    project: 'agentflow',
    cutoff: 1000,
    scopes,
    summaries: [
      { requests: 1, charges: [{ model: 'm', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] },
      { requests: 0, charges: [] },
    ],
  })
  assert.equal(receipt.scopes[1].requests, 0)
	assert.deepEqual(receipt.gaps.filter(gap => gap.code === 'missing_scope').map(gap => gap.scope_id), ['attempt-review-2'])
})

test('uses the all-attempt partition for cumulative and selected attempt scopes', () => {
  const records = [
    { ask: 'A-PARTITION', session_id: 'worker', ts: 199, event: 'attempt', role: 'review', attempt: 1, outcome: 'failed', started_ms: 100, ended_ms: 199 },
    { ask: 'A-PARTITION', session_id: 'worker', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 199, ended_ms: 300 },
  ]
  const options = { ask: 'A-PARTITION', project: 'agentflow', role: 'review', records, cutoff: 1000 }
  const cumulative = metrics.build_ccxray_scopes({ ...options, kind: 'cumulative' }).filter(scope => scope.role === 'review')
  const attempt_one = metrics.build_ccxray_scopes({ ...options, kind: 'attempt', attempt: 1 })
  const attempt_two = metrics.build_ccxray_scopes({ ...options, kind: 'attempt', attempt: 2 })

  assert.deepEqual(attempt_one.map(scope => scope.selector), [cumulative[0].selector])
  assert.deepEqual(attempt_two.map(scope => scope.selector), [cumulative[1].selector])
  assert.deepEqual(cumulative.map(scope => [scope.selector.start_inclusive, scope.selector.end_exclusive]), [
    ['1970-01-01T00:00:00.100Z', '1970-01-01T00:00:00.200Z'],
    ['1970-01-01T00:00:00.200Z', '1970-01-01T00:00:00.301Z'],
  ])

  const charge = { model: 'm', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }
  const first_receipt = metrics.build_ccxray_receipt({
    kind: 'attempt', ask: 'A-PARTITION', project: 'agentflow', cutoff: 1000, scopes: attempt_one,
    summaries: [{ requests: 1, cost_usd: '0.1', charges: [charge] }],
  })
  const second_receipt = metrics.build_ccxray_receipt({
    kind: 'attempt', ask: 'A-PARTITION', project: 'agentflow', cutoff: 1000, scopes: attempt_two,
    summaries: [{ requests: 0, cost_usd: '0', charges: [] }],
  })
  assert.match(metrics.format_ccxray_devlog_lines(first_receipt)[0], /USD 0\.1000 · 1 requests/u)
  assert.match(metrics.format_ccxray_devlog_lines(second_receipt)[0], /USD unknown · 0 requests/u)
  assert.equal(second_receipt.gaps.some(gap => gap.code === 'missing_scope'), true)
})

test('partitions worker attempts by role and recorded project', () => {
  const records = [
    { ask: 'A-PROJECT', session_id: 'worker-1', ts: 300, event: 'attempt', role: 'review', project: 'p', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 300 },
    { ask: 'A-PROJECT', session_id: 'worker-2', ts: 300, event: 'attempt', role: 'review', project: 'p2', attempt: 2, outcome: 'succeeded', started_ms: 100, ended_ms: 300 },
  ]
  const scopes = metrics.build_ccxray_scopes({ ask: 'A-PROJECT', project: 'p', records, cutoff: 1000, kind: 'cumulative' }).filter(scope => scope.role === 'review')
  assert.deepEqual(scopes.map(scope => scope.selector.labels.project), ['p', 'p2'])
  assert.deepEqual(scopes.map(scope => [scope.selector.start_inclusive, scope.selector.end_exclusive]), [
    ['1970-01-01T00:00:00.100Z', '1970-01-01T00:00:00.301Z'],
    ['1970-01-01T00:00:00.100Z', '1970-01-01T00:00:00.301Z'],
  ])
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative', ask: 'A-PROJECT', project: 'p', cutoff: 1000, scopes,
    summaries: [
      { requests: 1, cost_usd: '0.1', charges: [{ model: 'm1', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] },
      { requests: 1, cost_usd: '0.2', charges: [{ model: 'm2', component: 'input', quantity: '1000000', usd_per_unit: '0.2', basis: 'recorded' }] },
    ],
  })
  assert.equal(receipt.scopes.reduce((total, scope) => total + scope.requests, 0), 2)
  assert.equal(receipt.gaps.some(gap => gap.code === 'missing_scope'), false)
  assert.match(metrics.format_ccxray_devlog_lines(receipt)[0], /USD 0\.3000 · 2 requests/u)
})

test('keeps distinct role scope ids and matches summaries by array index', () => {
  const scopes = metrics.build_ccxray_scopes({
    ask: 'A-COLLISION',
    project: 'agentflow',
    kind: 'cumulative',
    records: [
      JSON.stringify({ ask: 'A-COLLISION', session_id: 's1', ts: 100, event: 'attempt', role: 'a/b', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }),
      JSON.stringify({ ask: 'A-COLLISION', session_id: 's2', ts: 300, event: 'attempt', role: 'a-b', attempt: 1, outcome: 'succeeded', started_ms: 300, ended_ms: 400 }),
    ],
    cutoff: 1000,
  }).filter(scope => scope.role !== 'coordinator')
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-COLLISION',
    project: 'agentflow',
    cutoff: 1000,
    scopes,
    summaries: [
      { requests: 1, cost_usd: '0.1', models: ['one'], charges: [{ model: 'bucket-one', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] },
      { requests: 1, cost_usd: '0.2', models: ['two'], charges: [{ model: 'bucket-two', component: 'input', quantity: '1000000', usd_per_unit: '0.2', basis: 'recorded' }] },
    ],
  })
  assert.deepEqual(receipt.scopes.map(scope => scope.id), ['attempt-a-b-1', 'attempt-a-b-1~2'])
  assert.deepEqual(receipt.scopes.map(scope => scope.known_usd), ['0.1', '0.2'])
  const lines = metrics.format_ccxray_devlog_lines(receipt)
  assert.match(lines[0], /USD 0\.3000/u)
  assert.equal(lines.some(line => line.includes('a/b: USD 0.1000')), true)
  assert.equal(lines.some(line => line.includes('a-b: USD 0.2000')), true)
  assert.equal(lines.some(line => line.includes('one') && !line.includes('bucket-one')), true)
  assert.equal(lines.some(line => line.includes('two') && !line.includes('bucket-two')), true)
})

test('receipt coordinator scopes use all host session intervals beyond the legacy cap', () => {
  const records = []
  for (let index = 0; index < 33; index += 1) {
    const start = 1_000_000 + index * 10_000
    records.push(JSON.stringify({ ask: 'A-MANY', session_id: `host-${index}`, ts: start, event: 'start' }))
    records.push(JSON.stringify({ ask: 'A-MANY', session_id: `host-${index}`, ts: start + 100, event: 'close' }))
  }
  const scopes = metrics.build_ccxray_scopes({ ask: 'A-MANY', project: 'agentflow', records, cutoff: 2_000_000, kind: 'cumulative' })
  assert.equal(scopes.filter(scope => scope.role === 'coordinator').length, 33)
})

test('two consecutive Asks in one session never share an instant', () => {
  // Found in independent review: clipping each Ask against the other's nearest
  // touch gave A `to = B.first` and B `from = A.last`, so a host request in the
  // gap between them was counted under both Asks.
  const records = [
    JSON.stringify({ ask: 'A', session_id: 's', ts: 1_000_000, event: 'start' }),
    JSON.stringify({ ask: 'A', session_id: 's', ts: 1_100_000, event: 'close' }),
    JSON.stringify({ ask: 'B', session_id: 's', ts: 1_150_000, event: 'start' }),
  ]
  const [a] = metrics.host_session_intervals('A', records, 2_000_000)
  const [b] = metrics.host_session_intervals('B', records, 2_000_000)
  assert.deepEqual(a, { session: 's', from: 820_000, to: 1_124_999 })
  assert.deepEqual(b, { session: 's', from: 1_125_000, to: null })
  const in_gap = 1_120_000
  const owners = [['A', a], ['B', b]].filter(([, interval]) => in_gap >= interval.from && (interval.to === null || in_gap <= interval.to)).map(([name]) => name)
  assert.deepEqual(owners, ['A'])
})

test('no instant in a session ever belongs to two Asks, including interleaved and long-gap sequences', () => {
  // Found in independent review: a shared boundary millisecond was owned by
  // both neighbours, and two Asks interleaved in one session had overlapping
  // first-to-last spans. Ownership is now a partition of the session timeline.
  const touch = (ask, ts, event = 'start') => JSON.stringify({ ask, session_id: 's', ts, event })
  const owners = (records, instant) => ['A', 'B'].filter(ask => metrics.host_session_intervals(ask, records, 9_000_000)
    .some(interval => instant >= interval.from && (interval.to === null || instant <= interval.to)))

  const short_gap = [touch('A', 1_000_000), touch('A', 1_100_000, 'close'), touch('B', 1_150_000), touch('B', 1_200_000, 'close')]
  assert.deepEqual(owners(short_gap, 1_124_999), ['A'])
  assert.deepEqual(owners(short_gap, 1_125_000), ['B'])

  // A gap wider than lead + tail padding belongs to nobody: the host was not
  // doing Agentflow work there.
  const long_gap = [touch('A', 1_000_000), touch('A', 1_100_000, 'close'), touch('B', 1_600_000), touch('B', 1_700_000, 'close')]
  assert.deepEqual(owners(long_gap, 1_219_999), ['A'])
  assert.deepEqual(owners(long_gap, 1_300_000), [])
  assert.deepEqual(owners(long_gap, 1_420_000), ['B'])

  // Interleaved: B interrupts A, so A hands over at B's touch with no lead for B.
  const interleaved = [touch('A', 1_000_000), touch('B', 1_100_000), touch('A', 1_200_000, 'close'), touch('B', 1_300_000, 'close')]
  assert.deepEqual(metrics.host_session_intervals('A', interleaved, 9_000_000), [
    { session: 's', from: 820_000, to: 1_099_999 },
    { session: 's', from: 1_200_000, to: 1_249_999 },
  ])
  assert.deepEqual(metrics.host_session_intervals('B', interleaved, 9_000_000), [
    { session: 's', from: 1_100_000, to: 1_199_999 },
    { session: 's', from: 1_250_000, to: 1_420_000 },
  ])
  assert.deepEqual(owners(interleaved, 1_150_000), ['B'])

  // Exhaustive: every two-Ask label/event sequence up to length 5, sampled instants.
  const labels = ['A', 'B']
  const events = ['start', 'close']
  let sequences = 0
  const walk = (prefix, depth) => {
    if (depth === 0) {
      const records = prefix.map((step, index) => touch(step[0], 1_000_000 + index * 50_000, step[1]))
      for (let instant = 700_000; instant <= 1_500_000; instant += 12_500) assert.ok(owners(records, instant).length <= 1, JSON.stringify({ prefix, instant }))
      sequences += 1
      return
    }
    for (const label of labels) for (const event of events) walk([...prefix, [label, event]], depth - 1)
  }
  for (let length = 1; length <= 5; length += 1) walk([], length)
  assert.equal(sequences, 4 + 16 + 64 + 256 + 1024)
})

test('codex override placement survives every value-taking root option and the joined config spelling', () => {
  const context = { task: 'T', endpoint: 'http://127.0.0.1:5577' }
  const shape = args => {
    const injection = runner.ccxray_worker_injection({ executable: 'codex', args }, {}, context)
    return { status: injection.status, reason: injection.reason, index: injection.arg_insert ? injection.arg_insert.index : null }
  }
  // Found in independent review: `-a never exec -c x=1` put the overrides at
  // root level again, and codex dropped them.
  for (const lead of [['-a', 'never'], ['--ask-for-approval', 'never'], ['--enable', 'foo'], ['--disable', 'bar'], ['-i', 'shot.png'], ['--add-dir', '/x'], ['--local-provider', 'ollama'], ['--remote', 'host:1'], ['--remote-auth-token-env', 'TOK']]) {
    assert.deepEqual(shape([...lead, 'exec', '-c', 'x=1', 'prompt']), { status: 'active', reason: null, index: lead.length + 1 }, lead.join(' '))
  }
  for (const sub of ['resume', 'fork', 'apply', 'a']) {
    assert.deepEqual(shape([sub, '--last']), { status: 'active', reason: null, index: 1 }, sub)
  }
  // An existing routing override in any spelling means we must not add ours.
  for (const args of [
    ['exec', '-c', 'openai_base_url="http://gw/v1"', 'p'],
    ['exec', '--config', 'chatgpt_base_url="http://gw/v1"', 'p'],
    ['--config=chatgpt_base_url="http://gw/v1"', 'exec', 'p'],
  ]) assert.equal(shape(args).reason, 'custom_base_url', JSON.stringify(args))
})

test('codex respects a foreign inherited base URL like claude and grok do', () => {
  const context = { task: 'T', endpoint: 'http://127.0.0.1:5577' }
  const foreign = runner.ccxray_worker_injection({ executable: 'codex', args: ['exec', 'p'] }, { OPENAI_BASE_URL: 'https://gateway.example/v1' }, context)
  assert.equal(foreign.status, 'skipped')
  assert.equal(foreign.reason, 'custom_base_url')
  assert.equal(foreign.arg_insert, undefined)
  const foreign_chatgpt = runner.ccxray_worker_injection({ executable: 'codex', args: ['exec', 'p'] }, { CHATGPT_BASE_URL: 'https://gateway.example/backend-api/codex' }, context)
  assert.equal(foreign_chatgpt.reason, 'custom_base_url')
  // The same ccxray origin, spelled localhost, is not foreign.
  const same = runner.ccxray_worker_injection({ executable: 'codex', args: ['exec', 'p'] }, { OPENAI_BASE_URL: 'http://localhost:5577/v1' }, context)
  assert.equal(same.status, 'active')
})

test('devlog lines mark under-counted or default-rate costs and stamp the snapshot time', () => {
  const summary = live_summary_fixture({
    task: 'A-1', calls: 4, cost_usd: 0.5, cache_hit_rate: 0.5,
    tokens: { input: 1, output: 1, cache: 1, total: 3 }, models: ['m'], agents: ['claude'],
    cost_confidence: { priced: 2, unknown: 1, fallback: 1, no_usage: 1 },
    as_of: '2026-09-20T10:00:00.000Z',
    by_role: {
      coordinator: { calls: 2, cost_usd: 0.1, tokens: { total: 1 }, cost_confidence: { priced: 1, unknown: 1, fallback: 0, no_usage: 0 } },
      w: { calls: 2, cost_usd: 0.4, tokens: { total: 2 }, cost_confidence: { priced: 2, unknown: 0, fallback: 0, no_usage: 0 } },
    },
  })
  assert.deepEqual(metrics.format_ccxray_devlog_lines(summary), [
    '- ccxray A-1: 4 calls · ~$0.5000+ · tokens in 1 / out 1 / cache 1 (hit 50.0%) / total 3 · m via claude · as of 2026-09-20T10:00:00.000Z',
    '  - cost is a lower bound: 1 not priced (unknown model); 1 without usage; 1 at default rates',
    '  - coordinator: 2 calls · $0.1000+ · 1 tokens',
    '  - w: 2 calls · $0.4000 · 2 tokens',
  ])
  // Fully priced, no stamp: the line is unchanged from before.
  const clean = { ...summary, cost_confidence: { priced: 4, unknown: 0, fallback: 0, no_usage: 0 }, as_of: undefined, by_role: {} }
  assert.equal(metrics.format_ccxray_devlog_lines(clean)[0], '- ccxray A-1: 4 calls · $0.5000 · tokens in 1 / out 1 / cache 1 (hit 50.0%) / total 3 · m via claude')
  assert.equal(metrics.format_ccxray_devlog_lines(clean).length, 1)
})

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
  const { server, endpoint } = await start_validated_server((req, res) => {
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
        res.end(JSON.stringify(live_summary_fixture({ request: summary_request(url), task: 'EMPTY', role: 'cross-check', project: 'ipadpos', calls: 0, cost_usd: 0 })))
        return
      }
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
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
      })))
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
    assert.equal(result.by_role['cross-check'].calls, 3)
    assert.equal(result.tokens.cache, 1500)
    assert.equal(await metrics.fetch_ccxray_metrics('EMPTY', { endpoint }), null)
  } finally {
    await close_server(server)
  }
})

test('sends exact coordinator session parameters only when the health capability is present', async () => {
  const queries = []
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const open_to = Date.now() - 5
      const coordinator = {
        calls: 2,
        cost_usd: 0.91,
        cost_confidence: { priced: 2, unknown: 0, fallback: 0, no_usage: 0 },
        uncomputable_requests: 0,
        sessions: [{ session: 'host-1', from: 1000, to: 2000, calls: 2 }, { session: 'host-2', from: 3000, to: open_to, calls: 2 }],
        charges: [{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '1000000', usd_per_unit: '0.91', usd: '0.91', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' }],
        last_ingested_at: '2026-09-20T10:00:00.000Z',
        pending_requests: 0,
      }
      const body = live_summary_fixture({
        request: summary_request(url),
        task: 'A-012', role: null, project: 'p', calls: 2, cost_usd: 0.91,
        by_role: { coordinator: live_summary_fixture({ role: 'coordinator', calls: 2, cost_usd: 0.91 }).by_role.coordinator },
        coordinator,
      })
      body.coordinator.sessions = body.coordinator.sessions.map((session, index) => ({ ...session, calls: 2, ...(index === 1 ? { to: open_to } : {}) }))
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const result = await metrics.fetch_ccxray_metrics('A-012', {
      endpoint,
      sessions: [
        { session: 'host-1', from: 1000, to: 2000 },
        { session: 'host-2', from: 3000, to: null },
      ],
    })
    assert.deepEqual(queries[0].searchParams.getAll('session'), ['host-1@1000-2000', 'host-2@3000-'])
    assert.equal(result.coordinator.calls, 2)
    assert.equal(result.coordinator.cost_usd, 0.91)
    assert.deepEqual(result.coordinator.sessions[0], { session: 'host-1', from: 1000, to: 2000, calls: 2 })
    assert.equal(result.coordinator.sessions[1].session, 'host-2')
    assert.equal(result.coordinator.sessions[1].from, 3000)
    assert.equal(Number.isSafeInteger(result.coordinator.sessions[1].to), true)
    assert.equal(result.coordinator.sessions[1].calls, 2)
  } finally {
    await close_server(server)
  }

  const old_queries = []
  const old = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      old_queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Deliberately legacy body: an old server has no summary schema fields.
      res.end(JSON.stringify({ task: 'A-012', calls: 1 }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    await metrics.fetch_ccxray_metrics('A-012', {
      endpoint: old.endpoint,
      sessions: [{ session: 'host-1', from: 1000, to: null }],
    })
    assert.deepEqual(old_queries[0].searchParams.getAll('session'), [])
  } finally {
    await close_server(old.server)
  }
})

test('formats coordinator role totals and coordinator availability lines', () => {
  // Deliberate formatter-only legacy input: this is not a wire success mock.
  const summary = {
    task: 'A-012',
    calls: 2,
    cost_usd: 0.91,
    cache_hit_rate: 0,
    tokens: { input: 1, output: 2, cache: 0, total: 3 },
    by_role: { coordinator: { calls: 2, cost_usd: 0.91, tokens: { total: 3 } } },
    coordinator: { calls: 2, sessions: [{ session: 'host-1', from: 1000, to: null }] },
  }
  assert.deepEqual(metrics.format_ccxray_devlog_lines(summary), [
    '- ccxray A-012: 2 calls · $0.9100 · tokens in 1 / out 2 / cache 0 (hit 0.0%) / total 3',
    '  - coordinator: 2 calls · $0.9100 · 3 tokens',
  ])
  assert.deepEqual(metrics.format_ccxray_devlog_lines({ ...summary, coordinator: { calls: 0, sessions: [{ session: 'host-1' }] } }), [
    '- ccxray A-012: 2 calls · $0.9100 · tokens in 1 / out 2 / cache 0 (hit 0.0%) / total 3',
    '  - coordinator: 2 calls · $0.9100 · 3 tokens',
    '  - coordinator: unavailable (host_not_proxied)',
  ])
  assert.deepEqual(metrics.format_ccxray_devlog_lines(summary, {
    sessions: [{ session: 'host-1', from: 1000, to: null }],
    coordinator_unavailable: 'ccxray_too_old',
  }), [
    '- ccxray A-012: 2 calls · $0.9100 · tokens in 1 / out 2 / cache 0 (hit 0.0%) / total 3',
    '  - coordinator: 2 calls · $0.9100 · 3 tokens',
    '  - coordinator: unavailable (ccxray_too_old)',
  ])
})

test('CLI derives coordinator intervals from the configured workspace and keeps worker queries unselected', async () => {
  const queries = []
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const sessions = url.searchParams.getAll('session')
      if (sessions.length > 0) {
        const body = live_summary_fixture({
          request: summary_request(url),
          task: 'A-012', role: null, project: 'p', calls: 0, cost_usd: 0, charges: [], coordinator: true,
          tokens: { input: 1, output: 1, cache_read: 0, cache_create: 0, reasoning: 0, total: 2 },
        })
        body.coordinator.sessions = body.coordinator.sessions.map(session => ({ ...session, calls: 0 }))
        res.end(JSON.stringify(body))
      } else {
        res.end(JSON.stringify(live_summary_fixture({
          request: summary_request(url),
          task: 'A-012', role: url.searchParams.get('role') || null, project: 'p', calls: 1, cost_usd: 0,
          tokens: { input: 1, output: 1, cache_read: 0, cache_create: 0, reasoning: 0, total: 2 },
        })))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-cli-coordinator-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-012', session_id: 'host-1', host: 'codex', ts: 100000, event: 'start' }),
      JSON.stringify({ ask: 'A-012', session_id: 'host-1', host: 'codex', ts: 101000, event: 'close' }),
    ].join('\n') + '\n')

    const common = ['ccxray-summary', '--task', 'A-012', '--config', config_path]
    const coordinator = await run_metrics_cli([...common, '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(coordinator.status, 0)
    assert.match(coordinator.stdout, /coordinator: unavailable \(host_not_proxied\)/)
    assert.deepEqual(queries[0].searchParams.getAll('session'), ['host-1@0-221000'])

    const worker = await run_metrics_cli([...common, '--role', 'cross-check', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(worker.status, 0)
    assert.deepEqual(queries[1].searchParams.getAll('session'), [])

    const skipped = await run_metrics_cli([...common, '--no-coordinator', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(skipped.status, 0)
    assert.deepEqual(queries[2].searchParams.getAll('session'), [])
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('CLI emits paste-ready ccxray devlog lines for found, empty, and unreachable tasks', async () => {
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.searchParams.get('task') === 'TASK-EMPTY') {
        res.end(JSON.stringify(live_summary_fixture({ request: summary_request(url), task: 'TASK-EMPTY', role: 'cross-check', project: 'agentflow', calls: 0, cost_usd: 0 })))
        return
      }
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
        task: 'TASK-FOUND',
        role: 'cross-check',
        project: 'agentflow',
        calls: 3,
        cost_usd: 0.0421,
        cache_hit_rate: 0.833,
        tokens: { input: 300, output: 45, cache_read: 1500, cache_create: 0, total: 1845 },
        tools: {},
        tool_failures: 0,
        models: ['gpt-5.5'],
        agents: ['codex'],
      })))
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
    // The CLI stamps the snapshot time it read the figures at (an ISO instant).
    assert.match(found.stdout, /^- ccxray TASK-FOUND\/cross-check: 3 calls · \$0\.0421 · tokens in 300 \/ out 45 \/ cache 1500 \(hit 83\.3%\) \/ total 1845 · gpt-5\.5 via codex · as of \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/u)

    const json_args = ['ccxray-summary', '--config', config_path, '--task', 'TASK-FOUND', '--role', 'cross-check', '--project', 'agentflow']
    const implicit_json = await run_metrics_cli(json_args, { CCXRAY_ENDPOINT: endpoint })
    const explicit_json = await run_metrics_cli([...json_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(implicit_json.status, 0)
    assert.equal(explicit_json.status, 0)
    const without_stamp = text => { const parsed = JSON.parse(text); delete parsed.as_of; return parsed }
    assert.deepEqual(without_stamp(explicit_json.stdout), without_stamp(implicit_json.stdout))
    assert.equal(JSON.parse(implicit_json.stdout).task, 'TASK-FOUND')
    assert.match(JSON.parse(implicit_json.stdout).as_of, /^\d{4}-\d{2}-\d{2}T/u)

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

test('CLI writes attempt and cumulative receipts, sends scope windows, and preserves the task summary query', async () => {
  const queries = []
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', instance_id: 'instance-1', version: '0.9.0', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      const role = url.searchParams.get('role')
      const coordinator = role === 'coordinator'
      const task_summary = role === null
      const cost = coordinator ? 0.1 : task_summary ? 0.5 : 0.2
      const charge = {
        model: coordinator ? 'coord-model' : 'worker-model',
        billing_provider: 'provider',
        component: coordinator ? 'output' : 'input',
        unit: 'tokens',
        quantity: coordinator ? '1000000' : task_summary ? '2500000' : '1000000',
        usd_per_unit: coordinator ? '0.1' : '0.2',
        usd: String(cost),
        basis: 'recorded',
        price_key: coordinator ? 'coord-output' : 'worker-input',
        rate_source: 'ccxray',
      }
      const selected_role = role || 'review'
      const selected = live_summary_fixture({
        task: 'A-012',
        role: selected_role,
        calls: coordinator ? 1 : task_summary ? 3 : 1,
        cost_usd: cost,
        charges: [charge],
      }).by_role[selected_role]
      const body = live_summary_fixture({
        request: summary_request(url),
        task: 'A-012',
        role: role || null,
        project: 'agentflow',
        calls: coordinator ? 1 : task_summary ? 3 : 1,
        cost_usd: cost,
        models: coordinator ? ['coord-model'] : ['worker-model'],
        charges: [charge],
        by_role: { [selected_role]: selected },
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        ...(coordinator ? { coordinator: true } : {}),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-receipt-cli-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'failed', started_ms: 1000, ended_ms: 2000 }),
      JSON.stringify({ ask: 'A-012', session_id: 'worker-1', host: 'codex', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 3000, ended_ms: 4000 }),
      JSON.stringify({ ask: 'A-012', session_id: 'host-1', host: 'codex', ts: 1000, event: 'start' }),
      JSON.stringify({ ask: 'A-012', session_id: 'host-1', host: 'codex', ts: 5000, event: 'close' }),
    ].join('\n') + '\n')

    const common = ['ccxray-summary', '--task', 'A-012', '--role', 'review', '--project', 'agentflow', '--config', config_path, '--format', 'devlog']
    const attempt = await run_metrics_cli([...common, '--attempt', '--dry-run'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(attempt.status, 0)
    assert.match(attempt.stdout, /^- ccxray A-012\/review attempt 2 \(succeeded\): USD 0\.2000 · 1 requests · worker-model · through \d{2}:\d{2}:\d{2}Z · receipt /u)
    const attempt_query = queries.find(url => url.searchParams.get('role') === 'review' && url.searchParams.has('from'))
    assert.equal(attempt_query.searchParams.get('from'), '3000')
    assert.equal(attempt_query.searchParams.get('to'), '4001')

    const cumulative = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--project', 'agentflow', '--config', config_path, '--cumulative', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(cumulative.status, 0)
    const receipt = JSON.parse(cumulative.stdout)
    assert.equal(receipt.kind, 'cumulative')
    assert.equal(receipt.source.instance_id, 'instance-1')
    assert.equal(receipt.source.ccxray_version, '0.9.0')
    assert.equal(receipt.source.query.task_summary.task, 'A-012')
    assert.equal(receipt.scopes.filter(scope => scope.role === 'review').length, 2)
    const coordinator_scope = receipt.scopes.find(scope => scope.role === 'coordinator')
    assert.ok(coordinator_scope)
    assert.ok(coordinator_scope.requests > 0)
    assert.equal(receipt.gaps.some(gap => gap.scope_id === coordinator_scope.id && gap.code === 'scope_query_failed'), false)
    assert.equal(fs.existsSync(path.join(directory, '.agentflow', 'evidence', 'ccxray', `${receipt.snapshot_id}.json`)), true)
    assert.equal(fs.readFileSync(path.join(directory, '.agentflow', 'evidence', 'ccxray', '.gitignore'), 'utf8'), '*\n')
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('CLI uses the recorded project for attempt scopes and queries each cumulative project once', async () => {
  const queries = []
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      const role = url.searchParams.get('role')
      const selected_role = role || 'review'
      const charge = { model: 'worker-model', billing_provider: 'provider', component: 'input', unit: 'tokens', quantity: '1000000', usd_per_unit: '0.1', usd: '0.100000', basis: 'recorded', price_key: 'worker-input', rate_source: 'ccxray' }
      const summary = live_summary_fixture({
        request: summary_request(url),
        task: 'A-021',
        role: role || null,
        project: url.searchParams.get('project'),
        calls: 1,
        cost_usd: 0.1,
        charges: [charge],
        by_role: { [selected_role]: live_summary_fixture({ role: selected_role, calls: 1, cost_usd: 0.1, charges: [charge] }).by_role[selected_role] },
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        ...(role === 'coordinator' ? { coordinator: true } : {}),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(summary))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-project-cli-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, JSON.stringify({ ask: 'A-021', session_id: 'worker-1', host: 'codex', ts: 300, event: 'attempt', role: 'review', project: 'slug-e2e-codex', attempt: 1, outcome: 'succeeded', started_ms: 1000, ended_ms: 2000 }) + '\n')

    const attempt = await run_metrics_cli(['ccxray-summary', '--task', 'A-021', '--role', 'review', '--project', 'directory-project', '--config', config_path, '--attempt', '--dry-run', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(attempt.status, 0)
    const attempt_receipt = JSON.parse(attempt.stdout)
    assert.equal(attempt_receipt.scopes[0].selector.labels.project, 'slug-e2e-codex')
    assert.equal(attempt_receipt.gaps.some(gap => gap.code === 'project_label_mismatch'), true)
    const attempt_queries = queries.filter(url => url.searchParams.get('role') === 'review' && url.searchParams.has('from'))
    assert.equal(attempt_queries.at(-1).searchParams.get('project'), 'slug-e2e-codex')

    const cumulative = await run_metrics_cli(['ccxray-summary', '--task', 'A-021', '--project', 'directory-project', '--config', config_path, '--cumulative', '--dry-run', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(cumulative.status, 0)
    const cumulative_receipt = JSON.parse(cumulative.stdout)
    const coordinator_scope = cumulative_receipt.scopes.find(scope => scope.role === 'coordinator')
    assert.notEqual(coordinator_scope.requests, null)
    assert.equal(coordinator_scope.requests, 1)
    assert.equal(coordinator_scope.known_usd, '0.1')
    assert.equal(cumulative_receipt.gaps.some(gap => gap.scope_id === coordinator_scope.id && gap.code === 'scope_query_failed'), false)
    const task_queries = queries.filter(url => url.searchParams.get('role') === null && !url.searchParams.has('from'))
    assert.deepEqual(task_queries.map(url => url.searchParams.get('project')).sort(), ['directory-project', 'slug-e2e-codex'])
    assert.equal(new Set(task_queries.map(url => url.searchParams.get('project'))).size, task_queries.length)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI degrades honestly when ccxray lacks cost-charges', async () => {
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
        task: 'A-012', role: 'review', project: 'agentflow', calls: 1, cost_usd: 0.2,
        charges: [{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '1000000', usd_per_unit: '0.2', usd: '0.2', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' }],
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      })))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-receipt-old-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, JSON.stringify({ ask: 'A-012', session_id: 's', host: 'codex', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }) + '\n')
    const result = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--role', 'review', '--project', 'agentflow', '--config', config_path, '--attempt', '--dry-run', '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /USD unknown\+.*receipt /u)
    assert.match(result.stdout, /ccxray_too_old_for_charges/u)
    const json = await run_metrics_cli(['ccxray-summary', '--task', 'A-012', '--role', 'review', '--project', 'agentflow', '--config', config_path, '--attempt', '--dry-run', '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(json.status, 0)
    const receipt = JSON.parse(json.stdout)
    assert.equal(receipt.scopes[0].known_usd, '0')
    assert.equal(receipt.scopes[0].priced_requests, 1)
    assert.equal(receipt.gaps.some(gap => gap.code === 'ccxray_too_old_for_charges'), true)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI records failed scope queries as nullable unknown gaps', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname === '/_api/task-summary' && url.searchParams.get('role') === 'coordinator') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    if (url.pathname === '/_api/task-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Deliberately invalid legacy body: this test exercises a failed coordinator query.
      res.end(JSON.stringify({ task: 'A-FAIL', calls: 0, cost_usd: '0', charges: [] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-scope-failure-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-FAIL', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-FAIL', session_id: 'host', host: 'codex', ts: 200, event: 'close' }),
    ].join('\n') + '\n')

    const args = ['ccxray-summary', '--task', 'A-FAIL', '--project', 'agentflow', '--config', config_path, '--cumulative', '--dry-run']
    const json = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    const devlog = await run_metrics_cli([...args, '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(json.status, 0)
    assert.equal(devlog.status, 0)
    const receipt = JSON.parse(json.stdout)
    const scope = receipt.scopes.find(value => value.role === 'coordinator')
    assert.equal(scope.requests, null)
    assert.equal(scope.known_usd, null)
    assert.deepEqual(scope.charges, [])
    assert.equal(receipt.gaps.some(gap => gap.scope_id === scope.id && gap.code === 'scope_query_failed' && /503/u.test(gap.detail)), true)
    assert.match(devlog.stdout, /USD unknown\+/u)
    assert.match(devlog.stdout, /scope_query_failed|HTTP 503/u)
    assert.doesNotMatch(devlog.stdout, /no observed requests/u)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI rejects invalid HTTP-200 summary bodies as failed scope queries', async () => {
  const valid_summary = live_summary_fixture({
    request: { task: 'A-INVALID', project: 'agentflow', role: 'review', session_specs: [], from: 100, to: 201, window_requested: true },
    task: 'A-INVALID', role: 'review', project: 'agentflow', calls: 1, cost_usd: 0.1,
  })
  let response_body = valid_summary
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response_body))
  })
  const directory = make_temp_dir('agentflow-ccxray-invalid-summary-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, JSON.stringify({ ask: 'A-INVALID', session_id: 'worker', host: 'codex', ts: 200, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }) + '\n')
    const args = ['ccxray-summary', '--task', 'A-INVALID', '--role', 'review', '--project', 'agentflow', '--config', config_path, '--attempt', '--dry-run', '--format', 'json']
    // Deliberately invalid bodies remain literal so each malformed shape is covered.
    for (const body of [{}, { error: 'upstream unavailable' }, { calls: '1' }, []]) {
      response_body = body
      const result = await run_metrics_cli(args, { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      const receipt = JSON.parse(result.stdout)
      assert.equal(receipt.scopes[0].requests, null)
      assert.equal(receipt.scopes[0].known_usd, null)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === receipt.scopes[0].id && gap.code === 'scope_query_failed'), true)
      assert.equal(receipt.gaps.some(gap => gap.code === 'missing_scope'), false)
    }
    response_body = valid_summary
    const valid = await run_metrics_cli(args, { CCXRAY_ENDPOINT: endpoint })
    assert.equal(valid.status, 0)
    const receipt = JSON.parse(valid.stdout)
    assert.equal(receipt.scopes[0].requests, 1)
    assert.equal(receipt.scopes[0].known_usd, '0.1')
    assert.equal(receipt.gaps.some(gap => gap.code === 'scope_query_failed'), false)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI rejects invalid selected summaries and charge records before merging them', async () => {
  const valid_summary = live_summary_fixture({ task: 'A-NESTED-INVALID', role: 'review', project: 'agentflow', calls: 1, cost_usd: 0.1 })
  const charge = valid_summary.charges[0]
  const nested = changes => ({
    ...valid_summary,
    by_role: { review: { ...valid_summary.by_role.review, ...changes } },
  })
  const invalid_summaries = [
    nested({ calls: -1 }),
    nested({ calls: 1.5 }),
    nested({ cost_confidence: { priced: 1, unknown: -1, fallback: 0, no_usage: 0 } }),
    nested({ charges: {} }),
    nested({ charges: [{}] }),
    nested({ charges: [{ ...charge, usd: null }] }),
    nested({ charges: [{ ...charge, quantity: '1e6' }] }),
    nested({ pending_requests: -1 }),
    nested({ uncomputable_requests: -1 }),
    nested({ last_ingested_at: 123 }),
  ]
  let response_body = valid_summary
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response_body))
  })
  const directory = make_temp_dir('agentflow-ccxray-nested-invalid-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, JSON.stringify({ ask: 'A-NESTED-INVALID', session_id: 'worker', host: 'codex', ts: 200, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }) + '\n')
    const args = ['ccxray-summary', '--task', 'A-NESTED-INVALID', '--role', 'review', '--project', 'agentflow', '--config', config_path, '--attempt', '--dry-run', '--format', 'json']
    for (const body of invalid_summaries) {
      response_body = body
      const result = await run_metrics_cli(args, { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      const receipt = JSON.parse(result.stdout)
      const scope = receipt.scopes[0]
      assert.equal(scope.requests, null)
      assert.equal(scope.known_usd, null)
      assert.equal(scope.charges.length, 0)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === scope.id && gap.code === 'scope_query_failed' && gap.detail.startsWith('invalid summary: ')), true)
      assert.equal(receipt.gaps.some(gap => gap.code === 'missing_scope'), false)
    }
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI rejects absent or incomplete selected sub-summaries without inheriting wrapper fields', async () => {
  const selected_worker = () => live_summary_fixture({ role: 'review', calls: 1, cost_usd: 0.1 }).by_role.review
  const selected_coordinator = request => live_summary_fixture({ request, role: 'coordinator', calls: 1, cost_usd: 0.2, coordinator: true }).coordinator
  const coordinator_role = () => live_summary_fixture({ role: 'coordinator', calls: 1, cost_usd: 0.2 }).by_role.coordinator
  const make_summary = (role, selected, request, overrides = {}) => {
    const worker = selected_worker()
    const coordinator = selected_coordinator(request)
    const by_role = role === 'coordinator' ? { coordinator: coordinator_role() } : { review: worker }
    const summary = live_summary_fixture({
      request,
      task: 'A-SELECTED',
      role,
      project: 'p',
      calls: selected.calls,
      cost_usd: selected.cost_usd,
      by_role,
      ...(role === 'coordinator' ? { coordinator } : {}),
      models: ['wrapper-model'],
      last_ingested_at: '2026-09-20T09:00:00.000Z',
      pending_requests: 0,
      uncomputable_requests: 0,
      coverage: { entries_in_memory: 1, max_entries: 5000 },
      ...overrides,
    })
    if (role === 'review') summary.by_role.review = selected
    if (role === 'coordinator') summary.coordinator = selected
    return summary
  }

  let mode = 'valid'
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    const role = url.searchParams.get('role')
    const request = summary_request(url)
    let body = role === 'coordinator'
      ? make_summary(role, selected_coordinator(request), request)
      : make_summary(role, selected_worker(), request)
    if (role === 'coordinator') {
      if (mode === 'coordinatorMissing') {
        delete body.coordinator
        delete body.by_role.coordinator
      } else if (mode === 'coordinatorEmpty') body.coordinator = {}
      else if (mode === 'coordinatorOptionalMissing') {
        delete body.coordinator.last_ingested_at
        delete body.coordinator.pending_requests
        delete body.coordinator.uncomputable_requests
      }
    } else if (role === 'review' && url.searchParams.get('from') === '200') {
      if (mode === 'nestedEmpty') body.by_role.review = {}
      if (mode === 'nestedMissingCalls') delete body.by_role.review.calls
      if (mode === 'nestedMissingCharges') delete body.by_role.review.charges
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  const run = async (name, args, records) => {
    const directory = make_temp_dir(`agentflow-ccxray-selected-${name}-`)
    try {
      const config_path = path.join(directory, 'ag.json')
      fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
      const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
      fs.mkdirSync(path.dirname(log_path), { recursive: true })
      fs.writeFileSync(log_path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
      return await run_metrics_cli([...args, '--config', config_path], { CCXRAY_ENDPOINT: endpoint })
    } finally {
      remove_temp_dir(directory)
    }
  }

  try {
    const coordinator_records = [
      { ask: 'A-SELECTED', session_id: 'host', host: 'codex', ts: 100, event: 'start' },
      { ask: 'A-SELECTED', session_id: 'host', host: 'codex', ts: 300, event: 'close' },
    ]
    for (const [case_name, expected] of [
      ['coordinatorMissing', 'invariant I1 violated: session query is missing coordinator'],
      ['coordinatorEmpty', 'invalid summary: coordinator.calls must be a non-negative integer'],
    ]) {
      mode = case_name
      const json = await run(case_name, ['ccxray-summary', '--task', 'A-SELECTED', '--project', 'p', '--cumulative', '--dry-run', '--format', 'json'], coordinator_records)
      const devlog = await run(`${case_name}-devlog`, ['ccxray-summary', '--task', 'A-SELECTED', '--project', 'p', '--cumulative', '--dry-run', '--format', 'devlog'], coordinator_records)
      assert.equal(json.status, 0)
      assert.equal(devlog.status, 0)
      const receipt = JSON.parse(json.stdout)
      const scope = receipt.scopes[0]
      assert.equal(scope.requests, null)
      assert.equal(scope.known_usd, null)
      assert.deepEqual(scope.charges, [])
      assert.deepEqual(receipt.gaps.find(gap => gap.scope_id === scope.id && gap.code === 'scope_query_failed'), {
        scope_id: scope.id,
        code: 'scope_query_failed',
        detail: expected,
      })
      assert.match(devlog.stdout, /USD unknown\+ · unknown requests/u)
    }

    const worker_records = [
      { ask: 'A-SELECTED', session_id: 'worker', host: 'codex', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 199 },
      { ask: 'A-SELECTED', session_id: 'worker', host: 'codex', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 200, ended_ms: 299 },
    ]
    for (const [case_name, expected] of [
      ['nestedEmpty', 'invalid summary: by_role.review.calls must be a non-negative integer'],
      ['nestedMissingCalls', 'invalid summary: by_role.review.calls must be a non-negative integer'],
      ['nestedMissingCharges', 'invalid summary: by_role.review.charges must be an array'],
    ]) {
      mode = case_name
      const json = await run(case_name, ['ccxray-summary', '--task', 'A-SELECTED', '--role', 'review', '--project', 'p', '--cumulative', '--dry-run', '--format', 'json'], worker_records)
      const devlog = await run(`${case_name}-devlog`, ['ccxray-summary', '--task', 'A-SELECTED', '--role', 'review', '--project', 'p', '--cumulative', '--dry-run', '--format', 'devlog'], worker_records)
      assert.equal(json.status, 0)
      assert.equal(devlog.status, 0)
      const receipt = JSON.parse(json.stdout)
      const failed_scope = receipt.scopes.find(scope => scope.attempt === 2)
      assert.equal(failed_scope.requests, null)
      assert.equal(failed_scope.known_usd, null)
      assert.deepEqual(failed_scope.charges, [])
      assert.deepEqual(receipt.gaps.find(gap => gap.scope_id === failed_scope.id && gap.code === 'scope_query_failed'), {
        scope_id: failed_scope.id,
        code: 'scope_query_failed',
        detail: expected,
      })
      assert.equal(receipt.gaps.some(gap => gap.code === 'completeness_unknown'), true)
      assert.equal(receipt.gaps.some(gap => gap.code === 'unscoped_requests'), false)
      assert.match(devlog.stdout, /USD unknown\+ · ≥ 1 requests/u)
      assert.match(devlog.stdout, /completeness of unscoped attribution could not be checked/u)
    }

    mode = 'valid'
    const valid = await run('coordinator-wrapper-different', ['ccxray-summary', '--task', 'A-SELECTED', '--project', 'p', '--cumulative', '--dry-run', '--format', 'json'], coordinator_records)
    assert.equal(valid.status, 0)
    const valid_receipt = JSON.parse(valid.stdout)
    assert.equal(valid_receipt.scopes[0].requests, 1)
    assert.equal(valid_receipt.scopes[0].known_usd, '0.2')
    assert.equal(valid_receipt.scopes[0].charges[0].usd, '0.2')

    mode = 'coordinatorOptionalMissing'
    const optional = await run('coordinator-optional-missing', ['ccxray-summary', '--task', 'A-SELECTED', '--project', 'p', '--cumulative', '--dry-run', '--format', 'json'], coordinator_records)
    assert.equal(optional.status, 0)
    const optional_scope = JSON.parse(optional.stdout).scopes[0]
    assert.equal(optional_scope.last_ingested_at, null)
    assert.equal(optional_scope.pending_requests, 0)
    assert.equal(optional_scope.uncomputable_requests, 0)
    assert.deepEqual(optional_scope.models, ['wrapper-model'])
  } finally {
    await close_server(server)
  }
})

test('round-9 invalid bodies remain receipts with bounded failure accounting', async () => {
  const task_summary = request => live_summary_fixture({
    request,
    task: 'A-ROUND-9',
    role: null,
    project: 'p',
    calls: 3,
    cost_usd: 0.7,
    charges: [{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '7000000', usd_per_unit: '0.1', usd: '0.7', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' }],
    by_role: {
      review: live_summary_fixture({ role: 'review', calls: 2, cost_usd: 0.3 }).by_role.review,
      'cross-check': live_summary_fixture({ role: 'cross-check', calls: 1, cost_usd: 0.4 }).by_role['cross-check'],
    },
  })
  let mode = 'valid'
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname !== '/_api/task-summary') {
      res.writeHead(404)
      res.end()
      return
    }
    const task_query = !url.searchParams.has('role')
    const coordinator_query = url.searchParams.get('role') === 'coordinator'
    const second_scope = url.searchParams.get('from') === '200'
    const request = summary_request(url)
    let body = coordinator_query
      ? live_summary_fixture({ request, task: 'A-ROUND-9', role: 'coordinator', project: 'p', calls: 0, cost_usd: 0, charges: [], coordinator: true })
      : task_query
      ? task_summary(request)
      : live_summary_fixture({ request, task: 'A-ROUND-9', role: 'review', project: 'p', calls: second_scope ? 1 : 1, cost_usd: second_scope ? 0.2 : 0.1, from: url.searchParams.get('from'), to: url.searchParams.get('to') })
    if (task_query) {
      if (mode === 'taskUsdObject') body.cost_usd = { wrong: 1 }
      if (mode === 'taskUsdBadString') body.cost_usd = 'oops'
      if (mode === 'taskByRoleArray') body.by_role['cross-check'] = []
      if (mode === 'taskByRoleString') body.by_role['cross-check'] = 'oops'
      if (mode === 'taskByRoleNegative') body.by_role['cross-check'].calls = -1
      if (mode === 'taskByRoleFractional') body.by_role['cross-check'].calls = 1.5
    } else if (!coordinator_query && second_scope) {
      if (mode === 'nestedBadTime') body.by_role.review.last_ingested_at = 'not-a-timestamp'
      if (mode === 'nestedUsdObject') body.by_role.review.cost_usd = { wrong: 1 }
      if (mode === 'nestedUsdNegative') body.by_role.review.cost_usd = -1
      if (mode === 'nestedUsdBadString') body.by_role.review.cost_usd = 'oops'
      if (mode === 'workerEmptyReality') body = live_summary_fixture({ request, task: 'A-ROUND-9', role: 'review', project: 'p', calls: 0, cost_usd: 0, window: { from: 200, to: 300 } })
      if (['providerObject', 'priceKeyArray', 'rateSourceNumber', 'missingProvider'].includes(mode)) {
        const charge = body.by_role.review.charges[0]
        if (mode === 'providerObject') charge.billing_provider = { secret: 'bad' }
        if (mode === 'priceKeyArray') charge.price_key = []
        if (mode === 'rateSourceNumber') charge.rate_source = 99
        if (mode === 'missingProvider') delete charge.billing_provider
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const directory = make_temp_dir('agentflow-ccxray-round9-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-ROUND-9', session_id: 'worker', host: 'codex', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 199 }),
      JSON.stringify({ ask: 'A-ROUND-9', session_id: 'worker', host: 'codex', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 200, ended_ms: 299 }),
    ].join('\n') + '\n')
    const base_args = ['ccxray-summary', '--task', 'A-ROUND-9', '--project', 'p', '--config', config_path, '--cumulative', '--dry-run']

    for (const case_name of ['taskUsdObject', 'taskUsdBadString', 'taskByRoleArray', 'taskByRoleString', 'taskByRoleNegative', 'taskByRoleFractional']) {
      mode = case_name
      const json = await run_metrics_cli([...base_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      const devlog = await run_metrics_cli([...base_args, '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(json.status, 0)
      assert.equal(devlog.status, 0)
      const receipt = JSON.parse(json.stdout)
      assert.equal(receipt.gaps.some(gap => gap.code === 'task_summary_query_failed' && gap.detail.startsWith('invalid summary: ')), true)
      assert.match(devlog.stdout, /USD 0\.3000\+ · ≥ 2 requests/u)
      assert.doesNotMatch(devlog.stdout, /-0\.3000/u)
    }

    for (const case_name of ['nestedBadTime', 'nestedUsdObject', 'nestedUsdNegative', 'nestedUsdBadString']) {
      mode = case_name
      const result = await run_metrics_cli([...base_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      assert.equal(result.stderr, '')
      const receipt = JSON.parse(result.stdout)
      const failed = receipt.scopes.find(scope => scope.id === 'attempt-review-2')
      assert.equal(failed.requests, null)
      assert.equal(failed.known_usd, null)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === failed.id && gap.code === 'scope_query_failed' && gap.detail.startsWith('invalid summary: by_role.review.')), true)
    }

    mode = 'workerEmptyReality'
    const empty = JSON.parse((await run_metrics_cli([...base_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })).stdout)
    const empty_scope = empty.scopes.find(scope => scope.id === 'attempt-review-2')
    assert.equal(empty_scope.requests, 0)
    assert.equal(empty_scope.known_usd, '0')
    assert.equal(empty.gaps.some(gap => gap.scope_id === empty_scope.id && gap.code === 'missing_scope'), true)
    assert.equal(empty.gaps.some(gap => gap.scope_id === empty_scope.id && gap.code === 'scope_query_failed'), false)

    for (const case_name of ['providerObject', 'priceKeyArray', 'rateSourceNumber', 'missingProvider']) {
      mode = case_name
      const result = await run_metrics_cli([...base_args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      const receipt = JSON.parse(result.stdout)
      const failed = receipt.scopes.find(scope => scope.id === 'attempt-review-2')
      assert.equal(failed.requests, null)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === failed.id && gap.code === 'scope_query_failed'), true)
    }
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt conversion ignores additive wire aliases and uses charge-derived exclusions', async () => {
  const charge = (model, usd) => ({
    model,
    billing_provider: 'p',
    component: 'input',
    unit: 'tokens',
    quantity: '1000000',
    usd_per_unit: String(usd),
    usd: String(usd),
    basis: 'recorded',
    price_key: `${model}-input`,
    rate_source: 'ccxray',
  })
  const task_body = mode => {
    const body = live_summary_fixture({
      task: 'A-ROUND-10',
      role: null,
      project: 'p',
      calls: 3,
      cost_usd: 0.7,
      charges: [charge('task-model', 0.7)],
      by_role: {
        review: live_summary_fixture({ role: 'review', calls: 2, cost_usd: 0.3, charges: [charge('review-model', 0.3)] }).by_role.review,
        'cross-check': live_summary_fixture({ role: 'cross-check', calls: 1, cost_usd: 0.4, charges: [charge('cross-model', 0.4)] }).by_role['cross-check'],
      },
    })
    if (mode === 'taskCostZero') body.cost_usd = 0
    return body
  }
  let mode = 'valid'
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname !== '/_api/task-summary') {
      res.writeHead(404)
      res.end()
      return
    }
    const role = url.searchParams.get('role')
    let body
    if (role === 'coordinator') {
      body = live_summary_fixture({ request: summary_request(url), task: 'A-ROUND-10', role: 'coordinator', project: 'p', calls: 0, cost_usd: 0, charges: [], coordinator: true })
    } else if (role === null) {
      body = task_body(mode)
    } else {
      const second = url.searchParams.get('from') === '200'
      body = live_summary_fixture({
        task: 'A-ROUND-10',
        role: 'review',
        project: 'p',
        calls: 1,
        cost_usd: second ? 0.2 : 0.1,
        charges: [charge(second ? 'review-model' : 'first-model', second ? 0.2 : 0.1)],
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      })
      const selected = body.by_role.review
      if (second && mode === 'requestsInflated') selected.requests = 999
      if (second && mode === 'nestedSummaryEmpty') selected.summary = {}
      if (second && mode === 'nestedSummaryBadTime') selected.summary = { ...selected, last_ingested_at: 'bad' }
      if (second && mode === 'nestedSummaryBadCost') selected.summary = { ...selected, cost_usd: 'bad' }
      if (second && mode === 'nestedModelsObject') selected.models = { bad: 1 }
      if (second && mode === 'nestedModelsArray') selected.models = [{ bad: 1 }]
      if (second && mode === 'nestedCostZero') selected.cost_usd = 0
      if (second && mode === 'nestedAliasFallback') selected.fallback_requests = 1
      if (second && mode === 'nestedAliasMissing') selected.missing_usage_requests = 1
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const directory = make_temp_dir('agentflow-ccxray-round10-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-ROUND-10', session_id: 'worker', host: 'codex', ts: 100, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 199 }),
      JSON.stringify({ ask: 'A-ROUND-10', session_id: 'worker', host: 'codex', ts: 300, event: 'attempt', role: 'review', attempt: 2, outcome: 'succeeded', started_ms: 200, ended_ms: 299 }),
    ].join('\n') + '\n')
    const args = ['ccxray-summary', '--task', 'A-ROUND-10', '--role', 'review', '--project', 'p', '--config', config_path, '--cumulative', '--dry-run']

    mode = 'requestsInflated'
    const inflated = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(inflated.status, 0)
    const inflated_receipt = JSON.parse(inflated.stdout)
    assert.deepEqual(inflated_receipt.scopes.filter(scope => scope.role === 'review').map(scope => scope.requests), [1, 1])
    assert.equal(inflated_receipt.gaps.some(gap => gap.code === 'scope_overlap'), false)

    for (const case_name of ['nestedSummaryEmpty', 'nestedSummaryBadTime', 'nestedSummaryBadCost']) {
      mode = case_name
      const result = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      assert.equal(result.stderr, '')
      const receipt = JSON.parse(result.stdout)
      assert.deepEqual(receipt.scopes.filter(scope => scope.role === 'review').map(scope => scope.requests), [1, 1])
      assert.equal(receipt.gaps.some(gap => gap.code === 'scope_query_failed'), false)
    }

    for (const case_name of ['nestedModelsObject', 'nestedModelsArray']) {
      mode = case_name
      const result = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      const receipt = JSON.parse(result.stdout)
      const failed = receipt.scopes.find(scope => scope.id === 'attempt-review-2')
      assert.equal(failed.requests, null)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === failed.id && gap.code === 'scope_query_failed'), true)
    }

    mode = 'taskCostZero'
    const task_zero = await run_metrics_cli([...args, '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(task_zero.status, 0)
    assert.match(task_zero.stdout, /\+ · ≥ 2 requests/u)
    assert.doesNotMatch(task_zero.stdout, /USD -/u)
    assert.match(task_zero.stdout, /reported cost disagrees with charges; exclusions cannot be quantified/u)

    mode = 'nestedCostZero'
    const nested_zero = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(nested_zero.status, 0)
    const nested_receipt = JSON.parse(nested_zero.stdout)
    assert.equal(nested_receipt.gaps.some(gap => gap.scope_id === 'attempt-review-2' && gap.code === 'arithmetic_mismatch'), true)
    assert.match(nested_receipt.gaps.find(gap => gap.code === 'unscoped_requests').detail, /USD 0\.4000/u)

    for (const case_name of ['nestedAliasFallback', 'nestedAliasMissing']) {
      mode = case_name
      const result = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
      assert.equal(result.status, 0)
      const receipt = JSON.parse(result.stdout)
      assert.equal(receipt.gaps.some(gap => gap.scope_id === 'attempt-review-2' && ['fallback_rate', 'missing_usage_requests'].includes(gap.code)), false)
    }
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI discloses a failed task-wide query as a lower-bound total', async () => {
  const summary_for = (role, request) => role === 'review'
    ? live_summary_fixture({ request, task: 'A-TASK-FAIL', role, project: 'agentflow', calls: 2, cost_usd: 0.3, charges: [{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '3000000', usd_per_unit: '0.1', usd: '0.3', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' }] })
    : live_summary_fixture({ request, task: 'A-TASK-FAIL', role: 'coordinator', project: null, calls: 1, cost_usd: 0, charges: [], coordinator: true })
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname === '/_api/task-summary' && !url.searchParams.has('role')) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'task-wide unavailable' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(summary_for(url.searchParams.get('role'), summary_request(url))))
  })
  const directory = make_temp_dir('agentflow-ccxray-task-summary-failure-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-TASK-FAIL', session_id: 'worker', host: 'codex', ts: 200, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }),
      JSON.stringify({ ask: 'A-TASK-FAIL', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-TASK-FAIL', session_id: 'host', host: 'codex', ts: 300, event: 'close' }),
    ].join('\n') + '\n')

    const args = ['ccxray-summary', '--task', 'A-TASK-FAIL', '--project', 'agentflow', '--config', config_path, '--cumulative', '--dry-run']
    const json = await run_metrics_cli([...args, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    const devlog = await run_metrics_cli([...args, '--format', 'devlog'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(json.status, 0)
    assert.equal(devlog.status, 0)
    const receipt = JSON.parse(json.stdout)
    assert.deepEqual(receipt.gaps.find(gap => gap.code === 'task_summary_query_failed'), {
      scope_id: null,
      code: 'task_summary_query_failed',
      detail: 'HTTP 503: completeness of worker attribution could not be checked',
    })
    assert.equal(receipt.source.query.failures.some(failure => failure.project === 'agentflow' && failure.detail === 'HTTP 503'), true)
    assert.match(devlog.stdout, /USD 0\.3000\+/u)
    assert.match(devlog.stdout, /gaps:.*HTTP 503: completeness of worker attribution could not be checked/u)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('receipt CLI records timeout scope failures without retrying', async () => {
  let coordinator_queries = 0
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    if (url.pathname === '/_api/task-summary' && url.searchParams.get('role') === 'coordinator') {
      coordinator_queries += 1
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // Deliberately invalid legacy body: the timeout test exercises a failed scope query.
    res.end(JSON.stringify({ task: 'A-TIMEOUT', calls: 0, cost_usd: '0', charges: [] }))
  })
  const directory = make_temp_dir('agentflow-ccxray-scope-timeout-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-TIMEOUT', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-TIMEOUT', session_id: 'host', host: 'codex', ts: 200, event: 'close' }),
    ].join('\n') + '\n')

    const result = await run_metrics_cli([
      'ccxray-summary', '--task', 'A-TIMEOUT', '--project', 'agentflow', '--config', config_path,
      '--cumulative', '--dry-run', '--timeout_ms', '20', '--format', 'json',
    ], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(result.status, 0)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.scopes[0].requests, null)
    assert.equal(receipt.gaps.some(gap => gap.code === 'scope_query_failed' && /TimeoutError/u.test(gap.detail)), true)
    assert.equal(coordinator_queries, 1)
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
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
    }), { endpoint, reason: null, ok: true, app: 'ccxray', capabilities: ['task-attribution'] })
  } finally {
    remove_temp_dir(home)
    await close_server(server)
  }
})

test('projects health metadata and treats string capabilities as unavailable', async () => {
  const sentinels = ['SYNTHETIC_PROMPT_12', 'SYNTHETIC_KEY_12', 'SYNTHETIC_TOOL_12', 'SYNTHETIC_HUB_12']
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        app: 'ccxray',
        pid: 123,
        hub: { secret: 'SYNTHETIC_HUB_12' },
        instance_id: 'I'.repeat(200),
        version: 'V'.repeat(200),
        capabilities: [
          'cost-charges',
          { prompt: 'SYNTHETIC_PROMPT_12', credentials: { api_key: 'SYNTHETIC_KEY_12' }, tool_arguments: { secret: 'SYNTHETIC_TOOL_12' } },
          'unknown-capability',
          'session-intervals',
          'task-attribution',
        ],
      }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
        task: 'A-HEALTH',
        project: 'p',
        role: url.searchParams.get('role'),
        coordinator: url.searchParams.getAll('session').length > 0,
        calls: 1,
        cost_usd: 0.1,
      })))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const directory = make_temp_dir('agentflow-ccxray-health-projection-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-HEALTH', session_id: 'worker', host: 'codex', ts: 200, event: 'attempt', role: 'review', attempt: 1, outcome: 'succeeded', started_ms: 100, ended_ms: 200 }),
      JSON.stringify({ ask: 'A-HEALTH', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-HEALTH', session_id: 'host', host: 'codex', ts: 300, event: 'close' }),
    ].join('\n') + '\n')
    const result = await run_metrics_cli([
      'ccxray-summary', '--task', 'A-HEALTH', '--project', 'p', '--config', config_path,
      '--cumulative', '--dry-run', '--format', 'json',
    ], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(result.status, 0)
    const receipt = JSON.parse(result.stdout)
    const serialized = JSON.stringify(receipt)
    for (const sentinel of sentinels) assert.doesNotMatch(serialized, new RegExp(sentinel))
    assert.deepEqual(receipt.source.query.task_summary.capabilities, ['task-attribution', 'session-intervals', 'cost-charges'])
    assert.equal(receipt.source.instance_id, 'I'.repeat(128))
    assert.equal(receipt.source.ccxray_version, 'V'.repeat(128))
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }

  const string_capability = await start_server((req, res) => {
    if (req.url === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: 'cost-charges' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    assert.deepEqual(await metrics.resolve_ccxray_endpoint({ endpoint: string_capability.endpoint }), {
      endpoint: null,
      reason: 'ccxray_too_old',
      capabilities: [],
    })
  } finally {
    await close_server(string_capability.server)
  }
})

test('legacy JSON output preserves every committed HEAD field with additive receipt fields', async () => {
  const request = { task: 'A-HEAD-COMPAT', project: 'p', role: 'review', session_specs: [], from: null, to: null, window_requested: false }
  const body = live_summary_fixture({
    request,
    task: 'A-HEAD-COMPAT',
    project: 'p',
    role: 'review',
    calls: 1,
    cost_usd: 0.2,
    cache_hit_rate: 0.25,
    tokens: { input: 100, output: 20, cache_read: 3, cache_create: 4, reasoning: 1, total: 128 },
  })
  body.by_role.review.cache_hit_rate = 0.25
  body.by_role.review.tokens = { input: 100, output: 20, cache_read: 3, cache_create: 4, reasoning: 1, total: 128 }
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(url.pathname === '/_api/health'
      ? { ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }
      : url.searchParams.getAll('session').length > 0 && url.searchParams.get('role') === null
        ? url.searchParams.get('task') === 'A-HEAD-COMPAT-OPEN'
          ? live_open_mixed_summary_fixture({ request: summary_request(url) })
          : live_mixed_summary_fixture({ request: summary_request(url) })
      : body))
  })
  const directory = make_temp_dir('agentflow-ccxray-head-compat-')
  const previous_endpoint = process.env.CCXRAY_ENDPOINT
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto' } }))
    const head_path = path.join(directory, 'metrics-head.cjs')
    fs.writeFileSync(head_path, child_process.execFileSync('git', ['show', 'HEAD:skills/agentflow/scripts/metrics.js'], { encoding: 'utf8' }))
    const head_metrics = require(head_path)
    assert.equal(typeof head_metrics.main, 'function')
    process.env.CCXRAY_ENDPOINT = endpoint
    const args = ['ccxray-summary', '--task', 'A-HEAD-COMPAT', '--role', 'review', '--project', 'p', '--config', config_path, '--no-coordinator', '--format', 'json']
    const old_result = await run_metrics_file(head_path, args, { CCXRAY_ENDPOINT: endpoint })
    const current_result = await run_metrics_file(path.join(__dirname, 'metrics.js'), args, { CCXRAY_ENDPOINT: endpoint })
    assert.equal(old_result.status, 0)
    assert.equal(current_result.status, 0)
    const old_json = JSON.parse(old_result.stdout)
    const current_json = JSON.parse(current_result.stdout)
    const assert_head_fields = (expected, actual, location = 'root') => {
      if (Array.isArray(expected)) {
        assert.equal(Array.isArray(actual), true, location)
        assert.equal(actual.length >= expected.length, true, location)
        expected.forEach((value, index) => assert_head_fields(value, actual[index], `${location}[${index}]`))
        return
      }
      if (expected !== null && typeof expected === 'object') {
        assert.equal(actual !== null && typeof actual === 'object', true, location)
        for (const [key, value] of Object.entries(expected)) {
          if (key === 'as_of') continue
          assert.equal(Object.hasOwn(actual, key), true, `${location}.${key}`)
          assert_head_fields(value, actual[key], `${location}.${key}`)
        }
        return
      }
      assert.deepEqual(actual, expected, location)
    }
    assert_head_fields(old_json, current_json)
    assert.equal(current_json.by_role.review.cache_hit_rate, 0.25)
    assert.equal(current_json.by_role.review.tokens.cache_read, 3)
    assert.equal(current_json.by_role.review.tokens.cache_create, 4)
    assert.equal(current_json.tokens.cache_read, 3)
    assert.equal(current_json.tokens.cache_create, 4)

    fs.mkdirSync(path.join(directory, '.agentflow', '.tmp'), { recursive: true })
    fs.writeFileSync(path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl'), [
      JSON.stringify({ ask: 'A-HEAD-COMPAT', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-HEAD-COMPAT', session_id: 'host', host: 'codex', ts: 200, event: 'close' }),
    ].join('\n') + '\n')
    const mixed_args = ['ccxray-summary', '--task', 'A-HEAD-COMPAT', '--project', 'p', '--config', config_path, '--format', 'json']
    const old_mixed_result = await run_metrics_file(head_path, mixed_args, { CCXRAY_ENDPOINT: endpoint })
    const current_mixed_result = await run_metrics_file(path.join(__dirname, 'metrics.js'), mixed_args, { CCXRAY_ENDPOINT: endpoint })
    assert.equal(old_mixed_result.status, 0)
    assert.equal(current_mixed_result.status, 0)
    const old_mixed_json = JSON.parse(old_mixed_result.stdout)
    const current_mixed_json = JSON.parse(current_mixed_result.stdout)
    assert_head_fields(old_mixed_json, current_mixed_json)
    assert.equal(current_mixed_json.calls, 2)
    assert.equal(current_mixed_json.cost_usd, 0.3)
    assert.equal(current_mixed_json.by_role.review.calls, 1)
    assert.equal(current_mixed_json.by_role.coordinator.calls, 1)
    assert.equal(current_mixed_json.coordinator.calls, 1)
    assert.equal(current_mixed_json.coordinator.sessions.length, 1)
    assert.equal(current_mixed_json.coordinator.sessions[0].session, 'host')
    assert.equal(current_mixed_json.coordinator.sessions[0].calls, 1)

    fs.appendFileSync(path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl'), `${JSON.stringify({ ask: 'A-HEAD-COMPAT-OPEN', session_id: 'host-open', host: 'codex', ts: 300, event: 'append-run' })}\n`)
    const open_result = await run_metrics_cli(['ccxray-summary', '--task', 'A-HEAD-COMPAT-OPEN', '--project', 'p', '--config', config_path, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(open_result.status, 0)
    assert.equal(open_result.stderr, '')
    const open_json = JSON.parse(open_result.stdout)
    assert.equal(open_json.coordinator.sessions[0].session, 'host-open')
    assert.equal(open_json.coordinator.sessions[0].from, 0)
    assert.equal(Number.isSafeInteger(open_json.coordinator.sessions[0].to), true)
  } finally {
    if (previous_endpoint === undefined) delete process.env.CCXRAY_ENDPOINT
    else process.env.CCXRAY_ENDPOINT = previous_endpoint
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('legacy JSON output surfaces invalid summary details instead of no_data', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (url.pathname === '/_api/health') {
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    const body = live_mixed_summary_fixture({ request: summary_request(url) })
    body.by_role.review.calls = 2
    res.end(JSON.stringify(body))
  })
  const directory = make_temp_dir('agentflow-ccxray-legacy-invalid-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    const log_path = path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl')
    fs.mkdirSync(path.dirname(log_path), { recursive: true })
    fs.writeFileSync(log_path, [
      JSON.stringify({ ask: 'A-LEGACY-INVALID', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-LEGACY-INVALID', session_id: 'host', host: 'codex', ts: 200, event: 'close' }),
    ].join('\n') + '\n')
    const result = await run_metrics_cli(['ccxray-summary', '--task', 'A-LEGACY-INVALID', '--project', 'p', '--config', config_path, '--format', 'json'], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), {
      available: false,
      reason: 'invalid_summary',
      detail: 'invariant I3 violated: coordinator calls 1 plus worker calls 2 does not equal wrapper calls 2',
    })
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('legacy JSON output drops nested unknowns and keeps scalar coordinator sessions', async () => {
  const { server, endpoint } = await start_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution', 'session-intervals', 'cost-charges'] }))
      return
    }
    const request = summary_request(url)
    const has_sessions = request.session_specs.length > 0
    const body = live_summary_fixture({
      request,
      task: 'A-LEGACY',
      role: request.role,
      project: 'p',
      calls: 1,
      cost_usd: 0.2,
      coordinator: has_sessions,
    })
    body.tools = { Bash: 1, unsafe: { prompt: 'SYNTHETIC_COUNTER' } }
    body.skills = { review: 2, unsafe: { credentials: 'SYNTHETIC_SKILL' } }
    body.coverage.credentials = { tool_arguments: 'SYNTHETIC_COVERAGE' }
    body.tokens.prompt = 'SYNTHETIC_TOKEN'
    body.charges[0].prompt = 'SYNTHETIC_CHARGE'
    if (has_sessions) {
      body.coordinator.sessions = body.coordinator.sessions.map(session => ({
        ...session,
        calls: 1,
        extra: {
          prompt: 'SYNTHETIC_SESSION_PROMPT',
          credentials: 'SYNTHETIC_SESSION_CREDENTIAL',
          tool_arguments: 'SYNTHETIC_SESSION_TOOL',
        },
      }))
    } else {
      body.by_role.review.sessions = [{
        session: { prompt: 'SYNTHETIC_WORKER_PROMPT' },
        from: { credentials: 'SYNTHETIC_WORKER_CREDENTIAL' },
        to: { tool_arguments: 'SYNTHETIC_WORKER_TOOL' },
        ignored: 'DROP',
      }]
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const directory = make_temp_dir('agentflow-ccxray-legacy-projection-')
  try {
    const config_path = path.join(directory, 'ag.json')
    fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: 'auto', 'workspace-dir': '.agentflow' } }))
    fs.mkdirSync(path.join(directory, '.agentflow', '.tmp'), { recursive: true })
    fs.writeFileSync(path.join(directory, '.agentflow', '.tmp', 'host-sessions.jsonl'), [
      JSON.stringify({ ask: 'A-LEGACY', session_id: 'host', host: 'codex', ts: 100, event: 'start' }),
      JSON.stringify({ ask: 'A-LEGACY', session_id: 'host', host: 'codex', ts: 200, event: 'close' }),
      JSON.stringify({ ask: 'A-LEGACY', session_id: 'host-2', host: 'codex', ts: 300, event: 'start' }),
      JSON.stringify({ ask: 'A-LEGACY', session_id: 'host-2', host: 'codex', ts: 400, event: 'close' }),
    ].join('\n') + '\n')

    const worker_result = await run_metrics_cli([
      'ccxray-summary', '--dry-run', '--task', 'A-LEGACY', '--role', 'review', '--project', 'p', '--config', config_path, '--no-coordinator', '--format', 'json',
    ], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(worker_result.status, 0)
    assert.equal(worker_result.stderr, '')
    const worker_output = JSON.parse(worker_result.stdout)
    assert.equal(Object.hasOwn(worker_output.by_role.review, 'sessions'), false)
    assert.deepEqual(worker_output.tools, { Bash: 1 })
    assert.deepEqual(worker_output.skills, { review: 2 })
    assert.deepEqual(worker_output.coverage, { entries_in_memory: 1, max_entries: 5000 })
    assert.doesNotMatch(JSON.stringify(worker_output), /SYNTHETIC_/u)

    const coordinator_result = await run_metrics_cli([
      'ccxray-summary', '--dry-run', '--task', 'A-LEGACY', '--project', 'p', '--config', config_path, '--format', 'json',
    ], { CCXRAY_ENDPOINT: endpoint })
    assert.equal(coordinator_result.status, 0)
    assert.equal(coordinator_result.stderr, '')
    const coordinator_output = JSON.parse(coordinator_result.stdout)
    assert.deepEqual(coordinator_output.coordinator.sessions.map(session => Object.keys(session).sort()), [
      ['calls', 'from', 'session', 'to'],
      ['calls', 'from', 'session', 'to'],
    ])
    assert.deepEqual(coordinator_output.coordinator.sessions.map(session => session.session), ['host', 'host-2'])
    assert.deepEqual(coordinator_output.coordinator.sessions.map(session => session.calls), [1, 1])
    assert.doesNotMatch(JSON.stringify(coordinator_output), /SYNTHETIC_/u)
  } finally {
    remove_temp_dir(directory)
    await close_server(server)
  }
})

test('enriches stages and never substitutes stage_id for the ccxray task id', async () => {
  const queries = []
  const { server, endpoint } = await start_validated_server((req, res) => {
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
        // Deliberately invalid body: this branch is never consumed by a task-less stage.
        res.end(JSON.stringify({ calls: 0 }))
        return
      }
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
        task: 'TASK-FOUND', role: 'cross-check', project: 'ipadpos', calls: 2, cost_usd: 0.02, cache_hit_rate: 0.5,
        tokens: { input: 'unavailable', output: 340, cache_read: 8, cache_create: 2, reasoning: 4, total: 'unavailable' },
        tools: { Bash: 1 }, tool_failures: 1, skills: { test: 1 }, models: [], agents: [], sessions: 1,
      })))
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
  const { server, endpoint } = await start_validated_server((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'ccxray', capabilities: ['task-attribution'] }))
      return
    }
    if (url.pathname === '/_api/task-summary') {
      queries.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(live_summary_fixture({
        request: summary_request(url),
        task: 'WORK-001', role: 'implementation', project: 'ipadpos', calls: 1, cost_usd: 0.1,
        tokens: { input: 1, output: 2, cache_read: 0, cache_create: 0, reasoning: 0, total: 3 }, models: [], agents: [], sessions: 1,
      })))
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
        touch_env: { CODEX_THREAD_ID: 'test-host' },
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
    touch_env: {},
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
      touch_env: {},
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
