'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')

const metrics = require('./ccxray-cost.js')
const { live_summary_fixture } = require('./ccxray-test-fixtures.js')

const make_root = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-ccxray-')))
const dispose = root => fs.rmSync(root, { recursive: true, force: true })

test('ccxray fixtures only add coordinator data for requested sessions and echo request identity', () => {
  const worker_request = { task: 'TASK-FIXTURE', project: null, role: 'review', session_specs: [] }
  for (const coordinator of [false, undefined, []]) {
    const body = live_summary_fixture({ request: worker_request, coordinator })
    assert.equal(Object.hasOwn(body, 'coordinator'), false)
    assert.equal(body.task, 'TASK-FIXTURE')
    assert.equal(body.project, null)
    assert.equal(body.role, 'review')
    assert.equal(Object.hasOwn(body.by_role, 'review'), true)
  }

  const default_body = live_summary_fixture({ request: { task: 'TASK-FIXTURE', project: null, session_specs: [] } })
  assert.equal(default_body.role, null)
  assert.equal(Object.hasOwn(default_body.by_role, 'review'), true)

  const session_request = { task: 'TASK-FIXTURE', project: null, role: null, session_specs: ['host@10-20'] }
  const session_body = live_summary_fixture({ request: session_request })
  assert.equal(Object.hasOwn(session_body, 'coordinator'), true)
  assert.equal(session_body.task, 'TASK-FIXTURE')
  assert.equal(session_body.project, null)
  assert.equal(session_body.role, null)
  assert.equal(Object.hasOwn(session_body.by_role, 'coordinator'), true)
})


const make_ccxray_summary = overrides => {
	const role_values = overrides.by_role === undefined
		? undefined
		: Object.fromEntries(Object.entries(overrides.by_role).map(([role, value]) => [role, {
			...live_summary_fixture({ role, calls: value.calls, cost_usd: value.cost_usd, tokens: value.tokens }).by_role[role],
			...value,
		}]))
	return live_summary_fixture({
		task: 'A-012',
		calls: 3,
		cost_usd: 0.0421,
		cache_hit_rate: 0.833,
		tokens: { input: 300, output: 45, cache: 1500, reasoning: 20, total: 1845 },
		tools: {},
		tool_failures: 0,
		skills: {},
		models: [],
		agents: [],
		...(role_values === undefined ? {} : { by_role: role_values }),
		...overrides,
		...(role_values === undefined ? {} : { by_role: role_values }),
	})
}

const live_scope_summary = ({ role = 'review', calls = 1, requests = calls, cost_usd = 0, charges, ...overrides } = {}) => {
	const fixture_calls = calls === 0 ? 1 : calls
	const fixture_cost = typeof cost_usd === 'number' ? cost_usd : Number(cost_usd)
	const fixture_charges = charges === undefined
		? undefined
		: charges.map((charge, index) => ({
			model: 'm',
			billing_provider: 'p',
			price_key: `m-${index}`,
			rate_source: 'ccxray',
			...charge,
		}))
	const source = live_summary_fixture({ role, calls: fixture_calls, cost_usd: fixture_cost, charges: fixture_charges }).by_role[role]
	return {
		...source,
		calls,
		requests,
		cost_usd: fixture_cost,
		cost_confidence: { priced: calls, unknown: 0, fallback: 0, no_usage: 0 },
		...(calls === 0 ? { last_ingested_at: null } : {}),
		...overrides,
	}
}

test('projects only validated ccxray observation fields and ignores wire aliases', () => {
  const clean_body = live_summary_fixture({ role: 'review', calls: 1, cost_usd: 0.1 })
  const dirty_body = {
    ...clean_body,
    requests: 999,
    summary: {},
    fallback_requests: 1,
    known_usd: '9',
    gaps: [{ code: 'forged', detail: 'forged' }],
    scope_id: 'x',
    by_role: {
      ...clean_body.by_role,
      review: {
        ...clean_body.by_role.review,
        requests: 999,
        summary: {},
        fallback_requests: 1,
        known_usd: '9',
        gaps: [{ code: 'forged', detail: 'forged' }],
        scope_id: 'x',
      },
    },
  }
  const context = {
    selected: 'review',
    capabilities: ['task-attribution', 'cost-charges'],
    ccxray_source: { instance_id: 'instance', ccxray_version: '2.3.1' },
  }
  const clean_projection = metrics.project_ccxray_observation(clean_body, context)
  const dirty_projection = metrics.project_ccxray_observation(dirty_body, context)
  assert.equal(JSON.stringify(dirty_projection), JSON.stringify(clean_projection))
  assert.deepEqual(Object.keys(clean_projection), [
    'requests', 'cost_usd', 'cost_confidence', 'uncomputable_requests', 'pending_requests',
    'last_ingested_at', 'charges', 'models', 'window', 'coverage', 'capabilities', 'ccxray_source',
  ])
  assert.equal(metrics.validate_ccxray_summary_body({
    ...clean_body,
    by_role: { review: { ...clean_body.by_role.review, models: { invalid: true } } },
  }), 'by_role.review.models must be an array of strings')
})

test('formats a role-filtered ccxray summary with model and agent attribution', () => {
	assert.deepEqual(metrics.format_ccxray_devlog_lines(make_ccxray_summary({
		models: ['gpt-5.5'],
		agents: ['codex'],
		by_role: {
			'cross-check': { calls: 2, cost_usd: 0.03, tokens: { total: 1200 } },
			implementation: { calls: 1, cost_usd: 0.0121, tokens: { total: 645 } },
		},
	}), { role: 'cross-check' }), [
		'- ccxray A-012/cross-check: 3 calls · $0.0421 · tokens in 300 / out 45 / cache 1500 (hit 83.3%) / total 1845 · gpt-5.5 via codex',
	])
})

test('formats unfiltered role totals and tools in stable sorted order', () => {
	assert.deepEqual(metrics.format_ccxray_devlog_lines(make_ccxray_summary({
		models: ['gpt-5.5'],
		agents: ['codex'],
		tools: { Edit: 1, Bash: 2 },
		tool_failures: 1,
		by_role: {
			implementation: { calls: 1, cost_usd: 0.0121, tokens: { total: 645 } },
			'cross-check': { calls: 2, cost_usd: 0.03, tokens: { total: 1200 } },
		},
	})), [
		'- ccxray A-012: 3 calls · $0.0421 · tokens in 300 / out 45 / cache 1500 (hit 83.3%) / total 1845 · gpt-5.5 via codex',
		'  - cross-check: 2 calls · $0.0300 · 1200 tokens',
		'  - implementation: 1 calls · $0.0121 · 645 tokens',
		'  - tools: Bash x2, Edit x1; failures: 1',
	])
})

test('formats empty model and agent lists and omits zero tool failures', () => {
	assert.deepEqual(metrics.format_ccxray_devlog_lines(make_ccxray_summary({
		tools: { Edit: 1, Bash: 2 },
	})), [
		'- ccxray A-012: 3 calls · $0.0421 · tokens in 300 / out 45 / cache 1500 (hit 83.3%) / total 1845',
		'  - tools: Bash x2, Edit x1',
	])
	assert.match(metrics.format_ccxray_devlog_lines(make_ccxray_summary({ models: ['gpt-5.5'] }))[0], /· gpt-5\.5$/)
	assert.match(metrics.format_ccxray_devlog_lines(make_ccxray_summary({ agents: ['codex'] }))[0], /· codex$/)
})

test('formats unavailable ccxray results with optional guidance and accepts empty input', () => {
	assert.deepEqual(metrics.format_ccxray_devlog_lines(null, {
		unavailable: { task: 'A-012', role: 'cross-check', reason: 'ccxray_not_found' },
	}), [
		'- ccxray A-012/cross-check: unavailable (ccxray_not_found)',
	])
	assert.deepEqual(metrics.format_ccxray_devlog_lines(undefined, {
		unavailable: { task: 'A-012', reason: 'no_data', guidance: ['Start ccxray.', 'Retry the command.'].join('\n') },
	}), [
		'- ccxray A-012: unavailable (no_data)',
		'  - Start ccxray.',
		'  - Retry the command.',
	])
	assert.deepEqual(metrics.format_ccxray_devlog_lines(), [])
	assert.deepEqual(metrics.format_ccxray_devlog_lines(null), [])
})

test('builds a self-sufficient receipt with exact decimal charge aggregation', () => {
	const exact_summary = live_scope_summary({
		role: 'cross-check',
		calls: 2,
		cost_usd: 0.000001,
		charges: [
			{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '1', usd_per_unit: '0.333333', usd: '0.000000333333', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' },
			{ model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: '1', usd_per_unit: '0.333333', usd: '0.000000333333', basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray' },
		],
	})
	const receipt = metrics.build_ccxray_receipt({
		kind: 'attempt',
		ask: 'A-012',
		project: 'agentflow',
		cutoff: '2026-09-20T10:00:00.000Z',
		source: {
			instance_id: 'ccxray-instance',
			ccxray_version: '0.9.0',
			exporter_version: '8.2.0',
			query: { task: 'A-012' },
		},
		scopes: [{
			id: 'attempt-cross-check-2',
			role: 'cross-check',
			attempt: 2,
			outcome: 'failed',
			selector: {
				labels: { task: 'A-012', role: 'cross-check', project: 'agentflow' },
				start_inclusive: '2026-09-20T09:59:00.000Z',
				end_exclusive: '2026-09-20T10:00:00.000Z',
			},
		}],
		summaries: [{ scope_id: 'attempt-cross-check-2', ...exact_summary }],
	})

	assert.equal(receipt.schema_version, 1)
	assert.equal(receipt.snapshot_id, '20260920t100000z-a-012-cross-check-a2')
	assert.equal(receipt.basis, 'modeled')
	assert.equal(receipt.reporting_tail_excluded, true)
	assert.equal(receipt.scopes[0].known_usd, '0.000000666666')
	assert.deepEqual(receipt.scopes[0].charges, [{
		model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens',
		quantity: '2', usd_per_unit: '0.333333', usd: '0.000000666666',
		basis: 'recorded', price_key: 'm-input', rate_source: 'ccxray',
	}])
	assert.deepEqual(receipt.gaps, [])
})

test('keeps exact receipt subtotals and rounds devlog USD once from rationals', () => {
  const make_receipt = (rate, kind) => {
    const known_usd = rate === '49.5' ? '0.0000495' : rate === '49.9' ? '0.0000499' : '0.00005'
    const scope = {
      id: 'attempt-review-role-1',
      role: 'review\nrole',
      attempt: 1,
      outcome: 'succeeded',
      selector: {
        start_inclusive: '2026-09-20T09:59:00.000Z',
        end_exclusive: '2026-09-20T10:00:00.000Z',
      },
    }
    const summary = live_scope_summary({
      role: scope.role,
      calls: 1,
      cost_usd: Number(known_usd),
      models: ['model\nname'],
      charges: [{
        model: 'bucket-model',
        billing_provider: 'p',
        component: 'input',
        quantity: '1',
        usd_per_unit: rate,
        basis: 'recorded',
      }],
    })
    const total_summary = live_summary_fixture({
      task: 'A-EXACT',
      role: null,
      calls: 1,
      cost_usd: Number(known_usd),
      by_role: { [scope.role]: live_summary_fixture({ role: scope.role, calls: 1, cost_usd: Number(known_usd) }).by_role[scope.role] },
    })
    return metrics.build_ccxray_receipt({
      kind,
      ask: 'A-EXACT',
      project: 'agentflow',
      cutoff: '2026-09-20T10:00:00.000Z',
      scopes: [scope],
      summaries: [summary],
      total_summary: kind === 'cumulative' ? total_summary : undefined,
    })
  }

  for (const [rate, amount, known_usd] of [
    ['49.5', '0.0000', '0.0000495'],
    ['49.9', '0.0000', '0.0000499'],
    ['50', '0.0001', '0.00005'],
  ]) {
    const cumulative = make_receipt(rate, 'cumulative')
    assert.equal(cumulative.scopes[0].known_usd, known_usd)
    assert.deepEqual(cumulative.scopes[0].models, ['model\nname'])
    const cumulative_lines = metrics.format_ccxray_devlog_lines(cumulative)
    assert.equal(cumulative_lines[0].includes(`USD ${amount}`), true)
    assert.equal(cumulative_lines.some(line => line.includes(`USD ${amount}`) && line.includes('review role')), true)
    assert.equal(cumulative_lines.some(line => line.includes(`input: USD ${amount}`)), true)

    const attempt_lines = metrics.format_ccxray_devlog_lines(make_receipt(rate, 'attempt'))
    assert.equal(attempt_lines[0].includes(`USD ${amount}`), true)
    assert.equal(attempt_lines[0].includes('review role'), true)
    assert.equal(attempt_lines[0].includes('model name'), true)
    assert.equal(attempt_lines.some(line => /[\r\n]/u.test(line)), false)
  }
})

test('uses ccxray request confidence for zero-cost knowledge and counters', () => {
  const zero = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-ZERO',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-zero-1', role: 'review', attempt: 1, outcome: 'succeeded', selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [live_scope_summary({ requests: 1, calls: 1, cost_usd: 0, models: ['summary-model'], charges: [], cost_confidence: { priced: 1, unknown: 0, fallback: 0, no_usage: 0 } })],
  })
  assert.equal(zero.scopes[0].known_usd, '0')
  assert.equal(zero.scopes[0].priced_requests, 1)
  assert.match(metrics.format_ccxray_devlog_lines(zero)[0], /USD 0\.0000 · 1 requests · summary-model/u)
  assert.doesNotMatch(metrics.format_ccxray_devlog_lines(zero)[0], /unknown/u)

  const fallback_charges = ['input', 'output', 'cache_read', 'cache_create'].map(component => ({
    model: 'bucket-model',
    billing_provider: 'p',
    component,
    quantity: '1',
    usd_per_unit: '1',
    basis: 'fallback',
  }))
  const fallback = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-FALLBACK',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-fallback-1', role: 'review', attempt: 1, outcome: 'succeeded', selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.000004, cost_confidence: { priced: 1, unknown: 0, fallback: 1, no_usage: 0 }, charges: fallback_charges })],
  })
  assert.equal(fallback.scopes[0].fallback_requests, 1)
  assert.match(fallback.gaps.find(gap => gap.code === 'fallback_rate').detail, /^1 request used/u)
  assert.doesNotMatch(metrics.format_ccxray_devlog_lines(fallback).at(-1), /4 requests used/u)
  assert.match(metrics.format_ccxray_devlog_lines({
    task: 'A-COMPLETENESS',
    calls: 1,
    cost_usd: 0.1,
    cost_confidence: { priced: 1, unknown: 0, fallback: 0, no_usage: 0 },
    uncomputable_requests: 0,
    completeness_unknown: true,
    tokens: { input: 1, output: 1, cache: 0, total: 2 },
  })[0], /\$0\.1000\+/u)
})

test('whitelists optional receipt entries without persisting raw source content', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-ENTRY',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, outcome: 'succeeded', selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [{ requests: 0, charges: [] }],
    entries: [{
      id: 'entry-1',
      received_at: '2026-09-20T10:00:00.000Z',
      model: 'm',
      role: 'review',
      requests: 1,
      usage: { input: 1, output: 2, cache_read: 3, cache_create: 4, prompt: 'SYNTHETIC_PROMPT' },
      cost_usd: '0.1',
      prompt: 'SYNTHETIC_PROMPT',
      credentials: 'SYNTHETIC_SECRET',
      tool_arguments: { secret: true },
      cwd: '/Users/synthetic/outside-workspace',
    }],
  })
  assert.deepEqual(receipt.entries, [{
    id: 'entry-1',
    received_at: '2026-09-20T10:00:00.000Z',
    model: 'm',
    role: 'review',
    requests: 1,
    usage: { input: 1, output: 2, cache_read: 3, cache_create: 4 },
    cost_usd: '0.1',
  }])
  assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_PROMPT|SYNTHETIC_SECRET|outside-workspace/u)
})

test('records an arithmetic mismatch when a ccxray total disagrees beyond tolerance', () => {
	const receipt = metrics.build_ccxray_receipt({
		kind: 'attempt', ask: 'A-013', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z',
		scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, outcome: 'succeeded', selector: {
			start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
		} }],
		summaries: [{ scope_id: 'attempt-review-1', ...live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.2, charges: [{
			model: 'm', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded',
		}] }) }],
	})
	assert.equal(receipt.scopes[0].known_usd, '0.1')
	assert.equal(receipt.gaps.some(gap => gap.code === 'arithmetic_mismatch' && gap.scope_id === 'attempt-review-1'), true)
	assert.match(metrics.format_ccxray_devlog_lines(receipt).at(-1), /recomputed USD 0\.1/u)
})

test('receipt arithmetic compares scope charges with each scope cost, not the labelled task total', () => {
	const scopes = [
		{ id: 'coordinator#1', role: 'coordinator', attempt: 0, selector: { session_id: 'host-1', start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } },
		{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: { labels: { task: 'A-015', role: 'review', project: 'agentflow' }, start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } },
	]
	const receipt = metrics.build_ccxray_receipt({
		kind: 'cumulative', ask: 'A-015', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z', scopes,
			summaries: [
				{ scope_id: 'coordinator#1', ...live_scope_summary({ role: 'coordinator', requests: 1, calls: 1, cost_usd: 0.1, charges: [{ model: 'coord', billing_provider: 'p', component: 'output', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] }) },
				{ scope_id: 'attempt-review-1', ...live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.2, charges: [{ model: 'worker', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.2', basis: 'recorded' }] }) },
			],
			total_summary: live_summary_fixture({ calls: 1, cost_usd: 0.2, by_role: { review: live_summary_fixture({ role: 'review', calls: 1, cost_usd: 0.2 }).by_role.review } }),
	})

	assert.equal(receipt.gaps.some(gap => gap.code === 'arithmetic_mismatch'), false)

	const scope_mismatch = metrics.build_ccxray_receipt({
		kind: 'attempt', ask: 'A-016', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z',
		scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: { start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } }],
			summaries: [{ scope_id: 'attempt-review-1', ...live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.2, charges: [{ model: 'worker', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] }) }],
	})
	assert.equal(scope_mismatch.gaps.some(gap => gap.code === 'arithmetic_mismatch' && gap.scope_id === 'attempt-review-1'), true)
})

test('cumulative receipts expose unscoped labelled requests and preserve overlap', () => {
	const coordinator_scope = { id: 'coordinator#1', role: 'coordinator', attempt: 0, outcome: 'succeeded', selector: { session_id: 'host-1', start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } }
	const unscoped = metrics.build_ccxray_receipt({
		kind: 'cumulative', ask: 'A-017', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z', scopes: [coordinator_scope],
		summaries: [{ scope_id: 'coordinator#1', ...live_scope_summary({ role: 'coordinator', requests: 0, calls: 0, cost_usd: 0, charges: [] }) }],
		total_summary: live_summary_fixture({ calls: 26, cost_usd: 2.0169, by_role: { 'cross-check': live_summary_fixture({ role: 'cross-check', calls: 26, cost_usd: 2.0169 }).by_role['cross-check'] } }),
	})
	const unscoped_gap = unscoped.gaps.find(gap => gap.code === 'unscoped_requests')
	assert.ok(unscoped_gap)
	assert.equal(unscoped_gap.detail, '26 labelled requests (USD 2.0169) fall outside every recorded attempt; cross-check: 26 requests, USD 2.0169')
	assert.doesNotMatch(unscoped_gap.detail, /[\u0000-\u001f\u007f]/u)
	const unscoped_gaps_line = metrics.format_ccxray_devlog_lines(unscoped).find(line => line.startsWith('  - gaps: '))
	assert.match(unscoped_gaps_line, /total: 26 labelled requests \(USD 2\.0169\) fall outside every recorded attempt; cross-check: 26 requests, USD 2\.0169/u)
	assert.match(metrics.format_ccxray_devlog_lines(unscoped)[0], /USD unknown\+/u)

	const scoped = metrics.build_ccxray_receipt({
		kind: 'cumulative', ask: 'A-018', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z',
		scopes: [{ id: 'attempt-cross-check-1', role: 'cross-check', attempt: 1, outcome: 'succeeded', selector: { labels: { task: 'A-018', role: 'cross-check', project: 'agentflow' }, start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } }],
		summaries: [{ scope_id: 'attempt-cross-check-1', ...live_scope_summary({ role: 'cross-check', requests: 26, calls: 26, cost_usd: 2.0169, charges: [{ model: 'worker', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '2.0169', basis: 'recorded' }] }) }],
		total_summary: live_summary_fixture({ calls: 26, cost_usd: 2.0169, by_role: { 'cross-check': live_summary_fixture({ role: 'cross-check', calls: 26, cost_usd: 2.0169 }).by_role['cross-check'] } }),
	})
	assert.equal(scoped.gaps.some(gap => gap.code === 'unscoped_requests' || gap.code === 'scope_overlap'), false)
	assert.doesNotMatch(metrics.format_ccxray_devlog_lines(scoped)[0], /\+/u)

	const overlap = metrics.build_ccxray_receipt({
		kind: 'cumulative', ask: 'A-019', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z',
		scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: { labels: { task: 'A-019', role: 'review', project: 'agentflow' }, start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' } }],
		summaries: [{ scope_id: 'attempt-review-1', ...live_scope_summary({ requests: 3, calls: 3, cost_usd: 0, charges: [] }) }],
		total_summary: live_summary_fixture({ calls: 2, cost_usd: 0, by_role: {} }),
	})
	const overlap_gap = overlap.gaps.find(gap => gap.code === 'scope_overlap')
	assert.ok(overlap_gap)
  assert.doesNotMatch(overlap_gap.detail, /-\d/u)
  assert.equal(overlap.gaps.some(gap => gap.code === 'completeness_unknown'), true)
})

test('receipt serialization failures are explicit and devlog keeps the failure gap', () => {
  const receipt = {
    kind: 'attempt',
    ask: 'A-SERIALIZE',
    cutoff: '2026-09-20T10:00:00.000Z',
    snapshot_id: 'serializable',
    scopes: [],
    gaps: [],
    source: { query: {} },
  }
  receipt.source.query.cycle = receipt
  assert.throws(() => metrics.serialize_ccxray_receipt(receipt), error => error.message === 'receipt_serialization_failed')
  assert.equal(metrics.mark_receipt_serialization_failure(receipt), true)
  assert.deepEqual(receipt.gaps, [{ scope_id: null, code: 'receipt_serialization_failed', detail: 'receipt serialization failed' }])
  assert.match(metrics.format_ccxray_devlog_lines(receipt).join('\n'), /receipt serialization failed/u)
})

test('negativeUsdRole produces overlap and completeness gaps without negative numerals', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-ROUND-11',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{
      id: 'attempt-review-1',
      role: 'review',
      attempt: 1,
      selector: { start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' },
    }],
    summaries: [{
      scope_id: 'attempt-review-1',
      ...live_scope_summary({ requests: 2, calls: 2, cost_usd: 0.3, charges: [{ model: 'm', component: 'input', quantity: '3000000', usd_per_unit: '0.1', usd: '0.3', basis: 'recorded' }] }),
    }],
    total_summary: live_summary_fixture({
      calls: 3,
      cost_usd: 0.7,
      charges: [{ model: 'm', component: 'input', quantity: '7000000', usd_per_unit: '0.1', usd: '0.7', basis: 'recorded' }],
      by_role: {
        review: live_summary_fixture({ role: 'review', calls: 1, cost_usd: 0.1, charges: [{ model: 'm', component: 'input', quantity: '1000000', usd_per_unit: '0.1', usd: '0.1', basis: 'recorded' }] }).by_role.review,
        'cross-check': live_summary_fixture({ role: 'cross-check', calls: 2, cost_usd: 0.6, charges: [{ model: 'm', component: 'input', quantity: '6000000', usd_per_unit: '0.1', usd: '0.6', basis: 'recorded' }] }).by_role['cross-check'],
      },
    }),
  })
  assert.equal(receipt.gaps.some(gap => gap.code === 'scope_overlap'), true)
  assert.equal(receipt.gaps.some(gap => gap.code === 'completeness_unknown'), true)
  for (const gap of receipt.gaps) assert.doesNotMatch(gap.detail, /-\d/u)
  assert.match(metrics.format_ccxray_devlog_lines(receipt)[0], /≥ 2 requests/u)
})

test('marks a recorded charge with missing usage as an uncomputable request', () => {
	const receipt = metrics.build_ccxray_receipt({
		kind: 'attempt', ask: 'A-014', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z',
		scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, outcome: 'succeeded', selector: {
			start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
		} }],
		summaries: [{ scope_id: 'attempt-review-1', ...live_scope_summary({ requests: 1, calls: 1, cost_usd: 0, cost_confidence: { priced: 0, unknown: 0, fallback: 0, no_usage: 1 }, charges: [{
			model: 'm', billing_provider: 'p', component: 'input', quantity: null, usd_per_unit: '0.1', basis: 'recorded',
		}] }) }],
	})
	assert.equal(receipt.gaps[0].code, 'missing_usage_requests')
	assert.match(metrics.format_ccxray_devlog_lines(receipt)[0], /USD unknown\+ /u)
})

test('marks unpriced charge buckets even when priced request counts are positive', () => {
  const scope = {
    id: 'attempt-review-1',
    role: 'review',
    attempt: 1,
    selector: { start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' },
  }
  const base = live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.1, cost_confidence: { priced: 1, unknown: 0, fallback: 0, no_usage: 0 }, charges: [] })
  const no_rate = metrics.build_ccxray_receipt({
    kind: 'attempt', ask: 'A-UNPRICED', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z', scopes: [scope],
    summaries: [{ ...base, charges: [{ model: 'm', component: 'input', quantity: '1000000', usd_per_unit: null, usd: null, basis: 'unpriced' }] }],
  })
  assert.equal(no_rate.scopes[0].known_usd, '0')
  assert.equal(no_rate.gaps.some(gap => gap.code === 'unpriced_charges'), true)
  assert.match(metrics.format_ccxray_devlog_lines(no_rate)[0], /USD unknown\+/u)

  const partial = metrics.build_ccxray_receipt({
    kind: 'attempt', ask: 'A-PARTIAL', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z', scopes: [scope],
    summaries: [{ ...base, cost_usd: 0.3, uncomputable_requests: 1, charges: [
      { model: 'm', component: 'input', quantity: '1000000', usd_per_unit: '0.1', usd: '0.1', basis: 'recorded' },
      { model: 'm', component: 'output', quantity: '1000000', usd_per_unit: null, usd: null, basis: 'unpriced' },
    ] }],
  })
  assert.equal(partial.scopes[0].known_usd, '0.1')
  assert.equal(partial.gaps.find(gap => gap.code === 'unpriced_charges').detail, '1 request has charges without a rate')
  assert.match(metrics.format_ccxray_devlog_lines(partial)[0], /USD 0\.1000\+/u)

  const complete = metrics.build_ccxray_receipt({
    kind: 'attempt', ask: 'A-COMPLETE', project: 'agentflow', cutoff: '2026-09-20T10:00:00.000Z', scopes: [scope],
    summaries: [{ ...base, charges: [{ model: 'm', component: 'input', quantity: '1000000', usd_per_unit: '0.1', usd: '0.1', basis: 'recorded' }] }],
  })
  assert.equal(complete.gaps.some(gap => gap.code === 'unpriced_charges'), false)
  assert.doesNotMatch(metrics.format_ccxray_devlog_lines(complete)[0], /\+/u)
})

test('writes receipts write-once and creates a private-by-default evidence ignore file', () => {
	const root = make_root()
	try {
		const receipt = {
			schema_version: 1,
			snapshot_id: '20260920t100000z-a-012-cross-check-a2',
		}
		const first = metrics.write_ccxray_receipt(receipt, { workspace_dir: root })
		assert.equal(fs.readFileSync(path.join(root, '.agentflow', 'evidence', 'ccxray', '.gitignore'), 'utf8'), '*\n')
		assert.deepEqual(JSON.parse(fs.readFileSync(first, 'utf8')), receipt)
		const second = metrics.write_ccxray_receipt(receipt, { workspace_dir: root })
		assert.notEqual(second, first)
		assert.match(second, /20260920t100000z-a-012-cross-check-a2-2\.json$/u)
		assert.equal(receipt.snapshot_id, '20260920t100000z-a-012-cross-check-a2-2')
		assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')), receipt)
	} finally {
		dispose(root)
	}
})

test('does not create an ignore file in an existing opted-in receipt directory', () => {
  const root = make_root()
  try {
    const directory = path.join(root, '.agentflow', 'evidence', 'ccxray')
    fs.mkdirSync(directory, { recursive: true })
    const receipt = { schema_version: 1, snapshot_id: '20260920t100000z-a-012-cumulative' }
    const target = metrics.write_ccxray_receipt(receipt, { workspace_dir: root })
    assert.equal(fs.existsSync(path.join(directory, '.gitignore')), false)
    assert.equal(fs.existsSync(target), true)
  } finally {
    dispose(root)
  }
})

test('formats receipt attempt and cumulative blocks with exact marks and conditional gaps', () => {
	const attempt = {
		schema_version: 1,
		snapshot_id: '20260920t100000z-a-012-cross-check-a2',
		ask: 'A-012', project: 'agentflow', kind: 'attempt', generated_at: '2026-09-20T10:00:00.000Z', cutoff: '2026-09-20T10:00:00.000Z',
		basis: 'modeled', reporting_tail_excluded: true, source: { instance_id: 'i', ccxray_version: 'v', exporter_version: 'v', query: {} },
		scopes: [{ id: 'attempt-cross-check-2', role: 'cross-check', attempt: 2, outcome: 'failed', selector: { labels: { task: 'A-012', role: 'cross-check', project: 'agentflow' }, start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' }, requests: 3, missing_usage_requests: 0, unpriced_requests: 1, pending_requests: 1, fallback_requests: 1, last_ingested_at: '2026-09-20T10:00:00.000Z', known_usd: '0.300000', charges: [{ model: 'm', billing_provider: 'p', component: 'output', unit: 'tokens', quantity: '1000000', usd_per_unit: '0.3', usd: '0.3', basis: 'fallback', price_key: 'm-output', rate_source: 'default' }, { model: 'm', billing_provider: 'p', component: 'input', unit: 'tokens', quantity: null, usd_per_unit: null, usd: null, basis: 'unpriced', price_key: null, rate_source: null }] }],
		gaps: [
			{ scope_id: 'attempt-cross-check-2', code: 'pending_requests', detail: '1 request is still pending' },
			{ scope_id: 'attempt-cross-check-2', code: 'unpriced_requests', detail: '1 request is unpriced' },
			{ scope_id: 'attempt-cross-check-2', code: 'fallback_rate', detail: '1 request used a fallback rate' },
		],
	}
	assert.deepEqual(metrics.format_ccxray_devlog_lines(attempt), [
		'- ccxray A-012/cross-check attempt 2 (failed): USD 0.3000~+ · 3 requests · m · through 10:00:00Z · receipt 20260920t100000z-a-012-cross-check-a2',
		'  - gaps: attempt-cross-check-2: 1 request is still pending; attempt-cross-check-2: 1 request is unpriced; attempt-cross-check-2: 1 request used a fallback rate',
	])

	const cumulative = { ...attempt, kind: 'cumulative', snapshot_id: '20260920t100000z-a-012-cumulative', scopes: [
		{ ...attempt.scopes[0], id: 'attempt-cross-check-1', attempt: 1, outcome: 'succeeded', requests: 2, known_usd: '0.200000', charges: [{ ...attempt.scopes[0].charges[0], component: 'input', usd_per_unit: '0.2', usd: '0.2', quantity: '1000000', basis: 'recorded' }] },
		{ ...attempt.scopes[0], id: 'attempt-cross-check-2', attempt: 2 },
	], gaps: [] }
	assert.deepEqual(metrics.format_ccxray_devlog_lines(cumulative), [
		'- ccxray A-012 cumulative: USD 0.5000 · 5 requests · through 10:00:00Z · excludes reporting tail · receipt 20260920t100000z-a-012-cumulative',
		'  - cross-check: USD 0.5000 · 5 requests · 2 attempts (1 failed) · m',
		'  - cost components: output: USD 0.3000; input: USD 0.2000',
	])
})

test('formats coordinator cumulative roles as intervals with open counts', () => {
	const receipt = {
		kind: 'cumulative', ask: 'A-020', cutoff: '2026-09-20T10:00:00.000Z', snapshot_id: 'receipt',
		scopes: [
			{ id: 'coordinator#1', role: 'coordinator', outcome: 'succeeded', requests: 1, charges: [{ model: 'm', component: 'input', usd: '0.1', basis: 'recorded' }] },
			{ id: 'coordinator#2', role: 'coordinator', outcome: 'running', requests: 1, charges: [{ model: 'm', component: 'input', usd: '0.2', basis: 'recorded' }] },
		],
		gaps: [{ scope_id: 'coordinator#2', code: 'interval_still_open', detail: 'coordinator interval is still open at the snapshot cutoff' }],
	}
	assert.equal(metrics.format_ccxray_devlog_lines(receipt)[1], '  - coordinator: USD 0.3000 · 2 requests · 2 intervals (1 open) · m')
})

test('sets automatic supersedes links for every same-id receipt reissue', () => {
  const root = make_root()
  try {
    const first = { schema_version: 1, snapshot_id: '20260920t100000z-a-021-review-a1' }
    const first_path = metrics.write_ccxray_receipt(first, { workspace_dir: root })
    const second = { schema_version: 1, snapshot_id: first.snapshot_id }
    const second_path = metrics.write_ccxray_receipt(second, { workspace_dir: root })
    const third = { schema_version: 1, snapshot_id: first.snapshot_id }
    const third_path = metrics.write_ccxray_receipt(third, { workspace_dir: root })

    assert.equal(JSON.parse(fs.readFileSync(first_path, 'utf8')).supersedes, undefined)
    assert.equal(JSON.parse(fs.readFileSync(second_path, 'utf8')).supersedes, first.snapshot_id)
    assert.equal(JSON.parse(fs.readFileSync(third_path, 'utf8')).supersedes, second.snapshot_id)
  } finally {
    dispose(root)
  }
})

test('deeply whitelists optional receipt entry field types', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-022',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [{ requests: 0, charges: [] }],
    entries: [{
      id: 'safe',
      model: { prompt: 'NESTED_PROMPT_SENTINEL' },
      role: ['review'],
      received_at: { nested: true },
      requests: '1',
      usage: {
        input: { credentials: 'NESTED_SECRET_SENTINEL' },
        output: 2,
        cache_read: -1,
        cache_create: 3,
      },
      cost_usd: { amount: '0.1' },
    }, {
      id: 'valid',
      model: 'm',
      role: 'review',
      received_at: 123,
      requests: 1,
      usage: { input: 1, output: 2 },
      cost_usd: '0.1',
    }],
  })

  assert.deepEqual(receipt.entries, [
    { id: 'safe', usage: { output: 2, cache_create: 3 } },
    { id: 'valid', model: 'm', role: 'review', received_at: 123, requests: 1, usage: { input: 1, output: 2 }, cost_usd: '0.1' },
  ])
  assert.doesNotMatch(JSON.stringify(receipt), /NESTED_PROMPT_SENTINEL|NESTED_SECRET_SENTINEL/u)
})

test('scales receipt total arithmetic tolerance with the number of costed scopes', () => {
  const scopes = [0, 1].map(index => ({
    id: `scope-${index}`,
    role: `role-${index}`,
    attempt: 1,
    selector: { start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z' },
  }))
  const rounded = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-023',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes,
    summaries: scopes.map(scope => ({
      scope_id: scope.id,
      ...live_scope_summary({ role: scope.role, requests: 1, calls: 1, cost_usd: 0, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '1', usd_per_unit: '40', basis: 'recorded' }] }),
    })),
  })
  assert.equal(rounded.gaps.some(gap => gap.code === 'arithmetic_mismatch'), false)

  const wrong = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-024',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [scopes[0]],
    summaries: [{
      scope_id: scopes[0].id,
      ...live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.1, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '5000000', usd_per_unit: '0.1', basis: 'recorded' }] }),
    }],
  })
  assert.equal(wrong.gaps.some(gap => gap.code === 'arithmetic_mismatch' && gap.scope_id === scopes[0].id), true)
})

test('does not mark a fully computable pending request with plus', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'attempt',
    ask: 'A-025',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.1, pending_requests: 1, cost_confidence: { priced: 1, unknown: 0, fallback: 0, no_usage: 0 }, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] })],
  })
  const lines = metrics.format_ccxray_devlog_lines(receipt)
  assert.doesNotMatch(lines[0], /USD 0\.1000\+/u)
  assert.match(lines.at(-1), /pending/u)
})

test('makes an aggregate amount unknown when any scope query fails', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-026b',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [
      { id: 'coordinator-1', role: 'coordinator', attempt: 0, selector: {
        start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
      } },
      { id: 'attempt-review-1', role: 'review', attempt: 1, selector: {
        start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
      } },
    ],
    summaries: [
      { scope_query_failed: 'HTTP 503', gaps: [{ scope_id: 'coordinator-1', code: 'scope_query_failed', detail: 'HTTP 503' }] },
      live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.1, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] }),
    ],
    total_summary: live_summary_fixture({ calls: 1, cost_usd: 0.1, by_role: { review: live_summary_fixture({ role: 'review', calls: 1, cost_usd: 0.1 }).by_role.review } }),
  })
  const lines = metrics.format_ccxray_devlog_lines(receipt)
  assert.match(lines[0], /USD unknown\+/u)
  assert.match(lines.find(line => line.includes('review:')), /USD 0\.1000/u)
})

test('prints unknown or lower-bound requests and does not attribute failed scopes as unscoped', () => {
  const failed_scope_id = 'attempt-review-2'
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-026c',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [
      { id: 'attempt-review-1', role: 'review', attempt: 1, selector: {
        start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
      } },
      { id: failed_scope_id, role: 'review', attempt: 2, selector: {
        start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
      } },
    ],
    summaries: [
      live_scope_summary({ requests: 1, calls: 1, cost_usd: 0.1, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '1000000', usd_per_unit: '0.1', basis: 'recorded' }] }),
      { scope_query_failed: 'HTTP 503', gaps: [{ scope_id: failed_scope_id, code: 'scope_query_failed', detail: 'HTTP 503' }] },
    ],
    total_summary: live_summary_fixture({ calls: 2, cost_usd: 0.3, by_role: { review: live_summary_fixture({ role: 'review', calls: 2, cost_usd: 0.3 }).by_role.review } }),
  })
  const lines = metrics.format_ccxray_devlog_lines(receipt)
  assert.match(lines[0], /USD unknown\+ · ≥ 1 requests/u)
  assert.match(lines.find(line => line.includes('review:')), /≥ 1 requests/u)
  assert.equal(receipt.gaps.some(gap => gap.code === 'unscoped_requests'), false)
  assert.equal(receipt.gaps.some(gap => gap.code === 'completeness_unknown' && gap.detail.includes(failed_scope_id)), true)
})

test('discloses a failed task-wide query and marks the scoped total as a lower bound', () => {
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-026d',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'attempt-review-1', role: 'review', attempt: 1, selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [live_scope_summary({ requests: 2, calls: 2, cost_usd: 0.3, charges: [{ model: 'm', billing_provider: 'p', component: 'input', quantity: '3000000', usd_per_unit: '0.1', basis: 'recorded' }] })],
    task_summary_failures: [{ project: 'agentflow', detail: 'HTTP 503' }],
    source: { query: { failures: [{ project: 'agentflow', detail: 'HTTP 503' }] } },
  })
  const gap = receipt.gaps.find(value => value.code === 'task_summary_query_failed')
  assert.deepEqual(gap, {
    scope_id: null,
    code: 'task_summary_query_failed',
    detail: 'HTTP 503: completeness of worker attribution could not be checked',
    })
  assert.match(metrics.format_ccxray_devlog_lines(receipt)[0], /USD 0\.3000\+/u)
  assert.match(metrics.format_ccxray_devlog_lines(receipt)[0], /USD 0\.3000\+ · ≥ 2 requests/u)
  assert.match(metrics.format_ccxray_devlog_lines(receipt).at(-1), /completeness of worker attribution could not be checked/u)
})

test('sanitizes gap details and scope ids before writing devlog lines', () => {
  const evil_role = 'review\n  - forged: injected'
  const receipt = metrics.build_ccxray_receipt({
    kind: 'cumulative',
    ask: 'A-026',
    project: 'agentflow',
    cutoff: '2026-09-20T10:00:00.000Z',
    scopes: [{ id: 'scope\n  - forged', role: evil_role, attempt: 1, selector: {
      start_inclusive: '2026-09-20T09:59:00.000Z', end_exclusive: '2026-09-20T10:00:00.000Z',
    } }],
    summaries: [live_scope_summary({ role: evil_role, requests: 0, calls: 0, cost_usd: 0, charges: [] })],
    total_summary: live_summary_fixture({ calls: 1, cost_usd: 0.1, by_role: { [evil_role]: live_summary_fixture({ role: evil_role, calls: 1, cost_usd: 0.1 }).by_role[evil_role] } }),
  })
  const lines = metrics.format_ccxray_devlog_lines(receipt)
  assert.equal(lines.some(line => /[\r\n]/u.test(line)), false)
  assert.equal(receipt.gaps.some(gap => /[\r\n]/u.test(gap.detail)), false)
  assert.equal(lines.some(line => /^\s*- forged:/u.test(line)), false)
  assert.match(lines.at(-1), /1 labelled request/u)
})

test('sanitizes ordinary devlog string fields before interpolation', () => {
  const evil_role = 'review\n  - forged: injected'
  const lines = metrics.format_ccxray_devlog_lines({
    task: 'A-027\nforged-task',
    role: evil_role,
    calls: 1,
    cost_usd: '0.1',
    tokens: { input: 1, output: 2, cache: 0, total: 3 },
    models: ['model\nforged-model'],
    agents: ['agent\nforged-agent'],
    as_of: '2026-09-20T10:00:00.000Z\nforged-time',
    by_role: {
      coordinator: { calls: 0, cost_usd: '0' },
      [evil_role]: { calls: 1, cost_usd: '0.1' },
    },
    tools: { 'tool\nforged-tool': 1 },
  })
  assert.equal(lines.some(line => /[\r\n]/u.test(line)), false)
  assert.equal(lines.some(line => /^\s*- forged:/u.test(line)), false)
  assert.equal(lines.some(line => line.includes('forged-model') && line.startsWith('  - forged')), false)
})
