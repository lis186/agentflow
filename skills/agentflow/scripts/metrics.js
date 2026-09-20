'use strict'

const fs = require('node:fs')
const node_os = require('node:os')
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

const ccxray_mode = config => {
	if (config === 'ccxray' || config === 'auto') return config
	if (config === 'on' || config === 'off' || config === true || config === false || config === undefined || config === null) return 'off'
	if (typeof config === 'string') return ccxray_mode(read_config(config))
	return config && (config.switches?.metrics === 'ccxray' || config.switches?.metrics === 'auto')
		? config.switches.metrics
		: 'off'
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
	if (input.tools && typeof input.tools === 'object') stage.tools = input.tools
	if (typeof input.tool_failures === 'number') stage.tool_failures = input.tool_failures
	if (input.skills && typeof input.skills === 'object') stage.skills = input.skills
	if (nonempty_text(input.telemetry_source)) stage.telemetry_source = input.telemetry_source
	if (Number.isInteger(input.provider_calls) && input.provider_calls >= 0) stage.provider_calls = input.provider_calls
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
			if (stage.tools && Object.keys(stage.tools).length > 0) {
				const toolParts = Object.entries(stage.tools).map(([name, count]) => `${name} x${count}`)
				const failSuffix = stage.tool_failures ? ` (failures: ${stage.tool_failures})` : ''
				lines.push('        - Tools used: ' + toolParts.join(', ') + failSuffix + '.')
			}
			if (stage.skills && Object.keys(stage.skills).length > 0) {
				const skillParts = Object.entries(stage.skills).map(([name, count]) => `${name} x${count}`)
				lines.push('        - Skills invoked: ' + skillParts.join(', ') + '.')
			}
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

const attribution_value = value => {
	if (value === undefined || value === null) return null
	const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
	return cleaned.length === 0 || cleaned.length > 128 ? null : cleaned
}

const build_ccxray_attribution_prefix = ({ task, role, project } = {}) => {
	const values = { task: attribution_value(task), role: attribution_value(role), project: attribution_value(project) }
	const parameters = new URLSearchParams()
	for (const key of ['task', 'role', 'project']) if (values[key] !== null) parameters.set(key, values[key])
	const encoded = parameters.toString()
	return encoded === '' ? '' : `/_ccxray/attr/${encodeURIComponent(encoded)}`
}

const ccxray_install_guidance = (options = {}) => {
	if (options.reason === 'ccxray_too_old') {
		return [
			'A running ccxray was found, but it is too old for task attribution.',
			'Upgrade it with npm install -g ccxray@latest, then restart ccxray.',
			'Then start the assistant through it (ccxray claude, ccxray codex, or ccxray grok) or keep ccxray running in another terminal.',
			'Alternatively set metrics: auto to make ccxray optional.',
			'See https://github.com/lis186/ccxray.',
		].join('\n')
	}
	return [
		'ccxray is required because ag.json sets metrics: ccxray but no running ccxray was found.',
		'Install it with npm install -g ccxray.',
		'Then start the assistant through it (ccxray claude, ccxray codex, or ccxray grok) or keep ccxray running in another terminal.',
		'Alternatively set metrics: auto to make ccxray optional.',
		'See https://github.com/lis186/ccxray.',
	].join('\n')
}

const ccxray_executable_available = (options = {}) => {
	if (typeof options.executable_available === 'function') return options.executable_available('ccxray') === true
	if (options.executables !== undefined) {
		if (Array.isArray(options.executables)) return options.executables.includes('ccxray')
		if (is_object(options.executables)) return options.executables.ccxray === true
	}
	if (typeof options.command_exists === 'function') return options.command_exists('ccxray') === true
	const environment = options.env === undefined ? process.env : options.env
	const path_value = options.path_value === undefined ? environment?.PATH : options.path_value
	if (typeof path_value !== 'string') return false
	for (const directory of path_value.split(node_path.delimiter)) {
		if (directory === '') continue
		const candidate = node_path.join(directory, 'ccxray')
		try {
			const stat = fs.statSync(candidate)
			if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return true
		} catch {}
	}
	return false
}

const normalize_endpoint = value => {
	if (!nonempty_text(value)) return null
	try {
		const parsed = new URL(String(value).trim())
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
		return parsed.origin
	} catch {
		return null
	}
}

const hub_endpoint = (options = {}) => {
	const environment = options.env === undefined ? process.env : options.env
	const ccxray_home = environment?.CCXRAY_HOME || node_path.join(node_os.homedir(), '.ccxray')
	const hub_lock_path = node_path.join(ccxray_home, 'hub.json')
	try {
		const lock = JSON.parse(fs.readFileSync(hub_lock_path, 'utf8'))
		if (!lock || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || !Number.isInteger(lock.pid) || lock.pid < 1) return null
		try { process.kill(lock.pid, 0) } catch (error) { if (error?.code !== 'EPERM') return null }
		return `http://127.0.0.1:${lock.port}`
	} catch {
		return null
	}
}

const detect_ccxray_endpoint = (options = {}) => {
	const environment = options.env === undefined ? process.env : options.env
	const explicit = options.ccxray_endpoint ?? options.endpoint ?? environment?.CCXRAY_ENDPOINT
	if (explicit !== undefined && explicit !== null) return normalize_endpoint(explicit)
	return hub_endpoint(options)
}

const probe_http_health = async (endpoint, options = {}) => {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.health_timeout_ms ?? 3000)
	try {
		const response = await fetch(new URL('/_api/health', endpoint).toString(), {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
			signal: controller.signal,
		})
		if (response.status !== 200) return { healthy: false, reason: 'ccxray_not_found' }
		const data = await response.json()
		if (!data || data.ok !== true || data.app !== 'ccxray') return { healthy: false, reason: 'ccxray_not_found' }
		if (!Array.isArray(data.capabilities) || !data.capabilities.includes('task-attribution')) return { healthy: false, reason: 'ccxray_too_old' }
		return { healthy: true, reason: null }
	} catch {
		return { healthy: false, reason: 'ccxray_not_found' }
	} finally {
		clearTimeout(timeout)
	}
}

const check_ccxray_endpoint = async (endpoint, options = {}) => {
	const normalized = normalize_endpoint(endpoint)
	if (!normalized) return { endpoint: null, reason: 'ccxray_not_found' }
	const probe = options.health_check || options.probe_ccxray || options.probe
	let result
	try {
		result = typeof probe === 'function' ? await probe(normalized) : await probe_http_health(normalized, options)
	} catch {
		return { endpoint: null, reason: 'ccxray_not_found' }
	}
	if (result === true) return { endpoint: normalized, reason: null }
	if (result && result.healthy === true) return { endpoint: normalized, reason: null }
	if (result && result.ok === true && result.app === 'ccxray') {
		return Array.isArray(result.capabilities) && result.capabilities.includes('task-attribution')
			? { endpoint: normalized, reason: null }
			: { endpoint: null, reason: 'ccxray_too_old' }
	}
	return { endpoint: null, reason: result?.reason === 'ccxray_too_old' ? 'ccxray_too_old' : 'ccxray_not_found' }
}

const resolve_ccxray_endpoint = async (options = {}) => {
	const environment = options.env === undefined ? process.env : options.env
	const explicit = options.ccxray_endpoint ?? options.endpoint
	if (explicit !== undefined && explicit !== null) return check_ccxray_endpoint(explicit, options)
	if (environment?.CCXRAY_ENDPOINT) return check_ccxray_endpoint(environment.CCXRAY_ENDPOINT, options)

	const from_hub = hub_endpoint(options)
	if (from_hub) {
		const hub_result = await check_ccxray_endpoint(from_hub, options)
		if (hub_result.endpoint || hub_result.reason === 'ccxray_too_old') return hub_result
	}

	const probe_endpoint = options.probe_endpoint ?? options.default_endpoint ?? 'http://127.0.0.1:5577'
	if (probe_endpoint === null || probe_endpoint === false) return { endpoint: null, reason: 'ccxray_not_found' }
	return check_ccxray_endpoint(probe_endpoint, options)
}

const fetch_ccxray_metrics = async (task, options = {}) => {
	if (!nonempty_text(task)) return null
	const resolution = await resolve_ccxray_endpoint(options)
	if (!resolution.endpoint) return null
	const url = new URL('/_api/task-summary', resolution.endpoint)
	url.searchParams.set('task', task.trim())
	for (const key of ['role', 'project']) if (nonempty_text(options[key])) url.searchParams.set(key, String(options[key]).trim())

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 3000)
	try {
		const response = await fetch(url.toString(), {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
			signal: controller.signal,
		})
		if (response.status !== 200) return null
		const data = await response.json()
		if (!data || typeof data !== 'object' || data.calls === 0) return null

		const token_data = data.tokens && typeof data.tokens === 'object' ? data.tokens : {}
		const cache_tokens = (token_data.cache_read || 0) + (token_data.cache_create || 0)
		return {
			task: data.task,
			role: data.role ?? options.role,
			project: data.project ?? options.project,
			calls: data.calls,
			cost_usd: typeof data.cost_usd === 'number' ? data.cost_usd : 0,
			cache_hit_rate: typeof data.cache_hit_rate === 'number' ? data.cache_hit_rate : 0,
			tools: data.tools && typeof data.tools === 'object' ? data.tools : {},
			tool_failures: typeof data.tool_failures === 'number' ? data.tool_failures : 0,
			skills: data.skills && typeof data.skills === 'object' ? data.skills : {},
			models: Array.isArray(data.models) ? data.models : [],
			agents: Array.isArray(data.agents) ? data.agents : [],
			sessions: data.sessions,
			by_role: data.by_role && typeof data.by_role === 'object' ? data.by_role : {},
			tokens: {
				input: token_data.input ?? 'unavailable',
				output: token_data.output ?? 'unavailable',
				cache: cache_tokens,
				reasoning: token_data.reasoning ?? 0,
				total: token_data.total ?? 'unavailable',
			},
		}
	} catch {
		return null
	} finally {
		clearTimeout(timeout)
	}
}

const ccxray_format_value = value => value === undefined || value === null ? 'unavailable' : String(value)

const ccxray_format_cost = value => {
	const numeric = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(numeric) ? numeric.toFixed(4) : 'unavailable'
}

const ccxray_format_rate = value => {
	const numeric = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : 'unavailable'
}

const ccxray_format_list = value => Array.isArray(value)
	? value.filter(nonempty_text).map(item => String(item).trim()).join(', ')
	: ''

const ccxray_format_label = (task, role) => {
	const task_value = nonempty_text(task) ? String(task).trim() : 'unknown'
	const role_value = nonempty_text(role) ? String(role).trim() : null
	return role_value ? `${task_value}/${role_value}` : task_value
}

const ccxray_role_total = (role, values = {}) => {
	const tokens = is_object(values.tokens) ? values.tokens : {}
	const total_tokens = first_value(tokens, ['total', 'total_tokens']) ?? first_value(values, ['total_tokens', 'tokens_total', 'tokens'])
	return `  - ${role}: ${ccxray_format_value(first_value(values, ['calls', 'provider_calls']))} calls · $${ccxray_format_cost(first_value(values, ['cost_usd', 'cost']))} · ${ccxray_format_value(total_tokens)} tokens`
}

const format_ccxray_devlog_lines = (summary, options = {}) => {
	const option_values = is_object(options) ? options : {}
	const unavailable = option_values.unavailable
	if (is_object(unavailable)) {
		const lines = [`- ccxray ${ccxray_format_label(unavailable.task, unavailable.role)}: unavailable (${ccxray_format_value(unavailable.reason)})`]
		if (nonempty_text(unavailable.guidance)) {
			for (const line of String(unavailable.guidance).split(/\r?\n/u)) {
				if (line.trim() !== '') lines.push(`  - ${line.trim()}`)
			}
		}
		return lines
	}
	if (!is_object(summary) || !nonempty_text(summary.task)) return []

	const role = nonempty_text(option_values.role) ? String(option_values.role).trim() : nonempty_text(summary.role) ? String(summary.role).trim() : null
	const tokens = is_object(summary.tokens) ? summary.tokens : {}
	const models = ccxray_format_list(summary.models)
	const agents = ccxray_format_list(summary.agents)
	const attribution = models !== '' && agents !== ''
		? ` · ${models} via ${agents}`
		: models !== ''
			? ` · ${models}`
			: agents !== ''
				? ` · ${agents}`
				: ''
	const lines = [
		`- ccxray ${ccxray_format_label(summary.task, role)}: ${ccxray_format_value(summary.calls)} calls · $${ccxray_format_cost(summary.cost_usd)} · tokens in ${ccxray_format_value(tokens.input)} / out ${ccxray_format_value(tokens.output)} / cache ${ccxray_format_value(tokens.cache)} (hit ${ccxray_format_rate(summary.cache_hit_rate)}) / total ${ccxray_format_value(tokens.total)}${attribution}`,
	]

	const by_role = is_object(summary.by_role) ? summary.by_role : {}
	if (!role && Object.keys(by_role).length >= 2) {
		for (const role_name of Object.keys(by_role).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
			lines.push(ccxray_role_total(role_name, is_object(by_role[role_name]) ? by_role[role_name] : {}))
		}
	}

	const tools = is_object(summary.tools) ? summary.tools : {}
	const tool_names = Object.keys(tools).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
	if (tool_names.length > 0) {
		const failure_suffix = summary.tool_failures === 0 ? '' : `; failures: ${ccxray_format_value(summary.tool_failures)}`
		lines.push(`  - tools: ${tool_names.map(name => `${name} x${ccxray_format_value(tools[name])}`).join(', ')}${failure_suffix}`)
	}
	return lines
}

const enrich_stage_with_ccxray = async (stage_input, options = {}) => {
	const task_id = stage_input.task_id ?? stage_input.task ?? options.task
	if (!nonempty_text(task_id)) return create_stage_metrics(stage_input)
	const role = stage_input.role ?? options.role ?? stage_input.stage_id
	const metrics_data = await fetch_ccxray_metrics(task_id, { ...options, role, project: options.project })
	if (!metrics_data) return create_stage_metrics(stage_input)
	const original = create_stage_metrics(stage_input)
	const provider_tokens = Object.fromEntries(TOKEN_FIELDS.map(field => [
		field,
		metrics_data.tokens[field] === 'unavailable' && Number.isInteger(original.provider_tokens[field])
			? original.provider_tokens[field]
			: metrics_data.tokens[field],
	]))
	return create_stage_metrics({
		...stage_input,
		provider_tokens,
		cost_usd: metrics_data.cost_usd,
		cache_hit_rate: metrics_data.cache_hit_rate,
		tools: metrics_data.tools,
		tool_failures: metrics_data.tool_failures,
		skills: metrics_data.skills,
		telemetry_source: 'ccxray',
		provider_calls: metrics_data.calls,
	})
}

const enrichment_telemetry = (status, reason = null, guidance = null) => ({ status, reason, guidance })

const enrich_work_item_with_ccxray = async (work_item_input, options = {}) => {
	const normalized = create_work_item_metrics(work_item_input)
	const mode_config = options.config !== undefined ? options.config : options.config_path !== undefined ? options.config_path : options.metrics
	const mode = ccxray_mode(mode_config)
	if (mode === 'off') return { work_item: normalized, telemetry: enrichment_telemetry('off') }

	const task_id = work_item_input.task_id ?? work_item_input.work_item_id
	if (!nonempty_text(task_id)) return { work_item: normalized, telemetry: enrichment_telemetry('skipped', 'no_task') }
	const resolution = await resolve_ccxray_endpoint(options)
	if (!resolution.endpoint) {
		const guidance = mode === 'ccxray' ? ccxray_install_guidance({ reason: resolution.reason }) : null
		return { work_item: normalized, telemetry: enrichment_telemetry('unavailable', resolution.reason, guidance) }
	}

	const project = options.project ?? work_item_input.project
	const stages = []
	for (const [index, stage] of normalized.stages.entries()) {
		const source_stage = work_item_input.stages[index]
		const stage_with_attribution = source_stage && source_stage.role !== undefined
			? { ...stage, role: source_stage.role, task_id }
			: { ...stage, task_id }
		stages.push(await enrich_stage_with_ccxray(stage_with_attribution, { ...options, endpoint: resolution.endpoint, project }))
	}
	return {
		work_item: create_work_item_metrics({ ...work_item_input, stages }),
		telemetry: enrichment_telemetry('active'),
	}
}

const parse_cli = argv => {
	if (argv[0] === 'ccxray-summary') {
		let task
		let role
		let project
		let config_path
		let format
		for (let index = 1; index < argv.length; index += 1) {
			const argument = argv[index]
			if (argument === '--task' || argument === '--role' || argument === '--project' || argument === '--config' || argument === '--ag-json' || argument === '--format') {
				if (index + 1 >= argv.length) throw new MetricsError(`${argument} requires a value`)
				const value = argv[++index]
				if (argument === '--task') task = value
				else if (argument === '--role') role = value
				else if (argument === '--project') project = value
				else if (argument === '--format') format = value
				else config_path = value
			} else if (typeof argument === 'string' && argument.startsWith('--task=')) task = argument.slice('--task='.length)
			else if (typeof argument === 'string' && argument.startsWith('--role=')) role = argument.slice('--role='.length)
			else if (typeof argument === 'string' && argument.startsWith('--project=')) project = argument.slice('--project='.length)
			else if (typeof argument === 'string' && (argument.startsWith('--config=') || argument.startsWith('--ag-json='))) config_path = argument.slice(argument.indexOf('=') + 1)
			else if (typeof argument === 'string' && argument.startsWith('--format=')) format = argument.slice('--format='.length)
		}
		if (!nonempty_text(task)) throw new MetricsError('ccxray-summary requires --task <id>')
		return { subcommand: 'ccxray-summary', task, role, project, config_path, format }
	}

	let history_path
	let config_path
	let format
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
		} else if (argument === '--format') {
			if (index + 1 >= argv.length) throw new MetricsError('--format requires a value')
			format = argv[++index]
		} else if (typeof argument === 'string' && argument.startsWith('--window=')) {
			continue
		} else if (typeof argument === 'string' && argument.startsWith('--format=')) {
			format = argument.slice('--format='.length)
		} else if (typeof argument === 'string' && !argument.startsWith('--') && history_path === undefined) {
			history_path = argument
		}
	}
	const window = parse_window(argv)
	return {
		history_path: history_path || (config_path ? history_path_for(config_path) : history_path_for('ag.json')),
		window,
		format,
	}
}

const write_ccxray_output = (format, summary, unavailable, options = {}) => {
	if (format === 'devlog') {
		const unavailable_options = unavailable
			? { unavailable: { ...unavailable, task: unavailable.task ?? options.task, role: unavailable.role ?? options.role } }
			: options
		const lines = format_ccxray_devlog_lines(summary, unavailable_options)
		process.stdout.write(`${lines.join('\n')}\n`)
		return
	}
	process.stdout.write(`${JSON.stringify(unavailable || summary, null, 2)}\n`)
}

const main = async argv => {
	try {
		const options = parse_cli(argv)
		if (options.subcommand === 'ccxray-summary') {
			const format = options.format || 'json'
			if (!['json', 'devlog'].includes(format)) throw new MetricsError(`unknown format: ${format}`)
			let mode
			try {
				mode = options.config_path ? ccxray_mode(options.config_path) : 'auto'
			} catch {
				write_ccxray_output(format, null, { available: false, reason: 'config_unreadable' }, {
					task: options.task,
					role: options.role,
				})
				return 0
			}
			if (mode === 'off') {
				write_ccxray_output(format, null, {
					available: false,
					reason: 'metrics_disabled',
				}, {
					task: options.task,
					role: options.role,
				})
				return 0
			}
			const resolution = await resolve_ccxray_endpoint(options)
			const result = resolution.endpoint
				? await fetch_ccxray_metrics(options.task, { ...options, endpoint: resolution.endpoint })
				: null
			if (result) write_ccxray_output(format, result, null, { role: options.role })
			else {
				const unavailable = { available: false, reason: resolution.endpoint ? 'no_data' : resolution.reason }
				if (mode === 'ccxray' && !resolution.endpoint) unavailable.guidance = ccxray_install_guidance({ reason: unavailable.reason })
				write_ccxray_output(format, null, unavailable, {
					task: options.task,
					role: options.role,
				})
			}
			return 0
		}
		if (options.format !== undefined && options.format !== 'json') throw new MetricsError(`unknown format: ${options.format}`)
		const result = evaluate_history(options.history_path, { window: options.window })
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		return 1
	}
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code })

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
	format_ccxray_devlog_lines,
	history_path_for,
	metrics_history_path: history_path_for,
	main,
	metrics_enabled,
	ccxray_mode,
	build_ccxray_attribution_prefix,
	ccxray_install_guidance,
	ccxray_executable_available,
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
	enrich_work_item_with_ccxray,
	detect_ccxray_endpoint,
	resolve_ccxray_endpoint,
}
