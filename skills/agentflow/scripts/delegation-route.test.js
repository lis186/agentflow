'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const route = require('./delegation-route.js')
const settings = require('./ag-settings.js')
const external_runner = require('./external-runner.js')

const valid_record = () => ({
	executor_class: 'generic_external',
	substantive_delegated_capable: true,
	runner_id: 'external-runner-v1',
	shared_supervision: 'absent',
	clone_isolation: 'independent',
	os_confinement: 'not_proven',
	stage_id: 'coding',
	material_risks: ['provider-command'],
	reason: 'a trusted literal command runs in an independent clone',
})

const valid_brief = () => '# Brief\n\nOriginal Ask: 3ways\n\nEvidence: current plan\n\nNormal journey: owner trigger reaches the existing runner.\n\nMaterial uncertainties: one decision remains.\n\nForbidden scope: no new executor.\n'
const valid_resolution = () => '# Host resolution\n\nSelected design: existing runner operation.\n\nRejected alternatives: a new dispatcher service.\n\nEvidence: immutable worker report.\n\nModel-family limitation: recorded by worker selection.\n\nNext human decision: review the resolution.\n'

test('generic external records remain strict non-executable evidence', () => {
	assert.equal(route.validate_generic_external_record(valid_record()), null)
	assert.equal(route.select_delegation_route, undefined)
	assert.equal(route.validate_native_host_record, undefined)
})

test('generic external records reject removed supervision and malformed facts', () => {
	for (const [field, value] of [
		['runner_id', 'shared-supervisor'],
		['substantive_delegated_capable', 'true'],
		['shared_supervision', 'present'],
		['clone_isolation', 'shared'],
		['os_confinement', 'proven'],
		['stage_id', ''],
		['material_risks', []],
		['reason', ''],
	]) {
		const record = valid_record()
		record[field] = value
		assert.ok(route.validate_generic_external_record(record), field)
	}
})

test('threeways accepts only the exact owner trigger and never authorizes implementation', () => {
	for (const ask of ['3ways', 'threeways']) {
		const result = route.parse_threeways_trigger(ask)
		assert.equal(result.triggered, true)
		assert.equal(result.stage_id, 'threeways')
		assert.equal(result.runner_id, 'external-runner-v1')
		assert.equal(result.permits_one_review_when_allow_ag_off, true)
		assert.equal(result.permits_implementation, false)
	}
	for (const ask of ['my threeways preference', '3ways later', '3ways: debate the plan', 'threeways-review', 'three ways', '3WAYS', 'context\n3ways']) {
		assert.deepEqual(route.parse_threeways_trigger(ask), { triggered: false })
	}
})

test('threeways preserves one stable stage, immutable artifact names, and the three-start unresolved ceiling', () => {
	const first = route.plan_threeways_debate({ ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0 })
	assert.equal(first.valid, true)
	assert.equal(first.stage_id, 'threeways')
	assert.equal(first.permits_launch, true)
	assert.equal(first.round, 1)
	assert.deepEqual(first.artifacts, {
		brief: '.agentflow/artifacts/A-001-plan/threeways-brief-r1.md',
		report: '.agentflow/artifacts/A-001-plan/threeways-report-r1.md',
		resolution: '.agentflow/artifacts/A-001-plan/threeways-resolution-r1.md'
	})
	const ceiling = route.plan_threeways_debate({ ask_text: 'threeways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 3 })
	assert.equal(ceiling.permits_launch, false)
	assert.equal(ceiling.consensus, 'UNRESOLVED')
	assert.match(ceiling.reason, /ceiling/)
	const owner = route.plan_threeways_debate({ ask_text: 'threeways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0, owner_only_choice: true })
	assert.equal(owner.consensus, 'UNRESOLVED')
	assert.equal(route.plan_threeways_debate({ ask_text: '3ways', work_root: '../escape', worker_starts: 0 }).valid, false)
})

test('threeways launches only through the supplied unified external runner and configured better worker', async () => {
	const calls = []
	const result = await route.launch_threeways_debate({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0,
		worker_selection: { active_host: 'codex' }, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, {
		resolve_worker: selection => ({ tier: 'better', executable: 'codex', args: ['--safe'], profile: { id: 'reviewer' }, selection }),
		run_external_command: async options => { calls.push(options); return { process: { exit_code: 0 } } }
	})
	assert.equal(result.stage_id, 'threeways')
	assert.equal(result.worker.tier, 'better')
	assert.equal(result.runner_id, 'external-runner-v1')
	assert.deepEqual(calls, [{ source_directory: '/repo', command: ['codex', '--safe', 'exec', 'review'], role: 'threeways', attempt: 1 }])
	const no_launch = await route.launch_threeways_debate({ ask_text: 'threeways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 3 }, {})
	assert.equal(no_launch.permits_launch, false)
	assert.equal(no_launch.consensus, 'UNRESOLVED')
})

test('threeways forwards caller telemetry options and defaults the role only when absent', async () => {
	const calls = []
	await route.launch_threeways_debate({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0,
		worker_selection: { active_host: 'codex' }, runner_options: {
			source_directory: '/repo', task: 'A-012', project: 'ipadpos', metrics: 'auto', config_path: 'ag.json', touch_env: {},
		}, runner_arguments: ['exec', 'review']
	}, {
		resolve_worker: () => ({ tier: 'better', executable: 'codex', args: [] }),
		run_external_command: async options => { calls.push(options); return { process: { exit_code: 0 } } },
	})
	assert.deepEqual(calls, [{
		source_directory: '/repo', task: 'A-012', project: 'ipadpos', metrics: 'auto', config_path: 'ag.json', touch_env: {},
		command: ['codex', 'exec', 'review'], role: 'threeways', attempt: 1,
	}])
})

test('threeways default path binds the imported worker resolver to the imported unified runner command', async () => {
	const original_resolver = settings.resolve_threeways_worker
	const original_runner = external_runner.run_external_command
	const calls = []
	settings.resolve_threeways_worker = (config, selection) => ({ tier: 'better', executable: 'brain-two', args: ['--profile', 'better'], config, selection })
	external_runner.run_external_command = async options => { calls.push(options); return { process: { exit_code: 0 } } }
	try {
		const result = await route.launch_threeways_debate({
			ask_text: 'threeways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0,
			config: { approved: true }, worker_selection: { active_host: 'codex' }, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
		})
		assert.equal(result.worker.executable, 'brain-two')
		assert.deepEqual(calls, [{ source_directory: '/repo', command: ['brain-two', '--profile', 'better', 'exec', 'review'], role: 'threeways', attempt: 1 }])
	} finally {
		settings.resolve_threeways_worker = original_resolver
		external_runner.run_external_command = original_runner
	}
})

test('threeways executes one immutable brief-report-resolution journey through the existing runner', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const calls = []
	const facts = {
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0,
		repo_root, brief_text: valid_brief(), host_resolution: valid_resolution(),
		worker_selection: { active_host: 'codex' }, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review'], host_disagreement: false
	}
	const result = await route.execute_threeways_debate(facts, {
		resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: ['--review'] }),
		run_external_command: async options => {
			calls.push(options)
			return { status: 'completed', result: { value: '* _2026-09-02 12:00:00 (brain-two)_\n\nEvidence: brief reviewed.\n\nConsensus: AGREE\n\nSelf-check: I cited the brief and stated one conclusion.\n' } }
		}
	})
	assert.equal(result.consensus, 'AGREE')
	assert.equal(result.retry_required, false)
	assert.deepEqual(calls, [{ source_directory: '/repo', command: ['brain-two', '--review', 'exec', 'review'], role: 'threeways', attempt: 1 }])
	const artifact_root = path.join(repo_root, '.agentflow/artifacts/A-001-plan')
	assert.match(fs.readFileSync(path.join(artifact_root, 'threeways-brief-r1.md'), 'utf8'), /Normal journey/)
	assert.match(fs.readFileSync(path.join(artifact_root, 'threeways-report-r1.md'), 'utf8'), /^\* _2026/m)
	assert.match(fs.readFileSync(path.join(artifact_root, 'threeways-resolution-r1.md'), 'utf8'), /Consensus: AGREE/)
	const repeat = await route.execute_threeways_debate(facts, {})
	assert.equal(repeat.valid, false)
	assert.match(repeat.error, /already exists/)
})

test('threeways records the selected worker family fallback even if host prose understates it', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const understated_resolution = valid_resolution().replace('Model-family limitation: recorded by worker selection.', 'Model-family limitation: none.')
	const result = await route.execute_threeways_debate({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0, repo_root,
		brief_text: valid_brief(), host_resolution: understated_resolution, worker_selection: {}, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, {
		resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: [], family_diversity: 'same-family-fallback', limitation: 'different-family unavailable' }),
		run_external_command: async () => ({ status: 'completed', result: { value: '* _2026-09-02 12:00:00 (brain-two)_\n\nConsensus: AGREE\n\nSelf-check: Evidence was checked.\n' } })
	})
	assert.equal(result.consensus, 'AGREE')
	const resolution = fs.readFileSync(path.join(repo_root, '.agentflow/artifacts/A-001-plan/threeways-resolution-r1.md'), 'utf8')
	assert.match(resolution, /Worker family diversity: same-family-fallback/)
	assert.match(resolution, /Worker family limitation: different-family unavailable/)
})

test('threeways preserves an honest diagnostic and requires retry when a worker report is malformed', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const result = await route.execute_threeways_debate({
		ask_text: 'threeways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 1,
		repo_root, brief_text: valid_brief(), host_resolution: valid_resolution(), worker_selection: {},
		runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, {
		resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: [] }),
		run_external_command: async () => ({ status: 'completed', result: { value: 'not a stamped worker report' } })
	})
	assert.equal(result.consensus, 'UNRESOLVED')
	assert.equal(result.retry_required, true)
	const report = fs.readFileSync(path.join(repo_root, '.agentflow/artifacts/A-001-plan/threeways-report-r2.md'), 'utf8')
	assert.match(report, /worker diagnostic/)
	assert.doesNotMatch(report, /^\* _/m)
	assert.match(report, /HOST-DIAGNOSTIC/)
})

test('threeways refuses false agreement after a failed runner and still records an unresolved result', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const result = await route.execute_threeways_debate({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0, repo_root,
		brief_text: valid_brief(), host_resolution: valid_resolution(), worker_selection: {}, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, {
		resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: [] }),
		run_external_command: async () => ({ status: 'failed', result: { value: '* _2026-09-02 12:00:00 (brain-two)_\n\nConsensus: AGREE\n\nSelf-check: It looks valid but did not complete.\n' } })
	})
	assert.equal(result.consensus, 'UNRESOLVED')
	assert.equal(result.retry_required, true)
})

test('threeways persists an unresolved diagnostic when the existing runner throws', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const result = await route.execute_threeways_debate({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0, repo_root,
		brief_text: valid_brief(), host_resolution: valid_resolution(), worker_selection: {}, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, { resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: [] }), run_external_command: async () => { throw new Error('network unavailable') } })
	assert.equal(result.consensus, 'UNRESOLVED')
	assert.match(fs.readFileSync(path.join(repo_root, '.agentflow/artifacts/A-001-plan/threeways-resolution-r1.md'), 'utf8'), /Consensus: UNRESOLVED/)
})

test('threeways refuses a symlinked work root before writing an artifact', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-outside-'))
	fs.symlinkSync(outside, path.join(repo_root, 'link'))
	const result = await route.execute_threeways_debate({
		ask_text: '3ways', work_root: 'link', worker_starts: 0, repo_root,
		brief_text: valid_brief(), host_resolution: valid_resolution(), worker_selection: {}, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}, {})
	assert.equal(result.valid, false)
	assert.match(result.error, /symbolic link/)
	assert.equal(fs.readdirSync(outside).length, 0)
})

test('the production threeways host command invokes the existing debate operation from frozen facts', async () => {
	const repo_root = fs.mkdtempSync(path.join(os.tmpdir(), 'threeways-route-'))
	const facts_path = path.join(repo_root, 'facts.json')
	fs.writeFileSync(facts_path, JSON.stringify({
		ask_text: '3ways', work_root: '.agentflow/artifacts/A-001-plan', worker_starts: 0, repo_root,
		brief_text: valid_brief(), host_resolution: valid_resolution(), worker_selection: {}, runner_options: { source_directory: '/repo' }, runner_arguments: ['exec', 'review']
	}))
	const original_write = process.stdout.write
	const output = []
	process.stdout.write = text => { output.push(text); return true }
	try {
		const result = await route.main(['threeways', facts_path], {
			resolve_worker: () => ({ tier: 'better', executable: 'brain-two', args: [] }),
			run_external_command: async () => ({ status: 'completed', result: { value: '* _2026-09-02 12:00:00 (brain-two)_\n\nConsensus: AGREE\n\nSelf-check: Evidence was checked.\n' } })
		})
		assert.equal(result.consensus, 'AGREE')
		assert.match(output.join(''), /"runner_id":"external-runner-v1"/)
	} finally {
		process.stdout.write = original_write
	}
})
