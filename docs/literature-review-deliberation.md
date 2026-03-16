# Literature Review: Multi-Agent Deliberation & Coordination

Research conducted March 2026 for issue [#9](https://github.com/SpaceMolt/signal-crew/issues/9).

Goal: identify coordination and deliberation patterns applicable to a crew of 4 AI agents (Captain, Engineer, Tactical, Diplomatic) operating a shared ship in a text-based space MMO.

---

## How to Read This Document

Each entry has a **Relevance** rating:

- **HIGH** — directly applicable pattern we should implement
- **MEDIUM** — useful ideas to borrow selectively
- **LOW** — interesting but poor fit for our constraints (token cost, real-time game, 4 agents)
- **IGNORE** — reviewed and rejected

The **Transferable Pattern** section extracts what we'd actually build. The **Why Not More** section explains what we're leaving on the table and why.

---

## Part 1: AI Multi-Agent Frameworks

### 1.1 LangGraph Multi-Agent Patterns — Supervisor as Tool-Caller

**Relevance: HIGH**

LangGraph models multi-agent coordination as a state graph. The most relevant pattern is the **supervisor-as-tool-caller**: the supervisor agent treats each sub-agent as a tool it can invoke via standard tool-calling syntax. The LLM natively decides which agents to consult and can invoke multiple in parallel.

Also supports: hierarchical teams (supervisors supervising supervisors), parallel fan-out via `Send()`, and deterministic conditional routing based on state.

**Transferable Pattern**: The brain (Holden) gains `consult_naomi`, `consult_bobbie`, `consult_avasarala` tools. It decides when and whom to consult as part of its existing planning call. 2-3 LLM calls per decision. Cheapest multi-agent pattern surveyed.

**Why Not More**: LangGraph's graph definition is compile-time static. No built-in debate or disagreement — it's a dispatch model, not a deliberation model. Good for routine coordination, insufficient for high-stakes crew decisions.

**Reference**: LangGraph Multi-Agent Concepts — https://langchain-ai.github.io/langgraph/concepts/multi_agent/

---

### 1.2 Du et al. — Multi-Agent Debate

**Relevance: HIGH** (for critical decisions only)

Multiple LLM instances independently answer the same question, then see all other agents' answers and revise their positions. After 2-3 rounds, agents naturally converge. Key finding: **3 agents with 2 rounds is the sweet spot** — more agents/rounds have diminishing returns. Works even with the same model (diversity from sampling stochasticity). Significantly improves factual accuracy and reasoning vs. single agent.

**Transferable Pattern**: For high-stakes decisions (entering dangerous space, PvP engagement, major expenditure), each crew member independently generates a recommendation, then one round of debate seeing all recommendations, then captain synthesizes. 11 LLM calls — reserve for critical moments only.

**Why Not More**: Token cost scales with agents × rounds × growing context. Impractical for every decision. The simultaneous protocol (all respond in parallel) eliminates ordering bias but costs more than sequential.

**Reference**: Du, Y., Li, S., Torralba, A., Tenenbaum, J.B., & Mordatch, I. (2023). "Improving Factuality and Reasoning in Language Models through Multiagent Debate." *arXiv preprint arXiv:2305.14325*. https://arxiv.org/abs/2305.14325

---

### 1.3 Liang et al. — Divergent Thinking via Multi-Agent Debate

**Relevance: MEDIUM**

Similar to Du et al. but adds a **judge agent** that evaluates competing arguments and decides when debate has converged. The judge reduces groupthink by explicitly evaluating the quality of reasoning rather than just counting votes.

**Transferable Pattern**: For decisions where the crew genuinely disagrees, Holden acts as judge rather than participant — evaluating Bobbie's tactical argument against Avasarala's diplomatic argument against Naomi's engineering argument. Separating the "argue" and "decide" roles produces better outcomes than having the captain both argue and decide.

**Why Not More**: Adding a separate judge call on top of the debate adds cost. Only valuable when genuine disagreement exists, which the situation classifier can detect.

**Reference**: Liang, T., He, Z., Jiao, W., Wang, X., Wang, Y., Wang, R., Yang, Y., Tu, Z., & Shi, S. (2023). "Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate." *arXiv preprint arXiv:2305.19118*. https://arxiv.org/abs/2305.19118

---

### 1.4 MetaGPT — Publish-Subscribe with SOPs

**Relevance: HIGH** (the pub-sub pattern specifically)

Agents subscribe to message types rather than seeing everything. When a ProductManager publishes a PRD, only the Architect receives it. The "Standard Operating Procedure" defines a DAG of role dependencies. Agents produce structured artifacts, not freeform conversation.

**Transferable Pattern**: Before the brain plans, each specialist produces a brief structured assessment (engineering status, threat assessment, diplomatic opportunities). The brain subscribes to all assessments. Agents only see artifacts relevant to their role. 4-5 LLM calls per planning cycle — close to current single-call brain but significantly richer input.

**Why Not More**: MetaGPT's pipeline is rigid and designed for document-production workflows. Subscription setup is compile-time static. No real-time conversation. We borrow the pub-sub information flow pattern but not the rigid pipeline.

**Reference**: Hong, S., Zhuge, M., Chen, J., Zheng, X., Cheng, Y., Zhang, C., Wang, J., Wang, Z., Yau, S.K.S., Lin, Z., Zhou, L., Ran, C., Xiao, L., Wu, C., & Schmidhuber, J. (2023). "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework." *arXiv preprint arXiv:2308.00352*. https://arxiv.org/abs/2308.00352 / https://github.com/geekan/MetaGPT

---

### 1.5 AutoGen / AG2 — Group Chat Patterns

**Relevance: MEDIUM**

Microsoft's framework provides several group chat patterns: RoundRobin, SelectorGroupChat (LLM picks next speaker), Swarm (explicit handoffs), and MagenticOne (orchestrator with task ledger). The SelectorGroupChat is most interesting — an LLM examines conversation history and decides who should speak next.

**Transferable Pattern**: The selector pattern could determine which crew member weighs in on a decision. However, it adds 1 LLM call per turn just for speaker selection, which is expensive. The Swarm/Handoff pattern maps well to plan-then-execute: brain decides, hands off to specialist.

**Why Not More**: Token costs scale with conversation length × agents. A 3-round deliberation among 4 agents: 12 agent calls + 12 selector calls = 24 LLM calls, ~60-100K tokens for one decision. All-public conversation can't model private knowledge (Avasarala's secrets, individual values). Better to use selective activation (LangGraph-style) than full group chat.

**Reference**: AutoGen AgentChat Documentation — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html

---

### 1.6 ChatDev — Dyadic Chat Chains

**Relevance: MEDIUM** (for specific crisis conversations)

Phases with strictly 2-agent conversations. Within each phase, a CTO-Programmer or Designer-Tester pair converse for 3-10 turns. Phase outputs (artifacts) feed the next phase. Uses "inception prompting" — each agent's system prompt defines both roles.

**Transferable Pattern**: For domain-specific crises, two crew members have a short focused conversation: Holden-Bobbie on combat tactics, Holden-Naomi on engineering crises, Holden-Avasarala on negotiation strategy. 6 LLM calls per conversation. Cheaper than full group deliberation, more nuanced than a single assessment.

**Why Not More**: Strictly dyadic — no group deliberation. Rigid phase ordering doesn't suit real-time game dynamics. The inception prompting technique (tell each agent about the other's role) is universally useful regardless of framework.

**Reference**: Qian, C., Cong, X., Yang, C., Chen, W., Su, Y., Xu, J., Liu, Z., & Sun, M. (2023). "Communicative Agents for Software Development." *arXiv preprint arXiv:2307.07924*. https://arxiv.org/abs/2307.07924

---

### 1.7 CrewAI — Sequential & Hierarchical

**Relevance: LOW**

Two modes: sequential pipeline (Agent A → B → C) or hierarchical (manager delegates to workers). The hierarchical mode maps to captain-delegates-to-specialists but is bottlenecked on the manager — every decision requires a manager LLM call. No support for debate, disagreement, or parallel execution.

**Why Not More**: Sequential is too rigid. Hierarchical is just a less elegant version of LangGraph's supervisor pattern. No mechanism for agents to push back on the manager. We already have a better version of this in our brain→subagent architecture.

**Reference**: CrewAI Concepts — https://docs.crewai.com/concepts/crews

---

### 1.8 CAMEL — Inception Prompting

**Relevance: LOW** (the technique is useful, the framework is not)

Role-playing framework using "inception prompting" — each agent receives a system prompt defining both its own role AND the other agent's role. This creates shared understanding. Strictly pairwise, the "AI User" always drives, no mechanism for disagreement.

**Why Not More**: Strictly pairwise, no group coordination. The Assistant is always compliant — no push-back mechanism. For 4 crew you'd need 6 pairwise conversations. However, the **inception prompting technique** (telling each agent about all roles) is valuable and framework-independent. We should use it in any multi-agent prompt design.

**Reference**: Li, G., Hammoud, H.A.A.K., Itani, H., Khizbullin, D., & Ghanem, B. (2023). "CAMEL: Communicative Agents for 'Mind' Exploration of Large Scale Language Model Society." *arXiv preprint arXiv:2303.17760*. https://arxiv.org/abs/2303.17760

---

### 1.9 Xiong et al. — Role Diversity in LLM Collaboration

**Relevance: MEDIUM** (validates our approach)

Shows that agent persona/role significantly affects collaboration outcomes. Agents with different expertise converge on better answers than homogeneous agents. This validates our crew design — Holden, Naomi, Bobbie, and Avasarala have genuinely different perspectives and values, which should produce better decisions than 4 copies of the same generalist.

**Reference**: Xiong, K., Ding, X., Cao, Y., Liu, T., & Qin, B. (2023). "Examining Inter-Consistency of Large Language Models Collaboration: An In-depth Analysis." *arXiv preprint arXiv:2305.11595*. https://arxiv.org/abs/2305.11595

---

### 1.10 Chan et al. — ChatEval (Multi-Agent Debate Protocols)

**Relevance: MEDIUM**

Compares structured debate protocols for evaluation tasks: one-by-one (sequential), simultaneous (parallel), and debate (adversarial). Key finding: **simultaneous protocol** (all agents respond in parallel, then see all responses) eliminates ordering bias and produces the most balanced outcomes. Sequential protocols bias toward the first speaker.

**Transferable Pattern**: When we implement crew debate, use simultaneous responses (all crew members generate recommendations in parallel) rather than sequential (where later speakers anchor on earlier ones). This is easy to implement — just fan out 4 parallel LLM calls.

**Reference**: Chan, C.M., Chen, W., Su, Y., Yu, J., Xue, W., Zhang, S., Fu, J., & Liu, Z. (2023). "ChatEval: Towards Better LLM-based Evaluators through Multi-Agent Debate." *arXiv preprint arXiv:2308.07201*. https://arxiv.org/abs/2308.07201

---

## Part 2: Structured Deliberation Models

### 2.1 Commander's Intent + Auftragstaktik (Mission-Type Tactics)

**Relevance: HIGH** — Primary coordination mechanism

Military doctrine where the commanding officer issues a statement of intent (objective, end state, constraints) and subordinates execute autonomously within their domain. The key insight from the OODA loop: **the side that cycles faster wins**. A good plan executed now beats a perfect plan executed too late.

Auftragstaktik adds **Schwerpunkt** (main effort) — the entire organization understands the single most important objective. If you don't know what to do, support the Schwerpunkt.

**Transferable Pattern**: Holden sets Commander's Intent ("trade route Alpha→Beta, arrive with cargo intact, 100+ credits profit, don't engage unless fired upon"). Each agent operates autonomously within their domain — Naomi manages fuel, Bobbie monitors threats, Avasarala handles comms. No permission needed for domain actions that serve the intent. Schwerpunkt provides session-level coherence ("this session we're upgrading shields").

**Why This Is Primary**: Zero deliberation LLM calls for routine operations. The game tick is the natural OODA cycle. This should be the default 95% of the time.

**Reference**: U.S. Army Field Manual FM 6-0, *Commander and Staff Organization and Operations*; Boyd, J. (1986). "Patterns of Conflict" (OODA loop origin); Widder, W. (2002). "Auftragstaktik and Innere Führung: Trademarks of German Leadership." *Military Review*, 82(5).

---

### 2.2 Consensus Decision-Making — Consent-with-Block

**Relevance: HIGH** — For values-laden decisions

A single block stops a proposal, but blocks must cite shared principles (not personal preference). Stand-asides record dissent without blocking. This maps perfectly to our crew: Holden blocks deception, Bobbie blocks abandoning allies, Naomi blocks removing autonomy, Avasarala blocks strategic suicide.

**Transferable Pattern**: For morally ambiguous decisions (piracy, betrayal, breaking deals), each agent states consent/stand-aside/block. A block must reference the blocker's VALUES.md. This produces character-consistent crew dynamics and prevents the crew from acting against its own values.

**Why Not More**: Too slow for tactical decisions. Only for high-stakes values conflicts.

**Reference**: Consensus decision-making is a broad tradition. Key texts: Butler, C.T. & Rothstein, A. (1987). *On Conflict and Consensus: A Handbook on Formal Consensus Decision-making*; Seeds for Change (2020). "A Consensus Handbook." https://www.seedsforchange.org.uk/consensus

---

### 2.3 Robert's Rules of Order — Motion/Second/Vote

**Relevance: MEDIUM** — For major commitments

Formal parliamentary procedure: motion → second → debate → amendment → vote. The "second" requirement filters low-value proposals. Amendments can modify proposals before voting.

**Transferable Pattern**: For major resource commitments (2000+ credits, faction warfare declarations, long-term alliances): any agent proposes, another must second it to proceed, each agent gets one argument for/against, majority vote, captain breaks ties.

**Why Not More**: Too formal for most game decisions. The motion/second/vote overhead is only justified for genuinely irreversible actions.

**Reference**: Robert, H.M. (1876). *Robert's Rules of Order*. Modern edition: Robert, H.M. III et al. (2020). *Robert's Rules of Order Newly Revised*, 12th ed.

---

### 2.4 Delphi Method — Anonymous Convergence

**Relevance: MEDIUM** — For quantitative estimates

Independent anonymous estimates → aggregate → revise → converge. Prevents authority bias. Structured outlier justification forces extreme positions to be explained.

**Transferable Pattern**: For risk/resource estimation: each agent independently estimates (fuel needed, combat encounters expected, profit potential). Orchestrator computes median. Outliers justify. Domain expert outliers carry weight (Bobbie on combat risk, Naomi on fuel). 2 rounds, 8-10 LLM calls.

**Why Not More**: Only useful for quantitative questions. Most game decisions are "what to do" not "how much," making this a niche protocol.

**Reference**: Dalkey, N. & Helmer, O. (1963). "An Experimental Application of the Delphi Method to the Use of Experts." *Management Science*, 9(3), 458-467; Linstone, H.A. & Turoff, M. (1975). *The Delphi Method: Techniques and Applications*.

---

### 2.5 Agile Retrospective

**Relevance: HIGH** — Maps directly to existing dinner phase

What worked / what didn't / what to try next. Time-boxed, structured, blame-free. Planning poker (simultaneous estimates with outlier discussion) is a fast convergence mechanism.

**Transferable Pattern**: The existing `dinner.ts` session reflection becomes a structured retro. Each agent reports what worked, what didn't, what to try. Cross-agent outcome tracking ("Bobbie's combat calls were correct 4/5 times") creates a self-improving feedback loop. Planning poker for risk estimates uses simultaneous reveal to prevent anchoring.

**Why Not More**: Already fits naturally. The main work is structuring the dinner prompt to follow retro format and accumulating cross-session statistics.

**Reference**: Derby, E. & Larsen, D. (2006). *Agile Retrospectives: Making Good Teams Great*. Pragmatic Bookshelf.

---

## Part 3: Reality TV Deliberation Models

### 3.1 Survivor — Secret Ballot with Jury Memory

**Relevance: MEDIUM** — The simultaneous reveal and prediction tracking

The gap between public statements and private votes creates interesting dynamics. The jury mechanic (tracking who was right over time) builds earned authority.

**Transferable Pattern**: For contested decisions, agents submit positions simultaneously (prevents anchoring). Track which agents' recommendations turned out correct over time — this builds data-driven authority weighting for future decisions.

**Why Not More**: Alliance/betrayal dynamics don't apply to a cooperative crew. The voting mechanics are designed for elimination, not collaboration. We extract the anti-anchoring (simultaneous reveal) and reputation tracking (jury memory) patterns and leave the rest.

---

### 3.2 Big Brother — Ceremony Sequence with Veto

**Relevance: MEDIUM** — The agenda-setter + veto structure

HoH sets the agenda (nominations), PoV can disrupt it. Power is explicitly temporary — HoH can't compete next week. The layered veto creates counter-strategy opportunities.

**Transferable Pattern**: For session planning, a rotating agenda-setter proposes priorities. Any agent can invoke one veto per cycle (must propose alternative). Agenda-setter can't repeat for N cycles. This ensures all agents' priorities get surfaced over time without any single agent dominating direction.

**Why Not More**: The nomination/eviction mechanics don't apply. The weekly cycle is too rigid for real-time game play. We extract the rotation + veto pattern.

---

### 3.3 The Circle — Mediated Text Communication & Information Asymmetry

**Relevance: MEDIUM** — Channel architecture

All communication is text-based through an app. Group chat, private DMs, public profiles. Perfectly maps to AI agents. Reputation flows from ratings. Information gatekeeping creates natural asymmetry.

**Transferable Pattern**: Channel architecture for crew communication — bridge (all crew), private DMs (two agents), public (other factions). Avasarala as information gatekeeper — she learns things through external DMs that she may or may not share with the crew. This creates natural information asymmetry that produces interesting crew dynamics.

**Why Not More**: The catfishing/deception mechanics are about inter-player trust, not intra-crew coordination. Ratings-based power doesn't suit a cooperative crew. We take the channel architecture.

---

### 3.4 The Mole — Trust Verification Protocols

**Relevance: LOW** — For external faction evaluation only

A hidden saboteur creates paranoia and observation-based gameplay. Players balance cooperation with surveillance.

**Transferable Pattern**: When cooperating with external factions, designate Avasarala to track whether the other party's actions match stated intentions. Use low-stakes "test tasks" before high-value cooperation. Periodic crew review: "what do we actually know about Faction X?"

**Why Not More**: Our crew is cooperative, not adversarial. The saboteur mechanic is irrelevant internally. Only applicable to external trust evaluation.

---

### 3.5 Amazing Race — Speed Over Consensus + Roadblocks

**Relevance: LOW** — The forcing function insight

Time pressure resolves all disagreements. Detour choices (pick one of two tasks) are fast binary decisions. Roadblocks force individual assignment based on capability.

**Transferable Pattern**: For operational decisions, optimize for speed — a suboptimal decision made quickly beats an optimal decision made slowly. Domain experts decide within their domain without deliberation. This reinforces Commander's Intent as the default protocol.

**Why Not More**: The race format doesn't map to our turn-based game. Pair coordination for teams of 2 doesn't scale to our crew of 4. The insight about speed is useful but is already captured by OODA/Commander's Intent.

---

### 3.6 Taskmaster — Creative Constraints

**Relevance: IGNORE**

Individual creativity within constraints, judged by an authority. Interesting for game design but not for multi-agent coordination — it's fundamentally a single-player format with external judging.

**Why Ignore**: No deliberation. No coordination. The "loophole awareness" insight (encourage creative interpretation of game mechanics) is worth noting but isn't a coordination pattern.

---

## Part 4: Synthesis — What We Keep

### Recommended Protocol Stack (by frequency of use)

| Priority | Protocol | Source | When | Token Cost |
|---|---|---|---|---|
| **Default** | Commander's Intent | Military doctrine | 95% of game ticks | 0 extra calls |
| **Planning** | Crew Briefing (pub-sub) | MetaGPT | Every planning cycle | 4-5 calls |
| **Consultation** | Supervisor as Tool-Caller | LangGraph | Brain decides when | 2-3 calls |
| **Crisis** | Dyadic Chat | ChatDev | Domain-specific crises | 6 calls |
| **Contested** | Crew Debate (simultaneous) | Du et al. + Chan et al. | Critical decisions | 11 calls |
| **Values** | Consent-with-Block | Consensus tradition | Morally ambiguous acts | 5-10 calls |
| **Reflection** | Retro | Agile | Session end (dinner) | Maps to existing |
| **Accountability** | After-Action Review | Military AAR doctrine | Post-mission | Maps to existing |

### Key Design Principles

1. **Situation classifier selects protocol** — the existing `SituationClassifier` recommends which coordination protocol to use. Most ticks → Commander's Intent (free).
2. **Simultaneous over sequential** — when agents give opinions, they do so in parallel to prevent anchoring bias (Chan et al.).
3. **Inception prompting** — every agent's prompt describes all crew roles, not just their own (CAMEL).
4. **Structured artifacts over freeform chat** — agents produce typed assessments, not conversation (MetaGPT).
5. **Token cost proportional to decision importance** — routine (0 calls) → planning (4 calls) → critical (11 calls).
6. **Jury memory / reputation tracking** — track whose recommendations were correct over time to build data-driven authority weighting (Survivor).

### What We Explicitly Reject

- **Full group chat for every decision** (AutoGen RoundRobin) — too expensive, too slow
- **Sequential pipelines** (CrewAI Sequential, MetaGPT SOP) — too rigid for real-time game
- **Manager bottleneck** (CrewAI Hierarchical) — we already have a better brain→subagent pattern
- **Elimination/voting mechanics** (Survivor, Big Brother eviction) — we're a cooperative crew
- **Catfishing/deception within crew** (The Circle) — our crew trusts each other
- **Single authority with no pushback** (CAMEL User/Assistant) — we want genuine disagreement

---

## Appendix: Full Citation List

### Academic Papers

1. Du, Y., Li, S., Torralba, A., Tenenbaum, J.B., & Mordatch, I. (2023). "Improving Factuality and Reasoning in Language Models through Multiagent Debate." *arXiv:2305.14325*. https://arxiv.org/abs/2305.14325

2. Liang, T., He, Z., Jiao, W., Wang, X., Wang, Y., Wang, R., Yang, Y., Tu, Z., & Shi, S. (2023). "Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate." *arXiv:2305.19118*. https://arxiv.org/abs/2305.19118

3. Chan, C.M., Chen, W., Su, Y., Yu, J., Xue, W., Zhang, S., Fu, J., & Liu, Z. (2023). "ChatEval: Towards Better LLM-based Evaluators through Multi-Agent Debate." *arXiv:2308.07201*. https://arxiv.org/abs/2308.07201

4. Xiong, K., Ding, X., Cao, Y., Liu, T., & Qin, B. (2023). "Examining Inter-Consistency of Large Language Models Collaboration: An In-depth Analysis." *arXiv:2305.11595*. https://arxiv.org/abs/2305.11595

5. Hong, S., Zhuge, M., Chen, J., et al. (2023). "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework." *arXiv:2308.00352*. https://arxiv.org/abs/2308.00352

6. Qian, C., Cong, X., Yang, C., et al. (2023). "Communicative Agents for Software Development." *arXiv:2307.07924*. https://arxiv.org/abs/2307.07924

7. Li, G., Hammoud, H.A.A.K., Itani, H., Khizbullin, D., & Ghanem, B. (2023). "CAMEL: Communicative Agents for 'Mind' Exploration of Large Scale Language Model Society." *arXiv:2303.17760*. https://arxiv.org/abs/2303.17760

8. Dalkey, N. & Helmer, O. (1963). "An Experimental Application of the Delphi Method to the Use of Experts." *Management Science*, 9(3), 458-467.

### Framework Documentation

9. LangGraph Multi-Agent Concepts. https://langchain-ai.github.io/langgraph/concepts/multi_agent/

10. AutoGen AgentChat User Guide. https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html

11. CrewAI Crew Concepts. https://docs.crewai.com/concepts/crews

12. MetaGPT GitHub. https://github.com/geekan/MetaGPT

### Books & Doctrine

13. Derby, E. & Larsen, D. (2006). *Agile Retrospectives: Making Good Teams Great*. Pragmatic Bookshelf.

14. Robert, H.M. III et al. (2020). *Robert's Rules of Order Newly Revised*, 12th ed.

15. Butler, C.T. & Rothstein, A. (1987). *On Conflict and Consensus: A Handbook on Formal Consensus Decision-making*.

16. Seeds for Change (2020). "A Consensus Handbook." https://www.seedsforchange.org.uk/consensus

17. Boyd, J. (1986). "Patterns of Conflict." Unpublished briefing slides (origin of the OODA loop).

18. Linstone, H.A. & Turoff, M. (1975). *The Delphi Method: Techniques and Applications*.
