import { Container, getContainer } from "@cloudflare/containers";

// Thin Worker: routes every request to the LeadRail Next.js container.
// The container is the real app (existing `next start` server, unchanged) —
// this file has no app logic, just Cloudflare's required routing boilerplate.

export class LeadRailContainer extends Container {
  defaultPort = 3200;
  sleepAfter = "10m";
}

interface Env {
  LEADRAIL_CONTAINER: DurableObjectNamespace<LeadRailContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single named instance — LeadRail is one app, not per-tenant containers.
    const container = getContainer(env.LEADRAIL_CONTAINER, "leadrail-crm");
    return container.fetch(request);
  },
};
