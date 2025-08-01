import { defaultStepConfig } from "../internal/utils";
import {
  createWorkflowStepStartEvent,
  createWorkflowStepSuccessEvent,
  createWorkflowStepErrorEvent,
  publishWorkflowEvent,
  createStepContext,
} from "../event-utils";
import { matchStep } from "./helpers";
import type { WorkflowStepConditionalWhen, WorkflowStepConditionalWhenConfig } from "./types";
import { getGlobalLogger } from "../../logger";

/**
 * Creates a conditional step for the workflow that executes only when a condition is met
 *
 * @example
 * ```ts
 * const w = createWorkflow(
 *   andWhen({
 *     condition: (data) => data.userType === "admin",
 *     stepOrFunc: andThen(async (data) => {
 *       return { ...data, permissions: ["read", "write", "delete"] };
 *     })
 *   }),
 *   andWhen({
 *       condition: (data) => data.value > 100,
 *     andAgent(
 *       (data) => `Process high value transaction: ${data.value}`,
 *       agent,
 *       { schema: z.object({ processed: z.boolean() }) }
 *     )
 *   )
 * );
 * ```
 *
 * @param condition - Function that determines if the step should execute based on the input data
 * @param stepOrFunc - Either a workflow step or an agent to execute when the condition is true
 * @returns A conditional workflow step that executes the step only when the condition evaluates to true
 */
export function andWhen<INPUT, DATA, RESULT>({
  condition,
  step,
  inputSchema,
  outputSchema,
  suspendSchema,
  resumeSchema,
  ...config
}: WorkflowStepConditionalWhenConfig<INPUT, DATA, RESULT>) {
  const finalStep = matchStep<INPUT, DATA, RESULT>(step);
  return {
    ...defaultStepConfig(config),
    type: "conditional-when",
    condition,
    originalCondition: condition, // ✅ Store original condition for serialization
    inputSchema,
    outputSchema,
    suspendSchema,
    resumeSchema,
    execute: async (context) => {
      const { data, state } = context;
      // No workflow context, execute without events
      if (!state.workflowContext) {
        if (await condition(context)) {
          return await finalStep.execute(context);
        }
        return data;
      }

      // ✅ Serialize condition function for event tracking
      const stepFunction = condition.toString();

      // Create step context and publish start event
      const stepContext = createStepContext(
        state.workflowContext,
        "conditional-when",
        config.name || config.id,
      );
      const stepStartEvent = createWorkflowStepStartEvent(
        stepContext,
        state.workflowContext,
        data, // ✅ Pass input data
        {
          stepFunction,
          userContext: state.workflowContext.userContext,
        },
      );

      try {
        await publishWorkflowEvent(stepStartEvent, state.workflowContext);
      } catch (eventError) {
        getGlobalLogger()
          .child({ component: "workflow", stepType: "when" })
          .warn("Failed to publish workflow step start event:", { error: eventError });
      }

      try {
        const conditionMet = await condition(context);
        let result: any;

        if (conditionMet) {
          // ✅ FIXED: Execute nested step WITHOUT workflow context to prevent duplicate events
          // Wrapper conditional step already publishes the appropriate events
          const nestedContext = {
            ...context,
            state: {
              ...state,
              workflowContext: undefined, // ❌ Remove workflow context to prevent nested event publishing
            },
          };
          result = await finalStep.execute(nestedContext);
        } else {
          // Condition not met, return original data
          result = data;
        }

        // Publish step success event with condition result
        const stepSuccessEvent = createWorkflowStepSuccessEvent(
          stepContext,
          state.workflowContext,
          { result, conditionMet },
          stepStartEvent.id,
          {
            isSkipped: !conditionMet,
            stepFunction,
            userContext: state.workflowContext.userContext,
          },
        );

        try {
          await publishWorkflowEvent(stepSuccessEvent, state.workflowContext);
        } catch (eventError) {
          getGlobalLogger()
            .child({ component: "workflow", stepType: "when" })
            .warn("Failed to publish workflow step success event:", { error: eventError });
        }

        return result;
      } catch (error) {
        // Check if this is a suspension, not an error
        if (error instanceof Error && error.message === "WORKFLOW_SUSPENDED") {
          // For suspension, we don't publish an error event
          // The workflow core will handle publishing the suspend event
          throw error;
        }

        // Publish step error event for actual errors
        const stepErrorEvent = createWorkflowStepErrorEvent(
          stepContext,
          state.workflowContext,
          error,
          stepStartEvent.id,
          {
            stepFunction,
            userContext: state.workflowContext.userContext,
          },
        );

        try {
          await publishWorkflowEvent(stepErrorEvent, state.workflowContext);
        } catch (eventError) {
          getGlobalLogger()
            .child({ component: "workflow", stepType: "when" })
            .warn("Failed to publish workflow step error event:", { error: eventError });
        }

        throw error;
      }
    },
  } as WorkflowStepConditionalWhen<INPUT, DATA, RESULT>;
}
