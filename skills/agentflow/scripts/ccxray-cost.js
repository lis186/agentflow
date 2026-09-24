'use strict'

const fs = require('node:fs')
const node_os = require('node:os')
const node_path = require('node:path')

const HOST_SESSION_LOG_NAME = 'host-sessions.jsonl'
const CCXRAY_SCHEMA_VERSION = 1
const CCXRAY_EXPORTER_VERSION = '8.2.0'
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

const safe_integer = (value, label, minimum = 0) => {
	if (!Number.isSafeInteger(value) || value < minimum) throw new MetricsError(`${label} must be a non-negative integer`)
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

const utc_timestamp_text = (value, label) => new Date(timestamp_ms(value, label)).toISOString()

const first_value = (object, names) => {
	for (const name of names) {
		if (object && object[name] !== undefined) return object[name]
	}
	return undefined
}

const read_config = config_path => {
	try {
		return JSON.parse(fs.readFileSync(config_path, 'utf8'))
	} catch (error) {
		throw new MetricsError(`cannot read metrics configuration: ${error.message}`, 'AG_METRICS_CONFIG')
	}
}


const ccxray_mode = config => {
	if (config === 'on' || config === 'auto') return config
	if (config === 'off' || config === false || config === undefined || config === null) return 'off'
	if (typeof config === 'string') return ccxray_mode(read_config(config))
	const value = config?.switches?.ccxray
	return value === 'on' || value === 'auto' ? value : 'off'
}

const host_session = (env = process.env) => {
	const environment = env && typeof env === 'object' ? env : {}
	const codex_id = nonempty_text(environment.CODEX_THREAD_ID)
		? String(environment.CODEX_THREAD_ID)
		: nonempty_text(environment.CODEX_SESSION_ID)
			? String(environment.CODEX_SESSION_ID)
			: null
	if (codex_id !== null) return { host: 'codex', session_id: codex_id }
	const claude_id = nonempty_text(environment.CLAUDE_CODE_SESSION_ID)
		? String(environment.CLAUDE_CODE_SESSION_ID)
		: nonempty_text(environment.CLAUDE_SESSION_ID)
			? String(environment.CLAUDE_SESSION_ID)
			: null
	return claude_id === null ? { host: null, session_id: null } : { host: 'claude', session_id: claude_id }
}

const workspace_root_for_config = (config_path, workspace) => {
	const absolute_config = node_path.resolve(config_path)
	const config_directory = node_path.dirname(absolute_config)
	let current = config_directory
	while (true) {
		const candidate = node_path.resolve(current, workspace)
		try {
			if (fs.statSync(candidate).isDirectory()) return current
		} catch {}
		const parent = node_path.dirname(current)
		if (parent === current) break
		current = parent
	}
	const workspace_parts = String(workspace).replace(/\\/gu, '/').split('/').filter(Boolean)
	const directory_parts = config_directory.split(node_path.sep)
	for (let index = directory_parts.length - workspace_parts.length; index >= 0; index -= 1) {
		if (workspace_parts.length > 0 && workspace_parts.every((part, offset) => directory_parts[index + offset] === part)) {
			return directory_parts.slice(0, index).join(node_path.sep) || node_path.parse(config_directory).root
		}
	}
	return config_directory
}

const host_session_log_path = (options = {}) => {
	const config_path = options.config_path || node_path.join(options.repo_root || process.cwd(), 'ag.json')
	const config = options.config || read_config(config_path)
	const workspace = config?.switches?.['workspace-dir'] || '.agentflow'
	const root = options.repo_root
		? node_path.resolve(options.repo_root)
		: workspace_root_for_config(config_path, workspace)
	return node_path.join(node_path.resolve(root, workspace), '.tmp', HOST_SESSION_LOG_NAME)
}

const config_path_for_touch = options => {
	if (nonempty_text(options.config_path)) return node_path.resolve(options.config_path)
	const root = node_path.resolve(options.repo_root || process.cwd())
	if (nonempty_text(options.notebook_path)) {
		const relative_notebook = node_path.isAbsolute(options.notebook_path)
			? node_path.relative(root, options.notebook_path)
			: options.notebook_path
		const adjacent = node_path.resolve(root, node_path.dirname(relative_notebook), 'ag.json')
		if (fs.existsSync(adjacent)) return adjacent
	}
	return node_path.join(root, 'ag.json')
}

const record_host_touch = (options = {}) => {
	try {
		const identity = host_session(options.env === undefined ? process.env : options.env)
		if (identity.session_id === null || !nonempty_text(options.ask) || !nonempty_text(options.event)) return false
		const config_path = config_path_for_touch(options)
		if (!nonempty_text(options.config_path) && !fs.existsSync(config_path)) return false
		const config = options.config || read_config(config_path)
		if (!['auto', 'on'].includes(ccxray_mode(config))) return false
		const timestamp = options.ts === undefined ? Date.now() : options.ts
		if (!Number.isSafeInteger(timestamp) || timestamp < 0) return false
		const log_path = host_session_log_path({ ...options, config_path, config })
		fs.mkdirSync(node_path.dirname(log_path), { recursive: true })
		const record = {
			ask: String(options.ask),
			session_id: identity.session_id,
			host: identity.host,
			ts: timestamp,
			event: String(options.event),
		}
		if (record.event === 'attempt') {
			if (!nonempty_text(options.role)) return false
			const attempt = safe_integer(options.attempt === undefined ? 1 : options.attempt, 'attempt')
			if (!['succeeded', 'failed', 'cancelled', 'running'].includes(options.outcome)) return false
			const started_ms = safe_integer(options.started_ms, 'started_ms')
			const ended_ms = safe_integer(options.ended_ms, 'ended_ms')
			if (ended_ms < started_ms) return false
			record.role = String(options.role)
			record.attempt = attempt
			record.outcome = String(options.outcome)
			record.started_ms = started_ms
			record.ended_ms = ended_ms
			if (nonempty_text(options.project)) record.project = String(options.project)
		}
		fs.appendFileSync(log_path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
		return true
	} catch {
		return false
	}
}

const read_host_session_records = log_path => {
	try {
		return fs.readFileSync(log_path, 'utf8').split(/\r?\n/u).filter(line => line.trim() !== '')
	} catch {
		return []
	}
}

const parse_host_touch = value => {
	let record = value
	if (typeof value === 'string') {
		try { record = JSON.parse(value) } catch { return null }
	}
	if (!is_object(record) || !nonempty_text(record.ask) || !nonempty_text(record.session_id) || !nonempty_text(record.event)) return null
	if (!Number.isSafeInteger(record.ts) || record.ts < 0) return null
	const parsed = {
		ask: String(record.ask),
		session_id: String(record.session_id),
		ts: record.ts,
		event: String(record.event),
	}
	if (parsed.event === 'attempt') {
		if (!nonempty_text(record.role) || !Number.isSafeInteger(record.attempt) || record.attempt < 0 || !['succeeded', 'failed', 'cancelled', 'running'].includes(record.outcome)) return null
		if (!Number.isSafeInteger(record.started_ms) || record.started_ms < 0 || !Number.isSafeInteger(record.ended_ms) || record.ended_ms < record.started_ms) return null
		parsed.role = String(record.role)
		parsed.attempt = record.attempt
		parsed.outcome = String(record.outcome)
		parsed.started_ms = record.started_ms
		parsed.ended_ms = record.ended_ms
		parsed.host = nonempty_text(record.host) ? String(record.host) : null
		if (nonempty_text(record.project)) parsed.project = String(record.project)
	}
	return parsed
}

const HOST_LEAD_MS = 180000
const HOST_TAIL_MS = 120000
const is_close_touch = record => record.event === 'close' || record.event === 'close-round'

// Partition one session's timeline by its touches, in order, so that every
// instant belongs to at most one Ask (independent review found both a shared
// boundary millisecond and overlapping spans for interleaved Asks):
// - a touch owns the time until the next touch;
// - a close owns at most HOST_TAIL_MS after itself, and the next Ask's first
//   touch reaches back at most HOST_LEAD_MS; when those two paddings would
//   meet, the gap is split at its midpoint, and when they would not, the
//   middle of the gap belongs to nobody (the host was not doing Agentflow work);
// - an Ask that is interrupted by another Ask's touch before closing hands
//   over at that touch, with no lead padding for the newcomer;
// - the very first touch reaches back HOST_LEAD_MS; an unclosed final touch is
//   open-ended.
// Intervals are inclusive, so a boundary at B is [.., B - 1] and [B, ..].
const session_segments = touches => {
	const segments = []
	for (let index = 0; index < touches.length; index += 1) {
		const touch = touches[index]
		const next = touches[index + 1]
		const previous = touches[index - 1]
		let from = touch.ts
		if (!previous) from = Math.max(0, touch.ts - HOST_LEAD_MS)
		else if (previous.ask !== touch.ask && is_close_touch(previous)) {
			const gap = touch.ts - previous.ts
			from = gap < HOST_LEAD_MS + HOST_TAIL_MS ? previous.ts + Math.floor(gap / 2) : touch.ts - HOST_LEAD_MS
		}
		let to = null
		if (next) {
			if (next.ask === touch.ask) to = next.ts - 1
			else if (is_close_touch(touch)) {
				const gap = next.ts - touch.ts
				to = (gap < HOST_LEAD_MS + HOST_TAIL_MS ? touch.ts + Math.floor(gap / 2) : touch.ts + HOST_TAIL_MS) - 1
			} else to = next.ts - 1
		} else if (is_close_touch(touch)) to = touch.ts + HOST_TAIL_MS
		if (to !== null && to < from) continue
		segments.push({ ask: touch.ask, from, to })
	}
	return segments
}

const merge_adjacent = segments => {
	const merged = []
	for (const segment of segments) {
		const last = merged[merged.length - 1]
		if (last && last.to !== null && segment.from <= last.to + 1) {
			last.to = segment.to === null ? null : Math.max(last.to, segment.to)
		} else merged.push({ ...segment })
	}
	return merged
}

const host_session_intervals = (ask, records, _now = Date.now(), limit = 32) => {
	if (!nonempty_text(ask) || !Array.isArray(records)) return []
	const valid = records.map(parse_host_touch).filter(record => record !== null)
	const by_session = new Map()
	for (const record of valid) {
		if (!by_session.has(record.session_id)) by_session.set(record.session_id, [])
		by_session.get(record.session_id).push(record)
	}
	const intervals = []
	for (const [session, session_records] of by_session.entries()) {
		const touches = session_records.slice().sort((left, right) => left.ts - right.ts)
		const owned = merge_adjacent(session_segments(touches).filter(segment => segment.ask === String(ask)))
		for (const segment of owned) intervals.push({ interval: { session, from: segment.from, to: segment.to }, last: segment.to === null ? Number.MAX_SAFE_INTEGER : segment.to })
	}
	intervals.sort((left, right) => left.last - right.last)
	const selected = limit === null ? intervals : intervals.slice(-limit)
	return selected.map(entry => entry.interval)
}

const decimal_source = (value, label, nullable = false) => {
	if (value === null || value === undefined) {
		if (nullable) return null
		throw new MetricsError(`${label} must be a decimal`)
	}
	let text = typeof value === 'number' ? String(value) : typeof value === 'bigint' ? String(value) : String(value).trim()
	if (text.startsWith('+')) text = text.slice(1)
	const exponent = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(text)
	if (exponent) {
		const sign = exponent[1]
		const digits = `${exponent[2]}${exponent[3] || ''}`
		const point = exponent[2].length + Number(exponent[4])
		if (point <= 0) text = `${sign}0.${'0'.repeat(-point)}${digits}`
		else if (point >= digits.length) text = `${sign}${digits}${'0'.repeat(point - digits.length)}`
		else text = `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
	}
	const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text)
	if (!match || match[1] === '-') throw new MetricsError(`${label} must be a non-negative decimal`)
	const fraction = match[3] || ''
	let digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/u, '')
	let scale = fraction.length
	while (scale > 0 && digits.endsWith('0')) {
		digits = digits.slice(0, -1)
		scale -= 1
	}
	return { numerator: BigInt(digits || '0'), denominator: 10n ** BigInt(scale), scale }
}

const rational_reduce = value => {
	if (value.numerator === 0n) return { numerator: 0n, denominator: 1n }
	let left = value.numerator
	let right = value.denominator
	while (right !== 0n) {
		const remainder = left % right
		left = right
		right = remainder
	}
	return { numerator: value.numerator / left, denominator: value.denominator / left }
}

const rational_add = (left, right) => rational_reduce({
	numerator: left.numerator * right.denominator + right.numerator * left.denominator,
	denominator: left.denominator * right.denominator,
})

const rational_multiply = (left, right) => rational_reduce({
	numerator: left.numerator * right.numerator,
	denominator: left.denominator * right.denominator,
})

const rational_divide_integer = (value, divisor) => rational_reduce({ numerator: value.numerator, denominator: value.denominator * BigInt(divisor) })

const rational_compare = (left, right) => {
	const difference = left.numerator * right.denominator - right.numerator * left.denominator
	return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

const rational_absolute_difference = (left, right) => {
	const difference = left.numerator * right.denominator - right.numerator * left.denominator
	return rational_reduce({ numerator: difference < 0n ? -difference : difference, denominator: left.denominator * right.denominator })
}

const rational_to_decimal = value => {
	const reduced = rational_reduce(value)
	let denominator = reduced.denominator
	let twos = 0
	let fives = 0
	while (denominator % 2n === 0n) {
		denominator /= 2n
		twos += 1
	}
	while (denominator % 5n === 0n) {
		denominator /= 5n
		fives += 1
	}
	if (denominator !== 1n) throw new MetricsError('receipt decimal has a non-terminating denominator')
	const scale = Math.max(twos, fives)
	const numerator = reduced.numerator * (2n ** BigInt(scale - twos)) * (5n ** BigInt(scale - fives))
	const digits = numerator.toString().padStart(scale + 1, '0')
	if (scale === 0) return digits
	const whole = digits.slice(0, -scale) || '0'
	const fraction = digits.slice(-scale).replace(/0+$/u, '')
	return fraction === '' ? whole : `${whole}.${fraction}`
}

const round_rational_to_integer = value => {
	const quotient = value.numerator / value.denominator
	const remainder = value.numerator % value.denominator
	return remainder * 2n >= value.denominator ? quotient + 1n : quotient
}

const rational_to_fixed = (value, decimal_places) => {
	if (!Number.isInteger(decimal_places) || decimal_places < 0) throw new MetricsError('decimal places must be a non-negative integer')
	const negative = value.numerator < 0n
	const absolute = { numerator: negative ? -value.numerator : value.numerator, denominator: value.denominator }
	const scale = 10n ** BigInt(decimal_places)
	const rounded = round_rational_to_integer(rational_multiply(absolute, { numerator: scale, denominator: 1n }))
	const whole = rounded / scale
	const fraction = decimal_places === 0 ? '' : `.${(rounded % scale).toString().padStart(decimal_places, '0')}`
	return `${negative ? '-' : ''}${whole}${fraction}`
}

const decimal_text = (value, label, nullable = false) => {
	const source = decimal_source(value, label, nullable)
	return source === null ? null : rational_to_decimal({ numerator: source.numerator, denominator: source.denominator })
}

const ccxray_summary_value = (summary, names, fallback) => {
	for (const name of names) {
		if (summary && summary[name] !== undefined) return summary[name]
	}
	return fallback
}

const receipt_count = value => {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

const receipt_slug = value => {
	const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
	return slug || 'unknown'
}

const receipt_cutoff_id = cutoff => utc_timestamp_text(cutoff, 'cutoff').replace(/[-:]/gu, '').replace(/\.\d{3}/u, '').toLowerCase()

const receipt_snapshot_id = ({ kind, ask, cutoff, scopes }) => {
	const role = kind === 'attempt' ? scopes[0]?.role || 'unknown' : 'cumulative'

	const suffix = kind === 'attempt' ? `-a${scopes[0]?.attempt ?? 1}` : ''
	return `${receipt_cutoff_id(cutoff)}-${receipt_slug(ask)}-${receipt_slug(role)}${suffix}`
}

const normalize_receipt_selector = (scope, cutoff) => {
	const input = is_object(scope.selector) ? scope.selector : scope
	const start = first_value(input, ['start_inclusive', 'from', 'from_ms'])
	const end = first_value(input, ['end_exclusive', 'to_exclusive', 'to', 'to_ms'])
	if (start === undefined) throw new MetricsError(`scope ${scope.id || 'unknown'} is missing selector.start_inclusive`)
	const end_value = end === undefined || end === null ? cutoff : end
	if (timestamp_ms(end_value, 'scope.selector.end_exclusive') < timestamp_ms(start, 'scope.selector.start_inclusive')) throw new MetricsError(`scope ${scope.id || 'unknown'} selector end must not precede start`)
	const selector = {
		start_inclusive: utc_timestamp_text(start, 'scope.selector.start_inclusive'),
		end_exclusive: utc_timestamp_text(end_value, 'scope.selector.end_exclusive'),
	}
	if (is_object(input.labels)) selector.labels = Object.fromEntries(['task', 'role', 'project'].filter(key => nonempty_text(input.labels[key])).map(key => [key, String(input.labels[key])]))
	if (nonempty_text(input.session_id ?? input.session)) selector.session_id = String(input.session_id ?? input.session)
	return selector
}

const normalize_receipt_charge = value => {
	const charge = is_object(value) ? value : {}
	const basis = ['recorded', 'fallback', 'unpriced'].includes(charge.basis) ? charge.basis : 'unpriced'
	const quantity_source = decimal_source(charge.quantity, 'charge.quantity', true)
	const rate_source = decimal_source(charge.usd_per_unit, 'charge.usd_per_unit', true)
	return {
		model: charge.model === null || charge.model === undefined ? null : String(charge.model),
		billing_provider: charge.billing_provider === null || charge.billing_provider === undefined ? null : String(charge.billing_provider),
		component: nonempty_text(charge.component) ? String(charge.component) : 'unknown',
		unit: 'tokens',
		quantity_source,
		usd_per_unit_source: rate_source,
		quantity: quantity_source === null ? null : rational_to_decimal(quantity_source),
		usd_per_unit: rate_source === null ? null : rational_to_decimal(rate_source),
		basis,
		price_key: charge.price_key === null || charge.price_key === undefined ? null : String(charge.price_key),
		rate_source: charge.rate_source === null || charge.rate_source === undefined ? null : String(charge.rate_source),
	}
}

const aggregate_receipt_charges = charges => {
	const buckets = new Map()
	for (const input of Array.isArray(charges) ? charges : []) {
		const charge = normalize_receipt_charge(input)
		const key = JSON.stringify([charge.model, charge.billing_provider, charge.component, charge.usd_per_unit, charge.basis])
		const existing = buckets.get(key)
		if (!existing) {
			buckets.set(key, { ...charge })
			continue
		}
		if (existing.quantity_source === null || charge.quantity_source === null) existing.quantity_source = null
		else existing.quantity_source = rational_add(existing.quantity_source, charge.quantity_source)
		if (existing.price_key !== charge.price_key) existing.price_key = null
		if (existing.rate_source !== charge.rate_source) existing.rate_source = null
	}
	return [...buckets.values()].sort((left, right) => {
		const left_key = JSON.stringify([left.model, left.billing_provider, left.component, left.usd_per_unit, left.basis])
		const right_key = JSON.stringify([right.model, right.billing_provider, right.component, right.usd_per_unit, right.basis])
		return left_key < right_key ? -1 : left_key > right_key ? 1 : 0
	}).map(charge => {
		const computable = charge.basis !== 'unpriced' && charge.quantity_source !== null && charge.usd_per_unit_source !== null
		const usd = computable
			? rational_to_decimal(rational_divide_integer(rational_multiply(charge.quantity_source, charge.usd_per_unit_source), 1000000))
			: null
		return {
			model: charge.model,
			billing_provider: charge.billing_provider,
			component: charge.component,
			unit: 'tokens',
			quantity: charge.quantity_source === null ? null : rational_to_decimal(charge.quantity_source),
			usd_per_unit: charge.usd_per_unit_source === null ? null : rational_to_decimal(charge.usd_per_unit_source),
			usd,
			basis: charge.basis,
			price_key: charge.price_key,
			rate_source: charge.rate_source,
			usd_rational: computable
				? rational_divide_integer(rational_multiply(charge.quantity_source, charge.usd_per_unit_source), 1000000)
				: null,
		}
	})
}

const normalize_receipt_entry = value => {
	if (!is_object(value)) return null
	const entry = {}
	for (const key of ['id', 'model', 'role']) {
		if (typeof value[key] === 'string') entry[key] = value[key]
	}
	if (typeof value.received_at === 'string' || typeof value.received_at === 'number' && Number.isFinite(value.received_at)) entry.received_at = value.received_at
	if (Number.isInteger(value.requests) && value.requests >= 0) entry.requests = value.requests
	if (is_object(value.usage)) {
		const usage = {}
		for (const key of ['input', 'output', 'cache_read', 'cache_create']) {
			if (Number.isInteger(value.usage[key]) && value.usage[key] >= 0) usage[key] = value.usage[key]
		}
		if (Object.keys(usage).length > 0) entry.usage = usage
	}
	if (typeof value.cost_usd === 'number' && Number.isFinite(value.cost_usd)) entry.cost_usd = value.cost_usd
	if (typeof value.cost_usd === 'string') {
		try {
			decimal_source(value.cost_usd, 'entry.cost_usd')
			entry.cost_usd = value.cost_usd
		} catch {}
	}
	return entry
}

const receipt_summary_for_scope = (scope, summary) => {
	const values = is_object(summary) ? summary : {}
	const query_failure = nonempty_text(values.scope_query_failed) ? display_sentence(values.scope_query_failed) : nonempty_text(scope.scope_query_failed) ? display_sentence(scope.scope_query_failed) : null
	if (query_failure !== null) return {
		requests: null,
		missing_usage_requests: 0,
		unpriced_requests: 0,
		pending_requests: 0,
		fallback_requests: 0,
		last_ingested_at: null,
		known_rational: null,
		known_usd: null,
		charges: [],
		cost_usd: null,
		entry_ids: undefined,
		priced_requests: undefined,
		models: undefined,
		gaps: Array.isArray(values.gaps) ? values.gaps : [],
		query_failure,
	}
	const charges = aggregate_receipt_charges(values.charges)
	const requests_value = ccxray_summary_value(values, ['requests', 'calls', 'provider_calls'], scope.requests === undefined ? 0 : scope.requests)
	const requests = requests_value === null
		? null
		: Number.isSafeInteger(requests_value) && requests_value >= 0 ? requests_value : 0
	const missing_usage_requests = receipt_count(ccxray_summary_value(values, ['missing_usage_requests'], values.cost_confidence?.no_usage ?? scope.missing_usage_requests ?? 0))
	const unpriced_requests = receipt_count(ccxray_summary_value(values, ['unpriced_requests'], values.cost_confidence?.unknown ?? scope.unpriced_requests ?? 0))
	const pending_requests = receipt_count(ccxray_summary_value(values, ['pending_requests'], scope.pending_requests ?? 0))
	const fallback_requests = receipt_count(ccxray_summary_value(values, ['fallback_requests'], values.cost_confidence?.fallback ?? scope.fallback_requests ?? 0))
	const uncomputable_value = ccxray_summary_value(values, ['uncomputable_requests'], scope.uncomputable_requests)
	const uncomputable_requests = uncomputable_value === undefined ? undefined : receipt_count(uncomputable_value)
	const known_rational = charges.reduce((total, charge) => charge.usd_rational === null ? total : rational_add(total, charge.usd_rational), { numerator: 0n, denominator: 1n })
	const priced_requests = values.cost_confidence?.priced === undefined && scope.priced_requests === undefined
		? undefined
		: receipt_count(values.cost_confidence?.priced ?? scope.priced_requests)
	const models = Array.isArray(values.models)
		? values.models.map(String)
		: Array.isArray(scope.models) ? scope.models.map(String) : undefined
	return {
		requests,
		missing_usage_requests,
		unpriced_requests,
		pending_requests,
		fallback_requests,
		uncomputable_requests,
		last_ingested_at: values.last_ingested_at === null || values.last_ingested_at === undefined ? null : utc_timestamp_text(values.last_ingested_at, 'last_ingested_at'),
		known_rational,
		known_usd: rational_to_decimal(known_rational),
		charges,
		cost_usd: ccxray_summary_value(values, ['cost_usd', 'cost', 'known_usd'], undefined),
		entry_ids: Array.isArray(values.entry_ids) ? values.entry_ids.map(String) : Array.isArray(scope.entry_ids) ? scope.entry_ids.map(String) : undefined,
		priced_requests,
		models,
		gaps: Array.isArray(values.gaps) ? values.gaps : [],
	}
}

const receipt_gap = (gaps, scope_id, code, detail) => {
	const normalized_scope_id = scope_id === null || scope_id === undefined ? null : String(scope_id)
	const normalized_code = display_text(code)
	const normalized_detail = display_sentence(detail)
	if (gaps.some(gap => gap.scope_id === normalized_scope_id && gap.code === normalized_code && gap.detail === normalized_detail)) return
	gaps.push({ scope_id: normalized_scope_id, code: normalized_code, detail: normalized_detail })
}

const rational_subtract = (left, right) => {
	const numerator = left.numerator * right.denominator - right.numerator * left.denominator
	const denominator = left.denominator * right.denominator
	const sign = numerator < 0n ? -1n : 1n
	const reduced = rational_reduce({ numerator: numerator < 0n ? -numerator : numerator, denominator })
	return { numerator: reduced.numerator * sign, denominator: reduced.denominator }
}

const rational_to_signed_decimal = value => value.numerator < 0n
	? `-${rational_to_decimal({ numerator: -value.numerator, denominator: value.denominator })}`
	: rational_to_decimal(value)

const rational_usd_text = value => {
	return rational_to_fixed(value, 4)
}

// Receipt field contract: requests and known_usd are non-null numeric values
// unless a scope query fails. A failed scope has null requests and known_usd,
// no charges, and one scope_query_failed gap describing the query failure.
const build_ccxray_receipt = options => {
	if (!is_object(options) || !['attempt', 'cumulative'].includes(options.kind)) throw new MetricsError('receipt kind must be attempt or cumulative')
	if (!nonempty_text(options.ask) || !nonempty_text(options.project)) throw new MetricsError('receipt ask and project are required')
	const cutoff = utc_timestamp_text(options.cutoff === undefined ? Date.now() : options.cutoff, 'cutoff')
	const source = is_object(options.source) ? options.source : {}
	const input_scopes = Array.isArray(options.scopes) ? options.scopes : []
	const summaries = is_object(options.summaries) && is_object(options.summaries.scopes) ? options.summaries.scopes : options.summaries
	const total_summary = options.total_summary || (is_object(options.summaries) && is_object(options.summaries.total) ? options.summaries.total : undefined)
	const gaps = []
	const task_summary_failures = Array.isArray(options.task_summary_failures) ? options.task_summary_failures.filter(is_object) : []
	for (const failure of task_summary_failures) {
		const failure_detail = display_sentence(failure.detail || 'InvalidBody')
		const detail = failure_detail.startsWith('invalid summary:')
			? failure_detail
			: `${failure_detail}: completeness of worker attribution could not be checked`
		receipt_gap(gaps, null, 'task_summary_query_failed', detail)
	}
	const summary_for = (scope, index) => {
		if (Array.isArray(summaries)) {
			return summaries[index]
		}
		if (is_object(summaries)) {
			if (Object.hasOwn(summaries, scope.id)) return summaries[scope.id]
			if (Object.hasOwn(summaries, scope.role)) return summaries[scope.role]
			const by_role = is_object(summaries.by_role) ? new Map(Object.entries(summaries.by_role)) : new Map()
			if (by_role.has(scope.role)) return by_role.get(scope.role)
			if (scope.role === 'coordinator' && Object.hasOwn(summaries, 'coordinator')) return summaries.coordinator
			if (Object.hasOwn(summaries, 'total')) return summaries.total
			return summaries
		}
		return undefined
	}
	const scope_summaries = []
	const scope_costs = []
	const scopes = input_scopes.map((input, index) => {
		const role = nonempty_text(input.role) ? String(input.role) : 'unknown'
		const attempt = input.attempt === undefined ? role === 'coordinator' ? 0 : 1 : safe_integer(input.attempt, `scope ${input.id || index} attempt`)
		const id = nonempty_text(input.id) ? String(input.id) : `${receipt_slug(role)}-${attempt}-${index + 1}`
		const selector = normalize_receipt_selector({ ...input, id }, cutoff)
		const summary = receipt_summary_for_scope(input, summary_for(input, index))
		scope_summaries.push({ id, role, summary })
		if (summary.cost_usd !== undefined && summary.cost_usd !== null) {
			const expected = decimal_source(summary.cost_usd, `${id}.cost_usd`)
			scope_costs.push({ id, role, rational: { numerator: expected.numerator, denominator: expected.denominator } })
		}
		const scope_gaps = Array.isArray(input.gaps) ? input.gaps : []
		for (const gap of [...scope_gaps, ...summary.gaps]) {
			if (is_object(gap) && nonempty_text(gap.code) && nonempty_text(gap.detail)) receipt_gap(gaps, gap.scope_id === undefined ? id : gap.scope_id, gap.code, gap.detail)
		}
		if (role !== 'coordinator' && summary.requests === 0) receipt_gap(gaps, id, 'missing_scope', 'known attempt has zero observed requests')
		if (summary.pending_requests > 0) receipt_gap(gaps, id, 'pending_requests', `${summary.pending_requests} request${summary.pending_requests === 1 ? '' : 's'} still pending`)
		if (summary.missing_usage_requests > 0) receipt_gap(gaps, id, 'missing_usage_requests', `${summary.missing_usage_requests} request${summary.missing_usage_requests === 1 ? '' : 's'} ${summary.missing_usage_requests === 1 ? 'has' : 'have'} missing usage`)
		if (summary.unpriced_requests > 0) receipt_gap(gaps, id, 'unpriced_requests', `${summary.unpriced_requests} request${summary.unpriced_requests === 1 ? '' : 's'} ${summary.unpriced_requests === 1 ? 'is' : 'are'} unpriced`)
		if (summary.fallback_requests > 0) receipt_gap(gaps, id, 'fallback_rate', `${summary.fallback_requests} request${summary.fallback_requests === 1 ? '' : 's'} used a fallback rate`)
		if (summary.uncomputable_requests > 0) receipt_gap(gaps, id, 'uncomputable_requests', `${summary.uncomputable_requests} request${summary.uncomputable_requests === 1 ? '' : 's'} cannot be computed`)
		const has_fallback_charge = summary.charges.some(charge => charge.basis === 'fallback')
		if (has_fallback_charge && summary.fallback_requests === 0) receipt_gap(gaps, id, 'fallback_rate', '1 request used a fallback rate')
		const has_unpriced_charge = summary.charges.some(charge => charge.basis === 'unpriced')
		if (has_unpriced_charge) {
			const unpriced_charge_requests = summary.uncomputable_requests > 0 ? summary.uncomputable_requests : 1
			receipt_gap(gaps, id, 'unpriced_charges', `${unpriced_charge_requests} request${unpriced_charge_requests === 1 ? '' : 's'} ${unpriced_charge_requests === 1 ? 'has' : 'have'} charges without a rate`)
		}
		if (input.interval_open === true || input.open === true) receipt_gap(gaps, id, 'interval_still_open', 'coordinator interval is still open at the snapshot cutoff')
		if (summary.cost_usd !== undefined && summary.cost_usd !== null && ![...scope_gaps, ...summary.gaps].some(gap => is_object(gap) && gap.code === 'ccxray_too_old_for_charges')) {
			const expected = decimal_source(summary.cost_usd, `${id}.cost_usd`)
			const expected_rational = { numerator: expected.numerator, denominator: expected.denominator }
			const difference = summary.known_rational === null ? null : rational_absolute_difference(summary.known_rational, expected_rational)
			if (difference !== null && rational_compare(difference, { numerator: 5n, denominator: 100000n }) > 0) receipt_gap(gaps, id, 'arithmetic_mismatch', `recomputed USD ${summary.known_usd} differs from ccxray USD ${decimal_text(summary.cost_usd, `${id}.cost_usd`)}`)
		}
		const result = {
			id,
			role,
			attempt,
			outcome: ['succeeded', 'failed', 'cancelled', 'running'].includes(input.outcome) ? input.outcome : input.open === true ? 'running' : 'succeeded',
			selector,
			requests: summary.requests,
			missing_usage_requests: summary.missing_usage_requests,
			unpriced_requests: summary.unpriced_requests,
			pending_requests: summary.pending_requests,
			fallback_requests: summary.fallback_requests,
			last_ingested_at: summary.last_ingested_at,
			known_usd: summary.known_usd,
			charges: summary.charges.map(charge => {
				const { usd_rational, ...output } = charge
				return output
			}),
		}
		if (summary.priced_requests !== undefined) result.priced_requests = summary.priced_requests
		if (summary.uncomputable_requests !== undefined) result.uncomputable_requests = summary.uncomputable_requests
		if (summary.models !== undefined) result.models = summary.models
		if (summary.entry_ids !== undefined) result.entry_ids = summary.entry_ids
		return result
	})
	if (scope_costs.length === scopes.length && scopes.length > 0 && !gaps.some(gap => gap.code === 'ccxray_too_old_for_charges')) {
		const recomputed = scopes.flatMap(scope => scope.charges).filter(charge => charge.usd !== null && charge.usd !== undefined && charge.basis !== 'unpriced').reduce((total, charge) => {
			const value = decimal_source(charge.usd, 'charge.usd')
			return rational_add(total, { numerator: value.numerator, denominator: value.denominator })
		}, { numerator: 0n, denominator: 1n })
		const expected = scope_costs.reduce((total, scope) => rational_add(total, scope.rational), { numerator: 0n, denominator: 1n })
		const difference = rational_absolute_difference(recomputed, expected)
		const tolerance = { numerator: 5n * BigInt(scope_costs.length), denominator: 100000n }
		if (rational_compare(difference, tolerance) > 0) receipt_gap(gaps, null, 'arithmetic_mismatch', `recomputed total USD ${rational_to_decimal(recomputed)} differs from ccxray USD ${rational_usd_text(expected)}`)
	}
	if (options.kind === 'cumulative') {
		const worker_summaries = scope_summaries.filter(scope => scope.role !== 'coordinator')
		const failed_worker_scopes = worker_summaries.filter(scope => scope.summary.query_failure !== undefined || scope.summary.requests === null)
		if (failed_worker_scopes.length > 0) {
			const failed_details = failed_worker_scopes.map(scope => `scope ${display_text(scope.id)} query failed (${display_sentence(scope.summary.query_failure || 'unknown error')})`).join('; ')
			receipt_gap(gaps, null, 'completeness_unknown', `${failed_details}; completeness of unscoped attribution could not be checked`)
		}
		if (is_object(total_summary) && task_summary_failures.length === 0 && failed_worker_scopes.length === 0) {
			const task_observation = receipt_summary_for_scope({}, total_summary)
			const labelled_requests = receipt_count(task_observation.requests)
			const scoped_requests = worker_summaries.reduce((total, scope) => total + (Number.isSafeInteger(scope.summary.requests) && scope.summary.requests >= 0 ? scope.summary.requests : 0), 0)
			const unscoped_requests = labelled_requests - scoped_requests
			let task_cost_mismatch = false
			if (task_observation.cost_usd !== undefined && task_observation.cost_usd !== null) {
				const expected = decimal_source(task_observation.cost_usd, 'total.cost_usd')
				const difference = rational_absolute_difference(task_observation.known_rational, { numerator: expected.numerator, denominator: expected.denominator })
				if (rational_compare(difference, { numerator: 5n, denominator: 100000n }) > 0) {
					task_cost_mismatch = true
					receipt_gap(gaps, null, 'arithmetic_mismatch', `recomputed USD ${task_observation.known_usd} differs from ccxray USD ${decimal_text(task_observation.cost_usd, 'total.cost_usd')}`)
				}
			}
			const scoped_charge_total = worker_summaries.reduce((total, scope) => rational_add(total, scope.summary.known_rational), { numerator: 0n, denominator: 1n })
			const unscoped_cost = rational_subtract(task_observation.known_rational, scoped_charge_total)
			const scoped_by_role = new Map()
			for (const scope of worker_summaries) {
				const current = scoped_by_role.get(scope.role) || { requests: 0, charges: { numerator: 0n, denominator: 1n } }
				current.requests += receipt_count(scope.summary.requests)
				current.charges = rational_add(current.charges, scope.summary.known_rational)
				scoped_by_role.set(scope.role, current)
			}
			const role_values = new Map(Object.entries(is_object(total_summary.by_role) ? total_summary.by_role : {}))
			for (const role of scoped_by_role.keys()) if (!role_values.has(role)) role_values.set(role, undefined)
			const role_excesses = []
			for (const [role, values] of role_values.entries()) {
				const role_observation = receipt_summary_for_scope({ role }, values)
				const scoped_role = scoped_by_role.get(role) || { requests: 0, charges: { numerator: 0n, denominator: 1n } }
				role_excesses.push({
					role,
					requests: receipt_count(role_observation.requests) - scoped_role.requests,
					cost: rational_subtract(role_observation.known_rational, scoped_role.charges),
				})
			}
			const negative_role_excess = role_excesses.some(excess => excess.requests < 0 || excess.cost.numerator < 0n)
			const role_request_total = role_excesses.reduce((total, excess) => total + excess.requests, 0)
			const role_cost_total = role_excesses.reduce((total, excess) => rational_add(total, excess.cost), { numerator: 0n, denominator: 1n })
			const role_excess_matches = !negative_role_excess
				&& role_request_total === unscoped_requests
				&& rational_compare(role_cost_total, unscoped_cost) === 0
			const exclusions_known = !task_cost_mismatch && unscoped_requests >= 0 && unscoped_cost.numerator >= 0n && role_excess_matches
			if (task_cost_mismatch) receipt_gap(gaps, null, 'completeness_unknown', 'reported cost disagrees with charges; exclusions cannot be quantified')
			if (unscoped_requests > 0 && exclusions_known) {
				const role_details = role_excesses
					.filter(excess => excess.requests > 0)
					.map(excess => `${display_text(excess.role)}: ${excess.requests} request${excess.requests === 1 ? '' : 's'}, USD ${rational_usd_text(excess.cost)}`)
				const detail = `${unscoped_requests} labelled request${unscoped_requests === 1 ? '' : 's'} (USD ${rational_usd_text(unscoped_cost)}) fall outside every recorded attempt${role_details.length > 0 ? `; ${role_details.join('; ')}` : ''}`
				receipt_gap(gaps, null, 'unscoped_requests', detail)
			} else if (unscoped_requests < 0 || unscoped_cost.numerator < 0n || negative_role_excess) {
				receipt_gap(gaps, null, 'scope_overlap', 'scoped observations overlap the labelled task summary; exclusions cannot be quantified')
				receipt_gap(gaps, null, 'completeness_unknown', 'exclusions cannot be quantified')
			} else if (!exclusions_known) {
				receipt_gap(gaps, null, 'completeness_unknown', 'role exclusions do not reconcile with the task-wide excess; exclusions cannot be quantified')
			}
		}
	}
	const normalized_source = {
		instance_id: nonempty_text(source.instance_id) ? String(source.instance_id) : 'unknown',
		ccxray_version: nonempty_text(source.ccxray_version) ? String(source.ccxray_version) : 'unknown',
		exporter_version: nonempty_text(source.exporter_version) ? String(source.exporter_version) : CCXRAY_EXPORTER_VERSION,
		query: source.query === undefined ? {} : source.query,
	}
	const receipt = {
		schema_version: CCXRAY_SCHEMA_VERSION,
		snapshot_id: receipt_snapshot_id({ kind: options.kind, ask: options.ask, cutoff, scopes }),
		ask: String(options.ask),
		project: String(options.project),
		kind: options.kind,
		generated_at: new Date().toISOString(),
		cutoff,
		basis: 'modeled',
		reporting_tail_excluded: true,
		source: normalized_source,
		scopes: scopes,
		gaps,
	}
	if (nonempty_text(options.supersedes)) receipt.supersedes = String(options.supersedes)
	if (Array.isArray(options.entries)) receipt.entries = options.entries.map(normalize_receipt_entry).filter(entry => entry !== null)
	return receipt
}

const receipt_evidence_directory = workspace_dir => {
	if (!nonempty_text(workspace_dir)) throw new MetricsError('workspace_dir is required')
	const resolved = node_path.resolve(workspace_dir)
	const agentflow_dir = node_path.basename(resolved) === '.agentflow' ? resolved : node_path.join(resolved, '.agentflow')
	return node_path.join(agentflow_dir, 'evidence', 'ccxray')
}

const serialize_ccxray_receipt = receipt => {
	try {
		return JSON.stringify(receipt, null, 2)
	} catch {
		throw new MetricsError('receipt_serialization_failed', 'AG_METRICS_RECEIPT_SERIALIZATION')
	}
}

const mark_receipt_serialization_failure = receipt => {
	try {
		JSON.stringify(receipt)
		return false
	} catch {
		if (!Array.isArray(receipt.gaps)) receipt.gaps = []
		receipt_gap(receipt.gaps, null, 'receipt_serialization_failed', 'receipt serialization failed')
		return true
	}
}

const write_ccxray_receipt = (receipt, options = {}) => {
	if (!is_object(receipt) || !nonempty_text(receipt.snapshot_id)) throw new MetricsError('receipt snapshot_id is required')
	const directory = receipt_evidence_directory(options.workspace_dir)
	let directory_existed = true
	try {
		if (!fs.statSync(directory).isDirectory()) throw new MetricsError('receipt evidence path is not a directory')
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
		directory_existed = false
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
	if (!directory_existed) {
		try { fs.writeFileSync(node_path.join(directory, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
	}
	const base = String(receipt.snapshot_id)
	const supplied_supersedes = nonempty_text(receipt.supersedes)
	for (let suffix = 0; suffix < 1000000; suffix += 1) {
		const snapshot_id = suffix === 0 ? base : `${base}-${suffix + 1}`
		const filename = `${snapshot_id}.json`
		const target = node_path.join(directory, filename)
		try {
			if (suffix > 0) {
				receipt.snapshot_id = snapshot_id
				if (!supplied_supersedes) receipt.supersedes = suffix === 1 ? base : `${base}-${suffix}`
			}
			const encoded = `${serialize_ccxray_receipt(receipt)}\n`
			fs.writeFileSync(target, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
			return target
		} catch (error) {
			if (error.code !== 'EEXIST') throw error
		}
	}
	throw new MetricsError('could not allocate a unique ccxray receipt path')
}

const build_ccxray_scopes = options => {
	if (!is_object(options) || !nonempty_text(options.ask) || !nonempty_text(options.project)) throw new MetricsError('scope task and project are required')
	const cutoff_ms = timestamp_ms(options.cutoff === undefined ? Date.now() : options.cutoff, 'cutoff')
	const cutoff = new Date(cutoff_ms).toISOString()
	const records = (Array.isArray(options.records) ? options.records : []).map(parse_host_touch).filter(record => record !== null && record.ask === String(options.ask))
	const attempts = records.filter(record => record.event === 'attempt' && (options.role === undefined || record.role === String(options.role)))
	const ordered_attempts = attempts
		.map((record, index) => ({ record, index }))
		.sort((left, right) => left.record.started_ms - right.record.started_ms || left.record.ended_ms - right.record.ended_ms || left.index - right.index)
		.map(entry => entry.record)
	const previous_end_by_partition = new Map()
	const scope_id_counts = new Map()
	const all_worker_scopes = ordered_attempts.map(record => {
		const project = nonempty_text(record.project) ? String(record.project) : String(options.project)
		const base_id = `attempt-${receipt_slug(record.role)}-${record.attempt}`
		const count = (scope_id_counts.get(base_id) || 0) + 1
		scope_id_counts.set(base_id, count)
		const id = count === 1 ? base_id : `${base_id}~${count}`
		const original_end = record.ended_ms + 1
		const partition_key = `${record.role}\u0000${project}`
		const start = Math.max(record.started_ms, previous_end_by_partition.get(partition_key) ?? record.started_ms)
		const end = Math.max(start, original_end)
		previous_end_by_partition.set(partition_key, end)
		const scope_gaps = []
		if (start === end) scope_gaps.push({ scope_id: id, code: 'missing_scope', detail: 'known attempt has zero observed requests' })
		if (nonempty_text(record.project) && String(record.project) !== String(options.project)) scope_gaps.push({ scope_id: id, code: 'project_label_mismatch', detail: `recorded project label ${display_text(record.project)} differs from resolved project ${display_text(options.project)}` })
		const scope = {
			id,
			role: record.role,
			attempt: record.attempt,
			outcome: record.outcome,
			selector: {
				labels: { task: String(options.ask), role: record.role, project },
				start_inclusive: new Date(start).toISOString(),
				end_exclusive: new Date(end).toISOString(),
			},
			started_ms: record.started_ms,
			ended_ms: record.ended_ms,
			session_id: record.session_id,
		}
		if (scope_gaps.length > 0) scope.gaps = scope_gaps
		return { record, scope }
	})
	let selected_worker_scopes = all_worker_scopes
	if (options.kind === 'attempt' || options.attempt !== undefined) {
		if (options.attempt !== undefined && options.attempt !== true) {
			const number = safe_integer(options.attempt, 'attempt')
			selected_worker_scopes = all_worker_scopes.filter(entry => entry.record.attempt === number)
		} else if (attempts.length > 0) {
			const latest = attempts.slice().sort((left, right) => right.attempt - left.attempt || right.ended_ms - left.ended_ms)[0]
			selected_worker_scopes = all_worker_scopes.filter(entry => entry.record.role === latest.role && entry.record.attempt === latest.attempt)
		}
	}
	const worker_scopes = selected_worker_scopes.map(entry => entry.scope)
	if (options.kind === 'attempt' || options.attempt !== undefined) return worker_scopes
	const coordinator_intervals = host_session_intervals(options.ask, options.records || [], cutoff_ms, null).slice().sort((left, right) => left.from - right.from || (left.to ?? Number.MAX_SAFE_INTEGER) - (right.to ?? Number.MAX_SAFE_INTEGER) || String(left.session).localeCompare(String(right.session)))
	const coordinator_scopes = coordinator_intervals.map((interval, index) => ({
		id: `coordinator#${index + 1}`,
		role: 'coordinator',
		attempt: 0,
		outcome: interval.to === null ? 'running' : 'succeeded',
		interval_open: interval.to === null,
		selector: {
			session_id: interval.session,
			start_inclusive: new Date(interval.from).toISOString(),
			end_exclusive: new Date(interval.to === null ? cutoff_ms : interval.to + 1).toISOString(),
		},
		session_id: interval.session,
	}))
	return [...worker_scopes, ...coordinator_scopes]
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
			'Alternatively set ccxray: auto to make ccxray optional.',
			'See https://github.com/lis186/ccxray.',
		].join('\n')
	}
	return [
		'ccxray is required because ag.json sets ccxray: on but no running ccxray was found.',
		'Install it with npm install -g ccxray.',
		'Then start the assistant through it (ccxray claude, ccxray codex, or ccxray grok) or keep ccxray running in another terminal.',
		'Alternatively set ccxray: auto to make ccxray optional.',
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

const CCXRAY_HEALTH_CAPABILITIES = ['task-attribution', 'session-intervals', 'cost-charges']

const valid_ccxray_health_scalar = value => typeof value === 'boolean' || typeof value === 'string' || Number.isSafeInteger(value)

const project_ccxray_health = value => {
	const health = is_object(value) ? value : {}
	const projected = {}
	for (const key of ['ok', 'app', 'pid', 'hub']) {
		if (valid_ccxray_health_scalar(health[key])) projected[key] = health[key]
	}
	projected.capabilities = Array.isArray(health.capabilities)
		? CCXRAY_HEALTH_CAPABILITIES.filter(capability => health.capabilities.includes(capability))
		: []
	if (typeof health.instance_id === 'string') projected.instance_id = health.instance_id.slice(0, 128)
	const version = typeof health.ccxray_version === 'string'
		? health.ccxray_version
		: typeof health.version === 'string' ? health.version : undefined
	if (version !== undefined) projected.ccxray_version = version.slice(0, 128)
	return projected
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
		if (response.status !== 200) return { healthy: false, reason: 'ccxray_not_found', capabilities: [] }
		const projected = project_ccxray_health(await response.json())
		if (projected.ok !== true || projected.app !== 'ccxray') return { healthy: false, reason: 'ccxray_not_found', ...projected }
		if (!projected.capabilities.includes('task-attribution')) return { healthy: false, reason: 'ccxray_too_old', ...projected }
		return {
			healthy: true,
			reason: null,
			...projected,
		}
	} catch {
		return { healthy: false, reason: 'ccxray_not_found', capabilities: [] }
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
	if (result === true) return { endpoint: normalized, reason: null, capabilities: [] }
	const projected = project_ccxray_health(result)
	if (result && result.healthy === true) return {
		endpoint: normalized,
		reason: null,
		...projected,
	}
	if (result && result.ok === true && result.app === 'ccxray') {
		const capabilities = projected.capabilities
		return capabilities.includes('task-attribution')
			? { endpoint: normalized, reason: null, ...projected }
			: { endpoint: null, reason: 'ccxray_too_old', capabilities }
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

const session_spec = value => {
	if (nonempty_text(value)) return String(value).trim()
	if (!is_object(value) || !nonempty_text(value.session) || !Number.isSafeInteger(value.from) || value.from < 0) return null
	if (value.to !== null && value.to !== undefined && (!Number.isSafeInteger(value.to) || value.to < value.from)) return null
	return `${String(value.session)}@${value.from}-${value.to === null || value.to === undefined ? '' : value.to}`
}

const fetch_ccxray_error_class = error => error?.name === 'AbortError' ? 'TimeoutError' : nonempty_text(error?.name) ? String(error.name) : 'NetworkError'

const valid_ccxray_counter = value => Number.isSafeInteger(value) && value >= 0

const valid_ccxray_token = value => valid_ccxray_counter(value) || value === 'unavailable'

const valid_ccxray_integer_string = value => typeof value === 'string' && /^\d+$/u.test(value)

const valid_ccxray_decimal_string = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value)

const valid_ccxray_cost = value => typeof value === 'number'
	? Number.isFinite(value) && value >= 0
	: valid_ccxray_decimal_string(value)

const CCXRAY_CHARGE_COMPONENTS = new Set(['input', 'output', 'cache_read', 'cache_create'])

const ccxray_wire_depth_error = body => {
	const pending = [{ value: body, depth: 0 }]
	while (pending.length > 0) {
		const current = pending.pop()
		if (current.depth > 8) return 'summary nesting exceeds 8 levels'
		if (current.value === null || typeof current.value !== 'object') continue
		for (const key of Object.keys(current.value)) pending.push({ value: current.value[key], depth: current.depth + 1 })
	}
	return null
}

const valid_ccxray_window_value = value => value === null || valid_ccxray_counter(value)

const ccxray_window_shape_error = value => {
	if (!is_object(value)) return 'window must be an object or null'
	if (!Object.hasOwn(value, 'from') || !Object.hasOwn(value, 'to')) return 'window must contain from and to'
	if (!valid_ccxray_window_value(value.from) || !valid_ccxray_window_value(value.to)) return 'window.from and window.to must be non-negative integers or null'
	return null
}

const ccxray_coverage_shape_error = value => {
	if (!is_object(value)) return 'coverage must be an object or null'
	if (!valid_ccxray_counter(value.entries_in_memory) || !valid_ccxray_counter(value.max_entries)) return 'coverage.entries_in_memory and coverage.max_entries must be non-negative integers'
	return null
}

const ccxray_charge_validation_error = (charge, path) => {
	if (!is_object(charge)) return `${path} must be an object`
	for (const field of ['model', 'billing_provider', 'price_key', 'rate_source']) {
		if (typeof charge[field] !== 'string' && charge[field] !== null) return `${path}.${field} must be a string or null`
	}
	if (!CCXRAY_CHARGE_COMPONENTS.has(charge.component)) return `${path}.component must be input, output, cache_read, or cache_create`
	if (charge.unit !== 'tokens') return `${path}.unit must be tokens`
	if (!valid_ccxray_integer_string(charge.quantity)) return `${path}.quantity must be a non-negative integer decimal string`
	if (!['recorded', 'fallback', 'unpriced'].includes(charge.basis)) return `${path}.basis must be recorded, fallback, or unpriced`
	if (charge.basis === 'unpriced') {
		if (charge.usd_per_unit !== null || charge.usd !== null) return `${path}.usd_per_unit and ${path}.usd must both be null when basis is unpriced`
	} else if (!valid_ccxray_decimal_string(charge.usd_per_unit) || !valid_ccxray_decimal_string(charge.usd)) {
		return `${path}.usd_per_unit and ${path}.usd must be non-negative decimal strings when basis is ${charge.basis}`
	}
	return null
}

const ccxray_sub_summary_validation_error = (data, path) => {
	const field = name => path ? `${path}.${name}` : name
	if (!is_object(data)) return `${path} must be an object`
	if (!valid_ccxray_counter(data.calls)) return `${field('calls')} must be a non-negative integer`
	if (!valid_ccxray_cost(data.cost_usd)) return `${field('cost_usd')} must be a non-negative decimal`
	if (!is_object(data.cost_confidence)) return `${field('cost_confidence')} must be an object`
	for (const key of ['priced', 'unknown', 'fallback', 'no_usage']) {
		if (!valid_ccxray_counter(data.cost_confidence[key])) return `${field(`cost_confidence.${key}`)} must be a non-negative integer`
	}
	if (!Array.isArray(data.charges)) return `${field('charges')} must be an array`
	for (const [index, charge] of data.charges.entries()) {
		const error = ccxray_charge_validation_error(charge, `${field('charges')}[${index}]`)
		if (error !== null) return error
	}
	if (data.models !== undefined && (!Array.isArray(data.models) || data.models.some(model => typeof model !== 'string'))) return `${field('models')} must be an array of strings`
	if (data.pending_requests !== undefined && !valid_ccxray_counter(data.pending_requests)) return `${field('pending_requests')} must be a non-negative integer`
	if (data.uncomputable_requests !== undefined && !valid_ccxray_counter(data.uncomputable_requests)) return `${field('uncomputable_requests')} must be a non-negative integer`
	if (data.last_ingested_at !== undefined && data.last_ingested_at !== null && (typeof data.last_ingested_at !== 'string' || !Number.isFinite(Date.parse(data.last_ingested_at)))) return `${field('last_ingested_at')} must be a valid timestamp`
	return null
}

const validate_ccxray_summary_body = (body, { selected } = {}) => {
	if (!is_object(body)) return 'summary must be an object'
	const depth_error = ccxray_wire_depth_error(body)
	if (depth_error !== null) return depth_error
	const top_level_error = ccxray_sub_summary_validation_error(body, '')
	if (top_level_error !== null) return top_level_error
	if (!is_object(body.by_role)) return 'by_role must be an object'
	for (const [role, summary] of Object.entries(body.by_role)) {
		const error = ccxray_sub_summary_validation_error(summary, `by_role.${role}`)
		if (error !== null) return error
	}
	if (Object.hasOwn(body, 'coordinator')) {
		const coordinator_error = ccxray_sub_summary_validation_error(body.coordinator, 'coordinator')
		if (coordinator_error !== null) return coordinator_error
	}
	return null
}

const ccxray_request_session_value = value => {
	if (is_object(value)) {
		if (!nonempty_text(value.session) || !valid_ccxray_counter(value.from)) return null
		if (value.to !== null && !valid_ccxray_counter(value.to)) return null
		return { session: String(value.session), from: value.from, to: value.to }
	}
	if (!nonempty_text(value)) return null
	const text = String(value)
	const at = text.lastIndexOf('@')
	const dash = text.indexOf('-', at + 1)
	if (at <= 0 || dash <= at + 1) return null
	const session = text.slice(0, at)
	const from_text = text.slice(at + 1, dash)
	const to_text = text.slice(dash + 1)
	if (!/^\d+$/u.test(from_text) || to_text !== '' && !/^\d+$/u.test(to_text)) return null
	const from = Number(from_text)
	const to = to_text === '' ? null : Number(to_text)
	if (!valid_ccxray_counter(from) || to !== null && !valid_ccxray_counter(to)) return null
	return { session, from, to }
}

const ccxray_request_parameters = request => {
	const values = is_object(request) ? request : {}
	const role = nonempty_text(values.role) ? String(values.role).trim() : null
	const session_values = Array.isArray(values.session_specs)
		? values.session_specs
		: Array.isArray(values.sessions)
			? values.sessions
			: values.session === undefined ? [] : [values.session]
	const sessions = session_values.map(ccxray_request_session_value).filter(value => value !== null)
	const from = values.from === undefined ? values.from_ms : values.from
	const to = values.to === undefined ? values.to_ms : values.to
	const window_requested = values.window_requested === true || from !== undefined && from !== null || to !== undefined && to !== null
	return {
		task: Object.hasOwn(values, 'task') ? nonempty_text(values.task) ? String(values.task).trim() : null : undefined,
		project: nonempty_text(values.project) ? String(values.project).trim() : null,
		role,
		sessions,
		received_ms: valid_ccxray_counter(values.received_ms) ? values.received_ms : null,
		from: from === undefined || from === null ? null : from,
		to: to === undefined || to === null ? null : to,
		window_requested,
	}
}

const ccxray_query_class = values => nonempty_text(values.role)
	? 'filtered'
	: values.sessions.length > 0 ? 'mixed' : 'plain'

const ccxray_invariant_error = (id, detail) => `invariant ${id} violated: ${detail}`

const ccxray_charge_bucket_projection = charges => aggregate_receipt_charges(charges).map(charge => ({
		model: charge.model,
		billing_provider: charge.billing_provider,
		component: charge.component,
		usd_per_unit: charge.usd_per_unit,
		basis: charge.basis,
		quantity: charge.quantity,
	}))

const check_ccxray_invariants = (validated_body, request = {}) => {
	if (!is_object(validated_body)) return ccxray_invariant_error('I1', 'summary must be an object')
	const values = ccxray_request_parameters(request)
	const by_role = new Map(Object.entries(validated_body.by_role))
	const wrapper_calls = validated_body.calls
	const query_class = ccxray_query_class(values)
	if (values.task !== undefined && validated_body.task !== values.task) return ccxray_invariant_error('I9', 'response task does not equal the requested task')
	if (values.project !== undefined && validated_body.project !== values.project) return ccxray_invariant_error('I9', 'response project does not equal the requested project')
	if (validated_body.role !== values.role) return ccxray_invariant_error('I9', 'response role does not equal the requested role')

	if (values.sessions.length > 0) {
		if (!is_object(validated_body.coordinator)) return ccxray_invariant_error('I1', 'session query is missing coordinator')
		const sessions = validated_body.coordinator.sessions
		if (!Array.isArray(sessions)) return ccxray_invariant_error('I2', 'coordinator.sessions must be an array')
		if (sessions.length !== values.sessions.length) return ccxray_invariant_error('I2', `coordinator.sessions has ${sessions.length} entries for ${values.sessions.length} session specs`)
		for (const [index, expected] of values.sessions.entries()) {
			const actual = sessions[index]
			const actual_to_matches = expected.to === null
				? valid_ccxray_counter(values.received_ms) && valid_ccxray_counter(actual?.to) && actual.to >= expected.from && actual.to <= values.received_ms + 60_000
				: actual?.to === expected.to
			if (!is_object(actual) || actual.session !== expected.session || actual.from !== expected.from || !actual_to_matches) return ccxray_invariant_error('I2', `coordinator.sessions[${index}] does not match the requested session interval`)
			if (!valid_ccxray_counter(actual.calls) || actual.calls > validated_body.coordinator.calls) return ccxray_invariant_error('I13', `coordinator.sessions[${index}].calls must be an integer between 0 and coordinator calls`)
		}
	}

	const filtered_selected = query_class === 'filtered'
		? values.role === 'coordinator' && values.sessions.length > 0 ? validated_body.coordinator : by_role.get(values.role)
		: undefined
	if (query_class === 'filtered') {
		const selected = filtered_selected
		if (wrapper_calls > 0 && !is_object(selected)) return ccxray_invariant_error('I1', `selected ${values.role} summary is missing`)
		if (is_object(selected) && selected.calls !== wrapper_calls) return ccxray_invariant_error('I3', `selected ${values.role} calls ${selected.calls} does not equal wrapper calls ${wrapper_calls}`)
	} else if (query_class === 'mixed') {
		const coordinator_by_role = by_role.get('coordinator')
		const worker_calls = [...by_role.entries()]
			.filter(([role]) => role !== 'coordinator')
			.reduce((total, [, summary]) => total + summary.calls, 0)
		if ((validated_body.coordinator.calls > 0 && !is_object(coordinator_by_role)) || (is_object(coordinator_by_role) && coordinator_by_role.calls !== validated_body.coordinator.calls)) return ccxray_invariant_error('I3', `by_role.coordinator calls ${coordinator_by_role?.calls} does not equal coordinator calls ${validated_body.coordinator.calls}`)
		if (validated_body.coordinator.calls + worker_calls !== wrapper_calls) return ccxray_invariant_error('I3', `coordinator calls ${validated_body.coordinator.calls} plus worker calls ${worker_calls} does not equal wrapper calls ${wrapper_calls}`)
	}
	const role_calls = [...by_role.values()].reduce((total, summary) => total + summary.calls, 0)
	if (role_calls !== wrapper_calls) return ccxray_invariant_error('I3', `by_role calls sum ${role_calls} does not equal wrapper calls ${wrapper_calls}`)
	const compared_summaries = query_class === 'filtered' && is_object(filtered_selected)
		? { left: validated_body, right: filtered_selected, left_name: 'wrapper', right_name: 'selected summary' }
		: query_class === 'mixed' && is_object(validated_body.coordinator) && is_object(by_role.get('coordinator'))
			? { left: validated_body.coordinator, right: by_role.get('coordinator'), left_name: 'coordinator', right_name: 'by_role.coordinator' }
			: null
	if (compared_summaries !== null) {
		const { left, right, left_name, right_name } = compared_summaries
		for (const key of ['priced', 'unknown', 'fallback', 'no_usage']) {
			if (left.cost_confidence[key] !== right.cost_confidence[key]) return ccxray_invariant_error('I10', `${left_name} cost_confidence.${key} does not equal the ${right_name}`)
		}
		const left_buckets = JSON.stringify(ccxray_charge_bucket_projection(left.charges))
		const right_buckets = JSON.stringify(ccxray_charge_bucket_projection(right.charges))
		if (left_buckets !== right_buckets) return ccxray_invariant_error('I10', `${left_name} charges do not normalize to the ${right_name} buckets`)
		for (const key of ['uncomputable_requests', 'pending_requests']) {
			const left_value = left[key] === undefined ? 0 : left[key]
			const right_value = right[key] === undefined ? 0 : right[key]
			if (left_value !== right_value) return ccxray_invariant_error('I12', `${left_name} ${key} ${left_value} does not equal the ${right_name} ${right_value}`)
		}
	}

	const levels = [['summary', validated_body], ...[...by_role.entries()].map(([role, summary]) => [`by_role.${role}`, summary])]
	if (is_object(validated_body.coordinator)) levels.push(['coordinator', validated_body.coordinator])
	for (const [path, summary] of levels) {
		const confidence = summary.cost_confidence
		const priced = confidence.priced
		const unknown = confidence.unknown
		const fallback = confidence.fallback
		const no_usage = confidence.no_usage
		if (priced + unknown + no_usage !== summary.calls) return ccxray_invariant_error('I4', `${path} confidence counts do not equal calls`)
		if (fallback > priced) return ccxray_invariant_error('I4', `${path} fallback count exceeds priced count`)
		if (summary.pending_requests !== undefined && summary.pending_requests > summary.calls) return ccxray_invariant_error('I4', `${path} pending_requests exceeds calls`)
		if (summary.uncomputable_requests !== undefined && summary.uncomputable_requests > summary.calls) return ccxray_invariant_error('I4', `${path} uncomputable_requests exceeds calls`)
		const has_fallback = summary.charges.some(charge => charge.basis === 'fallback')
		const has_unpriced = summary.charges.some(charge => charge.basis === 'unpriced')
		if (has_fallback && fallback < 1) return ccxray_invariant_error('I5', `${path} has a fallback charge but fallback is zero`)
		if (has_unpriced && summary.uncomputable_requests !== undefined && summary.uncomputable_requests < 1) return ccxray_invariant_error('I5', `${path} has an unpriced charge but uncomputable_requests is zero`)
		if (summary.charges.some(charge => /^0+$/u.test(charge.quantity))) return ccxray_invariant_error('I5', `${path} contains a zero-quantity charge bucket`)
		for (const [index, charge] of summary.charges.entries()) {
			if (charge.basis === 'unpriced') continue
			const quantity = decimal_source(charge.quantity, `${path}.charges[${index}].quantity`)
			const usd_per_unit = decimal_source(charge.usd_per_unit, `${path}.charges[${index}].usd_per_unit`)
			const usd = decimal_source(charge.usd, `${path}.charges[${index}].usd`)
			const expected = rational_divide_integer(rational_multiply(quantity, usd_per_unit), 1000000)
			if (rational_compare(expected, usd) !== 0) return ccxray_invariant_error('I11', `${path}.charges[${index}].usd does not equal quantity times usd_per_unit divided by 1e6`)
		}
	}

	const window = validated_body.window
	if (window !== null && window !== undefined) {
		const error = ccxray_window_shape_error(window)
		if (error !== null) return ccxray_invariant_error('I6', error)
	}
	const coverage = validated_body.coverage
	if (coverage !== null && coverage !== undefined) {
		const error = ccxray_coverage_shape_error(coverage)
		if (error !== null) return ccxray_invariant_error('I6', error)
	}
	if (values.window_requested) {
		if (!is_object(window) || window.from !== values.from || window.to !== values.to) return ccxray_invariant_error('I6', 'window does not echo the requested from/to')
	} else if (window !== null) {
		return ccxray_invariant_error('I6', 'window must be null when from/to were not sent')
	}
	return null
}

const project_ccxray_charge = charge => ({
	model: typeof charge?.model === 'string' || charge?.model === null ? charge.model : null,
	billing_provider: typeof charge?.billing_provider === 'string' || charge?.billing_provider === null ? charge.billing_provider : null,
	component: CCXRAY_CHARGE_COMPONENTS.has(charge?.component) ? charge.component : null,
	unit: charge?.unit === 'tokens' ? charge.unit : null,
	quantity: valid_ccxray_integer_string(charge?.quantity) ? charge.quantity : null,
	usd_per_unit: charge?.usd_per_unit === null || valid_ccxray_decimal_string(charge?.usd_per_unit) ? charge.usd_per_unit : null,
	usd: charge?.usd === null || valid_ccxray_decimal_string(charge?.usd) ? charge.usd : null,
	basis: ['recorded', 'fallback', 'unpriced'].includes(charge?.basis) ? charge.basis : null,
	price_key: typeof charge?.price_key === 'string' || charge?.price_key === null ? charge.price_key : null,
	rate_source: typeof charge?.rate_source === 'string' || charge?.rate_source === null ? charge.rate_source : null,
})

const project_ccxray_window = value => {
	if (value === undefined || value === null) return null
	const error = ccxray_window_shape_error(value)
	if (error !== null) throw new MetricsError(error)
	return { from: value.from, to: value.to }
}

const project_ccxray_coverage = value => {
	if (value === undefined || value === null) return null
	const error = ccxray_coverage_shape_error(value)
	if (error !== null) throw new MetricsError(error)
	return {
		entries_in_memory: value.entries_in_memory,
		max_entries: value.max_entries,
	}
}

const project_ccxray_counter_map = value => {
	if (!is_object(value)) return {}
	const projected = new Map()
	for (const [name, count] of Object.entries(value)) {
		if (valid_ccxray_counter(count)) projected.set(String(name), count)
	}
	return Object.fromEntries(projected)
}

const project_ccxray_tokens = (value, cache) => {
	const tokens = is_object(value) ? value : {}
	const cache_read = valid_ccxray_token(tokens.cache_read) ? tokens.cache_read : undefined
	const cache_create = valid_ccxray_token(tokens.cache_create) ? tokens.cache_create : undefined
	const cache_value = cache === undefined
		? valid_ccxray_token(tokens.cache)
			? tokens.cache
			: (valid_ccxray_counter(cache_read) ? cache_read : 0) + (valid_ccxray_counter(cache_create) ? cache_create : 0)
		: valid_ccxray_token(cache) ? cache : 0
	return {
		input: valid_ccxray_token(tokens.input) ? tokens.input : 'unavailable',
		output: valid_ccxray_token(tokens.output) ? tokens.output : 'unavailable',
		...(cache_read === undefined ? {} : { cache_read }),
		...(cache_create === undefined ? {} : { cache_create }),
		cache: cache_value,
		reasoning: valid_ccxray_token(tokens.reasoning) ? tokens.reasoning : 0,
		total: valid_ccxray_token(tokens.total) ? tokens.total : 'unavailable',
	}
}

const project_ccxray_output_sessions = value => Array.isArray(value)
	? value.filter(session => is_object(session)
		&& typeof session.session === 'string'
		&& valid_ccxray_counter(session.from)
		&& (session.to === null || valid_ccxray_counter(session.to))
		&& valid_ccxray_counter(session.calls))
		.map(session => ({
			session: session.session,
			from: session.from,
			to: session.to,
			calls: session.calls,
		}))
	: []

const project_ccxray_output_sub_summary = (value, { coordinator = false } = {}) => {
	const summary = is_object(value) ? value : {}
	const confidence = is_object(summary.cost_confidence) ? summary.cost_confidence : {}
	const projected = {
		calls: valid_ccxray_counter(summary.calls) ? summary.calls : 0,
		cost_usd: valid_ccxray_cost(summary.cost_usd) ? summary.cost_usd : 0,
		cost_confidence: {
			priced: valid_ccxray_counter(confidence.priced) ? confidence.priced : 0,
			unknown: valid_ccxray_counter(confidence.unknown) ? confidence.unknown : 0,
			fallback: valid_ccxray_counter(confidence.fallback) ? confidence.fallback : 0,
			no_usage: valid_ccxray_counter(confidence.no_usage) ? confidence.no_usage : 0,
		},
		uncomputable_requests: valid_ccxray_counter(summary.uncomputable_requests) ? summary.uncomputable_requests : 0,
		charges: Array.isArray(summary.charges) ? summary.charges.map(project_ccxray_charge) : [],
		last_ingested_at: typeof summary.last_ingested_at === 'string' && Number.isFinite(Date.parse(summary.last_ingested_at)) ? summary.last_ingested_at : null,
		pending_requests: valid_ccxray_counter(summary.pending_requests) ? summary.pending_requests : 0,
	}
	if (typeof summary.cache_hit_rate === 'number' && Number.isFinite(summary.cache_hit_rate)) projected.cache_hit_rate = summary.cache_hit_rate
	if (is_object(summary.tokens)) projected.tokens = project_ccxray_tokens(summary.tokens)
	if (coordinator && Array.isArray(summary.sessions)) projected.sessions = project_ccxray_output_sessions(summary.sessions)
	return projected
}

const selected_ccxray_sub_summary = (validated_body, selected) => {
	if (is_object(selected) && Object.hasOwn(selected, 'calls')) return selected
	const role = typeof selected === 'string' ? selected : selected?.role
	if (!nonempty_text(role)) return validated_body
	const by_role = new Map(Object.entries(validated_body.by_role))
	if (role === 'coordinator' && selected?.session_query === true) return validated_body.coordinator
	return by_role.get(role) || (role === 'coordinator' ? validated_body.coordinator : undefined)
}

const project_ccxray_observation = (validated_body, {
	selected,
	capabilities,
	ccxray_source,
	resolution,
} = {}) => {
	const source = selected_ccxray_sub_summary(validated_body, selected) || validated_body
	const source_models = Array.isArray(source.models)
		? source.models
		: Array.isArray(validated_body.models) ? validated_body.models : []
	const resolved_capabilities = Array.isArray(capabilities)
		? capabilities
		: Array.isArray(resolution?.capabilities) ? resolution.capabilities : []
	const source_ccxray = is_object(ccxray_source)
		? ccxray_source
		: is_object(resolution) ? resolution : {}
	return {
		requests: source.calls,
		cost_usd: source.cost_usd,
		cost_confidence: {
			priced: source.cost_confidence.priced,
			unknown: source.cost_confidence.unknown,
			fallback: source.cost_confidence.fallback,
			no_usage: source.cost_confidence.no_usage,
		},
		uncomputable_requests: source.uncomputable_requests === undefined ? 0 : source.uncomputable_requests,
		pending_requests: source.pending_requests === undefined ? 0 : source.pending_requests,
		last_ingested_at: source.last_ingested_at === undefined ? null : source.last_ingested_at,
		charges: source.charges.map(project_ccxray_charge),
		models: source_models.slice(),
		window: Object.hasOwn(validated_body, 'window') ? project_ccxray_window(validated_body.window) : null,
		coverage: Object.hasOwn(validated_body, 'coverage') ? project_ccxray_coverage(validated_body.coverage) : null,
		capabilities: resolved_capabilities.slice(),
		ccxray_source: {
			instance_id: nonempty_text(source_ccxray.instance_id) ? String(source_ccxray.instance_id) : 'unknown',
			ccxray_version: nonempty_text(source_ccxray.ccxray_version) ? String(source_ccxray.ccxray_version) : 'unknown',
		},
	}
}

const project_ccxray_summary = (validated_body, context = {}) => {
	const observation = project_ccxray_observation(validated_body, context)
	const by_role = new Map()
	for (const [role, summary] of Object.entries(validated_body.by_role)) by_role.set(role, project_ccxray_observation(validated_body, { ...context, selected: summary }))
	const projected = Object.assign({}, observation, { by_role: Object.fromEntries(by_role) })
	if (Object.hasOwn(validated_body, 'coordinator')) projected.coordinator = project_ccxray_observation(validated_body, { ...context, selected: validated_body.coordinator })
	return projected
}

const internal_conversion_error = error => `internal conversion error: ${display_sentence(error?.message || error || 'unknown error')}`

const fetch_ccxray_metrics_result = async (task, options = {}) => {
	if (!nonempty_text(task)) return { summary: null, failure: 'InvalidTask' }
	const resolution = await resolve_ccxray_endpoint(options)
	if (!resolution.endpoint) return { summary: null, failure: resolution.reason || 'ccxray_not_found' }
	const url = new URL('/_api/task-summary', resolution.endpoint)
	url.searchParams.set('task', task.trim())
	for (const key of ['role', 'project']) if (nonempty_text(options[key])) url.searchParams.set(key, String(options[key]).trim())
	const request = {
		task: task.trim(),
		project: nonempty_text(options.project) ? String(options.project).trim() : null,
		role: nonempty_text(options.role) ? String(options.role).trim() : null,
		session_specs: [],
		from: Number.isSafeInteger(options.from_ms) && options.from_ms >= 0 ? options.from_ms : null,
		to: Number.isSafeInteger(options.to_ms) && options.to_ms >= 0 ? options.to_ms : null,
		window_requested: Number.isSafeInteger(options.from_ms) && options.from_ms >= 0 || Number.isSafeInteger(options.to_ms) && options.to_ms >= 0,
	}
	if (request.window_requested) {
		if (request.from !== null) url.searchParams.set('from', String(request.from))
		if (request.to !== null) url.searchParams.set('to', String(request.to))
	}
	if (nonempty_text(options.session)) {
		const session = String(options.session).trim()
		url.searchParams.set('session', session)
		request.session_specs.push(session)
	}
	if (Array.isArray(options.sessions) && resolution.capabilities?.includes('session-intervals')) {
		for (const value of options.sessions.slice(0, 32)) {
			const spec = session_spec(value)
			if (spec !== null) {
				url.searchParams.append('session', spec)
				request.session_specs.push(spec)
			}
		}
	}

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 3000)
	try {
		let response
		try {
			response = await fetch(url.toString(), {
				method: 'GET',
				headers: { 'Accept': 'application/json' },
				signal: controller.signal,
			})
		} catch (error) {
			return { summary: null, failure: fetch_ccxray_error_class(error) }
		}
		const received_ms = Date.now()
		if (response.status !== 200) return { summary: null, failure: `HTTP ${response.status}` }

		let data
		try {
			data = await response.json()
		} catch (error) {
			return { summary: null, failure: fetch_ccxray_error_class(error) }
		}
		const validation_error = validate_ccxray_summary_body(data)
		if (validation_error !== null) return { summary: null, failure: `invalid summary: ${validation_error}` }
		const invariant_error = check_ccxray_invariants(data, { ...request, received_ms })
		if (invariant_error !== null) return { summary: null, failure: invariant_error }
		if (data.calls === 0 && !is_object(data.coordinator) && options.allow_empty !== true) return { summary: null, failure: 'NoData' }
		const ccxray_source = {
			instance_id: resolution.instance_id || 'unknown',
			ccxray_version: resolution.ccxray_version || 'unknown',
		}
		const selected = nonempty_text(options.role)
			? selected_ccxray_sub_summary(data, { role: options.role, session_query: request.session_specs.length > 0 })
			: undefined

		const token_data = data.tokens && typeof data.tokens === 'object' ? data.tokens : {}
		const cache_tokens = (token_data.cache_read || 0) + (token_data.cache_create || 0)
		const output_by_role = new Map()
		for (const [role, summary] of Object.entries(data.by_role)) output_by_role.set(role, project_ccxray_output_sub_summary(summary))
		const output_summary = {
			task: typeof data.task === 'string' ? data.task : task.trim(),
			role: typeof data.role === 'string' || data.role === null ? data.role : options.role,
			project: typeof data.project === 'string' || data.project === null ? data.project : options.project,
			calls: data.calls,
			cost_usd: data.cost_usd,
			cost_confidence: {
				priced: data.cost_confidence.priced,
				unknown: data.cost_confidence.unknown,
				fallback: data.cost_confidence.fallback,
				no_usage: data.cost_confidence.no_usage,
			},
			uncomputable_requests: data.uncomputable_requests === undefined ? 0 : data.uncomputable_requests,
			cache_hit_rate: typeof data.cache_hit_rate === 'number' ? data.cache_hit_rate : 0,
			tools: project_ccxray_counter_map(data.tools),
			tool_failures: valid_ccxray_counter(data.tool_failures) ? data.tool_failures : 0,
			skills: project_ccxray_counter_map(data.skills),
			models: Array.isArray(data.models) ? data.models.filter(model => typeof model === 'string').map(String) : [],
			agents: Array.isArray(data.agents) ? data.agents.filter(agent => typeof agent === 'string').map(String) : [],
			window: project_ccxray_window(data.window),
			coverage: project_ccxray_coverage(data.coverage),
			...(Array.isArray(data.entry_ids) ? { entry_ids: data.entry_ids.filter(entry => typeof entry === 'string').map(String) } : {}),
			charges: data.charges.map(project_ccxray_charge),
			last_ingested_at: data.last_ingested_at === null || data.last_ingested_at === undefined ? null : data.last_ingested_at,
			pending_requests: data.pending_requests === undefined ? 0 : data.pending_requests,
			sessions: valid_ccxray_counter(data.sessions) ? data.sessions : 0,
			by_role: Object.fromEntries(output_by_role),
			capabilities: Array.isArray(resolution.capabilities) ? resolution.capabilities.slice() : [],
			ccxray_source: {
				instance_id: ccxray_source.instance_id,
				ccxray_version: ccxray_source.ccxray_version,
			},
			as_of: new Date().toISOString(),
			tokens: project_ccxray_tokens(token_data, cache_tokens),
		}
		if (Object.hasOwn(data, 'coordinator')) output_summary.coordinator = project_ccxray_output_sub_summary(data.coordinator, { coordinator: true })
		return {
			summary: output_summary,
			observation: project_ccxray_observation(data, {
				selected,
				capabilities: resolution.capabilities,
				ccxray_source,
			}),
			projected_summary: project_ccxray_summary(data, {
				capabilities: resolution.capabilities,
				ccxray_source,
			}),
			failure: null,
		}
	} finally {
		clearTimeout(timeout)
	}
}

const fetch_ccxray_metrics = async (task, options = {}) => (await fetch_ccxray_metrics_result(task, options)).summary

const aggregate_projected_ccxray_observations = values => {
	const cost = values.reduce((total, summary) => {
		if (summary.cost_usd === undefined || summary.cost_usd === null) return total
		const value = decimal_source(summary.cost_usd, 'task_summary.cost_usd')
		return rational_add(total, { numerator: value.numerator, denominator: value.denominator })
	}, { numerator: 0n, denominator: 1n })
	const has_cost = values.some(summary => summary.cost_usd !== undefined && summary.cost_usd !== null)
	const confidence = ['priced', 'unknown', 'fallback', 'no_usage'].reduce((result, key) => {
		result[key] = values.reduce((total, summary) => total + receipt_count(summary.cost_confidence?.[key]), 0)
		return result
	}, {})
	const models = [...new Set(values.flatMap(summary => Array.isArray(summary.models) ? summary.models : []))]
	const capabilities = [...new Set(values.flatMap(summary => Array.isArray(summary.capabilities) ? summary.capabilities : []))]
	const last_ingested_at = values.reduce((latest, summary) => summary.last_ingested_at === null || summary.last_ingested_at === undefined ? latest : summary.last_ingested_at, null)
	const first_source = values.find(summary => is_object(summary.ccxray_source))?.ccxray_source || {}
	return {
		requests: values.reduce((total, summary) => total + receipt_count(summary.requests), 0),
		cost_usd: has_cost ? rational_to_decimal(cost) : undefined,
		cost_confidence: confidence,
		uncomputable_requests: values.reduce((total, summary) => total + receipt_count(summary.uncomputable_requests), 0),
		pending_requests: values.reduce((total, summary) => total + receipt_count(summary.pending_requests), 0),
		last_ingested_at,
		charges: values.flatMap(summary => Array.isArray(summary.charges) ? summary.charges : []),
		models,
		window: values.length === 1 ? values[0].window : null,
		coverage: values.length === 1 ? values[0].coverage : null,
		capabilities,
		ccxray_source: {
			instance_id: nonempty_text(first_source.instance_id) ? String(first_source.instance_id) : 'unknown',
			ccxray_version: nonempty_text(first_source.ccxray_version) ? String(first_source.ccxray_version) : 'unknown',
		},
	}
}

const aggregate_ccxray_summaries = (summaries, { task, project } = {}) => {
	const values = (Array.isArray(summaries) ? summaries : []).filter(is_object)
	if (values.length === 0) return undefined
	const role_values = new Map()
	for (const summary of values) {
		for (const [role, input] of Object.entries(is_object(summary.by_role) ? summary.by_role : {})) {
			if (!is_object(input)) continue
			if (!role_values.has(role)) role_values.set(role, [])
			role_values.get(role).push(input)
		}
	}
	const aggregate = aggregate_projected_ccxray_observations(values)
	const by_role = new Map()
	for (const [role, role_summaries] of role_values.entries()) by_role.set(role, aggregate_projected_ccxray_observations(role_summaries))
	aggregate.by_role = Object.fromEntries(by_role)
	if (nonempty_text(task)) aggregate.task = String(task)
	if (nonempty_text(project)) aggregate.project = String(project)
	if (values.length > 1) aggregate.projects = values.map(summary => ({
		project: summary.project,
		requests: summary.requests,
		cost_usd: summary.cost_usd,
		by_role: summary.by_role,
	}))
	return aggregate
}

const ccxray_format_value = value => value === undefined || value === null ? 'unavailable' : display_text(value)

const ccxray_format_cost = value => {
	const numeric = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(numeric) ? numeric.toFixed(4) : 'unavailable'
}

// ccxray's aggregate-cost rule (its ADR 0017): a total that skipped unpriced or
// usage-less calls is a lower bound and is marked `+`; one that leans on
// default rates is marked `~`. An unmarked figure is one we can stand behind.
const ccxray_cost_marks = (confidence, uncomputable_requests = 0, charges = [], completeness_unknown = false) => {
	const values = is_object(confidence) ? confidence : {}
	const unknown = Number.isSafeInteger(values.unknown) && values.unknown >= 0 ? values.unknown : 0
	const no_usage = Number.isSafeInteger(values.no_usage) && values.no_usage >= 0 ? values.no_usage : 0
	const fallback = Number.isSafeInteger(values.fallback) && values.fallback >= 0 ? values.fallback : 0
	const under = unknown + no_usage
	return {
		prefix: fallback > 0 || charges.some(charge => charge?.basis === 'fallback') ? '~' : '',
		suffix: under > 0 || uncomputable_requests > 0 || charges.some(charge => charge?.basis === 'unpriced') || completeness_unknown === true ? '+' : '',
	}
}

const ccxray_marked_cost = (value, confidence, uncomputable_requests = 0, charges = [], completeness_unknown = false) => {
	const marks = ccxray_cost_marks(confidence, uncomputable_requests, charges, completeness_unknown)
	return `${marks.prefix}$${ccxray_format_cost(value)}${marks.suffix}`
}

const ccxray_format_rate = value => {
	const numeric = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : 'unavailable'
}

const ccxray_format_list = value => Array.isArray(value)
	? value.filter(nonempty_text).map(display_text).filter(nonempty_text).join(', ')
	: ''

// Names (roles, models, scope ids, snapshot ids) are capped so one hostile
// label cannot flood a devlog line; whole sentences (gap details) are only
// made single-line, never truncated, or the reader loses the fact.
const display_sentence = value => String(value)
	.replace(/[\u0000-\u001f\u007f]/gu, ' ')
	.replace(/\s+/gu, ' ')
	.trim()

const display_text = value => display_sentence(value).slice(0, 64)

const ccxray_format_label = (task, role) => {
	const task_value = nonempty_text(task) ? display_text(task) : 'unknown'
	const role_value = nonempty_text(role) ? display_text(role) : null
	return role_value ? `${task_value}/${role_value}` : task_value
}

const ccxray_role_total = (role, values = {}) => {
	const tokens = is_object(values.tokens) ? values.tokens : {}
	const total_tokens = first_value(tokens, ['total', 'total_tokens']) ?? first_value(values, ['total_tokens', 'tokens_total', 'tokens'])
	return `  - ${display_text(role)}: ${ccxray_format_value(first_value(values, ['calls', 'provider_calls']))} calls · ${ccxray_marked_cost(first_value(values, ['cost_usd', 'cost']), values.cost_confidence, values.uncomputable_requests, values.charges, values.completeness_unknown)} · ${ccxray_format_value(total_tokens)} tokens`
}

const receipt_known_rational = scopes => scopes.reduce((total, scope) => {
	const charges = Array.isArray(scope.charges) ? scope.charges : []
	const computable = charges.filter(charge => charge.usd !== null && charge.usd !== undefined && charge.basis !== 'unpriced')
	if (computable.length === 0 && charges.length === 0 && scope.known_usd !== undefined && scope.known_usd !== null) {
		const value = decimal_source(scope.known_usd, 'scope.known_usd')
		return rational_add(total, { numerator: value.numerator, denominator: value.denominator })
	}
	return computable.reduce((subtotal, charge) => {
		const value = decimal_source(charge.usd, 'charge.usd')
		return rational_add(subtotal, { numerator: value.numerator, denominator: value.denominator })
	}, total)
}, { numerator: 0n, denominator: 1n })

const receipt_requests = (scopes, gaps = []) => {
	let known = 0
	let unknown = false
	for (const scope of scopes) {
		if (Number.isSafeInteger(scope.requests) && scope.requests >= 0) known += scope.requests
		else unknown = true
	}
	const completeness_unknown = gaps.some(gap => ['completeness_unknown', 'task_summary_query_failed'].includes(gap.code))
	return {
		known,
		unknown: unknown || completeness_unknown,
		text: unknown ? known > 0 ? `≥ ${known}` : 'unknown' : completeness_unknown ? `≥ ${known}` : String(known),
	}
}

const receipt_models = scopes => [...new Set(scopes.flatMap(scope => {
		if (Array.isArray(scope.models)) return scope.models.filter(nonempty_text).map(String)
		return (Array.isArray(scope.charges) ? scope.charges : []).map(charge => charge.model).filter(nonempty_text).map(String)
	}))]
	.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

const receipt_gap_codes = (receipt, scope_ids = null, include_global = false) => (Array.isArray(receipt.gaps) ? receipt.gaps : []).filter(gap => scope_ids === null || scope_ids.includes(gap.scope_id) || (include_global && gap.scope_id === null))

const receipt_marks = (gaps, scopes = []) => {
	const fallback = gaps.some(gap => gap.code === 'fallback_rate')
	const additive = gaps.some(gap => ['completeness_unknown', 'missing_usage_requests', 'unpriced_requests', 'unpriced_charges', 'uncomputable_requests', 'unscoped_requests', 'scope_query_failed', 'task_summary_query_failed', 'receipt_serialization_failed'].includes(gap.code))
		|| gaps.some(gap => gap.code === 'ccxray_too_old_for_charges' && scopes.some(scope => Number.isSafeInteger(scope.requests) && scope.requests > 0))
	return `${fallback ? '~' : ''}${additive ? '+' : ''}`
}

const receipt_money = (rational, unknown = false) => {
	if (unknown) return 'unknown'
	return rational_to_fixed(rational, 4)
}

const receipt_scope_known = (scopes, gaps) => scopes.some(scope => {
	if (gaps.some(gap => gap.code === 'ccxray_too_old_for_charges' && gap.scope_id === scope.id)) return false
	const charges = Array.isArray(scope.charges) ? scope.charges : []
	if (charges.some(charge => charge.usd !== null && charge.usd !== undefined && charge.basis !== 'unpriced')) return true
	return charges.length === 0 && scope.priced_requests > 0
})

const receipt_query_failed = (scopes, gaps) => gaps.some(gap => gap.code === 'scope_query_failed' && (gap.scope_id === null || scopes.some(scope => scope.id === gap.scope_id)))

const receipt_unknown = (scopes, gaps) => receipt_query_failed(scopes, gaps) || !receipt_scope_known(scopes, gaps) && (receipt_requests(scopes).known > 0 || gaps.some(gap => ['missing_scope', 'pending_requests', 'missing_usage_requests', 'unpriced_requests', 'unpriced_charges', 'unscoped_requests', 'scope_query_failed', 'ccxray_too_old_for_charges'].includes(gap.code)))

const receipt_scope_status = (scopes, receipt, include_global = false) => {
	const scope_ids = scopes.map(scope => scope.id)
	const gaps = receipt_gap_codes(receipt, scope_ids, include_global)
	const request_status = receipt_requests(scopes, gaps)
	return {
		rational: receipt_known_rational(scopes),
		requests: request_status.known,
		requests_text: request_status.text,
		models: receipt_models(scopes),
		gaps,
		unknown: receipt_unknown(scopes, gaps),
		marks: receipt_marks(gaps, scopes),
	}
}

const receipt_cutoff_clock = cutoff => {
	const date = new Date(timestamp_ms(cutoff, 'cutoff'))
	return `${date.toISOString().slice(11, 19)}Z`
}

const receipt_attempts_text = scopes => {
	const count = scopes.length
	const label = `${count} ${count === 1 ? 'attempt' : 'attempts'}`
	const failed = scopes.filter(scope => scope.outcome === 'failed').length
	const cancelled = scopes.filter(scope => scope.outcome === 'cancelled').length
	const counts = []
	if (failed > 0) counts.push(`${failed} failed`)
	if (cancelled > 0) counts.push(`${cancelled} cancelled`)
	return counts.length === 0 ? label : `${label} (${counts.join(', ')})`
}

const receipt_intervals_text = (scopes, receipt) => {
	const count = scopes.length
	const open_ids = new Set((Array.isArray(receipt.gaps) ? receipt.gaps : [])
		.filter(gap => gap.code === 'interval_still_open' && scopes.some(scope => scope.id === gap.scope_id))
		.map(gap => gap.scope_id))
	const open = scopes.filter(scope => scope.outcome === 'running' || open_ids.has(scope.id)).length
	const label = `${count} ${count === 1 ? 'interval' : 'intervals'}`
	return open === 0 ? label : `${label} (${open} open)`
}

const format_receipt_devlog_lines = receipt => {
	const scopes = Array.isArray(receipt.scopes) ? receipt.scopes : []
	const total = receipt_scope_status(scopes, receipt, true)
	const amount = receipt_money(total.rational, total.unknown)
	const cutoff = receipt_cutoff_clock(receipt.cutoff)
	const lines = []
	const models_text = models => models.map(display_text).filter(nonempty_text).filter((model, index, values) => values.indexOf(model) === index)
	if (receipt.kind === 'attempt') {
		const scope = scopes[0] || { role: 'unknown', attempt: 1, outcome: 'running' }
		const display_models = models_text(total.models)
		lines.push(`- ccxray ${ccxray_format_label(receipt.ask, scope.role)} attempt ${display_text(scope.attempt)} (${display_text(scope.outcome)}): USD ${amount}${total.marks} · ${total.requests_text} requests · ${display_models.length > 0 ? display_models.join(', ') : 'unknown'} · through ${cutoff} · receipt ${display_text(receipt.snapshot_id)}`)
	} else {
		lines.push(`- ccxray ${display_text(receipt.ask)} cumulative: USD ${amount}${total.marks} · ${total.requests_text} requests · through ${cutoff} · excludes reporting tail · receipt ${display_text(receipt.snapshot_id)}`)
		const roles = new Map()
		for (const scope of scopes) {
			if (!roles.has(scope.role)) roles.set(scope.role, [])
			roles.get(scope.role).push(scope)
		}
		for (const role of [...roles.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
			const role_scopes = roles.get(role)
			const role_status = receipt_scope_status(role_scopes, receipt)
			const role_count = role === 'coordinator' ? receipt_intervals_text(role_scopes, receipt) : receipt_attempts_text(role_scopes)
			const display_models = models_text(role_status.models)
			lines.push(`  - ${display_text(role)}: USD ${receipt_money(role_status.rational, role_status.unknown)}${role_status.marks} · ${role_status.requests_text} requests · ${role_count} · ${display_models.length > 0 ? display_models.join(', ') : 'unknown'}`)
		}
		const components = new Map()
		for (const charge of scopes.flatMap(scope => Array.isArray(scope.charges) ? scope.charges : [])) {
			if (charge.usd === null || charge.usd === undefined || charge.basis === 'unpriced') continue
			const value = decimal_source(charge.usd, 'charge.usd')
			const rational = { numerator: value.numerator, denominator: value.denominator }
			components.set(charge.component, components.has(charge.component) ? rational_add(components.get(charge.component), rational) : rational)
		}
		const component_lines = [...components.entries()].filter(([, value]) => value.numerator !== 0n).sort((left, right) => {
			const comparison = rational_compare(right[1], left[1])
			return comparison === 0 ? left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0 : comparison
		})
		if (component_lines.length > 0) lines.push(`  - cost components: ${component_lines.map(([component, value]) => `${display_text(component)}: USD ${receipt_money(value)}`).join('; ')}`)
	}
	if (total.gaps.length > 0) lines.push(`  - gaps: ${total.gaps.map(gap => `${gap.scope_id === null ? 'total' : display_text(gap.scope_id)}: ${display_sentence(gap.detail)}`).join('; ')}`)
	return lines
}

const coordinator_unavailable_line = options => {
	const values = is_object(options) ? options : {}
	const known_sessions = Array.isArray(values.sessions) && values.sessions.length > 0
	const reason = values.coordinator_unavailable || (values.coordinator_capability === false && known_sessions ? 'ccxray_too_old' : null)
	return known_sessions && nonempty_text(reason) ? `  - coordinator: unavailable (${display_text(reason)})` : null
}

const format_ccxray_devlog_lines = (summary, options = {}) => {
	const option_values = is_object(options) ? options : {}
	const receipt = is_object(summary) && ['attempt', 'cumulative'].includes(summary.kind)
		? summary
		: is_object(option_values.receipt) && ['attempt', 'cumulative'].includes(option_values.receipt.kind)
			? option_values.receipt
			: null
	if (receipt) return format_receipt_devlog_lines(receipt)
	const unavailable = option_values.unavailable
	if (is_object(unavailable)) {
		const lines = [`- ccxray ${ccxray_format_label(unavailable.task, unavailable.role)}: unavailable (${ccxray_format_value(unavailable.reason)})`]
		const coordinator_line = coordinator_unavailable_line(option_values)
		if (coordinator_line) lines.push(coordinator_line)
		if (nonempty_text(unavailable.guidance)) {
			for (const line of String(unavailable.guidance).split(/\r?\n/u)) {
				const display_line = display_text(line)
				if (display_line !== '') lines.push(`  - ${display_line}`)
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
	const as_of = nonempty_text(summary.as_of) ? ` · as of ${display_text(summary.as_of)}` : ''
	const lines = [
		`- ccxray ${ccxray_format_label(summary.task, role)}: ${ccxray_format_value(summary.calls)} calls · ${ccxray_marked_cost(summary.cost_usd, summary.cost_confidence, summary.uncomputable_requests, summary.charges, summary.completeness_unknown)} · tokens in ${ccxray_format_value(tokens.input)} / out ${ccxray_format_value(tokens.output)} / cache ${ccxray_format_value(tokens.cache)} (hit ${ccxray_format_rate(summary.cache_hit_rate)}) / total ${ccxray_format_value(tokens.total)}${attribution}${as_of}`,
	]
	if (is_object(summary.cost_confidence)) {
		const unknown = Number.isSafeInteger(summary.cost_confidence.unknown) && summary.cost_confidence.unknown >= 0 ? summary.cost_confidence.unknown : 0
		const no_usage = Number.isSafeInteger(summary.cost_confidence.no_usage) && summary.cost_confidence.no_usage >= 0 ? summary.cost_confidence.no_usage : 0
		const fallback = Number.isSafeInteger(summary.cost_confidence.fallback) && summary.cost_confidence.fallback >= 0 ? summary.cost_confidence.fallback : 0
		const notes = []
		if (unknown > 0) notes.push(`${unknown} not priced (unknown model)`)
		if (no_usage > 0) notes.push(`${no_usage} without usage`)
		if (fallback > 0) notes.push(`${fallback} at default rates`)
		if (notes.length > 0) lines.push(`  - cost is a lower bound: ${notes.join('; ')}`)
	}

	const by_role = new Map(is_object(summary.by_role) ? Object.entries(summary.by_role) : [])
	if (!by_role.has('coordinator') && is_object(summary.coordinator)) by_role.set('coordinator', summary.coordinator)
	const role_names = [...by_role.keys()]
	if ((!role || role === 'coordinator') && (role_names.length >= 2 || role_names.length === 1 && role_names[0] === 'coordinator')) {
		for (const role_name of role_names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
			const role_summary = by_role.get(role_name)
			lines.push(ccxray_role_total(role_name, is_object(role_summary) ? role_summary : {}))
		}
	}

	const coordinator_sessions = is_object(summary.coordinator) && Array.isArray(summary.coordinator.sessions)
		? summary.coordinator.sessions
		: []
	if (coordinator_sessions.length > 0 && summary.coordinator.calls === 0) {
		lines.push('  - coordinator: unavailable (host_not_proxied)')
	} else {
		const coordinator_line = coordinator_unavailable_line(option_values)
		if (coordinator_line) lines.push(coordinator_line)
	}

	const tools = is_object(summary.tools) ? summary.tools : {}
	const tool_names = Object.keys(tools).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
	if (tool_names.length > 0) {
		const failure_suffix = summary.tool_failures === 0 ? '' : `; failures: ${ccxray_format_value(summary.tool_failures)}`
		lines.push(`  - tools: ${tool_names.map(name => `${display_text(name)} x${ccxray_format_value(tools[name])}`).join(', ')}${failure_suffix}`)
	}
	return lines
}

const ccxray_receipt_project = (config, root, requested) => nonempty_text(requested)
	? String(requested)
	: nonempty_text(config?.project)
		? String(config.project)
		: node_path.basename(root)

const ccxray_selector_milliseconds = selector => ({
	from_ms: timestamp_ms(selector.start_inclusive, 'scope.selector.start_inclusive'),
	to_ms: timestamp_ms(selector.end_exclusive, 'scope.selector.end_exclusive'),
})

const query_ccxray_receipt_scopes = async (task, project, scopes, resolution, options = {}) => {
	const cost_charges = resolution.capabilities?.includes('cost-charges') === true
	const summaries = []
	const query_failures = []
	for (const scope of scopes) {
		const milliseconds = ccxray_selector_milliseconds(scope.selector)
		if (milliseconds.to_ms <= milliseconds.from_ms) {
			summaries.push({ scope_id: scope.id, requests: 0, charges: [], pending_requests: 0, gaps: Array.isArray(scope.gaps) ? scope.gaps : [] })
			continue
		}
		const scope_project = nonempty_text(scope.selector.labels?.project) ? String(scope.selector.labels.project) : project
		const query = { endpoint: resolution.endpoint, project: scope_project, allow_empty: true, validate_summary: true }
		if (scope.role === 'coordinator') {
			query.role = 'coordinator'
			query.session = session_spec({ session: scope.selector.session_id, from: milliseconds.from_ms, to: milliseconds.to_ms - 1 })
		} else {
			query.role = scope.role
			query.from_ms = milliseconds.from_ms
			query.to_ms = milliseconds.to_ms
		}
		let queried
		try {
			queried = resolution.endpoint
				? await fetch_ccxray_metrics_result(task, { ...query, timeout_ms: options.timeout_ms })
				: { summary: null, failure: 'ccxray_not_found' }
		} catch (error) {
			const detail = internal_conversion_error(error)
			query_failures.push({ scope_id: scope.id, detail })
			summaries.push({
				scope_id: scope.id,
				requests: null,
				known_usd: null,
				cost_usd: null,
				charges: [],
				pending_requests: 0,
				scope_query_failed: detail,
				gaps: [
					...(Array.isArray(scope.gaps) ? scope.gaps : []),
					{ scope_id: scope.id, code: 'scope_query_failed', detail },
				],
			})
			continue
		}
		const summary = queried.observation
		if (!is_object(summary) && nonempty_text(queried.failure)) {
			const detail = display_sentence(queried.failure)
			query_failures.push({ scope_id: scope.id, detail })
			summaries.push({
				scope_id: scope.id,
				requests: null,
				known_usd: null,
				cost_usd: null,
				charges: [],
				pending_requests: 0,
				scope_query_failed: detail,
				gaps: [
					...(Array.isArray(scope.gaps) ? scope.gaps : []),
					{ scope_id: scope.id, code: 'scope_query_failed', detail },
				],
			})
				continue
		}
		try {
			const projected = is_object(summary)
				? summary
				: {
					requests: 0,
					cost_usd: 0,
					cost_confidence: { priced: 0, unknown: 0, fallback: 0, no_usage: 0 },
					uncomputable_requests: 0,
					pending_requests: 0,
					last_ingested_at: null,
					charges: [],
					models: [],
				}
			const scope_gaps = []
			if (!cost_charges) scope_gaps.push({ scope_id: scope.id, code: 'ccxray_too_old_for_charges', detail: 'ccxray_too_old_for_charges: ccxray does not advertise cost-charges' })
			if (scope.role === 'coordinator' && Number.isSafeInteger(projected.requests) && projected.requests === 0) scope_gaps.push({ scope_id: scope.id, code: 'host_not_proxied', detail: 'host coordinator interval has no observed requests' })
			summaries.push({
				scope_id: scope.id,
				requests: projected.requests,
				cost_usd: projected.cost_usd,
				cost_confidence: projected.cost_confidence,
				uncomputable_requests: projected.uncomputable_requests,
				pending_requests: projected.pending_requests,
				last_ingested_at: projected.last_ingested_at,
				charges: cost_charges && Array.isArray(projected.charges) ? projected.charges : [],
				models: Array.isArray(projected.models) ? projected.models : [],
				window: projected.window,
				coverage: projected.coverage,
				capabilities: projected.capabilities,
				ccxray_source: projected.ccxray_source,
				gaps: scope_gaps,
			})
		} catch (error) {
			const detail = internal_conversion_error(error)
			query_failures.push({ scope_id: scope.id, detail })
			summaries.push({
				scope_id: scope.id,
				requests: null,
				known_usd: null,
				cost_usd: null,
				charges: [],
				pending_requests: 0,
				scope_query_failed: detail,
				gaps: [
					...(Array.isArray(scope.gaps) ? scope.gaps : []),
					{ scope_id: scope.id, code: 'scope_query_failed', detail },
				],
			})
		}
	}
	let task_summary
	let task_summaries
	const task_summary_failures = []
	if (options.include_task_summary === true && resolution.endpoint) {
		const projects = [...new Set([project, ...scopes.map(scope => scope.selector.labels?.project).filter(nonempty_text).map(String)])]
		task_summaries = []
		for (const task_project of projects) {
			try {
				const queried = await fetch_ccxray_metrics_result(task, { endpoint: resolution.endpoint, project: task_project, allow_empty: true, validate_summary: true, timeout_ms: options.timeout_ms })
				if (queried.projected_summary) task_summaries.push(Object.assign({}, queried.projected_summary, { task: String(task), project: String(task_project) }))
				else if (nonempty_text(queried.failure)) task_summary_failures.push({ project: task_project, detail: display_sentence(queried.failure) })
			} catch (error) {
				task_summary_failures.push({ project: task_project, detail: internal_conversion_error(error) })
			}
		}
		task_summary = task_summaries.length === 1 ? task_summaries[0] : aggregate_ccxray_summaries(task_summaries, { task, project })
	}
	return { summaries, task_summary, task_summaries, cost_charges, query_failures, task_summary_failures }
}

const ccxray_receipt_query = (task, project, scopes, task_summary, task_summaries, failures = []) => ({
	task,
	project,
	scopes: scopes.map(scope => ({ id: scope.id, role: scope.role, selector: scope.selector })),
	...(task_summary === undefined ? {} : { task_summary }),
	...(Array.isArray(task_summaries) && task_summaries.length > 1 ? { task_summaries } : {}),
	...(failures.length > 0 ? { failures } : {}),
})

const run_ccxray_receipt_cli = async options => {
	if (!nonempty_text(options.config_path)) throw new MetricsError('--attempt and --cumulative require --config <ag.json>')
	const config = read_config(options.config_path)
	const mode = ccxray_mode(config)
	if (mode === 'off') {
		const unavailable = { available: false, reason: 'ccxray_disabled' }
		if (options.format === 'devlog') return { output: format_ccxray_devlog_lines(null, { unavailable: { ...unavailable, task: options.task, role: options.role } }) }
		return { output: unavailable }
	}
	const workspace = config?.switches?.['workspace-dir'] || '.agentflow'
	const root = workspace_root_for_config(options.config_path, workspace)
	const project = ccxray_receipt_project(config, root, options.project)
	const log_path = host_session_log_path({ config_path: options.config_path, config })
	const records = read_host_session_records(log_path)
	const cutoff = new Date().toISOString()
	const kind = options.cumulative ? 'cumulative' : 'attempt'
	const scopes = build_ccxray_scopes({ ask: options.task, project, records, cutoff, kind, role: options.role, attempt: options.attempt })
	const resolution = await resolve_ccxray_endpoint(options)
	if (!resolution.endpoint) {
		const unavailable = { available: false, reason: resolution.reason }
		if (options.format === 'devlog') return { output: format_ccxray_devlog_lines(null, { unavailable: { ...unavailable, task: options.task, role: options.role } }) }
		return { output: unavailable }
	}
	const queried = await query_ccxray_receipt_scopes(options.task, project, scopes, resolution, { include_task_summary: kind === 'cumulative', timeout_ms: options.timeout_ms })
	const receipt = build_ccxray_receipt({
		kind,
		ask: options.task,
		project,
		scopes,
		summaries: queried.summaries,
		total_summary: queried.task_summary,
		task_summary_failures: queried.task_summary_failures,
		cutoff,
		source: {
			instance_id: resolution.instance_id || 'unknown',
			ccxray_version: resolution.ccxray_version || 'unknown',
			exporter_version: CCXRAY_EXPORTER_VERSION,
			query: ccxray_receipt_query(options.task, project, scopes, queried.task_summary, queried.task_summaries, [...queried.query_failures, ...queried.task_summary_failures]),
		},
		supersedes: options.supersedes,
	})
	let receipt_path = null
	const serialization_failed = mark_receipt_serialization_failure(receipt)
	if (serialization_failed && options.format !== 'devlog') throw new MetricsError('receipt_serialization_failed', 'AG_METRICS_RECEIPT_SERIALIZATION')
	if (!serialization_failed && options.dry_run !== true) receipt_path = write_ccxray_receipt(receipt, { workspace_dir: root })
	const output = options.format === 'devlog' ? format_ccxray_devlog_lines(receipt) : receipt
	return { output, receipt, receipt_path }
}

const parse_cli = argv => {
	if (argv[0] === 'ccxray-summary') {
		let task
		let role
		let project
		let config_path
		let format
		let no_coordinator = false
		let attempt
		let cumulative = false
		let dry_run = false
		let supersedes
		let timeout_ms
		for (let index = 1; index < argv.length; index += 1) {
			const argument = argv[index]
			if (argument === '--no-coordinator') {
				no_coordinator = true
				continue
			}
			if (argument === '--cumulative') {
				cumulative = true
				continue
			}
			if (argument === '--dry-run') {
				dry_run = true
				continue
			}
			if (argument === '--timeout_ms' || argument === '--timeout-ms') {
				const next = argv[index + 1]
				if (next === undefined || !/^\d+$/u.test(next)) throw new MetricsError(`${argument} must be a non-negative integer`)
				timeout_ms = Number(next)
				index += 1
				continue
			}
			if (typeof argument === 'string' && (argument.startsWith('--timeout_ms=') || argument.startsWith('--timeout-ms='))) {
				const value = argument.slice(argument.indexOf('=') + 1)
				if (!/^\d+$/u.test(value)) throw new MetricsError(`${argument.split('=')[0]} must be a non-negative integer`)
				timeout_ms = Number(value)
				continue
			}
			if (argument === '--attempt') {
				const next = argv[index + 1]
				if (next !== undefined && typeof next === 'string' && !next.startsWith('--')) {
					if (!/^\d+$/u.test(next)) throw new MetricsError('--attempt must be a non-negative integer')
					attempt = Number(next)
					index += 1
				} else attempt = true
				continue
			}
			if (typeof argument === 'string' && argument.startsWith('--attempt=')) {
				const value = argument.slice('--attempt='.length)
				if (!/^\d+$/u.test(value)) throw new MetricsError('--attempt must be a non-negative integer')
				attempt = Number(value)
				continue
			}
			if (typeof argument === 'string' && argument.startsWith('--supersedes=')) {
				supersedes = argument.slice('--supersedes='.length)
				continue
			}
			if (argument === '--supersedes') {
				if (index + 1 >= argv.length) throw new MetricsError('--supersedes requires a value')
				supersedes = argv[++index]
				continue
			}
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
		if (attempt !== undefined && cumulative) throw new MetricsError('--attempt and --cumulative are mutually exclusive')
			return { subcommand: 'ccxray-summary', task, role, project, config_path, format, no_coordinator, attempt, cumulative, dry_run, supersedes, timeout_ms }
	}

	throw new MetricsError('usage: ccxray-cost.js ccxray-summary --task <id> [options]')
}

const write_ccxray_output = (format, summary, unavailable, options = {}) => {
	if (format === 'devlog') {
		const unavailable_options = unavailable
			? { ...options, unavailable: { ...unavailable, task: unavailable.task ?? options.task, role: unavailable.role ?? options.role } }
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
			if (options.attempt !== undefined || options.cumulative) {
				const result = await run_ccxray_receipt_cli(options)
				if (format === 'devlog') process.stdout.write(`${result.output.join('\n')}\n`)
				else process.stdout.write(`${serialize_ccxray_receipt(result.output)}\n`)
				return 0
			}
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
					reason: 'ccxray_disabled',
				}, {
					task: options.task,
					role: options.role,
				})
				return 0
			}
			const coordinator_enabled = !options.no_coordinator && (!nonempty_text(options.role) || options.role === 'coordinator')
			let coordinator_sessions = []
			if (coordinator_enabled && options.config_path) {
				try {
					const log_path = host_session_log_path({ config_path: options.config_path })
					coordinator_sessions = host_session_intervals(options.task, read_host_session_records(log_path), Date.now())
				} catch {}
			}
			const resolution = await resolve_ccxray_endpoint(options)
			const coordinator_capable = resolution.capabilities?.includes('session-intervals') === true
			const queried = resolution.endpoint
				? await fetch_ccxray_metrics_result(options.task, { ...options, endpoint: resolution.endpoint, sessions: coordinator_sessions })
				: null
			const coordinator_unavailable = coordinator_sessions.length > 0 && !coordinator_capable && resolution.endpoint
				? 'ccxray_too_old'
				: null
			if (queried?.summary) write_ccxray_output(format, queried.summary, null, {
				role: options.role,
				sessions: coordinator_sessions,
				coordinator_unavailable,
			})
			else {
				const failure = queried?.failure
				const invalid_summary = nonempty_text(failure) && (failure.startsWith('invalid summary: ') || failure.startsWith('invariant '))
				const unavailable = !resolution.endpoint
					? { available: false, reason: resolution.reason }
					: invalid_summary
						? { available: false, reason: 'invalid_summary', detail: failure.startsWith('invalid summary: ') ? failure.slice('invalid summary: '.length) : failure }
						: { available: false, reason: failure === 'NoData' || !nonempty_text(failure) ? 'no_data' : 'query_failed', detail: failure }
				if (mode === 'on' && !resolution.endpoint) unavailable.guidance = ccxray_install_guidance({ reason: unavailable.reason })
				write_ccxray_output(format, null, unavailable, {
					task: options.task,
					role: options.role,
					sessions: coordinator_sessions,
					coordinator_unavailable: resolution.reason === 'ccxray_too_old' || coordinator_unavailable
						? 'ccxray_too_old'
						: null,
				})
			}
			return 0
		}
		return 0
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		return 1
	}
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code })

module.exports = {
	HOST_SESSION_LOG_NAME,
	MetricsError,
	ccxray_mode,
	host_session,
	host_session_log_path,
	read_host_session_records,
	record_host_touch,
	host_session_intervals,
	format_ccxray_devlog_lines,
	build_ccxray_scopes,
	build_ccxray_receipt,
	write_ccxray_receipt,
	build_ccxray_attribution_prefix,
	ccxray_install_guidance,
	ccxray_executable_available,
	fetch_ccxray_metrics,
	detect_ccxray_endpoint,
	probe_http_health,
	resolve_ccxray_endpoint,
	validate_ccxray_summary_body,
	check_ccxray_invariants,
	project_ccxray_observation,
	project_ccxray_summary,
	serialize_ccxray_receipt,
	mark_receipt_serialization_failure,
	parse_cli,
	main,
}
