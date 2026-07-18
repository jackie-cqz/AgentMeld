import type { E2ERunResult } from "../../e2e-runner/types";
import type { ComposedVerdict, JudgeExecution } from "./judge-types";

export function composeVerdict(
  deterministic: E2ERunResult,
  judge: JudgeExecution | null,
  requiredForPass: boolean,
): ComposedVerdict {
  const deterministicVerdict = deterministic.status;
  if (deterministic.status !== "passed") {
    return {
      deterministicVerdict,
      semanticVerdict: semanticVerdict(judge),
      finalVerdict: deterministic.status === "error" || deterministic.status === "blocked" || deterministic.status === "budget_exceeded" ? "blocked" : "failed",
      reason: "Required deterministic evidence failed; semantic scoring cannot override a hard gate.",
    };
  }
  if (!judge || judge.status === "disabled") {
    return { deterministicVerdict, semanticVerdict: "not_requested", finalVerdict: "passed", reason: "Deterministic gates passed; semantic judging was not requested." };
  }
  if (judge.status === "pending") {
    return { deterministicVerdict, semanticVerdict: "pending", finalVerdict: requiredForPass ? "blocked" : "passed", reason: requiredForPass ? "A required semantic verdict is pending." : "Deterministic gates passed; optional semantic review is pending." };
  }
  if (judge.status === "failed" || !judge.result) {
    return { deterministicVerdict, semanticVerdict: "error", finalVerdict: requiredForPass ? "blocked" : "passed", reason: requiredForPass ? "Required semantic judging failed." : "Optional semantic judging failed; deterministic verdict is retained." };
  }
  if (judge.result.verdict === "needs_human_review") {
    return { deterministicVerdict, semanticVerdict: "needs_human_review", finalVerdict: "needs_human_review", reason: "Judge confidence or evidence was insufficient; human review is required." };
  }
  if (judge.result.verdict === "failed" && requiredForPass) {
    return { deterministicVerdict, semanticVerdict: "failed", finalVerdict: "failed", reason: "Deterministic gates passed, but the required semantic rubric failed." };
  }
  return {
    deterministicVerdict,
    semanticVerdict: judge.result.verdict,
    finalVerdict: "passed",
    reason: judge.result.verdict === "passed" ? "Deterministic and semantic evaluations passed." : "Deterministic gates passed; optional semantic issues are reported separately.",
  };
}

function semanticVerdict(judge: JudgeExecution | null): ComposedVerdict["semanticVerdict"] {
  if (!judge || judge.status === "disabled") return "not_requested";
  if (judge.status === "pending") return "pending";
  if (judge.status === "failed" || !judge.result) return "error";
  return judge.result.verdict;
}
