#!/usr/bin/env node
'use strict'

// agf — one shell entry for stream chores; agents may invoke this file directly.
//   agf new   = the `feature: <name>` sequence, minus the two steps a shell cannot
//               judge: the root STATUS pointer line (re-derived by the next
//               main-checkout session from features/*) and relocating a live session.
//   agf cleanup (aliases: clean, merge) = the `cleanup:<taskkey>` sequence, minus the root
//               devlog round — the next main-checkout `godev` round records it.
//   agf finish = two-phase preparation and delivery; the agent writes the closing
//               stream record between phases.
//   agf ditch = abandon a stream: no merge, one Y/n confirmation, then the
//               worktree (unsaved work included), remote branch, and local
//               branch are deleted.
// stdout = the folder to cd into, nothing else, so a shell function can `cd "$(...)"`.
// stderr = every human-facing message.

const { execFileSync, spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { TextDecoder } = require('node:util')
const ag_settings = require('./ag-settings.js')
const install_hook = require('./install-hook.js')
const setup = require('./setup.js')
const resume_intake = require('./resume-intake.js')
const notebook_writer = require('./notebook-write.js')
const completion_context = require('./completion-context.js')
const metrics = require('./metrics.js')
const { format_local_timestamp } = require('./local-time.js')

const MAX_GIT_TIMEOUT_MS = 30_000
const DELIVERY_LOCK_NAME = 'agf-delivery.lock'

const USAGE_COMMANDS = [
	{ label: 'skills', syntax: 'agf skills audit [--json]', description: 'inventory local skills and provide a read-only conflict audit prompt' },
	{ label: 'start', syntax: 'agf start --repo <path> --host <codex|claude> --message-stdin [--json]', description: 'initialize, record the owner message, and return one bounded intake result' },
	{ label: 'close', syntax: 'agf close --manifest-stdin [--push-authorized]', description: 'validate, replace, commit, and optionally push one prepared closeout manifest' },
	{ label: 'init', syntax: 'agf init', description: 'create Agentflow records, ignore entries, and project hooks in one repeatable action' },
	{ label: 'new', syntax: 'agf new <name> [taskkey] [-m "first ask"]', description: 'open a stream and write its initial notebook; root records stay with the agent' },
	{ label: 'finish', syntax: 'agf finish --prep [taskkey]', description: 'prepare a worktree by pushing its branch and integrating the default branch' },
	{ label: 'finish', syntax: 'agf finish --deliver [taskkey]', description: 'deliver a prepared worktree through the default branch and update the main checkout' },
	{ label: 'cleanup', syntax: 'agf cleanup [taskkey] (aliases: clean, merge)', description: 'close a stream from the main checkout with the existing merge-preserving cleanup' },
	{ label: 'ditch', syntax: 'agf ditch <taskkey>', description: 'abandon one stream after confirmation; no work is merged' },
	{ label: 'uninstall', syntax: 'agf uninstall [--skills]', description: 'preview and remove owned project hooks and shell shortcuts; optionally preserve skill copies as recoverable backups' },
	{ label: 'setup', syntax: 'agf setup [--fix]', description: 'check or install the shell shortcuts used to run Agentflow' },
	{ label: 'hooks', syntax: 'agf hooks [--project|--global] [--host <name>] [--off]', description: 'install or remove verified Stop hooks and the project commit guard' },
	{ label: 'settings', syntax: 'agf settings <show|validate|change|rename> [options]', description: 'inspect or change the current project configuration' },
]


const usage_words = (text, width) => {
	const usable_width = Math.max(1, Math.floor(Number(width) || 1))
	const words = String(text).trim().split(/\s+/).filter(Boolean)
	const lines = []
	let line = ''
	for (const word of words) {
		if (!line) {
			line = word
			continue
		}
		if (line.length + 1 + word.length <= usable_width) {
			line += ` ${word}`
			continue
		}
		lines.push(line)
		line = word
	}
	if (line) lines.push(line)
	return lines
}

const render_usage = (width) => {
	const usable_width = Number.isFinite(width) && width > 0 ? Math.max(1, Math.floor(width)) : 80
	const label_width = Math.max(...USAGE_COMMANDS.map((command) => command.label.length))
	const indent = 2
	const description_column = indent + label_width + 2
	const lines = [
		...usage_words('usage:', usable_width),
		...USAGE_COMMANDS.map((command) => `  ${command.syntax}`),
		'',
		...usage_words('commands:', usable_width),
	]

	for (const command of USAGE_COMMANDS) {
		const prefix = `${' '.repeat(indent)}${command.label.padEnd(label_width)}  `
		const beside_width = usable_width - description_column
		if (beside_width >= 10) {
			const wrapped = usage_words(command.description, beside_width)
			lines.push(`${prefix}${wrapped[0]}`)
			for (const continuation of wrapped.slice(1)) lines.push(`${' '.repeat(description_column)}${continuation}`)
		} else {
			lines.push(`${' '.repeat(indent)}${command.label}`)
			const narrow_indent = Math.min(description_column, Math.max(0, usable_width - 1))
			for (const continuation of usage_words(command.description, Math.max(1, usable_width - narrow_indent))) {
				lines.push(`${' '.repeat(narrow_indent)}${continuation}`)
			}
		}
	}

	lines.push('', ...usage_words('The plan runner remains the standalone agf-looper command. Commands that change stream state do not write the configured main notebook — type "godev" there afterwards.', usable_width))
	return `${lines.join('\n')}\n`
}

// ---------- pure ----------

const kebab_case = (name) =>
	String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const is_key = (key) => /^[a-z0-9][a-z0-9-]*$/.test(String(key))

const next_key = (base, taken) => {
	const used = new Set(taken)
	if (!used.has(base)) return base
	let n = 2
	while (used.has(`${base}-${n}`)) n += 1
	return `${base}-${n}`
}

const parse_new_args = (argv) => {
	const rest = []
	let wish = ''
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '-m' || argv[i] === '--message') {
			if (argv[i + 1] === undefined) return { error: `${argv[i]} requires a message` }
			wish = argv[i + 1]
			i += 1
			continue
		}
		if (argv[i] === '-h' || argv[i] === '--help') return { help: true }
		if (argv[i].startsWith('-')) return { error: `unknown new option "${argv[i]}"` }
		rest.push(argv[i])
	}
	if (rest.length > 2) return { error: 'new accepts a name and at most one taskkey' }
	return { name: rest[0] || '', key: rest[1] || '', wish }
}

const parse_clean_args = (argv) => {
	if (argv.some((arg) => arg === '-h' || arg === '--help')) return { help: true }
	const unknown = argv.find((arg) => arg.startsWith('-'))
	if (unknown) return { error: `unknown option "${unknown}"` }
	if (argv.length > 1) return { error: 'command accepts at most one taskkey' }
	return { help: false, key: argv[0] || '' }
}

const parse_start_args = (argv) => {
	const result = { repo: '', host: '', message_stdin: false, json: false }
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]
		if (flag === '--repo' || flag === '--host') {
			if (result[flag.slice(2)] || index + 1 >= argv.length || argv[index + 1].startsWith('--')) return { error: `${flag} requires a value` }
			result[flag.slice(2)] = argv[++index]
			continue
		}
		if (flag === '--message-stdin') {
			if (result.message_stdin) return { error: 'duplicate option --message-stdin' }
			result.message_stdin = true
			continue
		}
		if (flag === '--json') {
			if (result.json) return { error: 'duplicate option --json' }
			result.json = true
			continue
		}
		if (flag === '-h' || flag === '--help') return { help: true }
		return { error: `unknown start option "${flag}"` }
	}
	if (!result.repo) return { error: 'start requires --repo <path>' }
	if (!['codex', 'claude'].includes(result.host)) return { error: 'start requires --host <codex|claude>' }
	if (!result.message_stdin) return { error: 'start requires --message-stdin' }
	return result
}

const parse_close_args = (argv) => {
	const result = { help: false, manifest_stdin: false, push_authorized: false }
	for (const flag of argv) {
		if (flag === '-h' || flag === '--help') return { help: true }
		if (flag === '--manifest-stdin') {
			if (result.manifest_stdin) return { error: 'duplicate option --manifest-stdin' }
			result.manifest_stdin = true
			continue
		}
		if (flag === '--push-authorized') {
			if (result.push_authorized) return { error: 'duplicate option --push-authorized' }
			result.push_authorized = true
			continue
		}
		return { error: `unknown close option "${flag}"` }
	}
	if (!result.manifest_stdin) return { error: 'close requires --manifest-stdin' }
	return result
}

const update_ignore_file = (repo) => {
	const ignore_path = path.join(repo, '.gitignore')
	const current = fs.existsSync(ignore_path) ? fs.readFileSync(ignore_path, 'utf8') : ''
	const lines = current.split(/\r?\n/u).filter(Boolean)
	const next = [...lines]
	for (const entry of ['.claude/', '.codex/', '.worktrees/']) if (!next.includes(entry)) next.push(entry)
	const text = `${next.join('\n')}\n`
	if (text !== current) ag_settings.write_text_atomic(ignore_path, text)
	return ignore_path
}

const init_main = (argv, cwd, log) => {
	const args = parse_clean_args(argv)
	if (args.error || args.key) { log(args.error || 'init accepts no arguments'); return 1 }
	if (args.help) { log(render_usage(80)); return 1 }
	const repo = path.resolve(cwd)
	const host = active_host_for_cli(repo)
	const result = ag_settings.initialize_project({ repo_root: repo, explicit_host: host })
	update_ignore_file(repo)
	install_hook.install({ cwd: repo, hosts: [host], quiet: true, say: () => {} })
	const notebook = path.relative(repo, result.notebook_path || path.join(repo, result.config.switches['target-doc'])).split(path.sep).join('/')
	log(`${result.created ? 'initialized' : 'ready'}: ${notebook}`)
	return { dir: repo, notebook }
}

const parse_finish_args = (argv) => {
	const phases = []
	const rest = []
	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') return { help: true }
		if (arg === '--prep' || arg === '--deliver') {
			phases.push(arg.slice(2))
			continue
		}
		if (arg.startsWith('-')) return { error: `unknown finish option "${arg}"` }
		rest.push(arg)
	}
	if (phases.length !== 1) return { error: 'finish requires exactly one of --prep or --deliver' }
	if (rest.length > 1) return { error: 'finish accepts at most one taskkey' }
	const key = rest[0] || ''
	if (key && !is_key(key)) return { error: `taskkey "${key}" must be lowercase a-z0-9 and dashes` }
	return { help: false, phase: phases[0], key }
}

const resolve_key = ({ name, key }) => {
	if (key) {
		if (!is_key(key)) throw new Error(`taskkey "${key}" must be lowercase a-z0-9 and dashes`)
		return key
	}
	const derived = kebab_case(name)
	if (!derived) throw new Error(`"${name}" gives no usable key — pass one: agf new "${name}" <taskkey>`)
	return derived
}

const devlog_template = ({ taskkey, name, project_line, config_path, feature_root = 'features', root_notebook = 'devlog.md', host, date, wish, config, repo_root }) => {
	const doc = `${feature_root}/${taskkey}/${taskkey}.devlog.md`
	const ask = wish
		? `${ag_settings.format_ask_heading('A-001', { config, repo_root })}\n\n+ ${wish}\n\n---\n\n${ag_settings.format_ask_heading('A-002', { config, repo_root })}\n\n+ \n`
		: `${ag_settings.format_ask_heading('A-001', { config, repo_root })}\n\n+ \n`
	const status = ag_settings.format_status({
		project: project_line.replace(/^Project:\s*/, ''),
		notebook: doc,
		notebook_kind: 'stream',
		current_commit: 'stream-open only, no code commits yet',
		tests_scenarios: 'none',
		config_path: config_path || `${feature_root}/${taskkey}/ag.json`,
		host: host || 'unknown',
		validation: 'validated',
		proven: 'the stream configuration was copied from the root configuration',
		open: 'none',
		next: 'reply to the first Ask below',
		artifacts: 'none',
		archived_eras: 'none',
		streams: [],
	})
	return `${status}\nBacklink: main notebook \`${root_notebook}\` (main checkout)\n\nFeature: ${taskkey} — active — ${name}\n\nOpened by the \`agf\` shell shortcut on ${date}, not by an agent round. The main-notebook \`stream:\` pointer line was deliberately NOT written — the next main-checkout session re-derives it from \`${feature_root}/*/*devlog.md\`.\n\n---\n\n${ask}`
}

// .../<repo>/.worktrees/<key>[/deeper] → <key>; anything else → ''
const key_from_path = (cwd) => {
	const parts = String(cwd).split(path.sep)
	const at = parts.lastIndexOf('.worktrees')
	return at >= 0 && parts[at + 1] ? parts[at + 1] : ''
}

// `main` when refs/remotes/origin/HEAD points at origin/main; '' when it points nowhere.
const default_from_origin_head = (ref) => {
	const m = /^origin\/(.+)$/.exec(String(ref).trim())
	return m ? m[1] : ''
}

// (Y/n): Enter or y/yes = yes; EOF, a read error (null), or anything else = no.
const is_yes = (answer) => answer !== null && /^\s*(y|yes|)\s*$/i.test(String(answer))

// Keys close enough to be a typo of `key`: shares its first two characters, or it shares theirs.
const near_keys = (key, known) => {
	const head = String(key).slice(0, 2)
	return [...new Set(known)].filter((k) => head && (k.startsWith(head) || String(key).startsWith(k.slice(0, 2)))).sort()
}

// ---------- io ----------

const git_timeout_ms = () => {
	const requested = Number(process.env.AGF_TEST_GIT_TIMEOUT_MS)
	return Number.isFinite(requested) && requested > 0
		? Math.min(MAX_GIT_TIMEOUT_MS, Math.floor(requested))
		: MAX_GIT_TIMEOUT_MS
}

const sanitize_diagnostic = (value) => String(value || '')
	.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, '')
	.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g, '')
	.replace(/\u001b/g, '')
	.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
	.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1[redacted]@')
	.trim()

const git_failure_detail = (operation, result, { network = false } = {}) => {
	if (result.timed_out) return `${operation} timed out after ${git_timeout_ms()}ms; the result is unknown`
	if (network) return `${operation} failed`
	return `${operation} failed${result.out ? `: ${sanitize_diagnostic(result.out)}` : ''}`
}

const git = (cwd, args, { preserve_nul = false } = {}) => {
	try {
		return {
			ok: true,
			out: preserve_nul
				? String(execFileSync('git', args, {
					cwd,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: git_timeout_ms(),
				})).replace(/\0$/, '')
				: sanitize_diagnostic(execFileSync('git', args, {
				cwd,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: git_timeout_ms(),
			})),
		}
	} catch (err) {
		const timed_out = err.code === 'ETIMEDOUT' || /timed out/i.test(String(err.message || ''))
		return {
			ok: false,
			out: sanitize_diagnostic(`${String(err.stdout || '')}${String(err.stderr || err.message || '')}`),
			status: Number.isInteger(err.status) ? err.status : null,
			timed_out,
			mutation_unknown: timed_out,
		}
	}
}

// A committed notebook is data, not a diagnostic. Keep its successful stdout as
// the original bytes until the closing-record validator has checked it.
const git_blob = (cwd, args) => {
	try {
		return {
			ok: true,
			out: execFileSync('git', args, {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: git_timeout_ms(),
			}),
		}
	} catch (err) {
		const timed_out = err.code === 'ETIMEDOUT' || /timed out/i.test(String(err.message || ''))
		return {
			ok: false,
			out: sanitize_diagnostic(`${String(err.stdout || '')}${String(err.stderr || err.message || '')}`),
			timed_out,
			mutation_unknown: timed_out,
		}
	}
}

const close_usage = 'usage: agf close --manifest-stdin [--push-authorized]'

const read_close_stdin = () => {
	const chunks = []
	let total = 0
	while (true) {
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 1024 * 1024 + 1 - total))
		const count = fs.readSync(0, buffer, 0, buffer.length, null)
		if (count === 0) break
		total += count
		if (total > 1024 * 1024) throw new Error('close manifest standard input exceeds 1048576 bytes')
		chunks.push(buffer.subarray(0, count))
	}
	const content = Buffer.concat(chunks, total)
	if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content)) throw new Error('close manifest standard input is not valid UTF-8')
	return content.toString('utf8')
}

const is_plain_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const exact_keys = (value, expected, label) => {
	if (!is_plain_object(value)) throw new Error(`${label} must be a JSON object`)
	const expected_set = new Set(expected)
	const unknown = Object.keys(value).filter(key => !expected_set.has(key))
	const missing = expected.filter(key => !Object.hasOwn(value, key))
	if (unknown.length > 0) throw new Error(`${label} has undeclared field ${unknown[0]}`)
	if (missing.length > 0) throw new Error(`${label} is missing ${missing[0]}`)
}

const canonical_json_value = value => {
	if (Array.isArray(value)) return value.map(canonical_json_value)
	if (is_plain_object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical_json_value(value[key])]))
	return value
}

const close_id_for = manifest => {
	const material = {
		notebook: manifest.notebook,
		ask: manifest.ask,
		run_events: manifest.run_events,
		reply: manifest.reply,
		status: manifest.status,
		allowed_paths: manifest.allowed_paths,
		commit_message: manifest.commit_message,
	}
	return createHash('sha256').update(JSON.stringify(canonical_json_value(material)), 'utf8').digest('hex')
}

const close_delivery_result = delivery => {
	const mode = delivery?.mode === 'push' ? 'push' : 'local'
	return {
		mode,
		state: mode === 'push' ? 'not_requested' : 'not_requested',
		...(mode === 'push' ? { remote: delivery.remote, branch: delivery.branch } : {}),
	}
}

const close_result = ({ manifest, close_id = null } = {}) => ({
	version: 1,
	ok: false,
	phase: 'none',
	close_id,
	notebook: { path: manifest?.notebook ?? null },
	ask: manifest?.ask ?? null,
	next_ask: null,
	validation: null,
	commit: { state: 'not_attempted' },
	delivery: close_delivery_result(manifest?.delivery),
	error: null,
	recovery: null,
})

const close_success_result = result => ({
	version: result.version,
	ok: true,
	phase: result.phase,
	close_id: result.close_id,
	notebook: { path: result.notebook.path },
	ask: result.ask,
	next_ask: result.next_ask,
	commit: result.commit,
	delivery: result.delivery,
	...(result.validation?.checks.some(check => check.status === 'warn')
		? { warnings: result.validation.checks.filter(check => check.status === 'warn').map(({ id, detail }) => ({ id, detail })) }
		: {}),
})

const set_close_error = (result, code, message, recovery = 'correct the manifest or inspect the reported state before retrying') => {
	result.ok = false
	result.error = { code, message: sanitize_diagnostic(message).slice(0, 4096) }
	result.recovery = recovery
	return result
}

const close_validation_failure = (result, message) => {
	result.validation = {
		ok: false,
		checks: [{ id: 'close_candidate', status: 'fail', detail: sanitize_diagnostic(message) }],
	}
}

const close_validate_manifest = (manifest, repo) => {
	exact_keys(manifest, ['version', 'notebook', 'ask', 'run_events', 'reply', 'status', 'allowed_paths', 'commit_message', 'delivery'], 'close manifest')
	if (manifest.version !== 1 || !Number.isInteger(manifest.version)) throw new Error('close manifest version must be integer 1')
	if (typeof manifest.notebook !== 'string') throw new Error('close manifest notebook must be a repository-relative path')
	if (typeof manifest.ask !== 'string' || !/^A-\d{3}$/u.test(manifest.ask) || manifest.ask === 'A-999') throw new Error('close manifest Ask must use the exact A-NNN form except A-999')
	if (!Array.isArray(manifest.run_events) || !manifest.run_events.every(event => typeof event === 'string')) throw new Error('close manifest run_events must be an array of text events')
	if (typeof manifest.reply !== 'string') throw new Error('close manifest reply must be complete text')
	if (typeof manifest.status !== 'string' && !is_plain_object(manifest.status)) throw new Error('close manifest status must be a STATUS text string or fields object')
	if (!Array.isArray(manifest.allowed_paths) || manifest.allowed_paths.length === 0 || !manifest.allowed_paths.every(file => typeof file === 'string')) throw new Error('close manifest allowed_paths must be a non-empty array of paths')
	if (new Set(manifest.allowed_paths).size !== manifest.allowed_paths.length) throw new Error('close manifest allowed_paths must not contain duplicates')
	if (!manifest.allowed_paths.includes(manifest.notebook)) throw new Error('close manifest allowed_paths must contain notebook')
	if (typeof manifest.commit_message !== 'string' || manifest.commit_message.trim().length === 0) throw new Error('close manifest commit_message must be non-empty')
	if (Buffer.byteLength(manifest.commit_message, 'utf8') > 128 * 1024) throw new Error('close manifest commit_message is oversized')
	if (/^Agentflow-Close-Id:\s*[0-9a-f]{64}\s*$/imu.test(manifest.commit_message)) throw new Error('close manifest commit_message must not contain an Agentflow-Close-Id trailer')

	if (!is_plain_object(manifest.delivery)) throw new Error('close manifest delivery must be an object')
	if (manifest.delivery.mode === 'local') {
		exact_keys(manifest.delivery, ['mode'], 'local delivery')
	} else if (manifest.delivery.mode === 'push') {
		exact_keys(manifest.delivery, ['mode', 'remote', 'branch'], 'push delivery')
		for (const [label, value] of [['remote', manifest.delivery.remote], ['branch', manifest.delivery.branch]]) {
			if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f\s]/u.test(value)) throw new Error(`push delivery ${label} must be a non-empty name without whitespace or control characters`)
		}
	} else {
		throw new Error('close manifest delivery.mode must be local or push')
	}

	const notebook_file = notebook_writer.resolve_path(repo, manifest.notebook, 'notebook')
	const allowed_files = manifest.allowed_paths.map(file => {
		if (/[*?\[\]]/u.test(file)) throw new Error(`allowed path ${file} must name one regular file, not a glob`)
		const absolute = notebook_writer.resolve_path(repo, file, 'allowed')
		const stat = fs.lstatSync(absolute)
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`allowed path ${file} must be a regular non-symbolic-link file`)
		return { relative: file, absolute }
	})
	return { manifest, close_id: close_id_for(manifest), notebook_file, allowed_files }
}

const close_porcelain_paths = output => {
	const paths = []
	const records = String(output).split('\0')
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]
		if (record.length < 4) continue
		const status = record.slice(0, 2)
		const file = record.slice(3)
		if (file) paths.push(file)
		if (status.includes('R') || status.includes('C')) index += 1
	}
	return [...new Set(paths)]
}

const close_working_paths = repo => {
	const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { preserve_nul: true })
	return status.ok ? { paths: close_porcelain_paths(status.out) } : { error: git_failure_detail('reading working-tree paths', status) }
}

const close_index_paths = repo => {
	const status = git(repo, ['diff', '--cached', '--name-only', '-z'], { preserve_nul: true })
	return status.ok ? { paths: String(status.out).split('\0').filter(Boolean) } : { error: git_failure_detail('reading staged paths', status) }
}

const repository_identity = repo => {
	const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
	if (!branch.ok) return { error: git_failure_detail('reading repository branch', branch) }
	const head = git(repo, ['rev-parse', '--verify', 'HEAD'])
	if (head.ok) return { branch: branch.out, head: head.out, state: 'committed' }
	const unborn = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch.out}`])
	if (unborn.status === 1) return { branch: branch.out, head: null, state: 'unborn' }
	return { error: git_failure_detail('reading repository commit', head) }
}

const close_head_identity = repository_identity

const close_find_commit = (repo, close_id, notebook, expected_bytes) => {
	const history = git(repo, ['log', '--all', '--fixed-strings', `--grep=Agentflow-Close-Id: ${close_id}`, '--format=%H%x00%B%x00'], { preserve_nul: true })
	if (!history.ok) {
		const identity = repository_identity(repo)
		if (!identity.error && identity.state === 'unborn') return { sha: null }
		return { error: git_failure_detail('reading closeout history', history) }
	}
	const matches = []
	const records = String(history.out).split('\0')
	for (let index = 0; index + 1 < records.length; index += 1) {
		const sha = records[index].replace(/^\n/u, '')
		const message = records[index + 1]
		if (!/^[0-9a-f]{40}$/u.test(sha)) continue
		const trailer = message.match(new RegExp(`^Agentflow-Close-Id: ${close_id}$`, 'gmu'))
		if (trailer === null || trailer.length !== 1) continue
		const blob = git_blob(repo, ['show', `${sha}:${notebook}`])
		if (blob.ok && Buffer.isBuffer(blob.out) && blob.out.equals(expected_bytes)) matches.push(sha)
	}
	if (matches.length > 1) return { error: 'more than one matching Agentflow-Close-Id commit was found' }
	return { sha: matches[0] || null }
}

const dirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')) : [])

const branch_names = (repo) => {
	const r = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
	return r.ok ? r.out.split('\n').filter(Boolean).map((n) => n.replace(/^origin\//, '')).filter((n) => n !== 'HEAD') : []
}

const workspace_features = (repo) => {
	try {
		const config = JSON.parse(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'))
		return ag_settings.workspace_paths(config).features
	} catch {
		return '.agentflow/features'
	}
}

const main_notebook = (repo) => {
	try {
		const config = JSON.parse(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'))
		return config.switches['target-doc'] || ag_settings.workspace_paths(config).notebook
	} catch {
		return '.agentflow/devlog.md'
	}
}

const known_keys = (repo) => [
	...branch_names(repo),
	...dirs(path.join(repo, workspace_features(repo))),
	...dirs(path.join(repo, '.worktrees')),
]

const first_line_starting = (text, prefix) =>
	text.split('\n').find((line) => line.startsWith(prefix)) || ''

const write_all_sync = (descriptor, text, write = fs.writeSync) => {
	const bytes = Buffer.from(String(text), 'utf8')
	let offset = 0
	while (offset < bytes.length) {
		const written = write(descriptor, bytes, offset, bytes.length - offset)
		if (!Number.isInteger(written) || written <= 0) throw new Error('terminal output write did not make progress')
		offset += written
	}
}

const start_file_identity = file => resume_intake.file_identity(file)

const same_start_identity = (left, right) => {
	if (left === null || right === null) return left === right
	return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => String(left[key]) === String(right[key]))
}

const start_relative = (repo, file) => path.relative(repo, file).split(path.sep).join('/')

const start_snapshot_paths = (repo, host, target = '.agentflow/devlog.md') => [...new Set([
	'ag.json', '.gitignore', target, '.agentflow/devlog.md',
	`.${host}/settings.json`, `.${host}/hooks.json`,
	'.claude/settings.json', '.codex/hooks.json',
])]

const start_provenance = ({ repo, paths, before }) => paths.flatMap(relative => {
	const previous = before.get(relative) ?? null
	const after = start_file_identity(path.join(repo, relative))
	return same_start_identity(previous, after) ? [] : [{ path: relative, before: previous, after }]
})

const write_text_atomic_preserve_mode = (file, text, mode) => {
	const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`
	let descriptor = null
	let renamed = false
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
		fs.writeFileSync(descriptor, text, 'utf8')
		fs.fsyncSync(descriptor)
		fs.closeSync(descriptor)
		descriptor = null
		fs.chmodSync(temporary, mode)
		fs.renameSync(temporary, file)
		renamed = true
	} finally {
		if (descriptor !== null) {
			try { fs.closeSync(descriptor) } catch {}
		}
		if (!renamed) {
			try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
		}
	}
}

const acquire_start_lock = repo => {
	const lock_path = path.join(repo, '.agentflow-start.lock')
	let descriptor
	try {
		descriptor = fs.openSync(lock_path, 'wx', 0o600)
		fs.writeFileSync(descriptor, [
			'Agentflow startup lock',
			`pid: ${process.pid}`,
			`started: ${format_local_timestamp()}`,
			`repository: ${repo}`,
			'',
		].join('\n'), 'utf8')
		fs.fsyncSync(descriptor)
		return { path: lock_path, descriptor }
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor) } catch {}
		}
		if (error.code === 'EEXIST') return { path: lock_path, existing: true }
		throw error
	}
}

const release_start_lock = lock => {
	if (!lock || lock.existing) return
	try { fs.closeSync(lock.descriptor) } finally { fs.unlinkSync(lock.path) }
}

const read_start_message = () => {
	const message = fs.readFileSync(0, 'utf8').replace(/\r\n?/gu, '\n')
	if (message.trim().length === 0) throw new Error('start received an empty owner message on standard input')
	if (Buffer.byteLength(message, 'utf8') > 64 * 1024) throw new Error('start owner message exceeds the 65536-byte limit')
	return message.endsWith('\n') ? message.slice(0, -1) : message
}

const is_activation_only_message = message => ['godev', '/godev'].includes(String(message).trim().toLowerCase())

const insert_start_message = (text, current_ask, message) => {
	const { parse_fast_lane } = require('./fast-lane.js')
	if (current_ask && !['', '+'].includes(current_ask.text.trim()) && parse_fast_lane(message) && !parse_fast_lane(current_ask.text)) {
		const tail = text.slice(current_ask.body_start)
		const record_start = tail.search(/^(?:---[ \t]*$|## \[(?:RUN|WIP)-\d+\])/mu)
		const position = record_start < 0 ? text.length : current_ask.body_start + record_start
		return { text: `${text.slice(0, position).trimEnd()}\n\n${notebook_writer.format_owner_input(message)}\n\n${text.slice(position)}`, inserted: true, reason: 'fast_lane_selected' }
	}
	if (current_ask === null || !['', '+'].includes(current_ask.text.trim())) return { text, inserted: false, reason: 'already_present' }
	if (is_activation_only_message(message)) {
		if (current_ask.text.trim() === '+') return { text, inserted: false, reason: 'activation_only' }
		return { text: `${text.trimEnd()}\n\n+\n`, inserted: true, reason: 'activation_placeholder_repaired' }
	}
	const listed = notebook_writer.format_owner_input(message)
	if (current_ask.text.trim() === '') return { text: `${text.trimEnd()}\n\n${listed}\n`, inserted: true, reason: 'empty_ask_repaired' }
	const plus = text.indexOf('+', current_ask.body_start)
	if (plus < 0 || text.slice(current_ask.body_start, plus).trim() !== '') throw new Error(`Ask ${current_ask.id} is not a single empty + placeholder`)
	const line_end = text.indexOf('\n', plus)
	const after_plus = text.slice(plus + 1)
	const next_ask = after_plus.search(/^# → Ask \/ /mu)
	const body_tail = next_ask < 0 ? after_plus : after_plus.slice(0, next_ask)
	if (body_tail.trim() !== '') throw new Error(`Ask ${current_ask.id} is not a single empty + placeholder`)
	return { text: `${text.slice(0, plus)}${listed}${text.slice(line_end < 0 ? text.length : line_end)}`, inserted: true, reason: 'empty_placeholder_replaced' }
}

const next_run_id = (notebook_text, current_ask) => {
	const heading = current_ask === null ? '' : `# → Ask / ${current_ask.id}`
	const start = heading === '' ? -1 : String(notebook_text).lastIndexOf(heading)
	const round = start < 0 ? '' : String(notebook_text).slice(start)
	const ids = [...round.matchAll(/^## \[RUN-(\d{3})\] Event\b/gmu)].map(match => Number(match[1]))
	return `RUN-${String((ids.length === 0 ? 0 : Math.max(...ids)) + 1).padStart(3, '0')}`
}

const start_result = ({ repo, host, notebook, notebook_text, intake, setup_result, message_result, provenance, git_identity }) => ({
	repository: repo,
	notebook,
	active_host: host,
	git: git_identity,
	next_run_id: next_run_id(notebook_text, intake.current_ask),
	configuration: intake.configuration,
	setup_created: setup_result.created,
	setup_created_files: setup_result.created_files,
	hooks_restart_required: setup_result.changed_files.includes(host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'),
	setup: {
		created: setup_result.created,
		already_complete: setup_result.changed_files.length === 0,
		changed_files: setup_result.changed_files,
		provenance,
		tracked_project_records: setup_result.changed_files.filter(file => [notebook, 'ag.json', '.gitignore'].includes(file)),
		ignored_local_host_settings: setup_result.changed_files.filter(file => ['.codex/hooks.json', '.claude/settings.json'].includes(file)),
	},
	message: { inserted: message_result.inserted, reason: message_result.reason },
	current_ask_identifier: intake.current_ask?.id || null,
	current_ask: intake.current_ask,
	changed_paths: intake.changed_paths,
	stream_decision: intake.stream_decision,
	...(intake.fast_lane ? { fast_lane: intake.fast_lane } : {}),
	required_next_rulebook: intake.stream_decision.required_next_rulebook,
})

const start_public_result = result => ({
	repository: result.repository,
	notebook: result.notebook,
	active_host: result.active_host,
	local_timestamp: format_local_timestamp(),
	configuration: result.configuration,
	git: result.git,
	next_run_id: result.next_run_id,
	setup_created: result.setup_created,
	setup_created_files: result.setup_created_files,
	hooks_restart_required: result.hooks_restart_required,
	message: result.message,
	current_ask_identifier: result.current_ask_identifier,
	changed_paths: result.changed_paths,
	stream_decision: result.stream_decision,
	...(result.fast_lane ? { fast_lane: result.fast_lane } : {}),
	required_next_rulebook: result.required_next_rulebook,
})

const emit_start_result = (result, args, repo, log) => {
	if (args.json && result.message.reason === 'activation_only') return {
		dir: repo,
		json: {
			repository: result.repository,
			notebook: result.notebook,
			configuration: result.configuration,
			git: result.git,
			setup_created: result.setup_created,
			setup_created_files: result.setup_created_files,
			hooks_restart_required: result.hooks_restart_required,
			message: result.message,
		},
	}
	if (args.json) return { dir: repo, json: start_public_result(result) }
	log(`ready: ${repo}`)
	log(`notebook: ${result.notebook}`)
	log(`setup: ${result.setup.created ? 'initialized' : 'already complete'}`)
	log(`owner message: ${result.message.inserted ? 'recorded' : 'already present'}`)
	log(`current Ask: ${result.current_ask_identifier || 'none'}`)
	log(`stream decision: ${result.stream_decision.reason}`)
	if (result.required_next_rulebook) log(`next rulebook: ${result.required_next_rulebook}`)
	return { dir: repo }
}

const start_main = (argv, cwd, log, _ask, _width = 80) => {
	const args = parse_start_args(argv)
	if (args.help) { log(render_usage(80)); return 1 }
	if (args.error) { log(`${args.error}\n\n${render_usage(80)}`); return 1 }

	const requested = path.resolve(cwd, args.repo)
	const repo_path = real_path(requested)
	if (!fs.existsSync(repo_path) || !fs.statSync(repo_path).isDirectory()) throw new Error('start repository path must be an existing directory')
	const top = git(repo_path, ['rev-parse', '--show-toplevel'])
	const repo = top.ok ? real_path(top.out) : repo_path
	const message = read_start_message()
	const git_identity = top.ok ? repository_identity(repo) : { branch: null, head: null, state: 'unavailable' }
	if (git_identity.error) throw new Error(git_identity.error)
	let configured_target = '.agentflow/devlog.md'
	let config_file = path.join(repo, 'ag.json')
	if (fs.existsSync(config_file)) {
		const existing_config = ag_settings.load_config(config_file, { repo_root: repo, active_host: args.host })
		configured_target = existing_config.switches['target-doc'] || configured_target
	}
	if (top.ok && fs.statSync(path.join(repo, '.git')).isFile()) {
		configured_target = stream_doc(repo, git_identity.branch)
		if (!configured_target) throw new Error('stream notebook is missing for this worktree; restore its canonical notebook before intake')
		config_file = ag_settings.resolve_config_path(repo, configured_target)
		if (!fs.existsSync(config_file)) throw new Error('stream configuration is missing; restore its notebook/configuration pair before intake')
	}
	let lock = acquire_start_lock(repo)
	if (lock.existing) {
		const intake = resume_intake.collect_intake({ repo_root: repo, notebook_path: configured_target, active_host: args.host, interrupted_start: true })
		const result = start_result({
			repo,
			host: args.host,
			notebook: intake.notebook,
			notebook_text: fs.readFileSync(path.join(repo, intake.notebook), 'utf8'),
			intake,
			setup_result: { created: false, created_files: [], changed_files: [] },
			message_result: { inserted: false, reason: 'startup_lock_present', owner_message: message },
			provenance: [],
			git_identity,
		})
		metrics.record_host_touch({ repo_root: repo, config_path: config_file, ask: result.current_ask_identifier, event: 'start' })
		return emit_start_result(result, args, repo, log)
	}

	try {
		const before_paths = start_snapshot_paths(repo, args.host, configured_target)
		const before = new Map(before_paths.map(relative => [relative, start_file_identity(path.join(repo, relative))]))
		const initialized = fs.existsSync(config_file)
			? ag_settings.ensure_configuration({
				repo_root: repo,
				notebook_path: configured_target,
				config_path: config_file,
				explicit_host: args.host,
			})
			: ag_settings.initialize_project({ repo_root: repo, explicit_host: args.host })
		const notebook = start_relative(repo, initialized.notebook_path || path.join(repo, initialized.config.switches['target-doc']))
		const paths = start_snapshot_paths(repo, args.host, notebook)
		const notebook_file = path.join(repo, notebook)
		if (!fs.existsSync(notebook_file)) throw new Error(`configured notebook ${notebook} is missing; restore it or repair the pair explicitly`)
		update_ignore_file(repo)
		install_hook.install({ cwd: repo, hosts: [args.host], quiet: true, say: () => {} })
		const setup_provenance = start_provenance({ repo, paths, before })
		let message_result
		const input_lock = notebook_writer.acquire_close_round_lock(`${notebook_file}.close-round.lock`)
		try {
			const original = notebook_writer.read_regular_file(notebook_file, 'notebook')
			const current = resume_intake.final_ask_span(original.text)
			message_result = insert_start_message(original.text, current, message)
			message_result.owner_message = message
			const populated = resume_intake.final_ask_span(message_result.text || original.text)
			if (populated && populated.text !== '+') notebook_writer.capture_input_scope(repo, notebook, args.host, populated.id)
			if (message_result.inserted) {
				notebook_writer.verify_notebook_unchanged(notebook_file, original)
				notebook_writer.atomic_replace(notebook_file, Buffer.from(message_result.text), original.mode)
			}
		} finally { notebook_writer.release_close_round_lock(input_lock) }
		const provenance = start_provenance({ repo, paths, before })
		const changed_files = setup_provenance.map(record => record.path)
		const created_files = setup_provenance.filter(record => record.before === null).map(record => record.path)
		const setup_result = {
			created: Boolean(initialized.created || created_files.length > 0),
			created_files,
			changed_files,
		}
		release_start_lock(lock)
		lock = null
		const intake = resume_intake.collect_intake({ repo_root: repo, notebook_path: notebook, active_host: args.host, bootstrap_provenance: provenance })
		const result = start_result({ repo, host: args.host, notebook, notebook_text: message_result.text, intake, setup_result, message_result, provenance, git_identity })
		metrics.record_host_touch({ repo_root: repo, config_path: config_file, config: initialized.config, ask: result.current_ask_identifier, event: 'start' })
		return emit_start_result(result, args, repo, log)
	} finally {
		if (lock !== null) release_start_lock(lock)
	}
}

const host_from_root_status = (repo) => {
	let notebook = path.join(repo, '.agentflow/devlog.md')
	try {
		const config = JSON.parse(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'))
		notebook = path.join(repo, config.switches['target-doc'] || ag_settings.workspace_paths(config).notebook)
	} catch {}
	if (!fs.existsSync(notebook)) return ''
	const text = fs.readFileSync(notebook, 'utf8')
	if (!ag_settings.validate_status_projection(text).valid) return ''
	const match = /^Configuration:\s+[^\r\n]+\s+for\s+(codex|claude)\s+this round\.$/mu.exec(ag_settings.status_region(text).body)
	return match ? match[1] : ''
}

const active_host_for_cli = (repo) => {
	try {
		return ag_settings.detect_host()
	} catch (error) {
		if (!(error instanceof ag_settings.SettingsError) || error.code !== 'AG_HOST_UNKNOWN') throw error
		const recorded_host = host_from_root_status(repo)
		if (recorded_host) return recorded_host
		throw new ag_settings.SettingsError('agf could not identify the project host from the current STATUS; run godev once from Codex or Claude, then retry', { code: 'AG_HOST_UNKNOWN' })
	}
}

// The canonical stream notebook; '' when absent.
const stream_doc = (repo, key) => {
	const features = workspace_features(repo)
	const candidates = [
		path.join(features, key, `${key}.devlog.md`),
	]
	return candidates.find((rel) => fs.existsSync(path.join(repo, rel))) || ''
}

const registered_worktrees = (repo) => {
	const result = git(repo, ['worktree', 'list', '--porcelain'])
	if (!result.ok) return []
	return result.out.split('\n')
		.filter((line) => line.startsWith('worktree '))
		.map((line) => line.slice('worktree '.length).trim())
		.filter(Boolean)
}

const real_path = (value) => {
	try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

const shell_quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`

const local_branches = (repo) => {
	const result = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
	return result.ok ? result.out.split('\n').filter(Boolean) : []
}

const finish_default_branch = (repo, has_remote) => {
	const origin_head = has_remote
		? git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
		: { ok: false, out: '' }
	const from_origin = origin_head.ok
		? default_from_origin_head(origin_head.out.replace(/^refs\/remotes\//, ''))
		: ''
	const branches = local_branches(repo)
	const detected = from_origin || ['main', 'master'].find((branch) => branches.includes(branch)) || ''
	return detected && branches.includes(detected) ? detected : ''
}

const finish_context = (cwd, supplied_key) => {
	const top = git(cwd, ['rev-parse', '--show-toplevel'])
	if (!top.ok) return { error: 'not a git repository — run agf finish inside a stream worktree' }
	const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!common.ok) return { error: `cannot locate the main checkout:\n${common.out}` }
	const git_common_dir = real_path(common.out)
	const repo = path.dirname(git_common_dir)
	const worktree = real_path(top.out)
	const inferred_key = key_from_path(worktree)
	if (!inferred_key) return { error: 'agf finish runs only inside a .worktrees/<taskkey> stream worktree' }
	if (supplied_key && supplied_key !== inferred_key) {
		return { error: `taskkey "${supplied_key}" does not match the current worktree "${inferred_key}"` }
	}
	const key = supplied_key || inferred_key
	if (!is_key(key)) return { error: `taskkey "${key}" must be lowercase a-z0-9 and dashes` }
	const expected_worktree = real_path(path.join(repo, '.worktrees', key))
	if (worktree !== expected_worktree) {
		return { error: `finish requires the matching registered worktree .worktrees/${key}` }
	}
	if (!registered_worktrees(repo).some((candidate) => real_path(candidate) === worktree)) {
		return { error: `worktree .worktrees/${key} is not registered with Git` }
	}
	const branch = git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
	if (!branch.ok || branch.out !== key) {
		return { error: `worktree .worktrees/${key} is not on branch "${key}"` }
	}
	const status = git(worktree, ['status', '--porcelain', '--untracked-files=all'])
	if (!status.ok) return { error: `cannot inspect worktree state:\n${status.out}` }
	if (status.out !== '') return { error: `worktree .worktrees/${key} has unsaved changes — commit or stash them before running agf finish` }
	const remotes = git(repo, ['remote'])
	const has_remote = remotes.ok && remotes.out.split('\n').includes('origin')
	const def = finish_default_branch(repo, has_remote)
	if (!def) return { error: 'cannot tell which branch is the default line of work — keep a local main or master branch and try again' }
	return { repo, git_common_dir, worktree, key, def, has_remote }
}

const merge_and_abort = (context, source, log) => {
	const merged = git(context.worktree, ['merge', '--no-edit', source])
	if (merged.ok) return true
	const aborted = git(context.worktree, ['merge', '--abort'])
	const abort_note = aborted.ok
		? 'the merge was aborted'
		: `the merge abort also failed: ${git_failure_detail('merge abort', aborted)}`
	const merge_note = git_failure_detail(`merging ${source} into "${context.key}"`, merged)
	log(`${merge_note} — ${abort_note}; no default-branch delivery was attempted`)
	return false
}

const main_recovery = (context) =>
	`git -C ${shell_quote(context.repo)} switch ${shell_quote(context.def)} && git -C ${shell_quote(context.repo)} fetch origin && git -C ${shell_quote(context.repo)} merge --ff-only ${shell_quote(`origin/${context.def}`)}`

const local_main_recovery = (context, source = context.key) =>
	`git -C ${shell_quote(context.repo)} switch ${shell_quote(context.def)} && git -C ${shell_quote(context.repo)} merge --ff-only ${shell_quote(source)}`

const tree_paths = (repo, ref) => {
	const result = git(repo, ['ls-tree', '-r', '-z', '--name-only', ref], { preserve_nul: true })
	return result.ok
		? { paths: new Set(result.out.split('\0').filter(Boolean)) }
		: { error: git_failure_detail(`reading ${ref}`, result) }
}

const added_paths = (repo, base, target) => {
	const result = git(repo, ['diff', '--name-only', '-z', '--diff-filter=A', base, target], { preserve_nul: true })
	return result.ok
		? { paths: result.out.split('\0').filter(Boolean) }
		: { error: git_failure_detail(`checking changes from ${base} to ${target}`, result) }
}

const main_checkout_identity = (repo) => {
	const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
	if (!branch.ok) return { error: git_failure_detail('reading the main checkout branch', branch) }
	const tip = git(repo, ['rev-parse', 'HEAD'])
	if (!tip.ok) return { error: git_failure_detail('reading the main checkout tip', tip) }
	return { branch: branch.out, tip: tip.out }
}

const delivery_lock_path = (context) => path.join(context.git_common_dir, DELIVERY_LOCK_NAME)

const stat_identity = (stat) => ({ dev: stat.dev, ino: stat.ino })

const same_stat_identity = (left, right) =>
	Boolean(left && right && left.dev === right.dev && left.ino === right.ino)

const owner_token_from_lock = (details) => {
	const match = /(?:^|\n)owner-token: ([0-9a-f]{64})(?:\n|$)/.exec(String(details))
	return match ? match[1] : ''
}

const close_delivery_lock_fd = (lock) => {
	if (!lock || lock.fd === null || lock.fd === undefined) return null
	const fd = lock.fd
	lock.fd = null
	try {
		fs.closeSync(fd)
		return null
	} catch (error) {
		return sanitize_diagnostic(error.message)
	}
}

const remove_owned_lock_path = (lock) => {
	if (!lock || !lock.stat) return 'the acquired lock identity was not recorded'
	let current
	try {
		current = fs.lstatSync(lock.path)
	} catch (error) {
		return `could not verify the lock pathname: ${sanitize_diagnostic(error.message)}`
	}
	if (!same_stat_identity(lock.stat, stat_identity(current))) {
		return 'the lock pathname no longer refers to the acquired lock'
	}
	let details
	try {
		details = fs.readFileSync(lock.path, 'utf8')
	} catch (error) {
		return `could not verify the lock owner token: ${sanitize_diagnostic(error.message)}`
	}
	if (owner_token_from_lock(details) !== lock.owner_token) return 'the lock owner token does not match'
	try {
		fs.unlinkSync(lock.path)
		return null
	} catch (error) {
		return sanitize_diagnostic(error.message)
	}
}

const acquire_delivery_lock = (context) => {
	const lock_path = delivery_lock_path(context)
	let owner_token
	try {
		owner_token = randomBytes(32).toString('hex')
	} catch (error) {
		return { error: `delivery could not create an owner token for the lock at ${lock_path}: ${sanitize_diagnostic(error.message)}` }
	}
	let fd
	try {
		fd = fs.openSync(lock_path, 'wx', 0o600)
	} catch (error) {
		if (error.code === 'EEXIST') {
			return {
				error: `delivery refused: another Agentflow delivery owns the lock at ${lock_path}; inspect that file and remove it only after confirming its recorded process has stopped`,
			}
		}
		return { error: `delivery could not create the lock at ${lock_path}: ${sanitize_diagnostic(error.message)}` }
	}

	const details = [
		'Agentflow delivery lock',
		`pid: ${process.pid}`,
		`started: ${format_local_timestamp()}`,
		`owner-token: ${owner_token}`,
		`repository: ${context.repo}`,
		`worktree: ${context.worktree}`,
		`taskkey: ${context.key}`,
		`recovery: inspect this file and remove it only after confirming pid ${process.pid} has stopped`,
		'',
	].join('\n')
	const lock = { path: lock_path, fd, owner_token, stat: null }

	try {
		lock.stat = stat_identity(fs.fstatSync(fd))
		fs.writeSync(fd, details, null, 'utf8')
		fs.fsyncSync(fd)
	} catch (error) {
		const close_error = close_delivery_lock_fd(lock)
		const remove_error = remove_owned_lock_path(lock)
		const cleanup = [close_error ? `closing the lock descriptor also failed: ${close_error}` : '', remove_error ? `the lock was kept: ${remove_error}` : '']
			.filter(Boolean).join('; ')
		return { error: `delivery could not write the lock at ${lock_path}: ${sanitize_diagnostic(error.message)}${cleanup ? `; ${cleanup}` : ''}` }
	}

	return lock
}

const release_delivery_lock = (lock) => {
	const release_error = remove_owned_lock_path(lock)
	const close_error = close_delivery_lock_fd(lock)
	return [release_error ? `lock release refused or failed: ${release_error}` : '', close_error ? `closing the lock descriptor failed: ${close_error}` : '']
		.filter(Boolean).join('; ') || null
}

const close_relative_lock = (repo, file) => path.relative(repo, file).split(path.sep).join('/')

const close_captured_validation = ({ repo, notebook, notebook_path, config_file, ignore_paths, candidate_paths }) => {
	const facts = completion_context.collect({
		project_root: repo,
		notebook_path,
		config_path: config_file,
		active_host: active_host_for_cli(repo),
		devlog_text: notebook.text,
		require_status_projection: true,
		ignore_paths,
		candidate_paths,
	})
	const validation = completion_context.validate_candidate_facts({
		devlog_text: notebook.text,
		context: { ...facts, captured_context: true },
	})
	return { facts, validation }
}

const close_audit_paths = ({ repo, allowed_paths, ignore_paths }) => {
	const working = close_working_paths(repo)
	if (working.error) return working
	const ignored = new Set(ignore_paths)
	const paths = working.paths.filter(file => !ignored.has(file))
	const allowed = new Set(allowed_paths)
	const outside = paths.filter(file => !allowed.has(file))
	return { paths, outside }
}

const close_commit_message = (message, close_id) => `${message.trimEnd()}\n\nAgentflow-Close-Id: ${close_id}`

const close_push = ({ repo, manifest, commit_sha, result }) => {
	const remote = manifest.delivery.remote
	const branch = manifest.delivery.branch
	result.delivery.remote = remote
	result.delivery.branch = branch
	const remotes = git(repo, ['remote'])
	if (!remotes.ok || !remotes.out.split('\n').includes(remote)) {
		result.delivery.state = 'not_configured'
		set_close_error(result, 'remote_not_configured', `push remote ${remote} is not configured`, 'configure the named remote or retry the same manifest with local delivery')
		return
	}
	const fetched = git(repo, ['fetch', remote])
	if (!fetched.ok) {
		result.delivery.state = fetched.timed_out ? 'unknown' : 'failed'
		set_close_error(result, fetched.timed_out ? 'push_unknown' : 'push_fetch_failed', git_failure_detail(`fetching ${remote}`, fetched), 'inspect the remote result before retrying the same manifest')
		return
	}

	const remote_ref = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`])
	if (remote_ref.ok && remote_ref.out === commit_sha) {
		result.delivery.remote_sha = remote_ref.out
		result.delivery.state = 'pushed'
		result.phase = 'pushed'
		result.ok = true
		result.error = null
		result.recovery = null
		return
	}
	if (remote_ref.ok) {
		const ancestor = git(repo, ['merge-base', '--is-ancestor', remote_ref.out, commit_sha])
		if (!ancestor.ok) {
			result.delivery.state = 'failed'
			set_close_error(result, 'remote_diverged', `remote ${remote}/${branch} is not an ancestor of ${commit_sha}`, 'inspect the remote divergence and retry only after choosing the correct recovery')
			return
		}
	}

	result.delivery.state = 'unknown'
	const pushed = git(repo, ['push', remote, `HEAD:${branch}`])
	if (!pushed.ok) {
		result.delivery.state = pushed.timed_out ? 'unknown' : 'failed'
		set_close_error(result, pushed.timed_out ? 'push_unknown' : 'push_failed', git_failure_detail(`pushing ${remote}/${branch}`, pushed, { network: true }), 'inspect the remote result before retrying the same manifest')
		return
	}
	const verified = git(repo, ['ls-remote', remote, `refs/heads/${branch}`])
	const remote_sha = verified.ok ? (verified.out.split(/\s+/u)[0] || '') : ''
	if (!verified.ok || remote_sha !== commit_sha) {
		result.delivery.state = 'unknown'
		set_close_error(result, 'push_verification_unknown', 'push completed but the remote branch could not be verified as the committed SHA', 'inspect the remote result before retrying the same manifest')
		return
	}
	result.delivery.remote_sha = remote_sha
	result.delivery.state = 'pushed'
	result.phase = 'pushed'
	result.ok = true
	result.error = null
	result.recovery = null
}

const close_execute = ({ repo, manifest, close_id, notebook_file, allowed_files }) => {
	const result = close_result({ manifest, close_id })
	const notebook_path = manifest.notebook
	const lock_context = { repo, worktree: repo, key: 'closeout', git_common_dir: real_path(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out) }
	let source
	try {
		source = notebook_writer.read_regular_file(notebook_file, 'notebook')
	} catch (error) {
		return set_close_error(result, 'notebook_unreadable', error.message, 'correct the notebook path or restore the regular notebook, then retry the same manifest')
	}
	result.notebook.source_identity = source.identity
	const config_file = ag_settings.active_config_path(repo, notebook_path)
	const lock_path = `${notebook_file}.close-round.lock`
	const delivery_lock = acquire_delivery_lock(lock_context)
	if (delivery_lock.error) return set_close_error(result, 'delivery_lock_busy', delivery_lock.error, `inspect ${delivery_lock.path || delivery_lock.error} and retry only after the active closeout has stopped`)
	let close_lock = null
	let outcome = result
	let candidate = null
	let expected_identity = null
	const allowed_paths = allowed_files.map(file => file.relative)
	const ignore_paths = [close_relative_lock(repo, lock_path), close_relative_lock(repo, delivery_lock.path)]
	try {
		try {
			close_lock = notebook_writer.acquire_close_round_lock(lock_path)
		} catch (error) {
			set_close_error(outcome, 'notebook_lock_busy', error.message, `inspect ${lock_path} and retry only after the active notebook writer has stopped`)
			return outcome
		}

		const current = notebook_writer.read_regular_file(notebook_file, 'notebook')
		if (!notebook_writer.match_closed_close({ notebook_text: current.text, input: manifest, project_root: repo, notebook_path })) {
			if (!Object.keys(source.identity).every(key => source.identity[key] === current.identity[key]) || source.hash !== current.hash) {
				set_close_error(outcome, 'notebook_stale', 'notebook identity changed before closeout locks were held', 'inspect the notebook and prepare a fresh manifest before retrying')
				return outcome
			}
		}

		const index = close_index_paths(repo)
		if (index.error) {
			set_close_error(outcome, 'git_state_unknown', index.error, 'inspect Git state before retrying the same manifest')
			return outcome
		}
		if (index.paths.length > 0) {
			set_close_error(outcome, 'dirty_index', `staged paths are present before notebook mutation: ${index.paths.join(', ')}`, 'clear the staged index deliberately, then retry the same manifest')
			return outcome
		}
		const before_audit = close_audit_paths({ repo, allowed_paths, ignore_paths })
		if (before_audit.error) {
			set_close_error(outcome, 'git_state_unknown', before_audit.error, 'inspect Git state before retrying the same manifest')
			return outcome
		}

		const identity = close_head_identity(repo)
		if (identity.error) {
			set_close_error(outcome, 'git_state_unknown', identity.error, 'inspect repository identity before retrying the same manifest')
			return outcome
		}
		if (manifest.delivery.mode === 'push' && identity.branch !== manifest.delivery.branch) {
			set_close_error(outcome, 'push_branch_mismatch', `push manifest branch ${manifest.delivery.branch} does not match current branch ${identity.branch}`, 'switch to the named branch or prepare a manifest for the current branch')
			return outcome
		}

		const closed = notebook_writer.match_closed_close({ notebook_text: current.text, input: manifest, project_root: repo, notebook_path })
		const outside_snapshot = closed ? {} : notebook_writer.snapshot_scope_paths(repo, before_audit.outside)
		if (closed) {
			candidate = current
			result.next_ask = closed.next_ask
			result.notebook.replacement_identity = current.identity
			result.notebook.candidate_sha256 = current.hash
			result.phase = 'notebook_replaced'
		} else {
			try {
				const prepared = notebook_writer.prepare_close_candidate({ notebook: current, input: manifest, root: repo, notebook_path })
				candidate = { ...current, content: prepared.candidate, text: prepared.candidate_text, hash: createHash('sha256').update(prepared.candidate).digest('hex') }
				result.next_ask = prepared.next_ask
				result.notebook.candidate_sha256 = candidate.hash
			} catch (error) {
				close_validation_failure(outcome, error.message)
				set_close_error(outcome, 'candidate_invalid', error.message, 'correct the supplied RUN, Reply, or STATUS material and retry the manifest')
				return outcome
			}
		}

		// Only allowed paths can enter this commit. Preserve outside working files,
		// while completion still checks every committed change after the review.
		const captured = close_captured_validation({ repo, notebook: candidate, notebook_path, config_file: fs.existsSync(config_file) ? config_file : undefined, ignore_paths: [...ignore_paths, ...Object.keys(outside_snapshot)], candidate_paths: before_audit.paths.filter(file => allowed_paths.includes(file)) })
		outcome.validation = captured.validation
		if (!captured.validation.ok) {
			set_close_error(outcome, 'completion_failed', `candidate completion check failed: ${captured.validation.checks.filter(check => check.status === 'fail').map(check => `${check.id}: ${check.detail}`).join('; ')}`, 'correct the completion evidence or review state, then retry the same manifest')
			return outcome
		}
		if (result.phase === 'none') result.phase = 'validated'

		if (!notebook_writer.match_closed_close({ notebook_text: current.text, input: manifest, project_root: repo, notebook_path })) {
			const before_replace_identity = close_head_identity(repo)
			if (before_replace_identity.error || before_replace_identity.branch !== identity.branch || before_replace_identity.head !== identity.head) {
				set_close_error(outcome, 'repository_changed', before_replace_identity.error || 'repository branch or HEAD changed before notebook replacement', 'inspect repository identity and retry the same manifest')
				return outcome
			}
			try {
				notebook_writer.verify_notebook_unchanged(notebook_file, source)
				notebook_writer.atomic_replace(notebook_file, candidate.content, current.mode)
			} catch (error) {
				try {
					const after_failure = notebook_writer.read_regular_file(notebook_file, 'notebook')
					if (notebook_writer.match_closed_close({ notebook_text: after_failure.text, input: manifest, project_root: repo, notebook_path })) {
						result.phase = 'notebook_replaced'
						result.notebook.replacement_identity = after_failure.identity
						result.notebook.candidate_sha256 = after_failure.hash
					}
				} catch {}
				set_close_error(outcome, 'notebook_replace_failed', error.message, 'retry the same manifest; the notebook is either the old complete file or the new complete file')
				return outcome
			}
			const replaced = notebook_writer.read_regular_file(notebook_file, 'notebook')
			result.phase = 'notebook_replaced'
			result.notebook.replacement_identity = replaced.identity
			result.notebook.candidate_sha256 = replaced.hash
			candidate = replaced
		}

		const after_identity = close_head_identity(repo)
		if (after_identity.error || after_identity.branch !== identity.branch || after_identity.head !== identity.head) {
			set_close_error(outcome, 'repository_changed', after_identity.error || 'repository branch or HEAD changed during notebook closeout', 'inspect repository identity and retry the same manifest')
			return outcome
		}
		const after_audit = close_audit_paths({ repo, allowed_paths, ignore_paths })
		if (after_audit.error) {
			set_close_error(outcome, 'git_state_unknown', after_audit.error, 'inspect Git state before retrying the same manifest')
			return outcome
		}

		const existing = close_find_commit(repo, close_id, notebook_path, candidate.content)
		if (existing.error) {
			set_close_error(outcome, 'commit_identity_unknown', existing.error, 'inspect closeout history before retrying the same manifest')
			return outcome
		}
		let commit_sha = existing.sha
		if (commit_sha) {
			result.commit = { state: 'existing', sha: commit_sha }
			result.phase = 'committed'
		} else {
			const to_stage = after_audit.paths.filter(file => allowed_paths.includes(file))
			if (!to_stage.includes(notebook_path)) {
				set_close_error(outcome, 'notebook_not_changed', 'the closeout notebook is not present in the allowed changed paths', 'inspect the notebook and retry the same manifest')
				return outcome
			}
			const staged = git(repo, ['add', '--', ...to_stage])
			if (!staged.ok) {
				result.commit = { state: staged.timed_out ? 'unknown' : 'failed' }
				set_close_error(outcome, staged.timed_out ? 'commit_unknown' : 'stage_failed', git_failure_detail('staging closeout paths', staged), 'inspect the index before retrying the same manifest')
				return outcome
			}
			const staged_paths = close_index_paths(repo)
			if (staged_paths.error || staged_paths.paths.some(file => !allowed_paths.includes(file))) {
				result.commit = { state: 'failed' }
				set_close_error(outcome, 'staging_scope_failed', staged_paths.error || `staging included an unapproved path: ${staged_paths.paths.find(file => !allowed_paths.includes(file))}`, 'inspect the index and correct the explicit manifest scope before retrying')
				return outcome
			}
			const before_commit = close_head_identity(repo)
			if (before_commit.error || before_commit.branch !== identity.branch || before_commit.head !== identity.head) {
				set_close_error(outcome, 'repository_changed', before_commit.error || 'repository branch or HEAD changed before the closeout commit', 'inspect repository identity and the staged index before retrying the same manifest')
				return outcome
			}
			const committed = git(repo, ['commit', '-m', close_commit_message(manifest.commit_message, close_id)])
			if (!committed.ok) {
				const recovered = close_find_commit(repo, close_id, notebook_path, candidate.content)
				if (recovered.sha) {
					commit_sha = recovered.sha
					result.commit = { state: 'existing', sha: commit_sha }
					result.phase = 'committed'
				} else {
					result.commit = { state: committed.timed_out ? 'unknown' : 'failed' }
					set_close_error(outcome, committed.timed_out ? 'commit_unknown' : 'commit_failed', git_failure_detail('creating the closeout commit', committed), 'inspect the index and closeout history before retrying the same manifest')
					return outcome
				}
			} else {
				const verified = close_find_commit(repo, close_id, notebook_path, candidate.content)
				if (verified.error || !verified.sha) {
					result.commit = { state: 'unknown' }
					set_close_error(outcome, 'commit_verification_unknown', verified.error || 'the closeout commit was created but could not be verified', 'inspect closeout history before retrying the same manifest')
					return outcome
				}
				commit_sha = verified.sha
				result.commit = { state: 'created', sha: commit_sha }
				result.phase = 'committed'
			}
		}

		if (!closed) notebook_writer.save_close_scope(repo, notebook_path, active_host_for_cli(repo), manifest.ask, commit_sha, candidate.hash, outside_snapshot)
		if (manifest.delivery.mode === 'local') {
			result.delivery.state = 'local'
			result.ok = true
			result.error = null
			result.recovery = null
			return outcome
		}
		// The verified commit owns the delivered bytes. Input capture may now write
		// the next Ask while network delivery retains its separate repository lock.
		notebook_writer.release_close_round_lock(close_lock)
		close_lock = null
		close_push({ repo, manifest, commit_sha, result: outcome })
		return outcome
	} catch (error) {
		set_close_error(outcome, 'close_failed', error.message || error, 'inspect the reported phase and retry the same manifest')
		return outcome
	} finally {
		let release_error = null
		if (close_lock !== null) {
			try { notebook_writer.release_close_round_lock(close_lock) } catch (error) { release_error = `notebook lock release failed: ${error.message}` }
		}
		const delivery_release = release_delivery_lock(delivery_lock)
		if (delivery_release) release_error = [release_error, delivery_release].filter(Boolean).join('; ')
		if (release_error) {
			outcome.ok = false
			outcome.error = { code: 'lock_release_failed', message: sanitize_diagnostic(release_error).slice(0, 4096) }
			outcome.recovery = 'inspect the named lock and retained closeout phase before retrying the same manifest'
		}
	}
}

const local_delivery_collision = (context, target, expected_tip = '') => {
	const base = expected_tip
		? { ok: true, out: expected_tip }
		: git(context.repo, ['rev-parse', 'HEAD'])
	if (!base.ok) return { error: git_failure_detail('reading the main checkout tip', base) }
	const additions = added_paths(context.repo, base.out, target)
	if (additions.error) return additions
	const base_tree = tree_paths(context.repo, base.out)
	if (base_tree.error) return base_tree

	for (const relative of additions.paths) {
		const parts = relative.split('/')
		for (let index = 0; index < parts.length; index += 1) {
			const candidate = parts.slice(0, index + 1).join('/')
			const absolute = path.join(context.repo, ...parts.slice(0, index + 1))
			let stat
			try { stat = fs.lstatSync(absolute) } catch { continue }
			if (index < parts.length - 1 && stat.isDirectory()) continue
			if (base_tree.paths.has(candidate)) continue
			return { path: candidate }
		}
	}

	return null
}

const closing_marker_error = (context, doc) =>
	({ error: `delivery requires exactly one fixed stream-state marker "Feature: ${context.key} — closed" in ${doc}` })

const valid_closing_blob = (blob, key) => {
	if (!Buffer.isBuffer(blob)) return false

	const marker = Buffer.from(`Feature: ${key} — closed`, 'utf8')
	const state_prefix = Buffer.from(`Feature: ${key} — `, 'utf8')
	const lines = []
	let line_start = 0
	let line_ending = ''

	for (let index = 0; index < blob.length; index += 1) {
		const byte = blob[index]
		if (byte === 0x0d) {
			if (blob[index + 1] !== 0x0a) return false
			if (line_ending && line_ending !== 'crlf') return false
			line_ending = 'crlf'
			lines.push(blob.subarray(line_start, index))
			index += 1
			line_start = index + 1
			continue
		}
		if (byte === 0x0a) {
			if (line_ending && line_ending !== 'lf') return false
			line_ending = 'lf'
			lines.push(blob.subarray(line_start, index))
			line_start = index + 1
			continue
		}
		if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) return false
	}
	lines.push(blob.subarray(line_start))

	let text
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob)
	} catch {
		return false
	}
	if (!Buffer.from(text, 'utf8').equals(blob)) return false
	for (const character of text) {
		const code = character.codePointAt(0)
		if ((code <= 0x1f && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
	}

	let marker_count = 0
	for (const line of lines) {
		if (line.equals(marker)) {
			marker_count += 1
			continue
		}
		if (line.length >= state_prefix.length && line.subarray(0, state_prefix.length).equals(state_prefix)) return false
	}
	return marker_count === 1
}

const stream_source_identity = (context) => {
	const branch = git(context.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
	if (!branch.ok) return { error: git_failure_detail('reading the stream worktree branch', branch) }
	const tip = git(context.worktree, ['rev-parse', 'HEAD'])
	if (!tip.ok) return { error: git_failure_detail('reading the stream worktree tip', tip) }
	return { branch: branch.out, tip: tip.out }
}

const delivery_source_error = (context, record) => {
	const source = stream_source_identity(context)
	if (source.error) return source.error
	if (source.branch !== context.key || source.tip !== record.head) {
		return `the stream worktree changed before default-ref mutation (expected branch "${context.key}" at ${record.head}, found "${source.branch}" at ${source.tip})`
	}
	return ''
}

const closing_record = (context) => {
	const doc = stream_doc(context.worktree, context.key)
	if (!doc) {
		const features = workspace_features(context.worktree)
		return { error: `delivery requires the stream notebook ${features}/${context.key}/${context.key}.devlog.md` }
	}
	const head = git(context.worktree, ['rev-parse', 'HEAD'])
	if (!head.ok) return { error: git_failure_detail('reading the stream tip', head) }
	const tree = git(context.worktree, ['ls-tree', '-z', head.out, '--', doc], { preserve_nul: true })
	const entry = tree.ok
		? tree.out.split('\0').filter(Boolean).map((record) => {
			const tab = record.indexOf('\t')
			const [mode, type] = record.slice(0, tab).split(' ')
			return { mode, type, path: record.slice(tab + 1) }
		}).find((record) => record.path === doc)
		: undefined
	if (!tree.ok || !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
		return { error: `delivery requires the stream notebook ${doc} at HEAD:${doc} to be a regular committed file, not a symlink or other non-regular entry` }
	}
	const blob = git_blob(context.worktree, ['show', `${head.out}:${doc}`])
	if (!blob.ok) return { error: `delivery could not read the committed stream notebook HEAD:${doc}: ${git_failure_detail('reading the closing notebook blob', blob)}` }
	if (!valid_closing_blob(blob.out, context.key)) return closing_marker_error(context, doc)
	if (context.has_remote) {
		const remote = git(context.worktree, ['rev-parse', '--verify', `refs/remotes/origin/${context.key}`])
		if (!remote.ok || remote.out !== head.out) {
			return { error: `delivery requires origin/${context.key} to equal the current stream HEAD` }
		}
	}
	return { doc, head: head.out }
}

// ---------- agf finish ----------

const finish_main = (argv, cwd, log, _ask, width = 80) => {
	const args = parse_finish_args(argv)
	if (args.help) { log(render_usage(width)); return 1 }
	if (args.error) { log(`${args.error}\n\n${render_usage(width)}`); return 1 }
	const context = finish_context(cwd, args.key)
	if (context.error) { log(context.error); return 1 }

	if (args.phase === 'prep') {
		if (context.has_remote) {
			const pushed = git(context.worktree, ['push', 'origin', `HEAD:${context.key}`])
			if (!pushed.ok) {
				log(pushed.timed_out
					? `stream push timed out after ${git_timeout_ms()}ms; the remote stream result is unknown and preparation stopped before default-branch integration`
					: 'stream push failed; preparation stopped before default-branch integration')
				return 1
			}
			log(`pushed stream branch ${context.key} to origin`)
			const fetched = git(context.worktree, ['fetch', 'origin'])
			if (!fetched.ok) {
				log(fetched.timed_out
					? `stream branch ${context.key} was pushed, but origin fetch timed out after ${git_timeout_ms()}ms and its local result is unknown`
					: `stream branch ${context.key} was pushed, but origin fetch failed; preparation stopped`)
				return 1
			}
			if (!merge_and_abort(context, `origin/${context.def}`, log)) return 1
		} else {
			log('no remote configured — the merge is local only')
			if (!merge_and_abort(context, context.def, log)) return 1
		}
		log('phase 1 complete — write the closing round and commit it, then run agf finish --deliver')
		if (context.has_remote) log(`before running agf finish --deliver, push the committed closing record to origin/${context.key}`)
		return 0
	}

	const lock = acquire_delivery_lock(context)
	if (lock.error) { log(lock.error); return 1 }

	const delivery_state = {
		remote_default: context.has_remote ? 'not_attempted' : 'not_configured',
		local_checkout: 'not_attempted',
	}
	const delivery_status = (label, state) => {
		if (state === 'completed') return `${label} completed`
		if (state === 'unknown') return `${label} result is unknown`
		if (state === 'failed') return `${label} did not complete`
		if (state === 'not_configured') return `${label} was not configured`
		return `${label} was not attempted`
	}
	let outcome = 1
	try {
		outcome = (() => {
		const record = closing_record(context)
		if (record.error) { log(record.error); return 1 }
		const expected = main_checkout_identity(context.repo)
		if (expected.error) { log(`delivery stopped — ${expected.error}`); return 1 }

		if (context.has_remote) {
			const source_error = delivery_source_error(context, record)
			if (source_error) {
				log(`delivery stopped before remote default-ref mutation — ${source_error}`)
				return 1
			}
			delivery_state.remote_default = 'unknown'
			const pushed = git(context.worktree, ['push', 'origin', `${record.head}:${context.def}`])
			if (!pushed.ok) {
				delivery_state.remote_default = pushed.timed_out ? 'unknown' : 'failed'
				log(pushed.timed_out
					? `delivery push timed out after ${git_timeout_ms()}ms; the remote default-branch result is unknown and local delivery was not attempted`
					: 'delivery push failed; origin rejected the update. The stream branch is unchanged. If the default branch moved, run agf finish --prep again; if direct pushes are blocked, open a pull request from the stream branch.')
				return 1
			}
			delivery_state.remote_default = 'completed'
			log(`pushed validated stream commit ${record.head} to origin/${context.def}`)
			const fetched = git(context.repo, ['fetch', 'origin'])
			if (!fetched.ok) {
				log(fetched.timed_out
					? `remote default branch was updated, but origin fetch timed out after ${git_timeout_ms()}ms and the main-checkout delivery result is unknown`
					: 'remote default branch was updated but the main checkout was not — origin fetch failed')
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			const collision = local_delivery_collision(context, record.head, expected.tip)
			if (collision && collision.error) {
				log(`remote default branch was updated but the main checkout was not — ${collision.error}`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			if (collision) {
				log(`remote default branch was updated but the main checkout was not — local delivery would replace an untracked or ignored entry at "${sanitize_diagnostic(collision.path)}"`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			const before_merge = main_checkout_identity(context.repo)
			if (before_merge.error || before_merge.branch !== expected.branch || before_merge.tip !== expected.tip) {
				log(`remote default branch was updated but the main checkout was not — the checkout changed during delivery (expected "${expected.branch}" at ${expected.tip}, found "${before_merge.branch || 'unknown'}" at ${before_merge.tip || 'unknown'})`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			if (before_merge.branch !== context.def) {
				log(`remote default branch was updated but the main checkout was not — it is on "${before_merge.branch}", not "${context.def}"`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			const local_source_error = delivery_source_error(context, record)
			if (local_source_error) {
				log(`remote default branch was updated but the main checkout was not — delivery stopped before local default-ref mutation: ${local_source_error}`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			delivery_state.local_checkout = 'unknown'
			const merged = git(context.repo, ['merge', '--ff-only', record.head])
			if (!merged.ok) {
				delivery_state.local_checkout = merged.timed_out ? 'unknown' : 'failed'
				log(merged.timed_out
					? `remote default branch was updated, but local fast-forward delivery timed out after ${git_timeout_ms()}ms and its result is unknown`
					: `remote default branch was updated but the main checkout was not — fast-forward delivery failed: ${sanitize_diagnostic(merged.out)}`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			delivery_state.local_checkout = 'completed'
			const after_merge = main_checkout_identity(context.repo)
			if (after_merge.error || after_merge.branch !== context.def || after_merge.tip !== record.head) {
				log(`remote default branch was updated, but post-success checkout verification failed — expected "${context.def}" at ${record.head}, found "${after_merge.branch || 'unknown'}" at ${after_merge.tip || 'unknown'}`)
				log(`recover with: ${main_recovery(context)}`)
				return 1
			}
			log(`delivered origin/${context.def} to the main checkout`)
			return { dir: context.repo }
		}

		log('no remote configured — delivery is local only')
		if (expected.branch !== context.def) {
			log(`the main checkout is on "${expected.branch}", not "${context.def}" — nothing was changed`)
			log(`recover with: ${local_main_recovery(context)}`)
			return 1
		}
		const collision = local_delivery_collision(context, record.head, expected.tip)
		if (collision && collision.error) {
			log(`local delivery stopped — ${collision.error}`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		if (collision) {
			log(`local delivery stopped — it would replace an untracked or ignored entry at "${sanitize_diagnostic(collision.path)}"`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		const before_merge = main_checkout_identity(context.repo)
		if (before_merge.error || before_merge.branch !== expected.branch || before_merge.tip !== expected.tip) {
			log(`local delivery stopped — the checkout changed during delivery (expected "${expected.branch}" at ${expected.tip}, found "${before_merge.branch || 'unknown'}" at ${before_merge.tip || 'unknown'})`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		if (before_merge.branch !== context.def) {
			log(`the main checkout is on "${before_merge.branch}", not "${context.def}" — nothing was changed`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		const source_error = delivery_source_error(context, record)
		if (source_error) {
			log(`local delivery stopped before default-ref mutation — ${source_error}`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		delivery_state.local_checkout = 'unknown'
		const merged = git(context.repo, ['merge', '--ff-only', record.head])
		if (!merged.ok) {
			log(merged.timed_out
				? `local fast-forward delivery timed out after ${git_timeout_ms()}ms; the result is unknown`
				: `local delivery failed — the main checkout was not changed: ${sanitize_diagnostic(merged.out)}`)
			delivery_state.local_checkout = merged.timed_out ? 'unknown' : 'failed'
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		delivery_state.local_checkout = 'completed'
		const after_merge = main_checkout_identity(context.repo)
		if (after_merge.error || after_merge.branch !== context.def || after_merge.tip !== record.head) {
			log(`local delivery completed, but post-success checkout verification failed — expected "${context.def}" at ${record.head}, found "${after_merge.branch || 'unknown'}" at ${after_merge.tip || 'unknown'}`)
			log(`recover with: ${local_main_recovery(context, record.head)}`)
			return 1
		}
		log(`delivered ${context.key} to the local main checkout`)
		return { dir: context.repo }
		})()
	} finally {
		const release_error = release_delivery_lock(lock)
		if (release_error) {
			const remote_note = context.has_remote
				? delivery_status('remote default-ref delivery', delivery_state.remote_default)
				: 'remote default-ref delivery was not configured'
			const local_note = delivery_status('local main-checkout delivery', delivery_state.local_checkout)
			log(`delivery lock could not be released at ${lock.path}: ${release_error}; Git delivery status: ${remote_note}; ${local_note}; lifecycle cleanup did not complete`)
			outcome = 1
		}
	}
	return outcome
}

// ---------- agf new ----------

const new_main = (argv, cwd, log, ask, width = 80) => {
	const args = parse_new_args(argv)
	if (args.error) { log(`${args.error}\n\n${render_usage(width)}`); return 1 }
	if (args.help || !args.name) { log(render_usage(width)); return 1 }

	const root = git(cwd, ['rev-parse', '--show-toplevel'])
	if (!root.ok) { log('not a git repository — run agf inside your project'); return 1 }
	const repo = root.out

	// A worktree's .git is a file; only the main checkout may add worktrees and own the configured main notebook.
	if (!fs.statSync(path.join(repo, '.git')).isDirectory()) {
		log('this is a worktree, not the main checkout — run agf from the main project folder')
		return 1
	}

	const taskkey = next_key(resolve_key(args), known_keys(repo))
	const wt_rel = path.join('.worktrees', taskkey)
	const wt = path.join(repo, wt_rel)
	let feature_root = 'features'
	let root_notebook = 'devlog.md'

	if (!git(repo, ['check-ignore', '-q', '--no-index', '.worktrees/agentflow-ignore-probe']).ok) {
		log('warning: `.worktrees/` is not in .gitignore — add it, or the new folder shows up as untracked')
	}

	let root_config
	let active_host
	try {
		active_host = active_host_for_cli(repo)
		const configured = ag_settings.ensure_configuration({ repo_root: repo, active_host })
		root_config = configured.config
		feature_root = ag_settings.workspace_paths(root_config).features
		root_notebook = root_config.switches['target-doc'] || ag_settings.workspace_paths(root_config).notebook
	} catch (error) {
		log(`configuration blocked: ${error.message}`)
		return 1
	}

	const added = git(repo, ['worktree', 'add', wt_rel, '-b', taskkey])
	if (!added.ok) { log(`git worktree add failed:\n${added.out}`); return 1 }

	const doc_rel = path.join(feature_root, taskkey, `${taskkey}.devlog.md`)
	const config_rel = path.join(feature_root, taskkey, 'ag.json')
	const root_devlog = fs.existsSync(path.join(repo, root_notebook))
		? fs.readFileSync(path.join(repo, root_notebook), 'utf8')
		: ''
	const date = format_local_timestamp().slice(0, 10)
	const body = devlog_template({
		taskkey,
		name: args.name,
		project_line: first_line_starting(root_devlog, 'Project:') || `Project: ${path.basename(repo)}`,
		config_path: config_rel.split(path.sep).join('/'),
		feature_root: feature_root.split(path.sep).join('/'),
		root_notebook: root_notebook.split(path.sep).join('/'),
		host: active_host,
		date,
		wish: args.wish,
		config: root_config,
		repo_root: repo,
	})
	fs.mkdirSync(path.join(wt, feature_root, taskkey), { recursive: true })
	try {
		const stream_config = ag_settings.copy_for_notebook(root_config, doc_rel, { repo_root: wt, active_host })
		ag_settings.write_config_atomic(path.join(wt, config_rel), stream_config, { repo_root: wt, active_host })
	} catch (error) {
		log(`stream configuration could not be created: ${error.message}`)
		return 1
	}
	fs.writeFileSync(path.join(wt, doc_rel), body)

	for (const step of [['add', doc_rel, config_rel], ['commit', '-m', `devlog: open stream ${taskkey} (agf)`]]) {
		const r = git(wt, step)
		if (!r.ok) { log(`git ${step[0]} failed:\n${r.out}`); return 1 }
	}

	const has_remote = git(repo, ['remote']).out !== ''
	if (has_remote) {
		const pushed = git(wt, ['push', '-u', 'origin', taskkey])
		log(pushed.ok
			? `pushed branch ${taskkey} to origin`
			: pushed.timed_out
				? `stream branch push timed out after ${git_timeout_ms()}ms; remote branch state is unknown and the local branch remains available`
				: 'stream branch push failed; the local branch remains available')
	} else {
		log('no remote configured — nothing pushed')
	}

	log('')
	log(`stream: ${taskkey} open`)
	log(`branch: ${taskkey}`)
	log(`notebook: ${wt_rel}/${doc_rel}`)
	log('')
	log('open new notebook in your editor:')
	log(path.join(wt, doc_rel))
	log('')
	log('root stream pointer not written — the next `godev` in the main project folder adds it')
	log('')
	log('exit the current host, then continue in the stream:')
	log(`cd ${shell_quote(wt)} && ${active_host}`)

	const agf_open = process.env.AGF_OPEN
	if (agf_open) {
		try {
			const child = spawn(agf_open, [path.join(wt, doc_rel)], { detached: true, stdio: 'ignore' })
			child.on('error', () => {})
			child.unref()
		} catch (err) {
			log(`warning: AGF_OPEN="${agf_open}" could not open the notebook: ${err.message}`)
		}
	}

	return { dir: wt }
}

// ---------- agf clean ----------

const clean_main = (argv, cwd, log, ask, width = 80) => {
	const args = parse_clean_args(argv)
	if (args.error) { log(`${args.error}\n\n${render_usage(width)}`); return 1 }
	if (args.help) { log(render_usage(width)); return 1 }

	const top = git(cwd, ['rev-parse', '--show-toplevel'])
	if (!top.ok) { log('not a git repository — run agf inside your project'); return 1 }

	// --git-common-dir is the MAIN checkout's .git, from a worktree as well as from the main folder.
	const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!common.ok) { log(`cannot locate the main checkout:\n${common.out}`); return 1 }
	const repo = path.dirname(common.out)

	const key = args.key || key_from_path(cwd)
	if (!key) { log('no feature name given, and you are not standing in a .worktrees/<name> folder\n\n' + render_usage(width)); return 1 }

	// Guard 1 — the main checkout must sit on the default branch.
	const origin_head = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
	const known = known_keys(repo)
	const fallback = ['main', 'master'].find((b) => known.includes(b)) || ''
	const def = (origin_head.ok ? default_from_origin_head(origin_head.out.replace('refs/remotes/', '')) : '') || fallback
	if (!def) { log('cannot tell which branch is the main line of work — switch to it and try again'); return 1 }

	const on = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
	if (!on.ok || on.out !== def) {
		log(`the main project folder is on branch "${on.out}", not "${def}" — nothing was changed`)
		log(`get there with:  cd ${shell_quote(repo)} && git switch ${shell_quote(def)}`)
		return 1
	}

	// Guard 2 — the name must point at exactly one stream.
	if (!known.includes(key)) {
		const near = near_keys(key, known)
		log(`no feature called "${key}" — nothing was changed`)
		log(near.length ? `did you mean: ${near.join(', ')}` : `known names: ${[...new Set(known)].sort().join(', ') || '(none)'}`)
		return 1
	}

	const wt_rel = path.join('.worktrees', key)
	const wt = path.join(repo, wt_rel)

	// Guard 3 — never remove the folder still used by the running host. A shell
	// function can cd after this child exits, but an AI host runs its Stop hook
	// first; deleting cwd prevents the operating system from starting that hook. — I-058.
	if (path.resolve(top.out) === path.resolve(wt)) {
		log(`${wt_rel} is still using this running host as its current folder — nothing was changed`)
		log(`exit this session, then clean up from the main project folder with:  cd ${shell_quote(repo)} && agf cleanup ${shell_quote(key)}`)
		return 1
	}

	// Guard 4 — an unsaved worktree is never swept.
	if (fs.existsSync(wt)) {
		const dirty = git(wt, ['status', '--porcelain'])
		if (dirty.ok && dirty.out !== '') {
			log(`${wt_rel} still has unsaved changes — nothing was changed`)
			log(dirty.out.split('\n').map((l) => `  ${l}`).join('\n'))
			log('save them (or throw them away) in that folder first, then run agf cleanup again')
			return 1
		}
	}

	const has_remote = git(repo, ['remote']).out !== ''

	// Step 1 — level the default branch with the server.
	if (has_remote) {
		const fetched = git(repo, ['fetch', 'origin'])
		if (!fetched.ok) {
			log(fetched.timed_out
				? `main checkout fetch timed out after ${git_timeout_ms()}ms; cleanup stopped before merging or sweeping and the result is unknown`
				: 'main checkout fetch failed; cleanup stopped before merging or sweeping')
			return 1
		}
		const ff = git(repo, ['merge', '--ff-only', `origin/${def}`])
		if (!ff.ok && !/Already up to date|up to date/i.test(ff.out)) {
			log(ff.timed_out
				? `bringing the main folder level with origin timed out after ${git_timeout_ms()}ms; the local result is unknown and cleanup stopped before sweeping`
				: `your main folder could not be brought level with the server — nothing was swept: ${sanitize_diagnostic(ff.out)}`)
			return 1
		}
	}

	// Step 2 — merge the stream in.
	const has_local = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${key}`]).ok
	const source = has_local ? key : `origin/${key}`
	const merged = git(repo, ['merge', '--no-ff', source, '-m', `merge: ${key} — feature closed (agf cleanup)`])
	if (!merged.ok) {
		const aborted = git(repo, ['merge', '--abort'])
		const abort_note = aborted.ok
			? 'the merge was undone and nothing was deleted'
			: aborted.timed_out
				? `merge abort timed out after ${git_timeout_ms()}ms; merge state is unknown and nothing was swept`
				: `merge abort failed: ${sanitize_diagnostic(aborted.out)}; nothing was swept`
		const merge_note = merged.timed_out
			? `merging "${key}" timed out after ${git_timeout_ms()}ms; the merge result is unknown`
			: `merging "${key}" hit a conflict`
		log(`${merge_note} — ${abort_note}: ${sanitize_diagnostic(merged.out)}`)
		log(`open ${repo} and merge it by hand, or type godev there and ask for cleanup: ${key}`)
		return 1
	}
	log(/Already up to date/i.test(merged.out) ? `"${key}" was already merged — only the sweeping-up runs` : `merged "${key}" into ${def}`)

	// Step 3 — push the merge.
	if (has_remote) {
		const pushed = git(repo, ['push'])
		if (!pushed.ok) {
			log(pushed.timed_out
				? `default-branch push timed out after ${git_timeout_ms()}ms; the remote result is unknown and cleanup stopped before sweeping`
				: 'default-branch push failed; the local merge remains, and cleanup stopped before sweeping')
			return 1
		}
		log(`pushed ${def} to origin`)
	} else {
		log('no remote configured — nothing pushed')
	}

	// Step 4 — sweep, each step refusing rather than destroying.
	if (fs.existsSync(wt)) {
		const removed = git(repo, ['worktree', 'remove', wt_rel])
		log(removed.ok
			? `removed folder ${wt_rel}`
			: removed.timed_out
				? `removing folder ${wt_rel} timed out after ${git_timeout_ms()}ms; folder state is unknown`
				: `folder ${wt_rel} kept — git refused to remove it: ${sanitize_diagnostic(removed.out)}`)
	}
	// Remote first: while origin/<key> still exists, `git branch -d` compares the branch against
	// THAT ref and refuses a branch already merged into HEAD but never pushed to its own upstream —
	// exactly what merge_back leaves behind. With the upstream gone, -d falls back to the HEAD check,
	// which is the safety we actually want and which still refuses genuinely unmerged work.
	if (has_remote && git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${key}`]).ok) {
		const del = git(repo, ['push', 'origin', '--delete', key])
		log(del.ok
			? `deleted branch ${key} on origin`
			: del.timed_out
				? `deleting branch ${key} on origin timed out after ${git_timeout_ms()}ms; remote state is unknown`
				: `branch ${key} on origin kept — remote deletion failed`)
	}
	if (has_local) {
		const del = git(repo, ['branch', '-d', key])
		log(del.ok
			? `deleted branch ${key}`
			: del.timed_out
				? `deleting branch ${key} timed out after ${git_timeout_ms()}ms; local branch state is unknown`
				: `branch ${key} kept — git refused to delete it: ${sanitize_diagnostic(del.out)}`)
	}

	// Step 5 — the one thing a shell cannot do.
	const doc = stream_doc(repo, key)
	if (doc) log(`the feature notebook stays as the record: ${doc}`)
	log(`main notebook ${main_notebook(repo)} was NOT written — type godev in ${path.basename(repo)} and the next round records this close-out`)
	return { dir: repo }
}

// ---------- agf ditch ----------

// Blocking one-line prompt on stderr (stdout is reserved for the cd path).
// Returns the raw answer, or null on EOF / a closed stdin — which is_yes treats as no.
const ask_tty = (question) => {
	write_all_sync(process.stderr.fd, question)
	try {
		const buf = Buffer.alloc(1024)
		const n = fs.readSync(0, buf, 0, 1024)
		return n === 0 ? null : buf.slice(0, n).toString('utf8')
	} catch { return null }
}

const ditch_main = (argv, cwd, log, ask = ask_tty, width = 80) => {
	const args = parse_clean_args(argv)
	if (args.error) { log(`${args.error}\n\n${render_usage(width)}`); return 1 }
	if (args.help) { log(render_usage(width)); return 1 }

	const top = git(cwd, ['rev-parse', '--show-toplevel'])
	if (!top.ok) { log('not a git repository — run agf inside your project'); return 1 }
	const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!common.ok) { log(`cannot locate the main checkout:\n${common.out}`); return 1 }
	const repo = path.dirname(common.out)

	// Never inferred from the folder — for a delete, you type exactly what goes.
	const key = args.key
	if (!key) { log('ditch needs the feature name written out — you type what you delete\n\n' + render_usage(width)); return 1 }

	const known = known_keys(repo)
	if (!known.includes(key)) {
		const near = near_keys(key, known)
		log(`no feature called "${key}" — nothing was changed`)
		log(near.length ? `did you mean: ${near.join(', ')}` : `known names: ${[...new Set(known)].sort().join(', ') || '(none)'}`)
		return 1
	}

	// The default branch and the branch under the main checkout's feet are never ditched.
	const origin_head = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
	const def = (origin_head.ok ? default_from_origin_head(origin_head.out.replace('refs/remotes/', '')) : '')
		|| ['main', 'master'].find((b) => known.includes(b)) || ''
	if (key === def) { log(`"${key}" is the main line of work, not a feature — nothing was changed`); return 1 }
	const on = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
	if (on.ok && on.out === key) { log(`the main project folder is standing on branch "${key}" — switch it away first; nothing was changed`); return 1 }

	const wt_rel = path.join('.worktrees', key)
	const wt = path.join(repo, wt_rel)
	const has_wt = fs.existsSync(wt)
	const has_local = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${key}`]).ok
	const has_remote_branch = git(repo, ['remote']).out !== ''
		&& git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${key}`]).ok
	if (!has_wt && !has_local && !has_remote_branch) { log(`"${key}" has no branch or folder left to delete — nothing to ditch`); return 1 }

	const doomed = [
		has_wt ? `folder ${wt_rel}, including any unsaved work inside it` : '',
		has_remote_branch ? `branch ${key} on origin` : '',
		has_local ? `local branch ${key}` : '',
	].filter(Boolean)
	log(`feature branch "${key}" will be deleted — nothing is merged first, unmerged work is lost:`)
	log(doomed.map((d) => `  - ${d}`).join('\n'))
	if (!is_yes(ask('are you sure? (Y/n) '))) { log('nothing was changed'); return 1 }

	if (has_wt) {
		const removed = git(repo, ['worktree', 'remove', '--force', wt_rel])
		log(removed.ok
			? `removed folder ${wt_rel}`
			: removed.timed_out
				? `removing folder ${wt_rel} timed out after ${git_timeout_ms()}ms; folder state is unknown`
				: `folder ${wt_rel} kept — git refused to remove it: ${sanitize_diagnostic(removed.out)}`)
	}
	if (has_remote_branch) {
		const del = git(repo, ['push', 'origin', '--delete', key])
		log(del.ok
			? `deleted branch ${key} on origin`
			: del.timed_out
				? `deleting branch ${key} on origin timed out after ${git_timeout_ms()}ms; remote state is unknown`
				: `branch ${key} on origin kept — remote deletion failed`)
	}
	if (has_local) {
		const del = git(repo, ['branch', '-D', key])
		log(del.ok
			? `deleted branch ${key}`
			: del.timed_out
				? `deleting branch ${key} timed out after ${git_timeout_ms()}ms; local branch state is unknown`
				: `branch ${key} kept — git refused to delete it: ${sanitize_diagnostic(del.out)}`)
	}

	const doc = stream_doc(repo, key)
	if (doc) log(`the notebook ${doc} is already on ${def || 'the main line'} and stays — remove it by hand if you want it gone`)
	log(`main notebook ${main_notebook(repo)} was NOT written — type godev in ${path.basename(repo)} and the next round records this ditch`)
	return { dir: repo }
}

const uninstall_help = width => `${usage_words('usage: agf uninstall [--skills]', width).join('\n')}\n\n${usage_words('--skills also moves verified formal skill installations to recoverable sibling backup folders.', width).join('\n')}\n`

const uninstall_main = (argv, cwd, log, ask, width = 80) => {
	if (argv.some(argument => argument === '-h' || argument === '--help')) {
		log(uninstall_help(width))
		return 0
	}
	const unknown = argv.find(argument => argument !== '--skills')
	if (unknown) {
		log(`unknown uninstall option "${unknown}"\n\n${uninstall_help(width)}`)
		return 1
	}
	const top = git(cwd, ['rev-parse', '--show-toplevel'])
	if (!top.ok) {
		log('not a git repository — run agf uninstall inside your project')
		return 1
	}
	const repo = top.out
	const hook_preview = install_hook.inspect({ cwd: repo, scope: 'project' })
	return setup.uninstall_main({
		argv,
		shell: process.env.SHELL,
		home: process.env.HOME,
		skill_dir: path.resolve(__dirname, '..'),
		ask,
		say: log,
		extra_preview: hook_preview,
		after_confirm: hook_preview.length === 0 ? undefined : () => {
			try {
				install_hook.install({ cwd: repo, scope: 'project', off: true, quiet: false, say: log })
				return 0
			} catch (error) {
				log(`hook removal failed: ${error.message}`)
				return 1
			}
		},
	})
}

const setup_help = width => `${usage_words('usage: agf setup [--fix]', width).join('\n')}\n\n${usage_words('--fix previews and offers to install or update the managed agf and agf-looper shell shortcuts.', width).join('\n')}\n`

const setup_main = (argv, cwd, log, ask, width = 80) => {
	if (argv.some(argument => argument === '-h' || argument === '--help')) {
		log(setup_help(width))
		return 0
	}
	const unknown = argv.find(argument => argument !== '--fix')
	if (unknown) {
		log(`unknown setup option "${unknown}"\n\n${setup_help(width)}`)
		return 1
	}
	return setup.main({ argv, ask, say: log })
}

const hooks_help = width => `${usage_words('usage: agf hooks [--project|--global] [--host <claude|codex|all>] [--off]', width).join('\n')}\n\n${usage_words('Project scope is the default. --off removes only hooks whose Agentflow ownership can be verified.', width).join('\n')}\n`

const hooks_main = (argv, cwd, log, ask, width = 80) => {
	if (argv.some(argument => argument === '-h' || argument === '--help')) {
		log(hooks_help(width))
		return 0
	}
	if (argv.includes('--project') && argv.includes('--global')) {
		log(`hooks accepts only one scope\n\n${hooks_help(width)}`)
		return 1
	}
	const allowed = new Set(['--project', '--global', '--off'])
	let host = 'all'
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === '--host') {
			host = argv[index + 1]
			index += 1
			continue
		}
		if (!allowed.has(argv[index])) {
			log(`unknown hooks option "${argv[index]}"\n\n${hooks_help(width)}`)
			return 1
		}
	}
	if (!['all', 'claude', 'codex'].includes(host)) {
		log(`unknown --host value "${host}"\n\n${hooks_help(width)}`)
		return 1
	}
	install_hook.install({
		cwd,
		scope: argv.includes('--global') ? 'global' : 'project',
		off: argv.includes('--off'),
		hosts: host === 'all' ? ['claude', 'codex'] : [host],
		say: log,
	})
	return 0
}

const settings_help = width => `${usage_words('usage: agf settings <show|validate|change|rename> [options]', width).join('\n')}\n\n${usage_words('Use --set "key: value" with change. Use --from and --to with rename.', width).join('\n')}\n`

const settings_main = (argv, cwd, log, ask, width = 80) => {
	if (argv.length === 0 || argv.some(argument => argument === '-h' || argument === '--help')) {
		log(settings_help(width))
		return 0
	}
	try {
		return ag_settings.cli_main(argv, { cwd, output: log, error: log })
	} catch (error) {
		log(error instanceof ag_settings.SettingsError ? error.message : 'settings command failed')
		return 1
	}
}

const close_main = (argv, cwd, log, _ask, _width = 80) => {
	const args = parse_close_args(argv)
	if (args.help) { log(close_usage); return 0 }
	if (args.error) { log(`${args.error}\n\n${close_usage}`); return 1 }

	let manifest
	try {
		const input = read_close_stdin()
		const duplicate = ag_settings.duplicate_json_key(input)
		if (duplicate !== null) throw new Error(`close manifest contains duplicate JSON object key '${duplicate}'`)
		manifest = JSON.parse(input)
	} catch (error) {
		const result = close_result()
		set_close_error(result, 'invalid_manifest', error.message, 'correct the bounded UTF-8 JSON manifest and retry the same command')
		return { json: result, exitCode: 1 }
	}

	let result = close_result({ manifest })
	let validated
	try {
		const root = git(cwd, ['rev-parse', '--show-toplevel'])
		const repo = real_path(root.ok ? root.out : cwd)
		validated = close_validate_manifest(manifest, repo)
		result = close_result({ manifest, close_id: validated.close_id })
		if (manifest.delivery.mode === 'push' && !args.push_authorized) {
			set_close_error(result, 'push_not_authorized', 'push delivery requires the separate --push-authorized command authority', 'obtain the already-authorized push decision, then retry the same manifest with --push-authorized')
			return { json: result, exitCode: 1 }
		}
		if (manifest.delivery.mode === 'local' && args.push_authorized) {
			set_close_error(result, 'push_authority_mismatch', '--push-authorized is valid only when delivery.mode is push', 'remove --push-authorized or prepare a push manifest explicitly')
			return { json: result, exitCode: 1 }
		}
		if (!root.ok) {
			if (manifest.delivery.mode !== 'local') throw new Error('push delivery requires a Git repository; use local delivery for a plain folder')
			const current = notebook_writer.read_regular_file(validated.notebook_file, 'notebook')
			const closed = notebook_writer.match_closed_close({ notebook_text: current.text, input: manifest, project_root: repo, notebook_path: manifest.notebook })
			const saved = closed || notebook_writer.close_round({ root: repo, notebook: manifest.notebook, input: manifest })
			result.ok = true
			result.phase = 'notebook_replaced'
			result.next_ask = saved.next_ask
			result.commit = { state: 'not_applicable' }
			result.delivery.state = 'local'
		} else result = close_execute({ repo, ...validated })
		const response = result.ok ? close_success_result(result) : result
		if (response.ok === true) metrics.record_host_touch({ repo_root: repo, notebook_path: manifest.notebook, ask: manifest.ask, event: 'close' })
		return { json: response, exitCode: response.ok ? 0 : 1 }
	} catch (error) {
		close_validation_failure(result, error.message)
		set_close_error(result, error.code || 'invalid_manifest', error.message, 'correct the manifest or repository state, then retry the same command')
		return { json: result, exitCode: 1 }
	}
}

// ---------- dispatch ----------

const COMMANDS = { skills: (...args) => require('./skills-audit.js').main(...args), start: start_main, close: close_main, init: init_main, new: new_main, finish: finish_main, cleanup: clean_main, clean: clean_main, merge: clean_main, ditch: ditch_main, uninstall: uninstall_main, setup: setup_main, hooks: hooks_main, settings: settings_main }

const main = (argv, cwd, log, ask, width = 80) => {
	const cmd = COMMANDS[argv[0]]
	if (!cmd) {
		if (argv[0] && argv[0] !== '-h' && argv[0] !== '--help') log(`unknown subcommand "${argv[0]}"\n`)
		log(render_usage(width))
		return 1
	}
	return cmd(argv.slice(1), cwd, log, ask, width)
}

module.exports = {
	kebab_case, is_key, next_key, parse_new_args, parse_clean_args, parse_finish_args, resolve_key,
	parse_start_args, parse_close_args, render_usage, devlog_template, key_from_path, default_from_origin_head,
	is_yes, near_keys, stream_doc, host_from_root_status, active_host_for_cli, sanitize_diagnostic, git_timeout_ms, delivery_lock_path, write_all_sync, update_ignore_file, init_main, start_main, close_main, new_main, finish_main, clean_main, ditch_main, uninstall_main, setup_main, hooks_main, settings_main, main,
}

if (require.main === module) {
	try {
		const usage_width = process.stderr.isTTY && Number.isFinite(process.stderr.columns) && process.stderr.columns > 0
			? process.stderr.columns
			: 80
		const r = main(process.argv.slice(2), process.cwd(), (m) => write_all_sync(process.stderr.fd, `${m}\n`), undefined, usage_width)
		if (typeof r === 'number') process.exit(r)
		if (r.json !== undefined) write_all_sync(process.stdout.fd, `${JSON.stringify(r.json, null, 2)}\n`)
		else write_all_sync(process.stdout.fd, `${r.dir}\n`)
		if (r.exitCode !== undefined) process.exitCode = r.exitCode
	} catch (err) {
		write_all_sync(process.stderr.fd, `${err.message}\n`)
		process.exit(1)
	}
}
