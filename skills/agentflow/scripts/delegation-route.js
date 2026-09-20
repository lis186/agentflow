'use strict'

const settings = require('./ag-settings.js')
const external_runner = require('./external-runner.js')
const fs = require('node:fs')
const path = require('node:path')

const generic_external_record_fields = Object.freeze([
	'executor_class',
	'substantive_delegated_capable',
	'runner_id',
	'shared_supervision',
	'clone_isolation',
	'os_confinement',
	'stage_id',
	'material_risks',
	'reason',
])

const nonempty_text = value => typeof value === 'string' && value.trim().length > 0
const string_array = value => Array.isArray(value) && value.length > 0 && value.every(item => nonempty_text(item))

const parse_threeways_trigger = ask_text => {
	if (typeof ask_text !== 'string') return { triggered: false }
	const match = /^(?:3ways|threeways)$/.exec(ask_text.trim())
	return match === null
		? { triggered: false }
		: { triggered: true, stage_id: 'threeways', runner_id: 'external-runner-v1', permits_one_review_when_allow_ag_off: true, permits_implementation: false }
}

const safe_work_root = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.split('/').includes('..') && !value.startsWith('/')
const bounded_text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1024 * 1024
const report_stamp = /^\* _\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [+-]\d{4})? \([^\r\n]+\)_$/u
const report_self_check = /^Self-check:\s+\S.*$/u
const required_brief_sections = ['Original Ask:', 'Evidence:', 'Normal journey:', 'Material uncertainties:', 'Forbidden scope:']
const required_resolution_sections = ['Selected design:', 'Rejected alternatives:', 'Evidence:', 'Model-family limitation:', 'Next human decision:']
const has_required_sections = (text, sections) => bounded_text(text) && sections.every(section => new RegExp(`^${section}\\s+\\S`, 'mu').test(text))

const artifact_path = (repo_root, relative) => {
	if (typeof repo_root !== 'string' || repo_root.length === 0 || !safe_work_root(relative)) throw new Error('threeways artifact paths require a repository root and safe relative work root')
	const root = fs.realpathSync(repo_root)
	const target = path.resolve(root, relative)
	if (!target.startsWith(root + path.sep)) throw new Error('threeways artifact path escapes repository')
	let current = root
	for (const part of relative.split('/')) {
		current = path.join(current, part)
		if (!fs.existsSync(current)) break
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error('threeways artifact path contains a symbolic link')
	}
	return target
}

const write_immutable = (filename, text) => {
	if (!bounded_text(text)) throw new Error('threeways artifact must be non-empty bounded text')
	fs.mkdirSync(path.dirname(filename), { recursive: true })
	if (fs.existsSync(filename)) throw new Error(`threeways artifact already exists: ${path.basename(filename)}`)
	fs.writeFileSync(filename, text.endsWith('\n') ? text : `${text}\n`, { encoding: 'utf8', flag: 'wx' })
}

const valid_worker_report = text => {
	if (!bounded_text(text)) return false
	const lines = text.trimEnd().split(/\r?\n/u)
	return report_stamp.test(lines[0] || '') && report_self_check.test(lines.at(-1) || '') && lines.filter(line => line.startsWith('Self-check:')).length === 1
}

const plan_threeways_debate = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return { valid: false, error: 'threeways facts must be an object' }
	const trigger = parse_threeways_trigger(facts.ask_text)
	if (!trigger.triggered) return { valid: true, ...trigger }
	if (!safe_work_root(facts.work_root)) return { valid: false, error: 'threeways work_root must be a non-empty repository-relative path' }
	if (!Number.isInteger(facts.worker_starts) || facts.worker_starts < 0) return { valid: false, error: 'threeways worker_starts must be a non-negative integer' }
	if (facts.worker_starts >= 3 || facts.owner_only_choice === true) return { valid: true, ...trigger, permits_launch: false, consensus: 'UNRESOLVED', reason: facts.worker_starts >= 3 ? 'three worker starts reached the fixed ceiling' : 'an owner-only choice remains' }
	const round = facts.worker_starts + 1
	return {
		valid: true,
		...trigger,
		permits_launch: true,
		consensus: 'PENDING',
		round,
		artifacts: {
			brief: `${facts.work_root}/threeways-brief-r${round}.md`,
			report: `${facts.work_root}/threeways-report-r${round}.md`,
			resolution: `${facts.work_root}/threeways-resolution-r${round}.md`
		}
	}
}

const launch_threeways_debate = async (facts, dependencies = {}) => {
	const plan = plan_threeways_debate(facts)
	if (!plan.valid || !plan.triggered || !plan.permits_launch) return plan
	if (dependencies === null || typeof dependencies !== 'object') {
		return { ...plan, valid: false, error: 'threeways launch requires configured worker selection and external-runner-v1' }
	}
	if (facts.runner_options === null || typeof facts.runner_options !== 'object' || Array.isArray(facts.runner_options)) {
		return { ...plan, valid: false, error: 'threeways launch requires frozen external-runner options' }
	}
	const resolve_worker = dependencies.resolve_worker || (selection => settings.resolve_threeways_worker(facts.config, selection))
	const run_external_command = dependencies.run_external_command || external_runner.run_external_command
	const worker = resolve_worker(facts.worker_selection)
	if (worker === null || typeof worker !== 'object' || worker.tier !== 'better') return { ...plan, valid: false, error: 'threeways launch requires a configured better-tier worker' }
	if (!Array.isArray(facts.runner_arguments) || !facts.runner_arguments.every(argument => typeof argument === 'string')) {
		return { ...plan, valid: false, error: 'threeways launch requires frozen literal runner_arguments' }
	}
	if (Object.hasOwn(facts.runner_options, 'command') || Object.hasOwn(facts.runner_options, 'executable') || !Array.isArray(worker.args) || typeof worker.executable !== 'string') {
		return { ...plan, valid: false, error: 'threeways runner command must be derived only from the selected better-tier worker' }
	}
	const runner_options = { ...facts.runner_options, command: [worker.executable, ...worker.args, ...facts.runner_arguments] }
	if (!Object.hasOwn(facts.runner_options, 'role')) runner_options.role = plan.stage_id
	if (!Object.hasOwn(facts.runner_options, 'attempt')) runner_options.attempt = plan.round
	const result = await run_external_command(runner_options)
	return { ...plan, worker, runner_id: 'external-runner-v1', runner: result }
}

const execute_threeways_debate = async (facts, dependencies = {}) => {
	const plan = plan_threeways_debate(facts)
	if (!plan.valid || !plan.triggered || !plan.permits_launch) return plan
	if (typeof facts.repo_root !== 'string' || !has_required_sections(facts.brief_text, required_brief_sections) || !has_required_sections(facts.host_resolution, required_resolution_sections)) {
		return { ...plan, valid: false, error: 'threeways execution requires repository root plus frozen brief and resolution sections' }
	}
	let filenames
	try {
		filenames = Object.fromEntries(Object.entries(plan.artifacts).map(([kind, relative]) => [kind, artifact_path(facts.repo_root, relative)]))
		write_immutable(filenames.brief, facts.brief_text)
	} catch (error) {
		return { ...plan, valid: false, error: error.message }
	}

	let launched
	try {
		launched = await launch_threeways_debate(facts, dependencies)
	} catch (error) {
		launched = { ...plan, valid: false, error: `threeways runner failed: ${error.message}`, runner: { status: 'spawn_error' } }
	}
	const report_text = typeof launched.runner?.result?.value === 'string' ? launched.runner.result.value : ''
	const report_ok = launched.runner?.status === 'completed' && valid_worker_report(report_text)
	try {
		// A diagnostic is deliberately not shaped as a worker report: the host must
		// never fabricate a worker stamp or self-check after a failed invocation.
		write_immutable(filenames.report, report_ok ? report_text : '# Threeways worker diagnostic\n\nRecord type: HOST-DIAGNOSTIC (not a worker report)\n\nWorker report was missing, malformed, or its runner did not complete; no worker conclusion was accepted.\n')
		const agreed = report_ok && /^Consensus:\s+AGREE\s*$/mu.test(report_text) && facts.host_disagreement !== true
		const consensus = agreed ? 'AGREE' : 'UNRESOLVED'
		const family_record = launched.worker?.family_diversity || 'unavailable'
		const limitation = launched.worker?.limitation || 'none recorded'
		write_immutable(filenames.resolution, `${facts.host_resolution}\n\nWorker family diversity: ${family_record}\n\nWorker family limitation: ${limitation}\n\nConsensus: ${consensus}\n\nAttempts: ${plan.round}\n\nSelf-check: The host recorded the debate resolution without authorizing implementation.\n`)
		return { ...launched, artifacts: plan.artifacts, consensus, retry_required: consensus === 'UNRESOLVED' && plan.round < 3 }
	} catch (error) {
		return { ...launched, valid: false, error: error.message }
	}
}

const main = async (argv, dependencies = {}) => {
	if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== 'threeways' || argv[1] === '') {
		throw new Error('usage: node delegation-route.js threeways <frozen-facts.json>')
	}
	const facts_path = path.resolve(argv[1])
	const facts = JSON.parse(fs.readFileSync(facts_path, 'utf8'))
	const result = await execute_threeways_debate(facts, dependencies)
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if (result.valid === false || result.consensus === 'UNRESOLVED') process.exitCode = 1
	return result
}

const validate_generic_external_record = record => {
	if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'generic-external record must be an object'
	if (record.executor_class !== 'generic_external') return 'generic-external record executor_class must be generic_external'
	if (typeof record.substantive_delegated_capable !== 'boolean') return 'generic-external record substantive_delegated_capable must be an actual boolean'
	if (record.runner_id !== 'external-runner-v1') return 'generic-external record runner_id must identify the tested runner'
	if (record.shared_supervision !== 'absent') return 'generic-external record shared_supervision must be absent'
	if (record.clone_isolation !== 'independent') return 'generic-external record clone_isolation must be independent'
	if (record.os_confinement !== 'not_proven') return 'generic-external record os_confinement must be not_proven'
	if (!nonempty_text(record.stage_id)) return 'generic-external record stage_id must be a non-empty stable string'
	if (!string_array(record.material_risks)) return 'generic-external record material_risks must be an array of non-empty risk identifiers'
	if (!nonempty_text(record.reason)) return 'generic-external record reason must be a non-empty plain-language string'
	for (const field of Object.keys(record)) if (!generic_external_record_fields.includes(field)) return `generic-external record must not contain unrecognised field ${field}`
	return null
}

module.exports = {
	generic_external_record_fields,
	validate_generic_external_record,
	parse_threeways_trigger,
	plan_threeways_debate,
	launch_threeways_debate,
	execute_threeways_debate,
	main,
}

if (require.main === module) {
	main(process.argv.slice(2)).catch(error => {
		process.stderr.write(`${error.message}\n`)
		process.exitCode = 1
	})
}
