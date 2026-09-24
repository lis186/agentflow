'use strict'

const live_charge = ({
  model = 'm',
  billing_provider = 'p',
  component = 'input',
  quantity = '1000000',
  usd_per_unit = '0.1',
  usd = '0.1',
  basis = 'recorded',
  price_key = 'm-input',
  rate_source = 'ccxray',
} = {}) => ({
  model,
  billing_provider,
  component,
  unit: 'tokens',
  quantity,
  usd_per_unit,
  usd,
  basis,
  price_key,
  rate_source,
})

const live_sub_summary = ({
  calls = 1,
  cost_usd = 0.1,
  charges = calls === 0 ? [] : [live_charge({ usd: String(cost_usd), usd_per_unit: String(cost_usd) })],
  sessions,
  ...overrides
} = {}) => ({
  calls,
  cost_usd,
  cost_confidence: { priced: calls, unknown: 0, fallback: 0, no_usage: 0 },
  uncomputable_requests: 0,
  tokens: calls === 0
    ? { input: 0, output: 0, cache_read: 0, cache_create: 0, reasoning: 0, total: 0 }
    : { input: 100, output: 20, cache_read: 0, cache_create: 0, reasoning: 0, total: 120 },
  cache_hit_rate: 0,
  charges,
  last_ingested_at: calls === 0 ? null : '2026-09-20T10:00:00.000Z',
  pending_requests: 0,
  ...(sessions === undefined ? {} : { sessions }),
  ...overrides,
})

const fixture_session = (value, calls) => {
  const add_calls = session => calls === undefined ? session : { ...session, calls }
  if (value && typeof value === 'object' && !Array.isArray(value)) return {
    session: String(value.session),
    from: Number(value.from),
    to: value.to === undefined ? null : value.to === null ? null : Number(value.to),
    ...(calls === undefined ? {} : { calls }),
  }
  const text = String(value)
  const at = text.lastIndexOf('@')
  const dash = text.indexOf('-', at + 1)
  return add_calls({
    session: text.slice(0, at),
    from: Number(text.slice(at + 1, dash)),
    to: text.slice(dash + 1) === '' ? null : Number(text.slice(dash + 1)),
  })
}

const live_summary_fixture = ({
  request,
  task = 'A-012',
  role = null,
  project = 'p',
  calls = 1,
  cost_usd = 0.1,
  by_role,
  coordinator,
  charges = calls === 0 ? [] : [live_charge({ usd: String(cost_usd), usd_per_unit: String(cost_usd) })],
  last_ingested_at = calls === 0 ? null : '2026-09-20T10:00:00.000Z',
  first_ts = calls === 0 ? null : 100,
  last_ts = calls === 0 ? null : 200,
  window,
  from,
  to,
  coverage = { entries_in_memory: 1, max_entries: 5000 },
  models = calls === 0 ? [] : ['m'],
  agents = calls === 0 ? [] : ['codex'],
  sessions = calls === 0 ? 0 : 1,
  tokens = calls === 0
    ? { input: 0, output: 0, cache_read: 0, cache_create: 0, reasoning: 0, total: 0 }
    : { input: 100, output: 20, cache_read: 0, cache_create: 0, reasoning: 0, total: 120 },
  cache_hit_rate = 0,
  tools = {},
  tool_failures = 0,
  skills = {},
  uncomputable_requests = 0,
  pending_requests = 0,
  session_calls = calls,
  ...overrides
} = {}) => {
  const request_values = request && typeof request === 'object' ? request : {}
  const request_role = typeof request_values.role === 'string' && request_values.role.trim() !== '' ? request_values.role : null
  const requested_sessions = Array.isArray(request_values.session_specs)
    ? request_values.session_specs
    : Array.isArray(request_values.sessions)
      ? request_values.sessions
      : request_values.session === undefined ? [] : [request_values.session]
  const session_entries = requested_sessions.map(value => fixture_session(value, session_calls))
  const selected_role = role || request_role || (session_entries.length > 0 ? 'coordinator' : 'review')
  const request_from = request_values.from === undefined ? request_values.from_ms : request_values.from
  const request_to = request_values.to === undefined ? request_values.to_ms : request_values.to
  const has_request_window = (request_from !== undefined && request_from !== null) || (request_to !== undefined && request_to !== null) || (from !== undefined && from !== null) || (to !== undefined && to !== null)
  const response_window = has_request_window
    ? { from: request_from === undefined || request_from === null ? from === undefined || from === null ? null : Number(from) : Number(request_from), to: request_to === undefined || request_to === null ? to === undefined || to === null ? null : Number(to) : Number(request_to) }
    : window === undefined ? null : window
  const selected_summary = live_sub_summary({ calls, cost_usd, charges, uncomputable_requests, pending_requests })
  const requested_task = Object.hasOwn(request_values, 'task') ? request_values.task : undefined
  const requested_project = Object.hasOwn(request_values, 'project') ? request_values.project : request === undefined ? undefined : null
  const requested_role = Object.hasOwn(request_values, 'role') ? request_role : request === undefined ? undefined : null
  const response_task = requested_task === undefined ? task : requested_task
  const response_project = requested_project === undefined ? project : requested_project
  const response_role = requested_role === undefined ? role : requested_role
  const roles = by_role === undefined
    ? (calls === 0 ? {} : { [selected_role]: selected_summary })
    : by_role
  const body = {
    task: response_task,
    role: response_role,
    project: response_project,
    calls,
    cost_usd,
    cost_confidence: { priced: calls, unknown: 0, fallback: 0, no_usage: 0 },
    uncomputable_requests,
    tokens,
    cache_hit_rate,
    tools,
    tool_failures,
    skills,
    by_role: roles,
    models,
    agents,
    sessions,
    first_ts,
    last_ts,
    charges,
    last_ingested_at,
    pending_requests,
    window: response_window,
    coverage,
  }
  if (session_entries.length > 0) {
    body.coordinator = coordinator === true || coordinator === undefined || coordinator === false || Array.isArray(coordinator)
      ? {
        calls,
        cost_usd,
        cost_confidence: { priced: calls, unknown: 0, fallback: 0, no_usage: 0 },
        uncomputable_requests: 0,
        sessions: session_entries,
        charges,
        last_ingested_at,
        pending_requests,
      }
      : {
        calls,
        cost_usd,
        cost_confidence: { priced: calls, unknown: 0, fallback: 0, no_usage: 0 },
        uncomputable_requests: 0,
        sessions: [],
        charges,
        last_ingested_at,
        pending_requests,
        ...coordinator,
      }
  }
  const result = { ...body, ...overrides }
  if (request !== undefined) {
    result.task = response_task
    result.project = response_project
    result.role = response_role
    result.window = response_window
    result.by_role = roles
    if (session_entries.length > 0) result.coordinator = { ...result.coordinator, sessions: session_entries }
  }
  return result
}

const live_mixed_summary_fixture = ({
  request = { task: 'A-001', project: 'p', role: null, session_specs: ['host@100-200'] },
  worker_role = 'review',
  worker_calls = 1,
  coordinator_calls = 1,
  worker_cost_usd = 0.1,
  coordinator_cost_usd = 0.2,
} = {}) => {
  const worker = live_sub_summary({ calls: worker_calls, cost_usd: worker_cost_usd })
  const coordinator = live_sub_summary({ calls: coordinator_calls, cost_usd: coordinator_cost_usd })
  const request_values = request && typeof request === 'object' ? request : {}
  const sessions = Array.isArray(request_values.session_specs) ? request_values.session_specs : ['host@100-200']
  const wrapper_calls = worker_calls + coordinator_calls
  const wrapper_cost_usd = Number((worker_cost_usd + coordinator_cost_usd).toFixed(12))
  return live_summary_fixture({
    request,
    task: request_values.task || 'A-001',
    project: request_values.project || 'p',
    role: null,
    calls: wrapper_calls,
    cost_usd: wrapper_cost_usd,
    charges: [...worker.charges, ...coordinator.charges],
    by_role: { [worker_role]: worker, coordinator },
    coordinator: { ...coordinator, sessions: sessions.map(value => ({ ...fixture_session(value), calls: coordinator_calls })) },
    session_calls: coordinator_calls,
  })
}

const live_open_mixed_summary_fixture = ({
  request = { task: 'A-001', project: 'p', role: null, session_specs: ['host@100-'] },
  received_ms = Date.now(),
} = {}) => {
  const body = live_mixed_summary_fixture({ request })
  body.coordinator.sessions = body.coordinator.sessions.map(session => ({
    ...session,
    to: received_ms - 5,
  }))
  return body
}

module.exports = { live_charge, live_sub_summary, live_summary_fixture, live_mixed_summary_fixture, live_open_mixed_summary_fixture }
