# Synthetic OpenThoughts-Like Slice

Each JSONL record contains `domain`, `question`, and `response`.

For records where `domain` is exactly `science`, compose the counted text as:

```text
Question: {question}\nAnswer: {response}
```

Encode each composed text independently with the tokenizer identified in `tokenizer-lock.json`, with `add_special_tokens=false`, then sum token counts.

