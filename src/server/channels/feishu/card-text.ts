/**
 * Neutralise card markup in text this bot did not author.
 *
 * Question text, headers and similar come from a model, and `lark_md` renders
 * tags — an `<at id=all></at>` in a question would summon the whole room in this
 * bot's name. Stripping the angle brackets leaves the text readable and inert;
 * this is the same treatment the SDK applies to names it puts into mentions.
 *
 * Lives in its own module because both the question/approval cards and the
 * progress card need it, and the first imports the second.
 */
export function escapeLarkMd(text: string): string {
  return text.replace(/[<>]/g, "");
}

/**
 * Why a card's button values carry a version.
 *
 * The SDK drops a card click BEFORE it reaches our handler when the same person
 * has already sent the same value on the same message — the key is the message,
 * the operator, and the action's tag, name, option and first 128 characters of
 * its value — and it remembers that for twelve hours, across restarts. A button
 * whose value never changes can therefore be pressed once per person per card,
 * and every later press is silently ignored: no toast, no error, nothing.
 *
 * That is harmless for a button that is pressed once (approve, cancel, a single
 * answer) and fatal for one that is meant to be pressed again (status), or for
 * an answer that can be changed back to an earlier choice. So every rewrite of a
 * card gives its buttons a new `v`, and a click on the freshly written card is a
 * different action to the SDK.
 *
 * The version is bumped only when the rewrite has actually been delivered. A
 * card that did not change keeps the value it was sent with, and the next click
 * must carry that one. If a rewrite fails, the card on screen still has the old
 * version and the click is still deduplicated: that case degrades to "pressing
 * again does nothing", never to a wrong answer. The limit is stated rather than
 * hidden.
 */
export function withVersion<T extends object>(value: T, version: number): T & { v: number } {
  return { ...value, v: version };
}
