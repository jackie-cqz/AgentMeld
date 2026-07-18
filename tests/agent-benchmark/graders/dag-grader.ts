import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const dagEdgeGrader: BenchmarkGrader = {
  type: "dag_edge",
  grade(assertion, context) {
    if (assertion.type !== "dag_edge") throw new Error("dagEdgeGrader received an incompatible assertion.");
    const producers = findTasksByRole(context.trace.tasks, assertion.fromRole);
    const consumers = findTasksByRole(context.trace.tasks, assertion.toRole);
    const match = consumers.flatMap((consumer) =>
      producers
        .filter((producer) =>
          consumer.dependsOn.includes(producer.taskId) &&
          (!assertion.outputKey || (
            producer.producedBindings.some((binding) => binding.outputKey === assertion.outputKey) ||
            consumer.consumedInputs.some((input) =>
              input.fromTaskId === producer.taskId &&
              input.outputKey === assertion.outputKey &&
              input.bindingVerified
            )
          ))
        )
        .map((producer) => ({ producer, consumer }))
    )[0];

    return assertionResult(
      assertion,
      !!match,
      match
        ? `DAG edge ${match.producer.taskId} -> ${match.consumer.taskId} is present.`
        : `No DAG edge from ${assertion.fromRole} to ${assertion.toRole}${assertion.outputKey ? ` carrying ${assertion.outputKey}` : ""} was found.`,
      match
        ? [{ runId: context.trace.conductorRunId, taskId: match.producer.taskId }, { taskId: match.consumer.taskId }]
        : [],
    );
  },
};
