---
name: prd-builder
description: Create structured PRD.md files for Ralph Loop execution. Use when starting a new feature, planning implementation, or preparing tasks for autonomous AI delivery.
commands:
  - name: prd
    description: Create a PRD.md with user stories for Ralph Loop
---

# PRD Builder

Produce clear, execution-ready Product Requirements Documents (PRDs) designed for autonomous AI delivery using the Ralph workflow.

---

## Overview

1. Collect a feature brief from the user
2. Ask 3–5 high-impact clarification questions (lettered choices)
3. Draft a well-structured PRD based on responses
4. Save the output as `PRD.md`
5. Initialize an empty `progress.txt` file

**Important:** Do not implement anything. Your responsibility ends at documentation.

---

## Step 1: Clarification Phase

Only ask questions that are essential when details are unclear. Concentrate on:

- **Objective:** What outcome are we targeting?
- **Key Capabilities:** What must the feature do?
- **Boundaries:** What is explicitly out of scope?
- **Completion Signals:** How do we confirm success?

### Question Format

```
1. What is the main objective of this feature?
   A. Improve onboarding
   B. Increase engagement
   C. Reduce support requests
   D. Other: [describe]

2. Who is this for?
   A. New users
   B. Existing users
   C. All users
   D. Admins only

3. What level of scope is desired?
   A. MVP only
   B. Fully featured
   C. Backend/API only
   D. UI only
```

Users should be able to reply concisely (e.g., `1B, 2C, 3A`).

---

## Step 2: Story Size Rules (CRITICAL)

**Every user story must fit into a single AI context window (~10 minutes).**

Each Ralph iteration runs without memory of previous steps. Oversized stories risk incomplete or broken output.

### Appropriate story sizes:
- Add a database field and migration
- Create one UI component
- Modify a single backend action
- Add one filter or control

### Oversized stories (must be split):
| Too Broad | Break Down Into |
|-----------|-----------------|
| Build the dashboard | Schema → Queries → UI |
| Add authentication | Schema → Middleware → UI → Sessions |
| Implement drag & drop | Events → Zones → State → Persistence |
| Refactor API | One endpoint per story |

**Rule:** If you can't describe it in 2–3 sentences, it's too large.

---

## Step 3: Dependency-First Ordering

Stories must be sequenced so earlier items never rely on later ones.

**Correct sequence:**
1. Database / schema updates
2. Backend logic
3. UI elements consuming backend
4. Aggregated or summary views

**Incorrect:**
```
US-001: UI component (requires schema not yet created)
US-002: Schema update
```

---

## Step 4: Acceptance Criteria (Testable Only)

Each acceptance point must be objectively verifiable.

### Strong criteria:
- "Add `status` column with default `pending`"
- "Dropdown includes All / Active / Completed"
- "Delete action prompts confirmation"
- "Typecheck passes"
- "All tests pass"

### Weak criteria:
- "Works as expected"
- "Easy to use"
- "Good UX"
- "Handles edge cases"

### Mandatory final criterion:
```
Typecheck passes
```

### UI-related stories must also include:
```
Verify changes work in browser
```

---

## PRD Template

```markdown
# PRD: [Feature Name]

## Introduction
[High-level explanation of the feature and problem]

## Goals
- [Concrete, measurable objective 1]
- [Concrete, measurable objective 2]
- [Concrete, measurable objective 3]

## User Stories

### US-001: [Title]
**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] [Verifiable requirement]
- [ ] [Another requirement]
- [ ] Typecheck passes

### US-002: [Title]
**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] [Verifiable requirement]
- [ ] Typecheck passes
- [ ] Verify changes work in browser

## Non-Goals
- [Explicit exclusion 1]
- [Explicit exclusion 2]

## Technical Notes (Optional)
- [Constraints]
- [Existing components to reuse]
```

---

## Sample PRD

```markdown
# PRD: Task Priority System

## Introduction
Introduce task priorities so users can focus on important work first.

## Goals
- Assign priority levels to tasks
- Display priority visually
- Filter tasks by priority
- Default priority to medium

## User Stories

### US-001: Persist task priority
**Description:** As a developer, I want task priority stored so it persists.

**Acceptance Criteria:**
- [ ] Add priority column (high | medium | low, default medium)
- [ ] Migration runs successfully
- [ ] Typecheck passes

### US-002: Show priority badge
**Description:** As a user, I want to see priority at a glance.

**Acceptance Criteria:**
- [ ] Colored badge displayed on task card
- [ ] Visible without interaction
- [ ] Typecheck passes
- [ ] Verify changes work in browser

### US-003: Filter by priority
**Description:** As a user, I want to filter tasks by priority level.

**Acceptance Criteria:**
- [ ] Dropdown with All / High / Medium / Low options
- [ ] Filtering updates task list immediately
- [ ] Typecheck passes
- [ ] Verify changes work in browser

## Non-Goals
- Priority notifications
- Priority-based sorting (separate feature)
- Custom priority levels
```

---

## Output Requirements

### PRD.md
Save the PRD with all user stories.

### progress.txt
Also create `progress.txt`:
```markdown
# Progress Log

## Learnings
(Notes discovered during implementation)
```

---

## Final Checklist

Before completing:
- [ ] Clarifying questions asked with lettered options
- [ ] User answers incorporated
- [ ] Stories use US-### format
- [ ] Each story fits one iteration (~10 min)
- [ ] Stories ordered by dependency
- [ ] Acceptance criteria are testable
- [ ] "Typecheck passes" included everywhere
- [ ] UI stories include browser verification
- [ ] Non-goals clearly defined
- [ ] PRD.md saved
- [ ] progress.txt created

---

## Integration with Ralph Loop

After creating the PRD:
1. Run `/ralph-loop` to start autonomous execution
2. Ralph reads PRD.md, executes tasks one by one
3. Progress tracked in progress.txt
4. Each completed task marked `[x]` and committed
