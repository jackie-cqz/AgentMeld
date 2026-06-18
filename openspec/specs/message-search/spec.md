# Message Search

## Purpose

Defines local full-text search across persisted message text parts. Detailed behavior lives in `specs/16-message-search.md`.

## Requirements

### Requirement: Search SHALL index public text parts only

Search MUST index `text` message parts after a message leaves streaming state. Thinking, tool calls, tool results, and artifact content MUST NOT be indexed.

#### Scenario: A streaming message completes
- **WHEN** its status changes from `streaming` to a terminal status
- **THEN** its text parts become searchable
- **AND** tool payloads remain excluded.

### Requirement: Search SHALL support Chinese and English queries

The primary path SHALL use SQLite FTS5 trigram search. Short Chinese queries SHALL use a text-part-only LIKE fallback.

#### Scenario: User searches a two-character Chinese term
- **WHEN** the query contains fewer than three Han characters
- **THEN** the client requests LIKE fallback
- **AND** matching text parts are returned.

### Requirement: Search results SHALL navigate to messages

Search results MUST include conversation, sender, timestamp, snippet, and message id metadata.

#### Scenario: User selects a result
- **WHEN** the result belongs to another conversation
- **THEN** the frontend opens that conversation
- **AND** scrolls the message into view
- **AND** highlights it temporarily.

### Requirement: Search input SHALL be bounded

The API MUST validate query length, limit, offset, role, and fallback mode. Unsupported FTS syntax SHALL return a structured validation error.
