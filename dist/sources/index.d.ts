/**
 * 记忆源适配层入口。
 *
 * 上层(index.ts / 命令)只从这里取:openSource / describeSources / SOURCE_IDS。
 */
export { openSource, describeSources, detectSources, findSource, sqliteAvailable, SOURCES, SOURCE_IDS } from './registry.js';
export type { SourceContext, SourceId, SourceSpec } from './registry.js';
export type { Doc } from './kit.js';
export { makeTextStore, dshHome } from './kit.js';
