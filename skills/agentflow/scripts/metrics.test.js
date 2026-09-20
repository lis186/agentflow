'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')

const metrics = require('./metrics.js')
const record_completed = options => metrics.record_completed_work_item({
	...options,
	final_acceptance_complete: true,
	final_report_complete: true,
})

const make_root = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-metrics-')))
const dispose = root => fs.rmSync(root, { recursive: true, force: true })
const write_config = (root, mode) => {
	const config_path = path.join(root, 'ag.json')
	fs.writeFileSync(config_path, JSON.stringify({ switches: { metrics: mode } }) + '\n')
	return config_path
}

const make_stage = (stage_id, defect_id, overrides = {}) => metrics.create_stage_metrics({
	stage_id,
	stage_kind: overrides.stage_kind || 'review',
	started_at: overrides.started_at || '2026-08-23T11:00:00.000Z',
	ended_at: overrides.ended_at || '2026-08-23T11:00:02.500Z',
	retries: overrides.retries === undefined ? 1 : overrides.retries,
	transport_failures: overrides.transport_failures === undefined ? 1 : overrides.transport_failures,
	transport_failure_elapsed_ms: overrides.transport_failure_elapsed_ms === undefined ? 300 : overrides.transport_failure_elapsed_ms,
	provider_tokens: overrides.provider_tokens || { input: 10, output: 20 },
	visible_text_token_estimate: overrides.visible_text_token_estimate,
	defects: overrides.defects || [{
		defect_id,
		severity: overrides.severity || 'cosmetic',
		changed_product_behavior: overrides.changed_product_behavior || false,
		duplicate_of: overrides.duplicate_of || null,
	}],
})

const make_work_item = (work_item_id, stage, overrides = {}) => metrics.create_work_item_metrics({
	work_item_id,
	completed_at: overrides.completed_at || '2026-08-23T11:01:00.000Z',
	acceptance_result: overrides.acceptance_result || 'passed',
	stages: [stage],
	waiting_elapsed_ms: overrides.waiting_elapsed_ms || 0,
})

test('metrics off keeps the baseline and does not create history', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'off')
		const history_path = metrics.history_path_for(config_path)
		let factory_calls = 0
		const result = metrics.record_completed_work_item({
			config_path,
			record_factory: () => {
				factory_calls += 1
				return make_work_item('off-work', make_stage('off-stage', 'off-defect'))
			},
		})

		assert.equal(result.recorded, false)
		assert.equal(result.reason, 'metrics_disabled')
		assert.equal(factory_calls, 0)
		assert.equal(fs.existsSync(history_path), false)

		write_config(root, 'on')
		const enabled = record_completed({
			config_path,
			record_factory: () => {
				factory_calls += 1
				return make_work_item('on-work', make_stage('on-stage', 'on-defect'))
			},
		})
		assert.equal(enabled.recorded, true)
		assert.equal(factory_calls, 1)
	} finally {
		dispose(root)
	}
})

test('metrics on records exact local elapsed time and honest provider fields', () => {
	const stage = make_stage('stage-1', 'defect-1', {
		visible_text_token_estimate: 8,
	})

	assert.equal(stage.elapsed_ms, 2500)
	assert.equal(stage.transport_failure_elapsed_ms, 300)
	assert.deepEqual(stage.provider_tokens, {
		input: 10,
		output: 20,
		cache: 'unavailable',
		reasoning: 'unavailable',
		total: 'unavailable',
	})
	assert.deepEqual(stage.visible_text_token_estimate, { value: 8, label: 'estimate' })
	const report = metrics.build_metrics_report([make_work_item('work-1', stage)])
	assert.equal(report.provider_tokens.total, 'unavailable')
	assert.deepEqual(report.visible_text_token_estimate, { value: 8, label: 'estimate' })
})

test('stable work-item and stage identities survive retries', () => {
	const first = make_work_item('work-1', make_stage('stage-1', 'defect-1', { retries: 2 }))
	const retry = make_work_item('work-1', make_stage('stage-1', 'defect-1', { retries: 3 }))

	assert.equal(first.work_item_id, retry.work_item_id)
	assert.equal(first.stages[0].stage_id, retry.stages[0].stage_id)
	assert.equal(retry.stages[0].retries, 3)
})

test('history appends one JSON line and rejects duplicate work-item identities', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		const first = make_work_item('work-1', make_stage('stage-1', 'defect-1'))
		const second = make_work_item('work-2', make_stage('stage-2', 'defect-2', {
			duplicate_of: { work_item_id: 'work-1', stage_id: 'stage-1', defect_id: 'defect-1' },
		}))

		record_completed({ config_path, record: first })
		record_completed({ config_path, record: second })
		const history_path = metrics.history_path_for(config_path)
		const lines = fs.readFileSync(history_path, 'utf8').trimEnd().split('\n')

		assert.equal(lines.length, 2)
		assert.deepEqual(JSON.parse(lines[1]).stages[0].defects[0].duplicate_of, {
			work_item_id: 'work-1',
			stage_id: 'stage-1',
			defect_id: 'defect-1',
		})
		assert.throws(() => record_completed({ config_path, record: first }), /duplicate.*work_item_id/i)
	} finally {
		dispose(root)
	}
})

test('history rejects symlinks and a pathname replacement before append', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		const history_path = metrics.history_path_for(config_path)
		const target_path = path.join(root, 'target.jsonl')
		fs.writeFileSync(target_path, '')
		fs.symlinkSync(target_path, history_path)
		assert.throws(() => record_completed({
			config_path,
			record: make_work_item('symlink-work', make_stage('symlink-stage', 'symlink-defect')),
		}), /symlink|symbolic/i)
		assert.equal(fs.readFileSync(target_path, 'utf8'), '')
		fs.unlinkSync(history_path)
		fs.writeFileSync(history_path, '')
		const replacement_path = path.join(root, 'replacement.jsonl')
		fs.writeFileSync(replacement_path, '')
		assert.throws(() => record_completed({
			config_path,
			record: make_work_item('race-work', make_stage('race-stage', 'race-defect')),
			before_history_append: () => {
				fs.renameSync(history_path, path.join(root, 'original.jsonl'))
				fs.renameSync(replacement_path, history_path)
			},
		}), /replaced|identity|changed/i)
		assert.equal(fs.readFileSync(history_path, 'utf8'), '')
	} finally {
		dispose(root)
	}
})

test('history append uses an exclusive lock and restrictive creation mode', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		const history_path = metrics.history_path_for(config_path)
		const lock_path = `${history_path}.lock`
		fs.writeFileSync(lock_path, 'held', { mode: 0o600 })
		assert.throws(() => record_completed({
			config_path,
			record: make_work_item('locked-work', make_stage('locked-stage', 'locked-defect')),
		}), /lock|concurrent/i)
		fs.unlinkSync(lock_path)
		record_completed({ config_path, record: make_work_item('mode-work', make_stage('mode-stage', 'mode-defect')) })
		assert.equal(fs.statSync(history_path).mode & 0o777, 0o600)
	} finally {
		dispose(root)
	}
})

test('history evaluation opens an existing history read-only', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		const history_path = metrics.history_path_for(config_path)
		record_completed({ config_path, record: make_work_item('readonly-work', make_stage('readonly-stage', 'readonly-defect')) })
		fs.chmodSync(history_path, 0o400)
		assert.equal(metrics.read_history(history_path)[0].work_item_id, 'readonly-work')
	} finally {
		dispose(root)
	}
})

test('window parsing accepts positive integers and rejects every invalid form', () => {
	assert.equal(metrics.parse_window([]), 5)
	assert.equal(metrics.parse_window(['--window', '3']), 3)

	for (const value of ['0', '-1', '1.5', 'words', '']) {
		assert.throws(() => metrics.parse_window(['--window', value]), /positive integer/i)
	}
	assert.throws(() => metrics.parse_window(['--window']), /positive integer/i)
})

test('evaluation selects the requested recent window and recommends without changing stages', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		for (let index = 1; index <= 6; index += 1) {
			record_completed({
				config_path,
				record: make_work_item(`work-${index}`, make_stage('review-stage', `defect-${index}`, {
					completed_at: `2026-08-23T11:0${index}:00.000Z`,
				}), { completed_at: `2026-08-23T11:0${index}:00.000Z` }),
			})
		}

		const history_path = metrics.history_path_for(config_path)
		const default_result = metrics.evaluate_history(history_path)
		const short_result = metrics.evaluate_history(history_path, { window: 3 })

		assert.equal(default_result.window, 5)
		assert.equal(default_result.complete, true)
		assert.equal(default_result.records.length, 5)
		assert.equal(default_result.records[0].work_item_id, 'work-2')
		assert.equal(short_result.window, 3)
		assert.equal(short_result.records.length, 3)
		assert.equal(short_result.recommendations[0].automatic, false)
		assert.equal(short_result.recommendations[0].stage_id, 'review-stage')
		assert.equal(short_result.stage_selection_changed, false)
	} finally {
		dispose(root)
	}
})

test('incomplete evidence windows produce no recommendation', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		record_completed({
			config_path,
			record: make_work_item('work-1', make_stage('stage-1', 'defect-1')),
		})
		const result = metrics.evaluate_history(metrics.history_path_for(config_path))

		assert.equal(result.complete, false)
		assert.deepEqual(result.recommendations, [])
	} finally {
		dispose(root)
	}
})

test('active and waiting time stay separate in nested reporting', () => {
	const stage = make_stage('stage-1', 'defect-1')
	const record = make_work_item('work-1', stage, { waiting_elapsed_ms: 900 })
	const report = metrics.build_metrics_report([record])

	assert.equal(report.active_elapsed_ms, 2500)
	assert.equal(report.waiting_elapsed_ms, 900)
	assert.equal(report.provider_tokens.input, 10)
	assert.equal(report.provider_tokens.total, 'unavailable')
	assert.equal(report.stages[0].stage_id, 'stage-1')
	assert.equal(report.stages[0].elapsed_ms, 2500)
	const text = metrics.format_metrics_report({ records: [record], report })
	assert.match(text, /Active pipeline time: 2500 ms/)
	assert.match(text, /Waiting time: 900 ms/)
	assert.match(text, /Retries: 1/)
	assert.match(text, /Transport failures: 1.*300 ms/s)
	assert.match(text, /Provider input tokens: 10/)
	assert.match(text, /Provider total tokens: unavailable/)
	assert.match(text, /Defect defect-1.*cosmetic/s)
})

test('history append requires completed acceptance and reporting gates', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		const record = make_work_item('gated-work', make_stage('gated-stage', 'gated-defect'))
		const outside_history = path.join(os.tmpdir(), `agentflow-outside-metrics-${process.pid}.jsonl`)
		assert.throws(() => metrics.record_completed_work_item({
			config: 'on',
			history_path: outside_history,
			record,
			final_acceptance_complete: true,
			final_report_complete: true,
		}), /ag\.json|config.*path|beside/i)
		assert.equal(fs.existsSync(outside_history), false)
		assert.throws(() => metrics.record_completed_work_item({ config_path, record }), /acceptance.*report|report.*acceptance/i)
		assert.throws(() => metrics.record_completed_work_item({ config_path, record, final_acceptance_complete: true, final_report_complete: false }), /acceptance.*report|report.*acceptance/i)
		assert.equal(fs.existsSync(metrics.history_path_for(config_path)), false)
		record_completed({ config_path, record })
		assert.equal(fs.readFileSync(metrics.history_path_for(config_path), 'utf8').trim().split('\n').length, 1)
	} finally {
		dispose(root)
	}
})

test('stage and defect identities are unique within one work item', () => {
	const stage = make_stage('same-stage', 'same-defect')
	assert.throws(() => metrics.create_work_item_metrics({
		work_item_id: 'identity-work',
		completed_at: '2026-08-23T11:01:00.000Z',
		acceptance_result: 'passed',
		stages: [stage, stage],
	}), /duplicate.*stage_id|stage_id.*unique/i)

	const duplicate_defects = make_stage('defect-stage', 'first-defect')
	duplicate_defects.defects.push({ ...duplicate_defects.defects[0] })
	assert.throws(() => metrics.create_work_item_metrics({
		work_item_id: 'defect-work',
		completed_at: '2026-08-23T11:01:00.000Z',
		acceptance_result: 'passed',
		stages: [duplicate_defects],
	}), /duplicate.*defect_id|defect_id.*unique/i)
})

test('CLI reads the applicable history and honors the requested window', () => {
	const root = make_root()
	try {
		const config_path = write_config(root, 'on')
		record_completed({
			config_path,
			record: make_work_item('work-1', make_stage('stage-1', 'defect-1')),
		})
		const output = execFileSync(process.execPath, [path.join(__dirname, 'metrics.js'), '--config', config_path, '--window', '1'], { encoding: 'utf8' })
		const result = JSON.parse(output)

		assert.equal(result.window, 1)
		assert.equal(result.complete, true)
		assert.equal(result.records[0].work_item_id, 'work-1')
	} finally {
		dispose(root)
	}
})

const make_ccxray_summary = overrides => ({
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
	by_role: {},
	...overrides,
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
