import type {
  BenchmarkConsultationValidation,
  BenchmarkRole,
} from "@/server/context-metrics/benchmark-types";

import type { BenchmarkGrader, BenchmarkGraderContext } from "./grader-types";
import { assertionResult } from "./grader-types";

function consultationsForRole(
  context: BenchmarkGraderContext,
  role: BenchmarkRole,
): BenchmarkConsultationValidation[] {
  return (context.runtimeValidation?.consultations ?? []).filter(
    (consultation) => consultation.sourceRole === role,
  );
}

/**
 * The produced artifact must contain a distinctive token taken from the peer's
 * actual recorded answer. The codename is chosen by the peer at runtime and is
 * present nowhere in the case prompt or workspace, so the artifact cannot
 * satisfy this by guessing: the consulting role has to receive the reply.
 */
export const consultationReflectedGrader: BenchmarkGrader = {
  type: "consultation_reflected",
  grade(assertion, context) {
    if (assertion.type !== "consultation_reflected") {
      throw new Error("consultationReflectedGrader received an incompatible assertion.");
    }
    const consultations = consultationsForRole(context, assertion.role);
    const replied = consultations.filter(
      (consultation) => consultation.status === "replied" && Boolean(consultation.answer),
    );
    if (replied.length === 0) {
      const observed = consultations.map((consultation) => consultation.status).join(", ") || "none";
      return assertionResult(
        assertion,
        false,
        `Role ${assertion.role} has no replied peer consultation (recorded statuses: ${observed}).`,
      );
    }
    const artifacts = (context.runtimeValidation?.artifacts ?? []).filter(
      (artifact) =>
        artifact.outputKey === assertion.outputKey
        && artifact.artifactType === assertion.artifactType
        && artifact.valid,
    );
    if (artifacts.length === 0) {
      return assertionResult(
        assertion,
        false,
        `No valid ${assertion.artifactType} artifact is bound to ${assertion.outputKey} for role ${assertion.role}.`,
      );
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(assertion.answerPattern, "gi");
    } catch {
      return assertionResult(assertion, false, `answerPattern ${assertion.answerPattern} is not a valid regular expression.`);
    }
    for (const consultation of replied) {
      const tokens = [...new Set((consultation.answer ?? "").match(pattern) ?? [])];
      for (const artifact of artifacts) {
        const matched = tokens.find((token) => (artifact.contentText ?? "").includes(token));
        if (matched) {
          return assertionResult(
            assertion,
            true,
            `Artifact ${artifact.artifactId} contains "${matched}" from the reply to consultation ${consultation.id}.`,
            [{
              runId: context.trace.conductorRunId,
              taskId: artifact.taskId,
              artifactId: artifact.artifactId,
            }],
          );
        }
      }
    }
    const excerpt = replied
      .map((consultation) => (consultation.answer ?? "").slice(0, 120))
      .join(" | ");
    return assertionResult(
      assertion,
      false,
      `The ${assertion.outputKey} artifact contains no token matching ${assertion.answerPattern} `
      + `from the actual peer reply: ${excerpt}`,
    );
  },
};

/**
 * Proves the consultation lifecycle, not just that the tool was called: the
 * peer replied, its owned run was torn down, the lent workspace lease was
 * returned unpoisoned, and a replay did not start a second peer run.
 */
export const consultationLifecycleGrader: BenchmarkGrader = {
  type: "consultation_lifecycle",
  grade(assertion, context) {
    if (assertion.type !== "consultation_lifecycle") {
      throw new Error("consultationLifecycleGrader received an incompatible assertion.");
    }
    const consultations = consultationsForRole(context, assertion.role);
    const replied = consultations.filter((consultation) => consultation.status === "replied");
    const failures: string[] = [];

    if (assertion.requireReplied !== false && replied.length === 0) {
      failures.push(`no replied consultation was recorded for role ${assertion.role}`);
    }

    if (assertion.requirePeerTornDown !== false) {
      for (const consultation of replied) {
        if (!consultation.targetRunId) {
          failures.push(`consultation ${consultation.id} has no owned peer run`);
          continue;
        }
        if (consultation.peerRunStatus !== "complete") {
          failures.push(
            `peer run ${consultation.targetRunId} for consultation ${consultation.id} `
            + `ended as ${consultation.peerRunStatus ?? "missing"} instead of complete`,
          );
        }
      }
    }

    if (assertion.requireLeaseRestored !== false) {
      const lease = context.runtimeValidation?.workspaceLease;
      if (!lease) {
        failures.push("workspace lease state was not collected");
      } else if (lease.poisoned) {
        failures.push(`workspace lease ${lease.workspaceKey} is poisoned; peer teardown was not confirmed`);
      } else if (lease.held) {
        failures.push(
          `workspace lease ${lease.workspaceKey} is still held by child pid ${lease.childPid ?? "unknown"}`,
        );
      }
    }

    if (assertion.requireReplayBounded) {
      const requestKeys = new Set<string>();
      for (const consultation of consultations) {
        const key = `${consultation.sourceRunId}::${consultation.requestKey}`;
        if (requestKeys.has(key)) {
          failures.push(`consultation request key ${consultation.requestKey} was replayed as a new consultation`);
        }
        requestKeys.add(key);
      }
      const peerRuns = new Set<string>();
      for (const consultation of replied) {
        if (!consultation.targetRunId) continue;
        if (peerRuns.has(consultation.targetRunId)) {
          failures.push(`peer run ${consultation.targetRunId} served more than one consultation`);
        }
        peerRuns.add(consultation.targetRunId);
      }
    }

    if (assertion.requireNoExpired) {
      const expired = consultations.filter((consultation) => consultation.status === "expired");
      if (expired.length > 0) {
        failures.push(`${expired.length} consultation grant(s) expired before a reply`);
      }
    }

    if (failures.length > 0) {
      return assertionResult(assertion, false, failures.join("; "));
    }
    return assertionResult(
      assertion,
      true,
      `Role ${assertion.role} recorded ${replied.length} replied peer consultation(s); `
      + "peer run complete and workspace lease restored.",
      replied.map((consultation) => ({
        runId: consultation.targetRunId ?? context.trace.conductorRunId,
      })),
    );
  },
};
