# Changelog

Notable Agentflow changes, with the newest version first. Release metadata uses major.minor.patch; v8.2 is version 8.2.0. Earlier dates identify recorded source milestones, not independently verified public publication dates.

## [Unreleased]

### Added

- Optional ccxray telemetry attribution and per-stage cost and token enrichment for external Claude, Codex, and Grok workers.

- Audit-grade ccxray cost reporting: `ccxray-summary --attempt` and `--cumulative` write immutable receipts under `.agentflow/evidence/ccxray/` (gitignored by default) and print the paste-ready devlog attempt line and cumulative block with `cost components` and `gaps` bullets; amounts are exact decimal sums of ccxray charge buckets, marked `~` for default rates and `+` for lower bounds. ccxray responses are validated against a consumer trust model (invariants I1–I13) and projected field by field; any failed or inconsistent query is reported as unknown, never as zero.

## [8.2.0] — 2026-09-13

### Added

- Ordinary notebook work in folders without Git, including local completion. Git remains necessary for commits, branches, and feature worktrees; Agentflow does not initialize it automatically.

- An on-demand `agf skills audit` command to inventory discoverable skills and prepare a read-only conflict assessment.

- Optional completion-record cleanup through `completion-cleanup` and `completion-cleanup-interval-days`. Cleanup is off by default and uses Trash for eligible completed, inactive records older than 30 days.

- `show-diff` output with a reason for each logical change and unified diff hunks that mark removed and added lines.

- This changelog in the public release, with plugin metadata derived from the skill’s release version.

### Changed

- Rewrote the English and Taiwan Traditional Chinese guides around everyday tasks, retaining the YouTube introduction and placing advanced details in expandable sections.

- Refreshed public READMEs with installation maintenance, weekly crontab guidance, direct-agent help, and the maintainer’s `gpt-5.6-sol/low` recommendation for Codex coordination. Update examples use the Skills CLI’s installed-name syntax: `npx skills update agentflow`.

- Kept completion metadata in local supporting records, so new notebook Replies no longer contain generated evidence links or hashes.

- Used the active Codex transcript turn for new Reply model/effort attribution. Added the Ask identifier to new RUN and WIP headings while preserving old records.

- Refined direct execution and delegation guidance around the benefit of a handoff, retained necessary checks, and consolidated task artifact locations and writing rules.

### Fixed

- Closeout failures caused by archives exceeding the former 1 MiB read limit. Corrected retries now inspect archives in chunks; unchanged verified retries reuse their evidence.

- Recovery of filled question answers and preservation of configured asker names. Handled answers are not replayed, and empty fields do not count as approval.

- Duplicate capture when a prompt hook receives a manually recorded submission, while preserving separate later submissions.

- Recognition of explicit review waivers and comma-separated fast-lane controls during completion and hook checks.

- Requirements-refresh guidance that must preserve question history even outside an advisor-only workflow.

### Notes

- Agentflow’s release number changes to 8.2.0; the `ag.json` configuration format remains schema version 7.

- Current host and worker support centers on Codex and Claude; broader compatibility remains proposed work.

## [8.0.1] — 2026-09-09

### Changed

- Introduced explicit release-version metadata in `SKILL.md`, with a matching visible heading and a single authoritative version source.

- Reduced completion friction: presentation-only issues are advisory, and routine informational or cosmetic changes can complete after host inspection without unnecessary external review.

- Kept task scope, truthful evidence, and explicit owner review waivers central to closeout; fast-lane retains host self-review and necessary checks.

### History

- This is the earliest explicit semantic release version found in the retained skill source history. Earlier development is not assigned invented release numbers or dates here.
