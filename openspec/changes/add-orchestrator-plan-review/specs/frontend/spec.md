# Frontend Delta

## MODIFIED Requirements

### Requirement: Store reducers SHALL apply StreamEvent deterministically

Zustand reducers MUST update pending dispatch plan review state from StreamEvent payloads.

#### Scenario: Pending plan event arrives
- **WHEN** `dispatch.plan.pending` arrives
- **THEN** the store creates a dispatch state for the run
- **AND** marks its review status as pending.

#### Scenario: Plan review resolves
- **WHEN** `dispatch.plan.resolved` arrives
- **THEN** the store removes the pending review marker
- **AND** records whether the plan was approved or rejected.

### Requirement: Frontend SHALL expose Orchestrator plan review

The dispatch plan card MUST let users review and edit a pending Orchestrator plan before execution.

#### Scenario: User approves an edited plan
- **WHEN** a dispatch plan is pending review
- **AND** the user edits task fields and approves
- **THEN** the frontend submits the full edited plan to the pending plan API
- **AND** waits for SSE events to transition the card into execution progress.

#### Scenario: User rejects a plan
- **WHEN** a dispatch plan is pending review
- **AND** the user rejects it
- **THEN** the frontend submits a reject action
- **AND** the card displays the rejected state without child task progress.
