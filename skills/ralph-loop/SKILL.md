---
name: ralph-loop
description: Start Ralph Loop in current session
commands:
  - name: ralph-loop
    description: Start Ralph Loop - autonomous agent that executes tasks from PRD.md one by one
  - name: cancel-ralph
    description: Cancel active Ralph Loop
  - name: help
    description: Explain Ralph Loop plugin and available commands
---

# Ralph Loop - Autonomous Task Execution Agent

Execute tasks from PRD.md one at a time, tracking progress and learning from each iteration.

---

## Quick Start

1. Create a `PRD.md` with user stories (use `/prd-builder` skill)
2. Run `/ralph-loop` to start autonomous execution
3. Ralph will execute tasks until all are complete

---

## How Ralph Works

Ralph is an autonomous coding agent that:
1. Reads `PRD.md` to find the first unchecked task `[ ]`
2. Reviews `progress.txt` for learnings from previous iterations
3. Implements ONE task only
4. Validates via tests or type checks
5. On success: marks `[x]`, commits, logs learnings
6. On failure: logs details, does NOT commit
7. Repeats until all tasks are `[x]`

---

## Execution Rules

### You are Ralph. Execute ONE task per cycle.

### Execution Plan

1. **Inspect PRD.md** - Find the first unchecked task `[ ]`
2. **Read progress.txt** - Prioritize the Learnings section for prior context
3. **Implement that single task** - Nothing more
4. **Run tests or type checks** - Validate the change

### On Success

- Mark the task complete in PRD.md: `[x]`
- Commit with message: `feat: [task description]`
- Append successful approaches to progress.txt

### On Failure

- Do NOT mark completion
- Do NOT commit
- Record failure details in progress.txt for reuse later

---

## Progress Entry Template

Add to `progress.txt` after each iteration:

```markdown
## Iteration [N] — [Task Name]
- What was done
- Files affected
- Learnings for next cycles:
  - Patterns discovered
  - Traps to avoid
  - Helpful context
---
```

---

## AGENTS.md Guidance (Optional)

When reusable conventions are discovered:
- Verify AGENTS.md exists at the repository root
- Add durable guidance only (no task-specific notes)

---

## Completion Signal

After task execution:
- If ALL PRD.md tasks are completed `[x]`, output exactly: `<promise>COMPLETE</promise>`
- Otherwise, produce no final message

---

## Commands

### `/ralph-loop`
Start the autonomous loop. Ralph will:
- Check for PRD.md (required)
- Create progress.txt if missing
- Execute tasks one by one
- Continue until all tasks are `[x]`

### `/cancel-ralph`
Stop the current Ralph Loop gracefully.

### `/help`
Show this documentation.

---

## Required Files

### PRD.md (Required)
Contains user stories with checkboxes:
```markdown
### US-001: Add user authentication
**Description:** As a user, I want to log in securely.

**Acceptance Criteria:**
- [ ] Create login endpoint
- [ ] Add password hashing
- [ ] Typecheck passes
```

### progress.txt (Auto-created)
Tracks iteration history and learnings:
```markdown
# Progress Log

## Learnings
(Notes discovered during implementation)
```

---

## Best Practices

1. **Keep stories small** - Each should fit in one AI context window
2. **Order by dependency** - Schema before backend, backend before UI
3. **Be specific** - "Add status column with default 'pending'" not "Handle status"
4. **Always include** - "Typecheck passes" in acceptance criteria
5. **For UI stories** - Include "Verify changes work in browser"

---

## Integration

Works with:
- **PRD Builder** (`/prd-builder`) - Create properly structured PRD.md
- **Git** - Auto-commits successful changes
- **Type checking** - Validates before marking complete

---

## Troubleshooting

### Ralph keeps failing on same task
- Check progress.txt for error patterns
- Break the task into smaller pieces
- Add more specific acceptance criteria

### Ralph skipped a task
- Ensure checkbox is `[ ]` not `[x]`
- Check task is not commented out

### Ralph won't start
- Verify PRD.md exists in current directory
- Ensure at least one task has `[ ]`
