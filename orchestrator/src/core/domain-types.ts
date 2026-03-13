/** Domain state — opaque to the core orchestration loop. */
export type DomainState = unknown

/** Domain situation — derived from DomainState by the SituationClassifier. */
export type DomainSituation = unknown

/** Domain event — raw event from the domain's event source. */
export type DomainEvent = unknown
