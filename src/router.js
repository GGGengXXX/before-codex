import { resolveModelConfig } from "./config.js";

function weightedOrder(deployments, cursor) {
  const weighted = [];
  for (const deployment of deployments) {
    const weight = Math.max(1, Math.round(deployment.weight ?? 1));
    for (let index = 0; index < weight; index += 1) {
      weighted.push(deployment);
    }
  }
  if (weighted.length === 0) {
    return [];
  }
  const ordered = [];
  const seen = new Set();
  for (let offset = 0; offset < weighted.length && seen.size < deployments.length; offset += 1) {
    const deployment = weighted[(cursor + offset) % weighted.length];
    if (!seen.has(deployment.id)) {
      seen.add(deployment.id);
      ordered.push(deployment);
    }
  }
  return ordered;
}

export class Router {
  constructor(config, state) {
    this.config = config;
    this.state = state;
  }

  model(requestedModel) {
    return resolveModelConfig(this.config, requestedModel);
  }

  candidates({ requestedModel, previousResponseId, attempted = new Set() }) {
    const resolved = this.model(requestedModel);
    if (!resolved) {
      return { resolved: null, candidates: [] };
    }
    const affinityId = this.state.getAffinity(previousResponseId);
    const all = resolved.config.deployments
      .filter((deployment) => deployment.enabled !== false)
      .filter(
        (deployment) =>
          !deployment.models ||
          deployment.models.includes(requestedModel) ||
          deployment.models.includes(resolved.name) ||
          deployment.models.includes(deployment.model)
      )
      .filter((deployment) => !attempted.has(deployment.id));

    const byPriority = new Map();
    for (const deployment of all) {
      const list = byPriority.get(deployment.priority) ?? [];
      list.push(deployment);
      byPriority.set(deployment.priority, list);
    }

    const ordered = [];
    const priorities = [...byPriority.keys()].sort((a, b) => a - b);
    for (const priority of priorities) {
      const group = byPriority.get(priority);
      const weighted = weightedOrder(
        group.filter((deployment) => this.state.isAvailable(deployment)),
        this.state.nextCursor(`${resolved.name}:${priority}`)
      );
      ordered.push(...weighted);
    }

    if (affinityId) {
      const index = ordered.findIndex((deployment) => deployment.id === affinityId);
      if (index > 0) {
        ordered.unshift(ordered.splice(index, 1)[0]);
      }
    }
    return { resolved, candidates: ordered };
  }
}
