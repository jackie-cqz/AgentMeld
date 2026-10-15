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
