import { randomUUID } from "node:crypto";

import {
  GOAL_CHANGE_PROPOSAL_SCHEMA,
  normalizeGoalChangeProposal,
  normalizeGoalContract
} from "./goal-contract.js";


export function buildGoalChangeProposal({
  baseContract,
  operations,
  reason,
  impact = {},
  risk = { level: "medium", reasons: ["goal_contract_change"] },
  estimatedCost = { unit: "agent_turns", value: 1 },
  alternatives = [],
  now = new Date(),
  proposalId = `proposal-${randomUUID()}`
} = {}) {
  const contract = normalizeGoalContract(baseContract);
  return normalizeGoalChangeProposal({
    schema_version: GOAL_CHANGE_PROPOSAL_SCHEMA,
    proposal_id: proposalId,
    goal_id: contract.goal_id,
    base_goal_revision: contract.revision,
    proposed_by: "autopilot",
    reason,
    operations: structuredClone(operations || []),
    impact_summary: {
      goal_ids: [contract.goal_id],
      criterion_ids: [...(impact.criterion_ids || [])],
      evidence_ids: [...(impact.evidence_ids || [])],
      requires_revalidation: impact.requires_revalidation ?? true
    },
    risk_summary: structuredClone(risk),
    estimated_cost: structuredClone(estimatedCost),
    alternatives: [...alternatives],
    decision_state: "pending",
    created_at: now.toISOString()
  });
}
