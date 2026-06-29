import { createHash } from "node:crypto";

export const LOOP_MEMORY_COMPACTION_SCHEMA = "across-loop-memory-compaction/1.0";

export function compactLoopMemoryByEvidenceGraph(input = {}) {
  const graphs = Array.isArray(input.graphs) ? input.graphs : [input.graph || input.evidence || input].filter(Boolean);
  const nodes = new Map();
  const edges = [];
  for (const graph of graphs) {
    for (const node of extractNodes(graph)) {
      const key = stableNodeKey(node);
      const existing = nodes.get(key) || {
        node_id: key,
        kind: node.kind || node.type || "evidence",
        summary: textSummary(node),
        refs: [],
        status_counts: {}
      };
      existing.refs.push(...extractRefs(node));
      const status = String(node.status || "unknown");
      existing.status_counts[status] = (existing.status_counts[status] || 0) + 1;
      nodes.set(key, existing);
    }
    edges.push(...extractEdges(graph));
  }
  const compacted = [...nodes.values()].map((node) => ({
    ...node,
    refs: [...new Set(node.refs)].slice(0, 24)
  }));
  return {
    schema_version: LOOP_MEMORY_COMPACTION_SCHEMA,
    status: "passed",
    strategy: "evidence_graph_node",
    node_count: compacted.length,
    edge_count: edges.length,
    nodes: compacted,
    retrieval_policy: {
      mode: "just_in_time",
      key: "node_id",
      raw_transcripts_included: false,
      secrets_included: false
    }
  };
}

function extractNodes(graph) {
  if (Array.isArray(graph?.nodes)) return graph.nodes;
  const sections = ["sources", "actions", "gates", "outputs", "memory", "audit", "risks"];
  const nodes = [];
  for (const section of sections) {
    const value = graph?.[section];
    if (Array.isArray(value)) nodes.push(...value.map((item) => ({ ...item, kind: section })));
  }
  return nodes;
}

function extractEdges(graph) {
  if (Array.isArray(graph?.edges)) return graph.edges;
  return [];
}

function stableNodeKey(node) {
  const explicit = node.id || node.node_id || node.ref || node.path || node.adapter;
  if (explicit) return String(explicit);
  return createHash("sha256").update(JSON.stringify(redactNode(node))).digest("hex").slice(0, 16);
}

function textSummary(node) {
  const value = node.summary || node.title || node.message || node.description || node.kind || node.type || "evidence node";
  return String(value).replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]").slice(0, 240);
}

function extractRefs(node) {
  const refs = [];
  for (const key of ["ref", "path", "target", "url"]) {
    if (node[key]) refs.push(String(node[key]));
  }
  if (Array.isArray(node.evidence_refs)) refs.push(...node.evidence_refs.map(String));
  return refs;
}

function redactNode(node) {
  return JSON.parse(JSON.stringify(node, (key, value) => {
    if (/secret|token|api[_-]?key|credential/i.test(key)) return "[redacted]";
    if (typeof value === "string") return value.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
    return value;
  }));
}
