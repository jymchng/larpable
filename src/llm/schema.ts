/**
 * Argument validation for tool calls (PRD §9.3, "strict input schemas", "argument
 * validation").
 *
 * A model's arguments are untrusted input that happens to be JSON. Three things can be
 * wrong with them, and all three must produce a *readable* error rather than an
 * exception, because the loop hands the message back to the model so it can try again:
 *
 * - the JSON does not parse at all;
 * - it parses but is not an object;
 * - it is an object but a field is missing, of the wrong type, or out of range.
 *
 * The validator is deliberately strict about unknown properties. A typo in a field name
 * (`contents` instead of `content`) would otherwise silently write an empty file, and the
 * model would believe it had succeeded.
 */

import type { ToolParameterSchema } from "./types";

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: readonly string[] };

/** Render issues for a tool result: one line each, no stack traces, no provider jargon. */
export function describeIssues(issues: readonly string[]): string {
  if (issues.length === 0) return "The arguments were rejected.";
  return `The arguments were rejected:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

/**
 * Parse and validate a tool call's arguments against its schema.
 *
 * ```ts
 * validateToolArguments(schema, '{"path":"src/App.tsx"}');
 * // { ok: true, value: { path: "src/App.tsx" } }
 * validateToolArguments(schema, '{"path":42}');
 * // { ok: false, issues: ["path must be a string"] }
 * ```
 */
export function validateToolArguments(
  schema: ToolParameterSchema,
  raw: string,
): ValidationResult {
  if (raw.trim().length === 0) return validate(schema, {}, true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, issues: [`the arguments are not valid JSON (${message})`] };
  }
  return validate(schema, parsed, false);
}

function validate(
  schema: ToolParameterSchema,
  value: unknown,
  treatUndefinedAsEmptyObject: boolean,
): ValidationResult {
  const issues: string[] = [];
  const checked = validateValue(schema, value, "", issues, treatUndefinedAsEmptyObject);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: checked as Record<string, unknown> };
}

function validateValue(
  schema: ToolParameterSchema,
  value: unknown,
  path: string,
  issues: string[],
  treatUndefinedAsEmptyObject = false,
): unknown {
  const where = path.length === 0 ? "the arguments" : path;

  switch (schema.type) {
    case "object": {
      if (value === undefined || value === null) {
        if (treatUndefinedAsEmptyObject) {
          value = {};
        } else {
          issues.push(`${where} must be an object`);
          return value;
        }
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        issues.push(`${where} must be an object`);
        return value;
      }
      const record = value as Record<string, unknown>;
      const required = schema.required ?? [];
      for (const key of required) {
        if (record[key] === undefined) issues.push(`${label(path, key)} is required`);
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        const entry = record[key];
        if (entry === undefined) continue;
        validateValue(child, entry, label(path, key), issues);
      }
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          issues.push(
            `${label(path, key)} is not a known field (known: ${Object.keys(schema.properties).join(", ")})`,
          );
        }
      }
      return record;
    }
    case "string": {
      if (typeof value !== "string") {
        issues.push(`${where} must be a string`);
        return value;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        issues.push(`${where} must be one of ${schema.enum.join(", ")}`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push(`${where} must be at least ${String(schema.minLength)} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push(`${where} must be at most ${String(schema.maxLength)} characters`);
      }
      return value;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        issues.push(`${where} must be a ${schema.type}`);
        return value;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        issues.push(`${where} must be an integer`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push(`${where} must be at least ${String(schema.minimum)}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push(`${where} must be at most ${String(schema.maximum)}`);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") issues.push(`${where} must be a boolean`);
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push(`${where} must be an array`);
        return value;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push(`${where} must hold at least ${String(schema.minItems)} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push(`${where} must hold at most ${String(schema.maxItems)} items`);
      }
      value.forEach((item, index) => {
        validateValue(schema.items, item, `${path}[${String(index)}]`, issues);
      });
      return value;
    }
    default: {
      const exhaustive: never = schema;
      issues.push(`unsupported schema at ${String(exhaustive)}`);
      return value;
    }
  }
}

function label(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}
