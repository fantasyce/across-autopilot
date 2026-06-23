export const FAILURE_CODES = Object.freeze({
  SPEC_INVALID: "spec.invalid",
  CAPABILITY_MISSING: "capability.missing",
  ACTION_BLOCKED: "action.blocked",
  APPROVAL_REQUIRED: "approval.required",
  SOURCE_UNREACHABLE: "source.unreachable",
  SOURCE_RATE_LIMITED: "source.rate_limited",
  SOURCE_INVALID_CONTENT: "source.invalid_content",
  ADAPTER_TIMEOUT: "adapter.timeout",
  ADAPTER_DISABLED: "adapter.disabled",
  ADAPTER_INVALID_OUTPUT: "adapter.invalid_output",
  ORCHESTRATOR_SUBMIT_FAILED: "orchestrator.submit_failed",
  ORCHESTRATOR_TASK_FAILED: "orchestrator.task_failed",
  ORCHESTRATOR_CANCEL_FAILED: "orchestrator.cancel_failed",
  GATE_FAILED: "gate.failed",
  CONTEXT_REJECTED: "context.rejected",
  CONTEXT_REDACTED: "context.redacted",
  CONTEXT_UNAVAILABLE: "context.unavailable",
  SANDBOX_VIOLATION: "sandbox.violation",
  OUTPUT_WRITE_FAILED: "output.write_failed",
  TELEMETRY_FAILED: "telemetry.failed",
  RUNTIME_BUDGET_EXCEEDED: "runtime.budget_exceeded",
  RETRY_EXHAUSTED: "retry.exhausted",
  RUN_CANCELLED: "run.cancelled",
  INTERNAL_UNEXPECTED: "internal.unexpected"
});

const RETRYABLE_BY_DEFAULT = new Set([
  FAILURE_CODES.SOURCE_UNREACHABLE,
  FAILURE_CODES.SOURCE_RATE_LIMITED,
  FAILURE_CODES.ADAPTER_TIMEOUT,
  FAILURE_CODES.ORCHESTRATOR_SUBMIT_FAILED,
  FAILURE_CODES.CONTEXT_UNAVAILABLE
]);

const NEVER_RETRYABLE = new Set([
  FAILURE_CODES.SPEC_INVALID,
  FAILURE_CODES.ACTION_BLOCKED,
  FAILURE_CODES.APPROVAL_REQUIRED,
  FAILURE_CODES.RUNTIME_BUDGET_EXCEEDED,
  FAILURE_CODES.SANDBOX_VIOLATION,
  FAILURE_CODES.CONTEXT_REJECTED
]);

export class LoopFailure extends Error {
  constructor({ code, message, failedState, adapterId = null, evidenceRefs = [], causedBy = [], retryable = undefined, recovery = null }) {
    super(message || code);
    this.name = "LoopFailure";
    this.code = code || FAILURE_CODES.INTERNAL_UNEXPECTED;
    this.failed_state = failedState || "unknown";
    this.adapter_id = adapterId;
    this.evidence_refs = evidenceRefs;
    this.caused_by = causedBy;
    this.retryable = retryable === undefined ? retryableForCode(this.code) : Boolean(retryable);
    this.recovery = recovery || recoveryForCode(this.code, this.retryable);
  }

  toJSON() {
    return failureObject({
      code: this.code,
      failedState: this.failed_state,
      adapterId: this.adapter_id,
      message: this.message,
      evidenceRefs: this.evidence_refs,
      causedBy: this.caused_by,
      retryable: this.retryable,
      recovery: this.recovery
    });
  }
}

export function failureObject({ code, failedState, adapterId = null, message, evidenceRefs = [], causedBy = [], retryable = undefined, recovery = null }) {
  const finalCode = code || FAILURE_CODES.INTERNAL_UNEXPECTED;
  const finalRetryable = retryable === undefined ? retryableForCode(finalCode) : Boolean(retryable);
  return {
    code: finalCode,
    retryable: finalRetryable,
    failed_state: failedState || "unknown",
    adapter_id: adapterId,
    message: message || finalCode,
    recovery: recovery || recoveryForCode(finalCode, finalRetryable),
    evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    caused_by: Array.isArray(causedBy) ? causedBy : []
  };
}

export function failureFromError(error, failedState = "unknown") {
  if (error instanceof LoopFailure) return error.toJSON();
  return failureObject({
    code: error?.code || FAILURE_CODES.INTERNAL_UNEXPECTED,
    failedState,
    adapterId: error?.adapter_id || null,
    message: error?.message || String(error || "Unexpected failure"),
    evidenceRefs: error?.evidence_refs || [],
    causedBy: error?.caused_by || []
  });
}

export function retryableForCode(code) {
  if (NEVER_RETRYABLE.has(code)) return false;
  if (RETRYABLE_BY_DEFAULT.has(code)) return true;
  return false;
}

export function recoveryForCode(code, retryable = retryableForCode(code)) {
  if (retryable) {
    return {
      type: "retry",
      description: "Retry after the adapter or upstream backoff window.",
      requires_user_action: false
    };
  }
  if (code === FAILURE_CODES.APPROVAL_REQUIRED) {
    return {
      type: "approval",
      description: "Review and approve or deny the blocked action in the host workbench.",
      requires_user_action: true
    };
  }
  if (code === FAILURE_CODES.ACTION_BLOCKED || code === FAILURE_CODES.SANDBOX_VIOLATION) {
    return {
      type: "spec_change",
      description: "Change the LoopSpec action policy or output scope before retrying.",
      requires_user_action: true
    };
  }
  if (code === FAILURE_CODES.RUNTIME_BUDGET_EXCEEDED) {
    return {
      type: "policy_change",
      description: "Review the runtime policy budget or reduce the loop scope before retrying.",
      requires_user_action: true
    };
  }
  return {
    type: "inspect",
    description: "Inspect the run evidence and failure detail before retrying.",
    requires_user_action: true
  };
}

export function assertKnownFailureCode(code) {
  if (!Object.values(FAILURE_CODES).includes(code)) {
    throw new LoopFailure({
      code: FAILURE_CODES.SPEC_INVALID,
      failedState: "validating_spec",
      message: `Unknown failure code: ${code}`
    });
  }
}
