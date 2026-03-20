# Compass Personality Engine
## LLM Agent Read/Apply Specification
### Source-grounded operational document

> **Purpose:** This document reformats the Compass system into an agent-readable specification for LLM use.
> **Source basis:** This specification is derived from `Compass Theories.pdf` and `TheCompassSystem_reference.txt`.
> **Important:** The Compass is **not** a navigation compass. It is a **personality assessment / character personality engine** for fictional characters and real people.
> **Important:** Some sections of the source are explicitly marked as **hypothetical**, **still being vetted**, or **still in progress**. Those parts are preserved here, but are clearly labeled so an LLM does not accidentally treat unfinished theory as settled canon.

---

## 1. Primary Function

The Compass exists to:

- facilitate better communication between adverse parties
- improve immersion and learning through roleplay
- provide a structured way to understand characters and people
- summarize personality without pretending to define the whole person

The Compass is designed for both fictional characters and real people. It is especially suited to tabletop roleplaying, narrative design, character writing, interpersonal analysis, and personality-driven simulation.

The system is **descriptive**, not absolute.
It is intended to help understand a person, aid introspection, and create a common language for discussing personality.
It is **not** meant to fully define a person or erase individuality.

---

## 2. Core Model

The Compass breaks personality into two major components:

- **Endo**: the internal drive
- **Exo**: the external filter

These are collectively called **Petals**.

### 2.1 Endo

An Endo refers to:

- raw desires
- core passions
- driving forces

The Endo generates the raw meaning behind action.

### 2.2 Exo

An Exo refers to:

- the filter through which stimulus flows in and out
- the translation layer between desire and socially visible behavior
- the filter through which environmental input is interpreted

### 2.3 Endo/Exo flow model

When a person acts:

1. the Endo generates raw meaning
2. that meaning passes through the Exo
3. the action enters the environment

When a person receives stimulus:

1. the environment produces stimulus
2. that stimulus passes through the Exo
3. the Endo interprets it

So the operational model is:

```text
internal drive -> exo filter -> action
environment -> exo filter -> endo interpretation
```

This means a person is not just what they want, but also how their wants are filtered and expressed.

---

## 3. High-Level Agent Rules

An LLM applying Compass should obey the following rules.

### 3.1 Do not over-reduce

No single Endo or Exo perfectly fits a person.
A person may practice, manufacture, or modify interactions without changing their deeper desires.

**Agent rule:** classify dominant patterns, not total identity.

### 3.2 Dominant qualities matter most

Compass is interested in:

- dominant desires
- dominant filters
- dominant pressures
- dominant focus patterns
- dominant maturity/regression behaviors

It does **not** primarily track learned or engineered behaviors except where the source explicitly discusses them.

### 3.3 Do not compare people as if this were a leaderboard

The source explicitly says Compass was not designed to directly compare one person to another.
It compares:

- needs
- perspectives
- environmental responses

**Agent rule:** do not score one person as "better" or "worse" than another.

### 3.4 Use layered interpretation

The source emphasizes that Compass can be read at multiple layers.
A shallow read uses the main Archetype.
A deeper read uses the full Compass Rose, including:

- Super-Archetype
- Sub-Archetype
- Pistil
- Perspective
- Wings
- Thresholds
- Regression
- Compatibility
- trauma-linked consideration/perpetuation patterns

**Agent rule:** when data is sparse, output a shallow read.
When data is rich, output a layered read.

### 3.5 Mark uncertainty

The source repeatedly warns that people are dynamic and easy to misread.
Some theory is unfinished.

**Agent rule:** explicitly mark:
- high confidence
- medium confidence
- speculative / provisional interpretation

---

## 4. Canonical Petal Taxonomy

There are three Endos and three Exos.

## 4.1 Endos

### Tempest (Red Endo)

- **Color:** Red
- **Depiction:** The Unstoppable Force
- **Descriptors:** Competitive, Combative
- **Proverb:** Leader*
- **Core Desire:** Success

#### Description
Red Endos are stubborn, bull-headed, and unrelenting.
A Tempest is driven, ambitious, and powerful.
Once a target is chosen, a Tempest finds a way below, over, or through.

#### Agent interpretation
Primary signal cluster:
- ambition
- force
- insistence
- directed pursuit
- action toward success
- refusal to yield

#### Scope tendency
Centers on an objective or goal.

#### Pressure tendency
Exerts executional pressure.

---

### Trickster (Green Endo)

- **Color:** Green
- **Depiction:** The Gatekeeper
- **Descriptors:** Intuitive, Apathetic
- **Proverb:** For the Show*
- **Core Desire:** Affirmation

#### Description
Green Endos are amiable and often thrive off social interaction, whether extroverted or introverted.
The Trickster may be extremely personable or extremely devious.
They are quick to converse and quick to notice socially useful information.

#### Agent interpretation
Primary signal cluster:
- social maneuvering
- affirmation-seeking
- charisma
- social awareness
- attention-shaping
- relational leverage
- interpersonal cleverness

#### Scope tendency
Centers on the self.

#### Pressure tendency
Exerts social pressure.

---

### Scholar (Yellow Endo)

- **Color:** Yellow
- **Depiction:** The Infinite Eyes
- **Descriptors:** Observant, Gullible
- **Proverb:** Support*
- **Core Desire:** Understanding

#### Description
Yellow Endos are curious and may appear shy or timid.
The Scholar silently observes, remembers, and studies.
They are often underestimated because their curiosity can look soft, but they are usually more capable than expected.

#### Agent interpretation
Primary signal cluster:
- curiosity
- observation
- memory
- analysis
- understanding-seeking
- quiet questioning
- attentive pattern reading

#### Scope tendency
Centers on another Archetype, person, or personified collective.

#### Pressure tendency
Exerts computational pressure.

---

## 4.2 Exos

### Aristocrat (Blue Exo)

- **Color:** Blue
- **Depiction:** The Warmth
- **Descriptors:** Approachable, Melancholy
- **Proverb:** For the People*
- **Approach:** Empathetic

#### Description
Blue Exos are pleasant and traditional.
They create security and stability.
They empathize with a few and protect them from the many.
They hold those close to them in higher regard than the broader population.

#### Agent interpretation
Primary signal cluster:
- warmth
- empathy
- protectiveness
- community loyalty
- selective depth
- close-bond priority

#### Scope shape
Narrow and deep.

#### Pressure tendency
Accepts social pressure.

---

### Practitioner (Purple Exo)

- **Color:** Purple
- **Depiction:** The Answer
- **Descriptors:** Practical, Judgmental
- **Proverb:** The Job*
- **Approach:** Clinical

#### Description
Purple Exos are pragmatic and look for organized, efficient methods.
The Practitioner acts like a skeleton key.
It uses practical measures with fluid execution.
It rarely leaves the path it has chosen and will judge opposition.

#### Agent interpretation
Primary signal cluster:
- practicality
- preparation
- method
- procedural structuring
- efficient execution
- discipline
- organized response

#### Scope shape
Balanced width and depth.

#### Pressure tendency
Accepts executional pressure.

---

### Construct (Orange Exo)

- **Color:** Orange
- **Depiction:** The Immovable Object
- **Descriptors:** Analytical, Complacent
- **Proverb:** Top of Class*
- **Approach:** Analytical

#### Description
Orange Exos are calm, hard to phase, logical, and calculative.
They seek exact facts.
What cannot be calculated is treated as unknown.
They are often unaffected by adversity, dealing with it or ignoring it.

#### Agent interpretation
Primary signal cluster:
- detached logic
- calmness
- analytic framing
- calculation
- factual exactness
- durable composure

#### Scope shape
Wide and shallow.

#### Pressure tendency
Accepts computational pressure.

---

## 5. Archetype Generation

Any one Endo paired with any one Exo produces one of nine Archetypes.

This is the most superficial and most forward-facing classification layer.

---

## 5.1 The nine Archetypes

### Captain (Red-Blue)
- restless force
- acts based on feeling
- impulsive but powerful
- does first, explains after
- **Depiction:** The Wildfire
- **Proverb:** A Leader for the People

### Executive (Red-Purple)
- blunt
- prepared
- task-oriented
- finds resolution at all costs
- not focused on "why" as much as "how to execute"
- **Depiction:** The Master Key
- **Proverb:** Leadership is my Job

### Mastermind (Red-Orange)
- quietly thoughtful
- outwardly sporadic
- calculated
- verifies plans before execution
- often hides the scale of internal schemes
- **Depiction:** The Relentless
- **Proverb:** Designed for Leadership

### Performer (Green-Blue)
- witty
- performative
- elegant in interpretation
- sharp-tongued
- strong audience capture
- opinion voiced loudly and clearly
- **Depiction:** The Kitsune
- **Proverb:** A Show for the People

### Conductor (Green-Purple)
- concise
- critical
- detail-aware
- learns strengths and weaknesses of others
- sees utility in information and people
- **Depiction:** The Puppetmaster
- **Proverb:** The Show is my Job

### Maestro (Green-Orange)
- understands the power of speech and silence
- not moved, only convinced
- fills the space given to them
- resists retraction without substantial force
- may choose non-response instead of conflict
- **Depiction:** The Adamant
- **Proverb:** The Best in Show

### Lover (Yellow-Blue)
- encouraging
- outwardly hopeful
- finds peace with others through darkness
- supports those around them
- somber undertone at their worst
- **Depiction:** The Starfinder
- **Proverb:** Support for the People

### Inquisitor (Yellow-Purple)
- quiet answer to most problems
- highly self-organized
- waits for purpose before relaying findings
- thick shell, large internal potential
- **Depiction:** The Mystic
- **Proverb:** Support is my Job

### Genius (Yellow-Orange)
- considerate
- thoughtful
- questioning
- watchful
- often only speaks when spoken to
- may struggle to communicate discoveries
- discoveries may be squandered if not fostered
- **Depiction:** The Sentinel
- **Proverb:** Supporting the Best

---

## 5.2 Archetype matrix

| Endo \ Exo | Blue (Aristocrat) | Purple (Practitioner) | Orange (Construct) |
|---|---|---|---|
| Red (Tempest) | Captain | Executive | Mastermind |
| Green (Trickster) | Performer | Conductor | Maestro |
| Yellow (Scholar) | Lover | Inquisitor | Genius |

---

## 6. Pressures

Each Petal participates in pressure systems.

- Endos **exert**
- Exos **accept**

There are three pressure types:

- executional
- social
- computational

## 6.1 Executional pressure

**Exerted by:** Red Endos  
**Accepted by:** Purple Exos

### Nature
Immediate action, impulsiveness, spontaneity, direct movement toward resolution.

### Source example logic
A Red may accept the first viable answer and move.
A Purple restructures that impulsive force into something manageable through planning, lists, schedules, or organized procedure.

### Agent interpretation
Executional pressure shows up when someone:
- wants motion now
- privileges immediate progress
- tolerates incomplete analysis if action can begin
- drives tasks forward through force or momentum

A strong execution-accepting Purple often:
- organizes chaos
- prepares systems
- stabilizes impulsive drives into procedure

---

## 6.2 Social pressure

**Exerted by:** Green Endos  
**Accepted by:** Blue Exos

### Nature
Conversation gravity, influence, interpersonal pressure, hard-to-exit relational dynamics, strong presence inside dialogue.

### Source example logic
A Green may passively embed distress into normal conversation.
A Blue notices and responds with care, understanding, or security.

### Agent interpretation
Social pressure shows up when someone:
- changes the emotional/social weather of a room
- influences dialogue without direct force
- seeks response, attention, recognition, or relational adjustment

A strong social-accepting Blue often:
- makes pressure feel seen
- emotionally metabolizes what is coming in
- gives warmth, safety, and understanding

---

## 6.3 Computational pressure

**Exerted by:** Yellow Endos  
**Accepted by:** Orange Exos

### Nature
Questioning, dissection, deep inquiry, fixation, conceptual excavation.

### Source example logic
A Yellow may ramble through every detail of a fixation.
An Orange gives structure, process, useful questions, or analytical organization.

### Agent interpretation
Computational pressure shows up when someone:
- needs fuller understanding
- asks cascading questions
- dissects layers of meaning
- explores detail chains and implications

A strong computational-accepting Orange often:
- structures inquiry
- stabilizes complexity
- gives conceptual scaffolding
- converts curiosity into usable patterns

---

## 6.4 Pressure interaction rules

Every Archetype:

- exudes one pressure type through its Endo
- processes one pressure type through its Exo

This produces **Inverse Archetypes**:
two Archetypes where each exerts what the other best accepts.

### Canonical inverse pairs

- **Captain** ↔ **Conductor**
- **Mastermind** ↔ **Inquisitor**
- **Maestro** ↔ **Lover**
- Each **Chorus Archetype** is inverse with itself:
  - Executive
  - Performer
  - Genius

---

## 6.5 Chorus Archetypes

A Chorus Archetype exerts and accepts the same pressure.

These are:

- **Executive**: executional / executional
- **Performer**: social / social
- **Genius**: computational / computational

**Agent rule:** Chorus Archetypes can display both parallel and facing compatibility simultaneously.

---

## 7. Scopes

A Scope is the set of what a person considers important within their dominant view.

Scope has:

- **shape**
- **location**
- **relative volume**

The system does not primarily observe total volume.
It mainly observes shape and location.

### 7.1 General principles

- Wider scope = more things considered
- Deeper scope = fewer things considered more intensely
- Scope is conceptual, not merely physical
- What enters someone’s scope becomes meaningful or substantial

Entities in scope may include:
- objectives
- people
- possessions
- information

---

## 7.2 Scope shape is determined by Exo

### Blue scope
- narrow
- deep
- strong bonds
- intense local significance
- risk: missing what is just outside view

### Purple scope
- balanced width/depth
- moderate breadth
- moderate depth
- procedural equilibrium
- risk: not reaching deepest intensity or widest fairness

### Orange scope
- wide
- shallow
- considers many things
- less substantial attachment to each
- can appear fair
- can also look objectifying without context

### Agent rule
When modeling significance:
- Blue = few things matter a lot
- Purple = moderate number of things matter moderately
- Orange = many things matter somewhat

---

## 7.3 Scope location is determined by Endo

### Red scope location
Centered on an objective or goal.

Things become meaningful by proximity to success.
A Red focused on finishing college will prioritize what helps complete the degree.

### Green scope location
Centered on the self.

Things become meaningful by conceptual nearness to the Green person.

### Yellow scope location
Centered on another Archetype, person, or personified conglomerate.

Things become meaningful by proximity to whoever or whatever the Yellow centers.
If a Yellow centers a romantic partner, that partner’s interpretation of importance can bleed into the Yellow’s.

### Agent rule
When evaluating priorities:
- Red asks: does this move the goal?
- Green asks: how close is this to me?
- Yellow asks: how close is this to the person/group I orbit?

---

## 8. Core Philosophies and Modeling Assumptions

The source explicitly marks these ideas as under consideration and used to create shared context.

Treat them as **important theory**, but not always as finalized hard mechanics.

## 8.1 People are complicated

No system perfectly dictates identity, personality, or habit.
Compass knows this.

Compass is made to:
- summarize
- support understanding
- support introspection

It is not made to define a person absolutely.

### Agent rule
Never state "this person is nothing but X."
State "the dominant Compass reading suggests X."

---

## 8.2 Layering versus accuracy

Knowing only someone’s Super-Archetype is simple but broad.
The source says knowing the Archetype removes approximately 89% of possibilities, but still remains highly generalizing.

The more Compass data you gather:
- the more detailed the image
- the harder it becomes to be accurate

### Agent rule
More layers require more evidence.
Do not force deep classification from thin data.

---

## 8.3 Personal relativity

Everyone is at a different stage physically, mentally, and emotionally.

Being an empathetic Archetype does not mean "most empathetic in absolute terms."
It means empathy is a more dominant orientation relative to that person’s pattern.

Likewise, analytical behavior can be learned without someone being Orange.

### Agent rule
Classify the dominant motivational/filter structure, not surface skill alone.

---

## 8.4 Suffering is relative

Trauma is person-relative, based on what the person has experienced as extreme agony.
The same event can be devastating to one person and routine to another.

The model assumes:
- everyone experiences trauma
- perception matters
- lack of understanding can intensify impact

### Agent rule
When interpreting maturity/regression, personal history matters.
Do not universalize trauma effects.

---

## 8.5 Maturity is Homogony

The source proposes maturity as movement toward a "perfect average" for more efficient communication.

This is theoretical and philosophical, not a simple morality claim.

Important implications:
- maturity is framed as movement toward communicative norming
- this improves frictionless communication
- but it risks stagnation
- individuality exists between total social averaging and total reduction to component parts

### Agent rule
Model maturity as increased communicative integration and consideration, not blandness or moral superiority.

---

## 9. The Compass Rose

The full Compass model includes:

- **Super-Archetype**
- **Sub-Archetype**
- **Pistil**

These layers together form a richer reading than simple Archetype alone.

---

## 9.1 Super-Archetype

The Super-Archetype is the most superficial expression and is usually what people mean by "Archetype."

It is the front face of personality.

### Form
```text
Super-Archetype = Endo + Exo
```

### Agent rule
When only limited evidence exists, default to Super-Archetype output.

---

## 9.2 Sub-Archetype

The Sub-Archetype also has two parts, but differs in function:

- inner Petal = **Lean**
- outer Petal = **Perspective**

### Form
```text
Sub-Archetype = Lean + Perspective
```

This is especially important in:
- regression
- deeper relational reads
- trauma-linked perpetuation patterns
- Wings

---

## 9.3 Pistil

The Pistil is the initial internal Petal present at birth.

Possible Pistils:
- Red -> success
- Green -> affirmation
- Yellow -> understanding

The Pistil is the lowest level of drive.

### Agent rule
If modeling development:
- Pistil comes first
- Lean comes second
- Endo comes third

---

## 9.4 Lean

The Lean develops approximately around puberty.

It does **not** remove the original drive.
It creates a new method for accessing that drive.

### Example from source
Yellow Pistil + Green Lean:
- finds understanding through affirmation

### Development rule
The Lean must be one of the remaining two internal Petals not already taken by Pistil.

---

## 9.5 Endo development

Near young adulthood, the final internal Petal develops as the person’s Endo.

It is the one internal Petal not already used by Pistil or Lean.

### Example
Yellow Pistil + Green Lean -> Red Endo

This creates chained motivational access:
- success becomes a route to affirmation
- affirmation becomes a route to understanding

### Agent rule
If Pistil and Lean are known, Endo is the remaining internal color.

---

## 9.6 Perspective

Perspective is mechanically separate from Exo.

It refers less to behavior and more to what group is considered in decision-making.

### Perspective meanings

- **Blue Perspective**: direct community prioritized
- **Purple Perspective**: clinical middle-ground
- **Orange Perspective**: needs of the many over the few

The source says Perspective is a spectrum with infinitely many locations, even though Blue/Purple/Orange are the named anchors.

Perspective may shadow its matching Exo’s qualities.

### Example
Purple Exo + Orange Perspective:
- practical approach in an analytical manner

### Agent rule
Treat Perspective as:
- a decision-reference group
- a sub-filter
- a regression-relevant outer layer

---

## 10. Wings

Wings are generated from Super-Archetype and Sub-Archetype.

Two Wings are formed:

1. **Endo + Perspective**
2. **Exo + Lean**

### Example
Lover (Yellow-Blue) sub-Conductor (Green-Purple) produces:
- Inquisitor (Yellow-Purple)
- Performer (Green-Blue)

### Special case
If Exo and Perspective are the same, Wings match the Super-Archetype and Sub-Archetype.

Example:
Executive (Red-Purple) sub-Inquisitor (Yellow-Purple)
-> Wings are Executive and Inquisitor

### Agent rule
Wings are derivative patterns, not replacements for the main rose.
Use them for nuance and secondary relational behavior.

---

## 11. Regression

Regression is one of the most important and least finalized parts of the source.
The source gives both general rules and unresolved roadmap options.

This means an agent should split regression into:

- **settled operational rules**
- **provisional unresolved roadmap theories**

---

## 11.1 Settled operational regression rules

These are stated directly enough to treat as current working mechanics.

### Stress causes regression
Persistent duress causes the Super-Archetype to become more transparent, allowing the Sub-Archetype to take precedence.

### Threshold direction matters
Upper-threshold stress regresses the Exo.
Lower-threshold stress regresses the Endo.

- Upper threshold examples:
  - rigidity
  - overstimulation
  - burnout

- Lower threshold examples:
  - spontaneity
  - understimulation
  - loneliness

### What gets exposed
- Exo regression exposes **Perspective**
- Endo regression exposes **Lean** or eventually **Pistil**

### Practical result
During regression, a person acts less like their Super-Archetype and more like their Sub-Archetype or deeper internal layer.

---

## 11.2 Thresholds

Every person has three relative spectrums.

Each has an upper radical and lower radical.
Either extreme can produce duress.

### 11.2.1 Habitual Gauge
The source contains a wording inconsistency:
it labels this section "The Habitual Gauge" but then describes "The Executional Gauge."

Use the underlying mechanics, not the label confusion.

#### Range
physical behavior and habits

#### Upper radical
rigidity

#### Lower radical
spontaneity

#### Stress pattern
Too much sameness or too little pattern stability causes duress.

---

### 11.2.2 Mental Gauge

#### Upper radical
overstimulation

#### Lower radical
understimulation

#### Stress pattern
Too much incoming stimulus or too little meaningful stimulation causes duress.

---

### 11.2.3 Communal Gauge

#### Upper radical
burnout

#### Lower radical
loneliness

#### Stress pattern
Too much social expenditure or too much isolation causes duress.

---

## 11.3 Regression due to stress: agent mapping

Use this as the default operational heuristic.

```text
upper-threshold stress -> Exo regression -> Perspective becomes more visible
lower-threshold stress -> Endo regression -> Lean / Pistil becomes more visible
```

### Agent rule
If a character shows:
- burnout, overstimulation, rigidity -> expose Perspective-like behavior
- loneliness, understimulation, spontaneity dysregulation -> expose Lean/Pistil-like behavior

---

## 11.4 Consideration versus perpetuation

This is a major trauma-linked maturity/regression framework.

### Mature state = consideration
In maturity, the Super-Archetype guides what a person is considerate of.
That consideration is shaped by:
- personal history
- Endo pressure
- Exo pressure

### Regressed state = perpetuation
In regression, the Sub-Archetype guides what gets perpetuated.
That perpetuation is shaped by:
- Lean as driving force
- Perspective as filter

### Example logic from source
- A mature Lover (Yellow-Blue) who endured mental trauma may become considerate of others under mental pressure.
- A regressed Conductor sub-pattern may perpetuate emotional trauma patterns through manipulation or anxious attachment.

### Important source rule
Perspective as filter can create the assumption that traumatizing practices are being used even when that was not intended.

### Agent rule
When modeling regression:
- mature reading -> what pain makes them cautious/considerate
- regressed reading -> what pain patterns they might unintentionally reproduce

---

## 11.5 Important regression constraints

The source says:

- negative regression-linked actions are not necessarily permanent
- these can be practiced against
- change may require engineered effort until habit forms
- when certain Endos or Exos are absent from the current state, related trauma consideration/perpetuation may be absent as well

### Example from source
Inquisitor (Yellow-Purple) sub-Mastermind (Red-Orange) lacks Green and Blue in that state.
Result:
- minimal to no emotional trauma consideration/perpetuation

### Agent rule
Only infer trauma-linked perpetuation from currently active layers.
Do not assign absent-layer behaviors.

---

## 11.6 Provisional unresolved regression theories

The source explicitly says regression roadmaps are still in progress and heavily debated.

An LLM should treat the following as hypotheses, not settled canon:

1. whether Endo-first or Exo-first regression depends on Archetype-Lean combo
2. whether Endo and Exo regress independently according to Threshold position
3. whether Archetype regression chart always matches the Archetype
4. whether regression chart changes based on Super-Archetype + Sub-Archetype
5. whether regression chart side is determined by Endo
6. whether regression chart side is determined by Pistil
7. whether full regression requires Lean erosion
8. whether full regression only requires both Endo and Exo regression

### Special roadmap labels mentioned but not fully defined
The source names:
- Dreamer
- Opportunist
- Servant
- Rebel

These are mentioned as regression-chart destinations, but the uploaded sources do **not** fully define them.

### Agent rule
Do not invent mechanics or descriptions for:
- Dreamer
- Opportunist
- Servant
- Rebel
unless the user explicitly wants a speculative extrapolation.

If needed, report:
> "The source names this regression state but does not define it in the provided material."

---

## 12. Compatibility

Compatibility is nuanced.
The source says there is no single positive or negative form of compatibility.

Types include:

- Parallel Compatibility
- Facing Compatibility
- Neutral Compatibility
- Mixed Compatibility

And an additional principle:

- Chemistry Defeats All

---

## 12.1 Parallel Compatibility

Occurs when two or more individuals have similar or identical Compass Roses.

### Effects
- similar pressure acceptance
- similar environmental strengths
- easier agreement about what matters in a shared task

### Important note
Parallel compatibility is dynamic.
Role differences, regression state, and Sub-Archetype differences can change how it feels.

### Agent rule
Use Parallel when:
- Archetype matches strongly
- deeper rose alignment is high
- people process similar pressures in similar ways

---

## 12.2 Facing Compatibility

Occurs when one Archetype exerts the pressure another accepts, in a reciprocal pattern.

This is the ideal form of **Inverse Archetype** compatibility.

### Canonical inverse pairings
- Captain and Conductor
- Mastermind and Inquisitor
- Maestro and Lover
- Any Chorus type with itself

### Effects
- may not respond similarly
- but can process each other’s pressure well

### Regression nuance
If one person’s Sub-Archetype is inverse to another’s Super-Archetype, this compatibility may only show when one is regressed.

### Agent rule
Use Facing when:
- pressure reciprocity is central
- difference exists, but with mutual pressure processing support

---

## 12.3 Neutral Compatibility

Occurs when neither Parallel nor Facing structure meaningfully exists.

### Effects
- fewer built-in aids
- not the same thing as incompatibility
- can produce the lowest ease
- can also create exposure to new experience and growth

### Agent rule
Use Neutral when:
- there is no strong shared processing rhythm
- but no special contradiction either

---

## 12.4 Mixed Compatibility

The source says many real combinations will not fit only one category.
Compatibility changes with:
- maturity
- regression state
- relationship role
- time
- shared experience

### Agent rule
Prefer mixed/granular descriptions over rigid binary claims.

---

## 12.5 Chemistry Defeats All

The source explicitly states that time, understanding, and shared life can matter more than compatibility type.
Compatibility is most visible when communication is missing.
As people build shared dialects and habits, gaps can close.

### Agent rule
Compatibility is a starting condition, not destiny.

---

## 13. Full Agent Inference Procedure

This is the recommended operational pipeline for an LLM.

## 13.1 Step 1: identify dominant Endo evidence

Search for what the subject most fundamentally wants.

### Red indicators
- success
- winning
- overcoming
- target fixation
- forceful movement toward result
- ambition
- relentless objective pursuit

### Green indicators
- affirmation
- social response
- recognition
- audience capture
- relational leverage
- interpersonal cleverness
- self-centered significance field

### Yellow indicators
- understanding
- questioning
- observation
- memory
- knowledge-seeking
- conceptual excavation
- quiet information gathering

---

## 13.2 Step 2: identify dominant Exo evidence

Search for how the person filters action and input.

### Blue indicators
- warmth
- empathy
- protection of inner circle
- deep bonds
- selective care
- strong local loyalty

### Purple indicators
- method
- procedure
- practicality
- efficiency
- planning
- organizing action
- clinical judgment

### Orange indicators
- calm analysis
- detached logic
- factual exactness
- broad but shallow fairness
- conceptual structuring
- low visible disturbance

---

## 13.3 Step 3: generate Super-Archetype

```text
Super-Archetype = dominant Endo + dominant Exo
```

Output:
- name
- justification
- pressure exerted
- pressure accepted
- likely scope shape
- likely scope location

---

## 13.4 Step 4: infer Sub-Archetype if data exists

Infer:
- Lean
- Perspective

Use:
- adolescence/backstory development themes
- secondary motivational route
- who/what is considered in decisions
- what emerges under stress

### Lean signals
The Lean is a secondary internal route, not a replacement drive.
It often appears as:
- how the original Pistil found new access
- what secondary motive shaped development

### Perspective signals
Perspective appears in:
- what group is considered during decisions
- whether the subject favors the close few, the many, or a clinical middle path

---

## 13.5 Step 5: infer Pistil if developmental context exists

Pistil is best inferred from:
- earliest baseline tendencies
- childhood drive
- low-level core desire beneath later adaptations

If evidence is insufficient, mark Pistil as unknown rather than forcing it.

---

## 13.6 Step 6: model maturity versus regression

If the subject is stable:
- emphasize Super-Archetype
- consideration logic
- mature communication tendencies

If the subject is stressed:
- determine whether upper-threshold or lower-threshold duress dominates
- expose Perspective for Exo regression
- expose Lean/Pistil for Endo regression
- describe possible perpetuation patterns carefully and non-absolutely

---

## 13.7 Step 7: model compatibility if multiple people are present

Evaluate:
1. Archetype match
2. pressure reciprocity
3. Sub-Archetype interaction
4. regression-state dependence
5. shared history / chemistry

Return:
- Parallel
- Facing
- Neutral
- Mixed

plus a narrative explanation.

---

## 14. Confidence Rules for LLM Use

### High confidence
Use when:
- repeated signals converge on same Endo/Exo
- source-consistent behavior is present across contexts
- stress and maturity patterns support the same read

### Medium confidence
Use when:
- main Archetype is clear
- deeper rose is uncertain

### Low confidence
Use when:
- signals conflict
- behavior appears heavily trained/masked
- data is sparse or situational only

### Agent output pattern
Always include:
- inferred layer
- evidence
- confidence
- uncertainty note

---

## 15. Canonical Output Schema

Use this for structured output.

```yaml
compass_profile:
  subject: string
  source_basis: "Compass Theories.pdf + TheCompassSystem_reference.txt"
  confidence:
    super_archetype: high|medium|low
    sub_archetype: high|medium|low
    pistil: high|medium|low|unknown

  super_archetype:
    endo:
      color: Red|Green|Yellow
      name: Tempest|Trickster|Scholar
      core_desire: Success|Affirmation|Understanding
      evidence:
        - string
    exo:
      color: Blue|Purple|Orange
      name: Aristocrat|Practitioner|Construct
      approach: Empathetic|Clinical|Analytical
      evidence:
        - string
    archetype_name: Captain|Executive|Mastermind|Performer|Conductor|Maestro|Lover|Inquisitor|Genius
    rationale: string

  sub_archetype:
    lean:
      color: Red|Green|Yellow|Unknown
      rationale: string
    perspective:
      color: Blue|Purple|Orange|Unknown
      rationale: string
    archetype_name_if_derived: string

  pistil:
    color: Red|Green|Yellow|Unknown
    rationale: string

  pressures:
    exerts: executional|social|computational
    accepts: executional|social|computational

  scope:
    shape:
      width: narrow|balanced|wide
      depth: deep|balanced|shallow
      rationale: string
    location:
      center: objective|self|other_archetype
      rationale: string

  maturity_regression:
    mature_mode:
      consideration_summary: string
    regression_mode:
      likely_exo_regression_triggers:
        - rigidity
        - overstimulation
        - burnout
      likely_endo_regression_triggers:
        - spontaneity
        - understimulation
        - loneliness
      likely_subarchetype_expression: string
      perpetuation_risk_notes:
        - string

  wings:
    endo_plus_perspective: string
    exo_plus_lean: string

  compatibility_notes:
    with_subjects:
      - subject: string
        mode: Parallel|Facing|Neutral|Mixed
        rationale: string

  caveats:
    - "Compass is descriptive, not absolute."
    - "Some regression mechanics remain provisional in source."
```

---

## 16. Minimal Output Schema

Use when data is sparse.

```yaml
compass_minimal:
  subject: string
  archetype_name: string
  endo: string
  exo: string
  rationale:
    - string
  confidence: high|medium|low
  uncertainties:
    - string
```

---

## 17. Prompt Template for Agent Use

```text
You are applying the Compass Personality Engine from the uploaded source material.

Your job is to infer the subject's:
- Endo
- Exo
- Super-Archetype
- possible Lean
- possible Perspective
- possible Pistil
- exerted/accepted pressure
- scope shape
- scope location
- maturity vs regression tendencies
- compatibility notes if multiple people are present

Constraints:
- Do not treat Compass as total identity.
- Classify dominant motives and filters only.
- Separate canonical source-grounded conclusions from speculation.
- Mark unfinished theory as provisional.
- Do not invent definitions for regression labels not defined in source.
- If evidence is insufficient, output Unknown rather than forcing a fit.

Return:
1. short narrative read
2. structured YAML profile
3. confidence notes
4. caveats
```

---

## 18. Example Agent Read

### Input character
A severe but reliable commander who pushes action immediately, protects a tight inner circle, and becomes especially controlling when overstimulated.

### Agent reasoning
- dominant desire appears success/mission -> Red
- dominant filter appears protective, selective, relationally deep -> Blue
- Super-Archetype -> Captain
- upper-threshold stress -> Exo regression likely
- Exo regression would expose Perspective
- tight-circle concern suggests Blue-like outer decision anchoring, though deeper Perspective would need more evidence

### Example output

```yaml
compass_minimal:
  subject: "Example Commander"
  archetype_name: "Captain"
  endo: "Red / Tempest"
  exo: "Blue / Aristocrat"
  rationale:
    - "Pushes immediate action, suggesting executional Red drive."
    - "Protects a tight inner circle, suggesting deep Blue filtering."
    - "Acts first and explains after, matching Captain source description."
  confidence: medium
  uncertainties:
    - "Lean, Perspective, and Pistil are not clear from the current data."
```

---

## 19. What an Agent Must Not Do

Do **not**:

- treat the Compass like a moral ranking
- equate learned behavior with core drive automatically
- force full Compass Rose output from tiny evidence
- invent missing regression chart definitions
- assume all members of an Archetype behave identically
- ignore trauma relativity
- ignore maturity/regression state
- present compatibility as destiny

---

## 20. What an Agent Should Prioritize

Prioritize:

- dominant desire
- dominant filter
- pressure dynamics
- scope mechanics
- developmental layering when available
- maturity vs regression context
- explicit uncertainty
- source fidelity

---

## 21. Compact Reference Tables

## 21.1 Endo table

| Endo | Color | Core Desire | Pressure Exerted | Scope Location |
|---|---|---|---|---|
| Tempest | Red | Success | Executional | Objective/goal |
| Trickster | Green | Affirmation | Social | Self |
| Scholar | Yellow | Understanding | Computational | Another Archetype/personified collective |

## 21.2 Exo table

| Exo | Color | Approach | Pressure Accepted | Scope Shape |
|---|---|---|---|---|
| Aristocrat | Blue | Empathetic | Social | Narrow / Deep |
| Practitioner | Purple | Clinical | Executional | Balanced |
| Construct | Orange | Analytical | Computational | Wide / Shallow |

## 21.3 Archetype table

| Archetype | Formula | Core reading |
|---|---|---|
| Captain | Red + Blue | impulsive loyal force |
| Executive | Red + Purple | practical task-driving leader |
| Mastermind | Red + Orange | calculated strategist |
| Performer | Green + Blue | audience-shaping social force |
| Conductor | Green + Purple | detail-aware manipulative organizer |
| Maestro | Green + Orange | persuasive stillness and resistance |
| Lover | Yellow + Blue | hopeful supportive soul |
| Inquisitor | Yellow + Purple | quiet methodical answer-seeker |
| Genius | Yellow + Orange | watchful thinker with difficult-to-express insight |

---

## 22. Canon versus Provisional Map

## 22.1 Treat as current working canon
- Endos
- Exos
- archetype matrix
- pressure types
- pressure pairings
- scope shape/location
- Super-Archetype
- Sub-Archetype
- Pistil / Lean / Endo development order
- Perspective basics
- Wings basics
- Threshold gauges
- upper-threshold Exo regression
- lower-threshold Endo regression
- compatibility categories
- chemistry-defeats-all principle

## 22.2 Treat as provisional / unfinished
- exact regression roadmap determination
- regression chart mechanics
- Dreamer / Opportunist / Servant / Rebel definitions
- exact criteria for full vs partial regression resolution where source presents multiple competing options

---

## 23. Final Agent Summary

The Compass should be applied as a **layered motivational-filter model**.

At minimum:
- find the dominant Endo
- find the dominant Exo
- output the Super-Archetype

At richer levels:
- infer Lean, Perspective, and Pistil
- model pressure dynamics
- model scope shape and location
- model maturity versus regression
- model compatibility

Above all:
- keep the reading source-faithful
- keep the reading non-absolute
- distinguish canon from unfinished theory
- preserve individuality

---

## 24. Source Reminder for Future Agents

This specification was produced from uploaded source material and is intended as an implementation-facing restatement.
If a future agent is asked to expand beyond these definitions, it should say whether it is:

- quoting/restating source-grounded Compass rules
- inferring from source
- speculating beyond source

That distinction must remain explicit.
