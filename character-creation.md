---
name: character-creation
description: Interactive workflow for creating a cast of characters suited to a specific task or mission. Use when the user wants to create characters, define a cast, build character backgrounds, do collaborative worldbuilding, or design roles for a project or scenario.
disable-model-invocation: true
---

# Character Creation Workflow

This is an interactive, multi-phase workflow for creating a cast of characters suited to a specific task or mission. It covers role discovery, cast sizing, cultural cross-referencing, and detailed character background documents.

**This workflow is collaborative.** Each phase requires user input and approval before moving to the next. Do not rush through phases — Phase 1 alone may take several conversational turns. The experience should feel like collaborative worldbuilding, not a form being filled out.

---

## Phase 1: Task Definition and Role Discovery

**Goal:** Understand the task and identify the full space of roles needed.

1. Ask the user to describe the task, mission, or scenario that requires a group of people to accomplish.
2. Through conversation, narrow the world to a specific context. Ask clarifying questions. Explore the edges of the problem space.
3. For each role that emerges, identify:
   - **Core duties**: What the role is responsible for
   - **Defining traits**: The behavioral characteristics that make someone effective in this role
   - **Required mastery**: What skills the role demands expertise in
4. Roles may overlap or combine. The goal here is to map the full space of responsibilities before deciding how many characters carry them. Don't prematurely collapse roles into characters.
5. Present the candidate roles to the user for review. Iterate until the user is satisfied with the role landscape.

**Output:** A list of candidate roles with descriptions covering duties, traits, and required mastery.

**Do not proceed to Phase 2 until the user explicitly approves the role list.**

---

## Phase 2: Cast Sizing and Role Assignment

**Goal:** Decide on the precise number of characters and map roles onto them.

1. Based on the approved role list, discuss with the user how many characters should be in the cast. Consider:
   - Which roles naturally combine (e.g., "architect + fixer" or "builder + bridge")
   - Which roles are distinct enough to require their own character
   - What cast size serves the scenario best
2. Map roles onto characters. A single character may carry multiple roles.
3. Each character should have a clear, non-overlapping primary identity even when carrying multiple roles. Define a combined archetype for each.
4. Present the cast list to the user for review.

**Output:** A final cast list with role assignments and a short description of each character's combined archetype.

**Do not proceed to Phase 3 until the user explicitly approves the cast list.**

---

## Phase 3: Canon Cross-Reference

**Goal:** Find cultural and media reference points that define the tone, behavioral range, and values of each character.

**Important:** The cultural examples in this phase are not decoration. They define the tone, behavioral range, and values of each character. Take them seriously.

Use subagents for the research-heavy work in this phase.

For each character archetype:

1. Identify known cultural and media figures who exemplify one or more aspects of the role. Mix sources broadly:
   - **Real historical or industry figures** (e.g., engineers, leaders, scientists, artists)
   - **Fictional characters** from film, TV, literature, games, comics, anime
   - **Named concepts** from published frameworks, research, or organizational theory
2. For each example, provide:
   - The name
   - The source (film, book, real life, framework, etc.)
   - 1–2 sentences explaining what specific aspect of the role they exemplify
3. Aim for **5–8 cultural examples per character**.
4. Present the examples to the user. Let them react, swap out references, add their own, or refine. These serve as tonal and behavioral reference points — the user's taste matters here.

**Output:** A curated list of 5–8 cultural examples per character, approved by the user.

**Do not proceed to Phase 4 until the user explicitly approves the cultural references for all characters.**

---

## Phase 4: Character Backgrounds and Values

**Goal:** Produce detailed character background documents that are specific enough to portray the character convincingly or build a system prompt around.

For each character in the final cast, produce a document covering:

- **Duties**: What they're responsible for in the context of the task
- **Defining Traits**: The behavioral characteristics that make them effective
- **Required Mastery**: What skills the role demands expertise in
- **Core Values**: The principles embodied by the character, informed by the cultural examples from Phase 3. These should feel lived-in, not generic.
- **Cultural Examples**: The final curated list from Phase 3, formatted with name, source, and explanation

### Writing standards

- Write with enough specificity that someone could use each document to portray the character convincingly or build a system prompt around them.
- Values should be concrete and grounded in the cultural examples, not abstract platitudes.
- The voice of each document should reflect the character it describes.

### Saving the documents

1. Ask the user where to save the character documents (or use a sensible default like a `characters/` directory in the current project).
2. Save **one markdown file per character**, named after the character or their archetype.
3. Save an **index/summary document** that lists all characters with their archetypes and role assignments.
4. Present each character document to the user for review before finalizing. Iterate as needed.

**Output:** One markdown file per character, plus an index/summary document, all saved to the location the user specifies.
