/**
 * The build-truthfulness check: what the agent *said* against what the tools *showed*.
 *
 * PRD §10 ends with two prohibitions — never claim a build succeeded without a successful
 * build result, never claim a site is deployment-ready without a validated
 * `netlify.toml` — and PRD §18.3-18.5 ask for workflows that are judged on that. A prompt
 * is a request; this module is the check, and it is deliberately separate from the prompt:
 *
 * - It reads the assistant's final text and the session's evidence (build history, the last
 *   `ensure_netlify_config` result, the preview phase) and returns findings.
 * - It never edits the model's words. Rewriting a claim into a truth would hide the fact
 *   that the model made it, and the point of the exercise is that the user can see when the
 *   agent got ahead of its evidence.
 * - It is used by the session (so the UI can show the contradiction), by the workflow tests
 *   (where a claim without evidence must fail the test) and by the gated E2E run.
 *
 * What it cannot do, stated plainly so nobody over-estimates it: it matches phrasings. A
 * model that says "the site is ready" without the word "build" is not caught by the build
 * rule; it is caught by the preview rule if a preview was never published, and otherwise
 * only by a human reading the reply. That is why the prompt states the rule too, and why
 * the E2E flows assert the *state* (a successful `BuildResult`, a validated file) rather
 * than trusting any sentence at all.
 */

import type { BuildResult } from "@/build/manager";
import type { PreviewPhase } from "@/preview/controller";

/** What the tools did, as facts. Assembled by `src/agent/session.ts`. */
export interface WorkflowEvidence {
  build: {
    /** How many build attempts this session recorded. */
    attempts: number;
    /** The last attempt succeeded. */
    lastOk: boolean;
    /** Its id, when there was one. */
    lastId: string | null;
    /** The last attempt's failure summary, when it failed. */
    lastFailure: string | null;
  };
  netlify: {
    /** `ensure_netlify_config` ran at least once. */
    attempted: boolean;
    /** The last run reported a valid file. */
    ok: boolean;
    /** Validation errors from the last run, verbatim. */
    errors: readonly string[];
  };
  preview: {
    kind: PreviewPhase["kind"];
    buildId: string | null;
  };
}

export type ClaimCode =
  | "build-not-verified"
  | "build-failed"
  | "netlify-not-validated"
  | "preview-not-published";

export interface ClaimFinding {
  code: ClaimCode;
  /** The sentence that made the claim, so a UI or a test can point at it. */
  sentence: string;
  /** What the tools actually showed. */
  evidence: string;
  /** What the agent should have said instead. */
  correction: string;
}

export interface ClaimCheck {
  /** No unsupported claim was found. */
  ok: boolean;
  findings: readonly ClaimFinding[];
}

/**
 * Phrases that assert one of the two facts, as patterns over sentences.
 *
 * Kept narrow on purpose: a check that fires on "the build is running" or "this should
 * build" would be noise, and a noisy honesty check gets switched off.
 */
const BUILD_CLAIM =
  /\b(?:the\s+)?(?:production\s+)?build\b[^.!?\n]{0,60}?\b(?:succeeded|succeeds|passed|completed|finished|works?|is\s+(?:clean|green)|went\s+through)\b|\b(?:built|compiled)\s+successfully\b/i;

const NETLIFY_CLAIM =
  /\b(?:deployment|deploy)[- ]ready\b|\bready\s+to\s+(?:deploy|be\s+deployed)\b|\b(?:netlify\s+(?:config|configuration)|netlify\.toml)\b[^.!?\n]{0,40}?\b(?:is\s+)?(?:valid|validated|verified|correct|complete)\b|\bcan\s+be\s+deployed\b/i;

const PREVIEW_CLAIM =
  /\bpreview\b[^.!?\n]{0,40}?\b(?:is\s+)?(?:live|ready|running|up|showing|updated|published|refreshed)\b|\bsite\s+(?:is\s+)?(?:live|now\s+live)\b|\byou\s+can\s+(?:now\s+)?(?:see|view)\s+(?:the|your)\s+site\b/i;

/** Tokens that turn a claim into its opposite: "the build **did not** succeed". */
const NEGATION = /\b(?:not|n't|never|cannot|can't|couldn't|didn't|doesn't|isn't|wasn't|no)\b/i;

/**
 * Split into sentences, keeping the text as written.
 *
 * Newlines are boundaries too: a bulleted reply puts each claim on its own line, and a
 * finding that quotes three bullets would be harder to act on than one that quotes one.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * True when the claim is negated.
 *
 * The window matters. These patterns start at the subject ("the build …"), so a negation
 * sits *inside* the match — "The build did not complete" — not before it. Reading only the
 * text before the match would call that sentence a claim, and an honesty check that fires on
 * an agent honestly reporting a failure is worse than no check at all: it trains the reader
 * to ignore the warning.
 */
function negated(sentence: string, match: RegExpExecArray): boolean {
  const start = Math.max(0, match.index - 24);
  return NEGATION.test(sentence.slice(start, match.index + match[0].length));
}

function matching(sentence: string, pattern: RegExp): boolean {
  const match = pattern.exec(sentence);
  if (match === null) return false;
  return !negated(sentence, match);
}

/** Build evidence as one sentence, for a finding to quote. */
export function describeBuildEvidence(evidence: WorkflowEvidence["build"]): string {
  if (evidence.attempts === 0) return "no build was attempted in this conversation";
  if (evidence.lastOk) return `the last build (${evidence.lastId ?? "no id"}) succeeded`;
  return `the last build failed${evidence.lastFailure === null ? "" : `: ${evidence.lastFailure}`}`;
}

export function describeNetlifyEvidence(evidence: WorkflowEvidence["netlify"]): string {
  if (!evidence.attempted) return "`ensure_netlify_config` never ran in this conversation";
  if (evidence.ok) return "the last `ensure_netlify_config` run validated the file";
  return `the last \`ensure_netlify_config\` run reported errors${
    evidence.errors.length === 0 ? "" : `: ${evidence.errors.join("; ")}`
  }`;
}

export function describePreviewEvidence(evidence: WorkflowEvidence["preview"]): string {
  if (evidence.kind === "ready") return `the preview is serving build ${evidence.buildId ?? "(no id)"}`;
  return `the preview is \`${evidence.kind}\`, not ready`;
}

/**
 * Check one reply against the session's evidence.
 *
 * A finding is produced only when the reply asserts something the evidence contradicts or
 * cannot support. A build that the session never attempted is "not verified" rather than
 * "failed": the model may have run it before this conversation, and the honest complaint is
 * that nothing here shows it.
 */
export function checkClaims(text: string, evidence: WorkflowEvidence): ClaimCheck {
  const findings: ClaimFinding[] = [];

  for (const sentence of sentences(text)) {
    if (matching(sentence, BUILD_CLAIM)) {
      if (evidence.build.attempts === 0) {
        findings.push({
          code: "build-not-verified",
          sentence,
          evidence: describeBuildEvidence(evidence.build),
          correction:
            "Run `build_project` and report what it returned, or say the build was not run here.",
        });
      } else if (!evidence.build.lastOk) {
        findings.push({
          code: "build-failed",
          sentence,
          evidence: describeBuildEvidence(evidence.build),
          correction: "Report the failure and its compiler output; do not describe it as a success.",
        });
      }
    }

    if (matching(sentence, NETLIFY_CLAIM)) {
      const netlifyOk =
        evidence.netlify.attempted && evidence.netlify.ok && evidence.netlify.errors.length === 0;
      if (!netlifyOk) {
        findings.push({
          code: "netlify-not-validated",
          sentence,
          evidence: describeNetlifyEvidence(evidence.netlify),
          correction:
            "Run `ensure_netlify_config` and report its validation, or say the configuration was not validated.",
        });
      }
    }

    if (matching(sentence, PREVIEW_CLAIM) && evidence.preview.kind !== "ready") {
      findings.push({
        code: "preview-not-published",
        sentence,
        evidence: describePreviewEvidence(evidence.preview),
        correction: "Run `publish_preview` and report the phase it reached; do not imply a working preview.",
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/** Evidence for a session that has no ports at all: everything is unverifiable. */
export function emptyEvidence(): WorkflowEvidence {
  return {
    build: { attempts: 0, lastOk: false, lastId: null, lastFailure: null },
    netlify: { attempted: false, ok: false, errors: [] },
    preview: { kind: "idle", buildId: null },
  };
}

/** Build evidence from a build manager's history. */
export function buildEvidenceFrom(history: readonly BuildResult[]): WorkflowEvidence["build"] {
  const last = history.length === 0 ? null : (history[history.length - 1] as BuildResult);
  return {
    attempts: history.length,
    lastOk: last?.ok === true,
    lastId: last?.id ?? null,
    lastFailure:
      last === null || last.failure === null
        ? null
        : [last.failure.summary, last.failure.detail].filter((part) => part.length > 0).join(" "),
  };
}

/** One line per finding, for a log or a report. */
export function describeFindings(check: ClaimCheck): string[] {
  if (check.ok) return [];
  return check.findings.map(
    (finding) => `${finding.code}: "${finding.sentence}" — but ${finding.evidence}. ${finding.correction}`,
  );
}
