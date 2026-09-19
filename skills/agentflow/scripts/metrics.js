'use strict'

const fs = require('node:fs')
const node_path = require('node:path')

const METRICS_HISTORY_NAME = 'metrics-history.jsonl'
const DEFAULT_WINDOW = 5
const TOKEN_FIELDS = ['input', 'output', 'cache', 'reasoning', 'total']

class MetricsError extends Error {
	constructor(message, code = 'AG_METRICS') {
		super(message)
		this.name = 'MetricsError'
		this.code = code
	}
}

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty_text = value => typeof value === 'string' && value.trim().length > 0
const integer = (value, label, minimum = 0) => {
	if (!Number.isInteger(value) || value < minimum) throw new MetricsError(`${label} must be a non-negative integer`)
	return value
}

const timestamp_ms = (value, label) => {
	if (Number.isInteger(value) && value >= 0) return value
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
	if (nonempty_text(value)) {
		const parsed = Date.parse(value)
		if (Number.isFinite(parsed)) return parsed
	}
	throw new MetricsError(`${label} must be a valid timestamp`)
}

const timestamp_text = (value, label) => {
	if (nonempty_text(value)) {
		timestamp_ms(value, label)
		return value
	}
	return new Date(timestamp_ms(value, label)).toISOString()
}

const first_value = (object, names) => {
	for (const name of names) {
		if (object && object[name] !== undefined) return object[name]
	}
	return undefined
}

const history_path_for = config_path => node_path.join(
	node_path.dirname(node_path.resolve(config_path || 'ag.json')),
	METRICS_HISTORY_NAME,
)

const read_config = config_path => {
	try {
		return JSON.parse(fs.readFileSync(config_path, 'utf8'))
	} catch (error) {
		throw new MetricsError(`cannot read metrics configuration: ${error.message}`, 'AG_METRICS_CONFIG')
	}
}

const metrics_enabled = config => {
	if (config === 'on' || config === true || config === 'ccxray' || config === 'auto') return true
	if (config === 'off' || config === false || config === undefined || config === null) return false
	if (typeof config === 'string') return metrics_enabled(read_config(config))
	return config.switches?.metrics === 'on' || config.switches?.metrics === 'ccxray' || config.switches?.metrics === 'auto'
}

const token_value = (value, label) => {
	if (value === undefined || value === null) return 'unavailable'
	if (value === 'unavailable') return value
	return integer(value, `provider_tokens.${label}`)
}

const normalize_provider_tokens = (provider_usage = {}) => {
	if (!is_object(provider_usage)) throw new MetricsError('provider usage must be an object')
	const usage = is_object(provider_usage.tokens) ? provider_usage.tokens : provider_usage
	const aliases = {
		input: ['input', 'input_tokens'],
		output: ['output', 'output_tokens'],
		cache: ['cache', 'cache_tokens'],
		reasoning: ['reasoning', 'reasoning_tokens'],
		total: ['total', 'total_tokens'],
	}
	return Object.fromEntries(TOKEN_FIELDS.map(field => [field, token_value(first_value(usage, aliases[field]), field)]))
}

const normalize_estimate = value => {
	if (value === undefined || value === null) return undefined
	if (Number.isInteger(value)) return { value: integer(value, 'visible_text_token_estimate'), label: 'estimate' }
	if (!is_object(value)) throw new MetricsError('visible_text_token_estimate must be a non-negative integer marked estimate')
	const count = first_value(value, ['value', 'tokens', 'count'])
	if (value.label !== 'estimate' || !Number.isInteger(count) || count < 0) {
		throw new MetricsError('visible_text_token_estimate must be a non-negative integer marked estimate')
	}
	return { value: count, label: 'estimate' }
}

const normalize_duplicate = value => {
	if (value === undefined || value === null) return null
	if (!is_object(value) || !nonempty_text(value.work_item_id) || !nonempty_text(value.stage_id) || !nonempty_text(value.defect_id)) {
		throw new MetricsError('duplicate_of must contain work_item_id, stage_id, and defect_id')
	}
	return {
		work_item_id: value.work_item_id,
		stage_id: value.stage_id,
		defect_id: value.defect_id,
	}
}

const normalize_defect = (value, index) => {
	if (!is_object(value)) throw new MetricsError(`defects[${index}] must be an object`)
	const defect_id = first_value(value, ['defect_id', 'id'])
	const severity = value.severity
	const changed_product_behavior = first_value(value, ['changed_product_behavior', 'changed_behavior'])
	if (!nonempty_text(defect_id)) throw new MetricsError(`defects[${index}].defect_id is required`)
	if (!nonempty_text(severity)) throw new MetricsError(`defects[${index}].severity is required`)
	if (typeof changed_product_behavior !== 'boolean') throw new MetricsError(`defects[${index}].changed_product_behavior must be boolean`)
	return {
		defect_id,
		severity,
		changed_product_behavior,
		duplicate_of: normalize_duplicate(value.duplicate_of),
	}
}

const create_stage_metrics = input => {
	if (!is_object(input)) throw new MetricsError('stage metrics must be an object')
	const stage_id = input.stage_id
	const stage_kind = input.stage_kind ?? input.kind
	if (!nonempty_text(stage_id)) throw new MetricsError('stage_id is required')
	if (!nonempty_text(stage_kind)) throw new MetricsError('stage_kind is required')

	const started_value = first_value(input, ['started_at', 'start_time', 'start_at', 'started_at_ms'])
	const ended_value = first_value(input, ['ended_at', 'end_time', 'end_at', 'ended_at_ms'])
	const started_at = timestamp_text(started_value, 'started_at')
	const ended_at = timestamp_text(ended_value, 'ended_at')
	const elapsed_ms = timestamp_ms(ended_value, 'ended_at') - timestamp_ms(started_value, 'started_at')
	if (elapsed_ms < 0) throw new MetricsError('ended_at must not precede started_at')

	const retries = integer(input.retries ?? 0, 'retries')
	const transport_failures = integer(input.transport_failures ?? input.transport_failure_count ?? 0, 'transport_failures')
	const transport_failure_elapsed_ms = integer(input.transport_failure_elapsed_ms ?? input.transport_lost_ms ?? 0, 'transport_failure_elapsed_ms')
	const defects = input.defects ?? []
	if (!Array.isArray(defects)) throw new MetricsError('defects must be an array')

	const stage = {
		stage_id,
		stage_kind,
		started_at,
		ended_at,
		elapsed_ms,
		retries,
		transport_failures,
		transport_failure_elapsed_ms,
		provider_tokens: normalize_provider_tokens(input.provider_tokens ?? input.provider_usage ?? input.usage ?? {}),
		defects: defects.map(normalize_defect),
	}
	if (typeof input.cost_usd === 'number') stage.cost_usd = input.cost_usd
	if (typeof input.cache_hit_rate === 'number') stage.cache_hit_rate = input.cache_hit_rate
	const estimate = normalize_estimate(input.visible_text_token_estimate)
	if (estimate !== undefined) stage.visible_text_token_estimate = estimate
	return stage
}

const create_work_item_metrics = input => {
	if (!is_object(input)) throw new MetricsError('work-item metrics must be an object')
	if (!nonempty_text(input.work_item_id)) throw new MetricsError('work_item_id is required')
	const stages = input.stages
	if (!Array.isArray(stages) || stages.length === 0) throw new MetricsError('stages must be a non-empty array')
	const normalized_stages = stages.map(create_stage_metrics)
	if (new Set(normalized_stages.map(stage => stage.stage_id)).size !== normalized_stages.length) throw new MetricsError('stage_id values must be unique within a work item')
	for (const stage of normalized_stages) {
		if (new Set(stage.defects.map(defect => defect.defect_id)).size !== stage.defects.length) throw new MetricsError(`defect_id values must be unique within stage ${stage.stage_id}`)
	}
	const acceptance_result = input.acceptance_result ?? input.acceptance
	if (!nonempty_text(acceptance_result)) throw new MetricsError('acceptance_result is required')
	const waiting_elapsed_ms = integer(
		input.waiting_elapsed_ms ?? input.owner_waiting_elapsed_ms ?? input.external_waiting_elapsed_ms ?? input.waiting_ms ?? 0,
		'waiting_elapsed_ms',
	)
	return {
		work_item_id: input.work_item_id,
		completed_at: timestamp_text(input.completed_at, 'completed_at'),
		acceptance_result,
		stages: normalized_stages,
		active_elapsed_ms: normalized_stages.reduce((total, stage) => total + stage.elapsed_ms, 0),
		waiting_elapsed_ms,
	}
}

const validate_duplicate_references = (records, current) => {
	const known = new Set()
	for (const record of records) {
		for (const stage of record.stages) {
			for (const defect of stage.defects) known.add(`${record.work_item_id}\u0000${stage.stage_id}\u0000${defect.defect_id}`)
		}
	}
	for (const stage of current.stages) {
		for (const defect of stage.defects) {
			if (defect.duplicate_of === null) continue
			const reference = defect.duplicate_of
			const key = `${reference.work_item_id}\u0000${reference.stage_id}\u0000${reference.defect_id}`
			if (!known.has(key)) throw new MetricsError(`duplicate_of points to an unknown earlier defect: ${key}`)
		}
		for (const defect of stage.defects) known.add(`${current.work_item_id}\u0000${stage.stage_id}\u0000${defect.defect_id}`)
	}
}

const read_history = history_path => {
	if (!fs.existsSync(history_path)) return []
	const content = read_regular_history(history_path).content
	return parse_history(content)
}

const parse_history = content => {
	if (content.length === 0) return []
	const records = []
	for (const [index, line] of content.split('\n').entries()) {
		if (line.trim() === '') continue
		try {
			records.push(JSON.parse(line))
		} catch (error) {
			throw new MetricsError(`metrics history line ${index + 1} is not valid JSON`, 'AG_METRICS_HISTORY')
		}
	}
	return records
}

const open_regular_history = (history_path, create, writable = false) => {
	const nofollow = fs.constants.O_NOFOLLOW || 0
	let descriptor
	if (create) descriptor = fs.openSync(history_path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | nofollow, 0o600)
	else {
		const before = fs.lstatSync(history_path)
		if (!before.isFile() || before.isSymbolicLink()) throw new MetricsError('metrics history must not be a symbolic link', 'AG_METRICS_HISTORY_PATH')
		descriptor = fs.openSync(history_path, (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | nofollow)
		const opened = fs.fstatSync(descriptor)
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			fs.closeSync(descriptor)
			throw new MetricsError('metrics history identity changed while opening', 'AG_METRICS_HISTORY_PATH')
		}
	}
	return descriptor
}

const read_regular_history = history_path => {
	const descriptor = open_regular_history(history_path, false)
	try {
		const stat = fs.fstatSync(descriptor)
		const content = fs.readFileSync(descriptor, 'utf8')
		const after = fs.fstatSync(descriptor)
		if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new MetricsError('metrics history identity changed while reading', 'AG_METRICS_HISTORY_PATH')
		return { content, stat }
	} finally {
		fs.closeSync(descriptor)
	}
}

const same_path_identity = (history_path, stat) => {
	try {
		const current = fs.lstatSync(history_path)
		return current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino
	} catch {
		return false
	}
}

const with_history_lock = (history_path, operation) => {
	const lock_path = `${history_path}.lock`
	let descriptor
	try {
		descriptor = fs.openSync(lock_path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
	} catch (error) {
		if (error && error.code === 'EEXIST') throw new MetricsError('metrics history is locked by another append', 'AG_METRICS_HISTORY_LOCKED')
		throw new MetricsError(`cannot lock metrics history: ${error.message}`, 'AG_METRICS_HISTORY_LOCKED')
	}
	const lock_stat = fs.fstatSync(descriptor)
	try {
		return operation()
	} finally {
		fs.closeSync(descriptor)
		if (same_path_identity(lock_path, lock_stat)) fs.unlinkSync(lock_path)
	}
}

const record_completed_work_item = options => {
	if (!is_object(options)) throw new MetricsError('metrics recording options must be an object')
	const config_path = options.config_path ?? options.ag_json_path ?? options.ag_path
	if (!nonempty_text(config_path)) throw new MetricsError('metrics history requires the applicable ag.json config path')
	const expected_history_path = history_path_for(config_path)
	if (options.history_path !== undefined && node_path.resolve(options.history_path) !== expected_history_path) throw new MetricsError('metrics history must stay beside the applicable ag.json')
	const config = options.config ?? read_config(config_path)
	if (!metrics_enabled(config)) {
		return { recorded: false, reason: 'metrics_disabled', history_path: expected_history_path }
	}
	const history_path = expected_history_path
	if (options.final_acceptance_complete !== true || options.final_report_complete !== true) {
		throw new MetricsError('metrics history append requires final acceptance and final report completion')
	}
	const record_source = options.record ?? options.work_item ?? options.metrics_record ?? (typeof options.record_factory === 'function' ? options.record_factory() : undefined)
	const record = create_work_item_metrics(record_source)
	fs.mkdirSync(node_path.dirname(history_path), { recursive: true })
	with_history_lock(history_path, () => {
		let descriptor
		try {
			descriptor = open_regular_history(history_path, !fs.existsSync(history_path), true)
			const opened = fs.fstatSync(descriptor)
			const current = fs.readFileSync(descriptor, 'utf8')
			const after_read = fs.fstatSync(descriptor)
			if (after_read.dev !== opened.dev || after_read.ino !== opened.ino || after_read.size !== opened.size) throw new MetricsError('metrics history identity changed while reading', 'AG_METRICS_HISTORY_PATH')
			const existing = parse_history(current)
			if (existing.some(item => item.work_item_id === record.work_item_id)) throw new MetricsError(`duplicate work_item_id: ${record.work_item_id}`, 'AG_METRICS_DUPLICATE_WORK_ITEM')
			validate_duplicate_references(existing, record)
			if (typeof options.before_history_append === 'function') options.before_history_append()
			if (!same_path_identity(history_path, opened)) throw new MetricsError('metrics history pathname was replaced before append', 'AG_METRICS_HISTORY_PATH')
			const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
			fs.writeSync(descriptor, `${separator}${JSON.stringify(record)}\n`, opened.size, 'utf8')
			fs.fsyncSync(descriptor)
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor)
		}
	})
	return { recorded: true, history_path, record }
}

const append_metrics_history = options => record_completed_work_item(options)

const parse_window = args => {
	if (Number.isInteger(args) && args > 0) return args
	if (typeof args === 'string') args = ['--window', args]
	if (!Array.isArray(args)) throw new MetricsError('evidence window must be a positive integer')
	let value
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]
		if (argument === '--window') {
			if (value !== undefined || index + 1 >= args.length) throw new MetricsError('evidence window must be a positive integer')
			value = args[index + 1]
			index += 1
		} else if (typeof argument === 'string' && argument.startsWith('--window=')) {
			if (value !== undefined) throw new MetricsError('evidence window must be a positive integer')
			value = argument.slice('--window='.length)
		}
	}
	if (value === undefined) return DEFAULT_WINDOW
	if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) <= 0) {
		throw new MetricsError('evidence window must be a positive integer')
	}
	return Number(value)
}

const build_metrics_report = records => {
	if (!Array.isArray(records)) throw new MetricsError('metrics report records must be an array')
	const normalized = records.map(record => create_work_item_metrics(record))
	const active_elapsed_ms = normalized.reduce((total, record) => total + record.active_elapsed_ms, 0)
	const waiting_elapsed_ms = normalized.reduce((total, record) => total + record.waiting_elapsed_ms, 0)
	const stages = normalized.flatMap(record => record.stages.map(stage => ({
		work_item_id: record.work_item_id,
		...stage,
	})))
	const provider_tokens = Object.fromEntries(TOKEN_FIELDS.map(field => {
		const values = stages.map(stage => stage.provider_tokens[field])
		return [field, values.length > 0 && values.every(value => Number.isInteger(value)) ? values.reduce((total, value) => total + value, 0) : 'unavailable']
	}))
	const estimates = stages.map(stage => stage.visible_text_token_estimate?.value).filter(value => Number.isInteger(value))
	const costs = stages.map(stage => stage.cost_usd).filter(value => typeof value === 'number')
	return {
		active_elapsed_ms,
		waiting_elapsed_ms,
		total_elapsed_ms: active_elapsed_ms + waiting_elapsed_ms,
		provider_tokens,
		...(costs.length > 0 ? { cost_usd: Math.round(costs.reduce((t, c) => t + c, 0) * 10000) / 10000 } : {}),
		...(estimates.length > 0 ? { visible_text_token_estimate: { value: estimates.reduce((total, value) => total + value, 0), label: 'estimate' } } : {}),
		stages,
	}
}

const evaluate_history = (history_source, options = {}) => {
	const records = Array.isArray(history_source) ? history_source : read_history(history_source)
	const window = parse_window(typeof options === 'number' ? options : options.window === undefined ? [] : ['--window', String(options.window)])
	const ordered = records.map((record, index) => ({ record, index })).sort((left, right) => {
		const left_time = Date.parse(left.record.completed_at)
		const right_time = Date.parse(right.record.completed_at)
		if (Number.isFinite(left_time) && Number.isFinite(right_time) && left_time !== right_time) return left_time - right_time
		return left.index - right.index
	}).map(entry => entry.record)
	const selected = ordered.slice(-window)
	const complete = selected.length >= window
	const report = build_metrics_report(selected)
	const stage_map = new Map()
	for (const record of selected) {
		for (const stage of record.stages) {
			const summary = stage_map.get(stage.stage_id) || {
				stage_id: stage.stage_id,
				stage_kind: stage.stage_kind,
				work_items: new Set(),
				defects: [],
			}
			summary.work_items.add(record.work_item_id)
			summary.defects.push(...stage.defects.map(defect => ({ work_item_id: record.work_item_id, stage_id: stage.stage_id, ...defect })))
			stage_map.set(stage.stage_id, summary)
		}
	}
	const stages = [...stage_map.values()].map(summary => ({
		stage_id: summary.stage_id,
		stage_kind: summary.stage_kind,
		work_item_count: summary.work_items.size,
		defect_count: summary.defects.length,
		duplicate_count: summary.defects.filter(defect => defect.duplicate_of !== null).length,
		cosmetic_count: summary.defects.filter(defect => String(defect.severity).toLowerCase() === 'cosmetic').length,
		defects: summary.defects,
	}))
	const recommendations = complete ? stages.filter(stage => {
		if (stage.work_item_count < 2 || stage.defect_count === 0) return false
		return stage.defects.every(defect => {
			const cosmetic = String(defect.severity).toLowerCase() === 'cosmetic'
			const duplicate = defect.duplicate_of !== null
			return !defect.changed_product_behavior && (cosmetic || duplicate)
		})
	}).map(stage => ({
		stage_id: stage.stage_id,
		stage_kind: stage.stage_kind,
		action: 'consider_optional_or_remove',
		reason: 'repeated findings are cosmetic or duplicates only',
		automatic: false,
		applied: false,
	})) : []
	return {
		window,
		available_records: records.length,
		complete,
		records: selected,
		report,
		stages,
		recommendations,
		stage_selection_changed: false,
	}
}

const format_metrics_report = result => {
	const lines = [
		'- Active pipeline time: ' + result.report.active_elapsed_ms + ' ms.',
		'- Waiting time: ' + result.report.waiting_elapsed_ms + ' ms.',
		'- Work items:',
	]
	for (const record of result.records || []) {
		lines.push('  - ' + record.work_item_id + ':')
		for (const stage of record.stages) {
			lines.push('    - Stage ' + stage.stage_id + ' (' + stage.stage_kind + '):')
			lines.push('      - Active time: ' + stage.elapsed_ms + ' ms.')
			lines.push('      - Retries: ' + stage.retries + '.')
			lines.push('      - Transport failures: ' + stage.transport_failures + '; ' + stage.transport_failure_elapsed_ms + ' ms lost.')
			lines.push('      - Provider tokens:')
			for (const field of TOKEN_FIELDS) lines.push('        - Provider ' + field + ' tokens: ' + stage.provider_tokens[field] + '.')
			if (typeof stage.cost_usd === 'number') lines.push('        - Cost USD: $' + stage.cost_usd + '.')
			if (typeof stage.cache_hit_rate === 'number') lines.push('        - Cache hit rate: ' + (Math.round(stage.cache_hit_rate * 1000) / 10) + '%.')
			if (stage.visible_text_token_estimate) lines.push('      - Visible-text token estimate: ' + stage.visible_text_token_estimate.value + ' (estimate).')
			lines.push('      - Defects:')
			if (stage.defects.length === 0) lines.push('        - None.')
			for (const defect of stage.defects) {
				const duplicate = defect.duplicate_of === null ? 'not a duplicate' : `duplicate of ${defect.duplicate_of.work_item_id}/${defect.duplicate_of.stage_id}/${defect.duplicate_of.defect_id}`
				lines.push('        - Defect ' + defect.defect_id + ': ' + defect.severity + '; changed product behavior: ' + defect.changed_product_behavior + '; ' + duplicate + '.')
			}
		}
	}
	lines.push('- Exact provider token totals:')
	for (const field of TOKEN_FIELDS) lines.push('  - Provider ' + field + ' tokens: ' + result.report.provider_tokens[field] + '.')
	if (typeof result.report.cost_usd === 'number') lines.push('- Total cost: $' + result.report.cost_usd + '.')
	if (result.report.visible_text_token_estimate) lines.push('- Visible-text token estimate total: ' + result.report.visible_text_token_estimate.value + ' (estimate; excluded from exact provider totals).')
	return lines.join('\n')
}

const parse_cli = argv => {
	let history_path
	let config_path
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--history' || argument === '--config' || argument === '--ag-json') {
			if (index + 1 >= argv.length) throw new MetricsError(`${argument} requires a path`)
			if (argument === '--history') history_path = argv[++index]
			else config_path = argv[++index]
		} else if (typeof argument === 'string' && argument.startsWith('--history=')) {
			history_path = argument.slice('--history='.length)
		} else if (argument === '--window') {
			if (index + 1 >= argv.length) throw new MetricsError('evidence window must be a positive integer')
			index += 1
		} else if (typeof argument === 'string' && argument.startsWith('--window=')) {
			continue
		} else if (typeof argument === 'string' && !argument.startsWith('--') && history_path === undefined) {
			history_path = argument
		}
	}
	const window = parse_window(argv)
	return {
		history_path: history_path || (config_path ? history_path_for(config_path) : history_path_for('ag.json')),
		window,
	}
}

const detect_ccxray_endpoint = () => {
	if (process.env.CCXRAY_ENDPOINT) return process.env.CCXRAY_ENDPOINT
	try {
		const os = require('node:os')
		const ccxray_home = process.env.CCXRAY_HOME || node_path.join(os.homedir(), '.ccxray')
		const hub_lock_path = node_path.join(ccxray_home, 'hub.json')
		if (fs.existsSync(hub_lock_path)) {
			const lock = JSON.parse(fs.readFileSync(hub_lock_path, 'utf8'))
			if (lock && Number.isInteger(lock.port)) {
				let is_alive = true
				if (lock.pid) {
					try { process.kill(lock.pid, 0) } catch { is_alive = false }
				}
				if (is_alive) return `http://127.0.0.1:${lock.port}`
			}
		}
	} catch {}
	return null
}

const probe_http_health = url => new Promise(resolve => {
	try {
		const http = require('node:http')
		const u = new URL('/_api/health', url)
		const req = http.get(u, { timeout: 150 }, res => {
			res.resume()
			resolve(res.statusCode === 200)
		})
		req.on('error', () => resolve(false))
		req.on('timeout', () => { req.destroy(); resolve(false) })
	} catch {
		resolve(false)
	}
})

const resolve_ccxray_endpoint = async (options = {}) => {
	if (options.endpoint) return options.endpoint
	if (options.ccxray_endpoint) return options.ccxray_endpoint
	const fast = detect_ccxray_endpoint()
	if (fast) return fast

	const default_url = 'http://127.0.0.1:5577'
	const alive = await probe_http_health(default_url)
	if (alive) return default_url
	return null
}

const fetch_ccxray_metrics = async (task, options = {}) => {
	if (!task || typeof task !== 'string' || !task.trim()) return null
	const endpoint = await resolve_ccxray_endpoint(options)
	if (!endpoint) return null
	const project = options.project || process.env.CCXRAY_PROJECT
	const url = new URL('/api/task-summary', endpoint)
	url.searchParams.set('task', task.trim())
	if (project) url.searchParams.set('project', project.trim())

	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), options.timeout_ms || 3000)
		const res = await fetch(url.toString(), {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
			signal: controller.signal,
		})
		clearTimeout(timeout)
		if (!res.ok) return null
		const data = await res.json()
		if (!data || typeof data !== 'object') return null

		const t = data.tokens || {}
		const cache_tokens = (t.cache_read || 0) + (t.cache_create || 0)
		return {
			task: data.task,
			project: data.project,
			calls: data.calls || 0,
			cost_usd: typeof data.cost_usd === 'number' ? data.cost_usd : 0,
			cache_hit_rate: typeof data.cache_hit_rate === 'number' ? data.cache_hit_rate : 0,
			tokens: {
				input: t.input ?? 'unavailable',
				output: t.output ?? 'unavailable',
				cache: cache_tokens,
				reasoning: t.reasoning ?? 0,
				total: t.total ?? 'unavailable',
			},
		}
	} catch {
		return null
	}
}

const enrich_stage_with_ccxray = async (stage_input, options = {}) => {
	const task_id = stage_input.task_id || stage_input.task || stage_input.stage_id
	const metrics_data = await fetch_ccxray_metrics(task_id, options)
	if (!metrics_data) return create_stage_metrics(stage_input)
	return create_stage_metrics({
		...stage_input,
		provider_tokens: metrics_data.tokens,
		cost_usd: metrics_data.cost_usd,
		cache_hit_rate: metrics_data.cache_hit_rate,
	})
}

const main = argv => {
	try {
		const options = parse_cli(argv)
		const result = evaluate_history(options.history_path, { window: options.window })
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		return 1
	}
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = {
	DEFAULT_WINDOW,
	METRICS_HISTORY_NAME,
	MetricsError,
	append_metrics_history,
	append_metrics_record: record_completed_work_item,
	build_metrics_report,
	create_stage_metrics,
	create_stage_record: create_stage_metrics,
	create_work_item_metrics,
	create_work_item_record: create_work_item_metrics,
	evaluate_history,
	evaluate_evidence_window: evaluate_history,
	format_metrics_report,
	history_path_for,
	metrics_history_path: history_path_for,
	main,
	metrics_enabled,
	normalize_provider_tokens,
	parse_cli,
	parse_window,
	parse_evidence_window: parse_window,
	read_history,
	read_metrics_history: read_history,
	record_completed_work_item,
	append_history_record: append_metrics_history,
	record_work_item: record_completed_work_item,
	evaluate_metrics: evaluate_history,
	fetch_ccxray_metrics,
	enrich_stage_with_ccxray,
	detect_ccxray_endpoint,
	resolve_ccxray_endpoint,
}
