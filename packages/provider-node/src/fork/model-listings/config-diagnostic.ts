import { ZodError, type ZodIssue } from "zod";
import { UnsupportedProviderConfigVersionError } from "../../provider-config-file-codec.js";

export function describeRejectedProviderConfig(error: unknown): string {
  // JSON parse errors and custom validation messages can quote credentials from the file.
  if (error instanceof SyntaxError) return "invalid JSON";
  if (error instanceof UnsupportedProviderConfigVersionError) {
    return error.version === null
      ? "schemaVersion is missing or invalid"
      : `unsupported schemaVersion ${error.version}`;
  }
  if (error instanceof ZodError) return error.issues.map(describeConfigIssue).join(", ");
  return "could not read the file";
}

function describeConfigIssue(issue: ZodIssue): string {
  const path = issue.path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${String(part)}`,
    )
    .join("");
  const detail = configIssueDetail(issue);
  return path ? `${path} (${detail})` : detail;
}

function configIssueDetail(issue: ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys": {
      const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
      return `unrecognised ${issue.keys.length === 1 ? "key" : "keys"} ${keys}`;
    }
    case "invalid_type":
      return `expected ${issue.expected}`;
    default:
      return "invalid value";
  }
}
