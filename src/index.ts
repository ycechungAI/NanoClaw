import { logger } from './logger.js';
import { RuntimeCoordinator } from './services/runtime-coordinator.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// Setup single coordinator instance
export const coordinator = new RuntimeCoordinator();

export function getAvailableGroups() {
  return coordinator.getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: any) {
  coordinator._setRegisteredGroups(groups);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  coordinator.start().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
