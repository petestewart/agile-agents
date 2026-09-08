# Generate PR Description

Generate a pull request description from the PLAN.md ticket and the git changes.

## Instructions

1. **Ticket key**: `git branch --show-current`, match `^(T[0-9]{3})-`. No key → continue with just the git changes; don't prompt.

2. **Ticket details** (when a key was found): read the `### Ticket: T### <title>` block from the repo-root `PLAN.md` — Scope, Acceptance Criteria, Validation Steps, Notes. If there is also a linked GitHub issue number in Notes, fetch it with `gh issue view` when `gh` works; otherwise skip.

3. **Analyze the changes**: `git diff origin/main...HEAD --stat` and the diff itself, at a high level.

4. **Write the description** in exactly this format:

```
## Description

[High-level summary of what this PR does and why — not code-level changes or tests]

## References

[Design doc sections the ticket cites (design/agile-agents-design.md §N), spike findings, specs]

## QA

[Setup steps if dependencies or bootstrap changed]
[The ticket's Validation Steps and Acceptance Criteria as UAT steps — what to run, expected result]

## Ticket

T### <title>
[Closes #NN — only if a GitHub issue is linked]
```

Guidelines: present tense; stay at the level a reviewer cares about; no file/function lists; don't list tests added; omit References if empty; keep the QA section runnable.

5. **Title**: `T### <ticket title>`, under 70 chars where possible.

## Backticks

Write backticks literally (`` ` `` and ```` ``` ````), never escaped. When upserting to GitHub use `gh pr create|edit --body-file <tmpfile>` — never an inline `--body`. Verify the rendered PR shows no stray backslashes.
