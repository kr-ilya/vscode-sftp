import { parse as parseJsonc, printParseErrorCode, ParseError } from 'jsonc-parser';

/**
 * Parses the text of a config file.
 *
 * JSONC, not JSON: a config file is something a person edits by hand and
 * frequently wants to annotate -- "this profile is staging", a host commented
 * out for the afternoon -- and until now doing either made the file silently
 * unloadable. Comments and trailing commas are accepted.
 *
 * Pure by design: no file system, no editor API, so the parsing rules can be
 * tested directly rather than through a loader.
 */
export function parseConfigContent(content: string, sourceLabel: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    // Report the first error only: the rest are usually cascade noise from the
    // same mistake, and pointing at one offset is more actionable than five.
    const [first] = errors;
    throw new Error(
      `${sourceLabel} is not valid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }

  return parsed;
}
