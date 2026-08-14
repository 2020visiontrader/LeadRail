import ContentPipeline from '@/components/ContentPipeline';

// TODO(wiring): add a nav item for this page in src/components/AppShell.tsx
// (the NAV array) so /pipeline is reachable from the sidebar. AppShell.tsx is
// outside this feature's file partition, so it is left for the owner to wire.
export default function PipelinePage() {
  return <ContentPipeline />;
}
