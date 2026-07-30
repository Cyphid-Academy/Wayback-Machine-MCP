import type { Config } from '../config.js';
import type { ToolModule } from './define.js';
import { archiveStatsTool } from './archiveStats.js';
import { checkAvailabilityTool } from './checkAvailability.js';
import { searchSnapshotsTool } from './searchSnapshots.js';
import { listRevisionsTool } from './listRevisions.js';
import { getSnapshotTool } from './getSnapshot.js';
import { compareSnapshotsTool } from './compareSnapshots.js';
import { listScreenshotsTool } from './listScreenshots.js';
import { searchItemsTool } from './searchItems.js';
import { getItemMetadataTool } from './getItemMetadata.js';
import { saveUrlTool } from './saveUrl.js';
import { clearCacheTool } from './clearCache.js';

export type { ToolContext, ToolModule, ToolResultPayload } from './define.js';

/**
 * Tool registry, in the order the model sees them: cheap orientation tools first,
 * then the expensive ones. `save_url` is only registered when ENABLE_SAVE is on.
 */
export function buildToolRegistry(config: Config): ToolModule[] {
  const tools: ToolModule[] = [
    archiveStatsTool,
    checkAvailabilityTool,
    searchSnapshotsTool,
    listRevisionsTool,
    getSnapshotTool,
    compareSnapshotsTool,
    listScreenshotsTool,
    searchItemsTool,
    getItemMetadataTool,
  ];
  if (config.enableSave) tools.push(saveUrlTool);
  tools.push(clearCacheTool);
  return tools;
}
