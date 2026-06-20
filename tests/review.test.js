import test from "node:test";
import assert from "node:assert/strict";
import { buildReview, fetchSourceStatuses, loadSources, renderReviewMarkdown } from "../src/review.js";

test("review builds a conservative backlog without fetching by default", async () => {
  const sources = await loadSources();
  const statuses = await fetchSourceStatuses(sources, { fetch: false });
  const review = buildReview({ sources, statuses, mode: "test", now: new Date("2026-06-20T00:00:00Z") });

  assert.equal(review.schema_version, "across-autopilot-review/1.0");
  assert.equal(review.mode, "test");
  assert.equal(review.source_count, sources.length);
  assert.ok(review.findings.some((finding) => finding.id === "stable-candidate-control"));
  assert.ok(review.candidate_backlog.some((candidate) => candidate.target_product === "across-autopilot"));
  assert.equal(review.automation_policy.default_autonomy_level, 1);
  assert.equal(review.source_statuses.every((source) => source.status === "not_checked"), true);
  assert.equal(review.memory_write_candidates[0].status, "pending");
});

test("review markdown is readable and excludes raw secrets", async () => {
  const sources = [{ id: "one", name: "One", url: "https://example.com", area: "docs" }];
  const statuses = await fetchSourceStatuses(sources, { fetch: false });
  const review = buildReview({ sources, statuses, mode: "markdown", now: new Date("2026-06-20T00:00:00Z") });
  const markdown = renderReviewMarkdown(review);

  assert.match(markdown, /# Across Autopilot Review/);
  assert.match(markdown, /Candidate Backlog/);
  assert.doesNotMatch(markdown, /OPENAI_API_KEY=/);
  assert.doesNotMatch(markdown, /sk-/);
});

