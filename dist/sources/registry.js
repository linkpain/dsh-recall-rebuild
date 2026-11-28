/**
 * 记忆源注册表:把「生态里的记忆插件」登记成可枚举、可探测、可按名打开的源。
 *
 * 设计目标:新增一个插件支持 = 在这里加一条记录(或一个 open 函数),
 * 不改 store.ts、不改 config.ts 的其它逻辑。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { dshHome, isFile, isDir, walkFiles, sqliteCtor, combineStores } from './kit.js';
import { openPrimeMemoryStore, openPalaceStore, openDshMemoryStore } from '../store.js';
import { openLociSource, openLivingMemorySource, openLtmSource, openPlainDshMemorySource, openNebulaSource, } from './sqlite-sources.js';
import { openJipikaSource, openLingshuSource, openMnemonSource, openLongtermSource, openHubSource, openMemoryEngineSource, openMemoryTiersSource, openVectorJsonlSource, openAutoMemorySource, autoMemoryRoot, hasAutoMemoryScopes, } from './file-sources.js';
function anyFile(...files) {
    return files.some((f) => isFile(f));
}
function anyDir(...dirs) {
    return dirs.some((d) => isDir(d));
}
/** 目录下是否有匹配扩展名的文件(浅层探测,不深扫)。 */
function hasFilesIn(dir, exts, depth = 2) {
    if (!isDir(dir))
        return false;
    try {
        return walkFiles(dir, { exts, maxFiles: 1, skipDirs: ['_hot', '_index', 'archive', 'graveyard'] }).length > 0;
    }
    catch {
        return false;
    }
}
/** 全量源清单。顺序 = auto 探测的优先级(数据越「正式」越靠前)。 */
export const SOURCES = [
    {
        id: 'prime',
        label: 'dsh-prime-memory',
        kind: 'sqlite',
        open: (ctx) => openPrimeMemoryStore(ctx.dataDir, ctx.logger),
        probe: (ctx) => {
            const dir = ctx.dataDir || path.join(dshHome(), 'memory');
            return anyFile(path.join(dir, 'memory.db'), path.join(dir, 'prime.db'));
        },
    },
    {
        id: 'loci',
        label: 'dsh-loci',
        kind: 'sqlite',
        open: (ctx) => openLociSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyFile(path.join(dshHome(), 'memory', 'loci', 'memory.db')),
    },
    {
        id: 'living',
        label: 'dsh-living-memory',
        kind: 'sqlite',
        open: (ctx) => openLivingMemorySource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyFile(process.env.MEMORY_DB_PATH?.trim() || path.join(dshHome(), 'dsh-living-memory', 'memory.sqlite3')),
    },
    {
        id: 'ltm',
        label: '@tr1v3r/dsh-ltm',
        kind: 'sqlite',
        open: (ctx) => openLtmSource(ctx.cwd, ctx.logger, ctx.refreshMs ?? 0),
        probe: (ctx) => anyFile(path.join(ctx.cwd, 'memory', 'ltm.db'), path.join(dshHome(), 'memory', 'ltm.db'), path.join(dshHome(), 'storages', 'ltm.db')),
    },
    {
        id: 'nebula',
        label: 'dsh-memory-nebula',
        kind: 'sqlite',
        open: (ctx) => openNebulaSource(ctx.cwd, ctx.logger, ctx.refreshMs ?? 0),
        probe: (ctx) => anyFile(path.join(ctx.cwd, '.dsh-meow', 'memory.db'), path.join(dshHome(), '.dsh-meow', 'memory.db')),
    },
    {
        id: 'dsh-memory-sqlite',
        label: 'dsh-memory(SQLite)',
        kind: 'sqlite',
        open: (ctx) => openPlainDshMemorySource(ctx.cwd, ctx.logger, ctx.refreshMs ?? 0),
        probe: (ctx) => anyFile(path.join(ctx.cwd, 'memory', 'memory.db'), path.join(dshHome(), 'memory', 'memory.db')),
    },
    {
        id: 'lingshu',
        label: '@furongjun1999/dsh-memory',
        kind: 'markdown',
        open: (ctx) => openLingshuSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyDir(process.env.MDCG_DATA_ROOT?.trim() || path.join(dshHome(), '.dsh-memory', 'data', 'mdcg')),
    },
    {
        id: 'mnemon',
        label: 'dsh-mnemon',
        kind: 'markdown',
        open: (ctx) => openMnemonSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyDir(path.join(os.homedir(), '.mnemon', 'runtime')),
    },
    {
        id: 'palace',
        label: 'dsh-memory-palace',
        kind: 'markdown',
        open: (ctx) => openPalaceStore(ctx.cwd, ctx.logger),
        probe: (ctx) => anyFile(path.join(os.homedir(), '.deepseek-harness', 'MEMORY.md'), path.join(ctx.cwd, '.deepseek-harness', 'MEMORY.md')),
    },
    {
        id: 'jipika',
        label: '@jipika/dsh-memory',
        kind: 'markdown',
        open: (ctx) => openJipikaSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => hasFilesIn(path.join(dshHome(), 'memory', 'topics'), ['.md']),
    },
    {
        id: 'hub',
        label: 'dsh-memory-hub',
        kind: 'markdown',
        open: (ctx) => openHubSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => hasFilesIn(path.join(dshHome(), 'memory-hub', 'knowledge'), ['.md']) ||
            hasFilesIn(path.join(dshHome(), 'memory-hub', 'records'), ['.md']),
    },
    {
        id: 'longterm',
        label: 'dsh-longterm-memory',
        kind: 'markdown',
        open: (ctx) => openLongtermSource(ctx.cwd, ctx.logger, ctx.refreshMs ?? 0),
        probe: (ctx) => anyDir(process.env.DSH_LONGTERM_VAULT?.trim() || path.join(dshHome(), 'longterm-memory'), path.join(ctx.cwd, '.dsh-longterm-memory')),
    },
    {
        id: 'dsh-memory',
        label: '@max-null/dsh-memory',
        kind: 'json',
        open: (ctx) => openDshMemoryStore(ctx.cwd, ctx.logger),
        probe: (ctx) => anyFile(path.join(dshHome(), 'storages', 'memory.json'), path.join(ctx.cwd, '.dsh', 'storages', 'memory.json')),
    },
    {
        id: 'memory-engine',
        label: 'dsh-memory-engine',
        kind: 'json',
        open: (ctx) => openMemoryEngineSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyFile(path.join(dshHome(), 'memory-engine', 'memories.json')),
    },
    {
        id: 'tiers',
        label: 'dsh-memory-tiers',
        kind: 'json',
        open: (ctx) => openMemoryTiersSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => anyFile(path.join(dshHome(), 'storages', 'memory', 'L1.json')),
    },
    {
        id: 'memory-vector',
        label: '@restregular/dsh-memory',
        kind: 'jsonl',
        open: (ctx) => openVectorJsonlSource(ctx.logger, ctx.refreshMs ?? 0),
        probe: () => hasFilesIn(path.join(dshHome(), 'memory-vector'), ['.jsonl']),
    },
    {
        id: 'auto-memory',
        label: 'dsh-auto-memory',
        kind: 'markdown',
        open: (ctx) => openAutoMemorySource(ctx.logger, ctx.refreshMs ?? 0),
        // 只认「有作用域目录」的 memory 根:别的插件也可能在 <DSH_HOME>/memory 下
        // 放自己的一层目录(prime 的 memory.db 就在这儿),不能见目录就当 auto-memory。
        probe: () => hasAutoMemoryScopes(autoMemoryRoot()),
    },
];
/** 全部可写进配置的源 id(含 auto)。 */
export const SOURCE_IDS = ['auto', ...SOURCES.map((s) => s.id)];
/** 按 id 找源(找不到返回 undefined)。 */
export function findSource(id) {
    return SOURCES.find((s) => s.id === id);
}
/** 探测这台机器上「装了且有数据」的源,按注册顺序返回。 */
export function detectSources(ctx) {
    return SOURCES.filter((s) => {
        try {
            return s.probe(ctx);
        }
        catch {
            return false;
        }
    });
}
/**
 * 按配置打开记忆源。
 *
 * - 显式指定 id:只打开它,失败即失败(便于用户排查);
 * - 'auto':按注册顺序探测,取第一个真正读到条目的源;
 *   全部落空时给出「检测到了什么」的诊断,而不是一句「没有记忆库」。
 */
export function openSource(id, ctx) {
    const { logger } = ctx;
    if (id !== 'auto') {
        const spec = findSource(id);
        if (!spec) {
            // 不静默回退:拼错 id 时用户以为「只读某个源」,实际却在融合全部源,
            // 这种偏差只会在召回结果里慢慢显形。警告写全合法 id,标签也带上错误 id。
            logger.warn('[recall-rebuild] 未知记忆源 "' +
                id +
                '",回退 auto 探测。合法 id:' +
                SOURCE_IDS.join(', '));
            const fallback = openSource('auto', ctx);
            return {
                ...fallback,
                label: fallback.label + ' [配置的源 "' + id + '" 不存在,已回退 auto]',
                search: (q, n) => fallback.search(q, n),
                close: () => fallback.close(),
            };
        }
        const store = spec.open(ctx);
        if (!store.ok) {
            logger.warn('[recall-rebuild] 记忆源 ' + spec.label + ' 不可用:' + store.label);
        }
        return store;
    }
    const detected = detectSources(ctx);
    if (detected.length === 0) {
        logger.warn('[recall-rebuild] 未检测到任何已知记忆插件数据(已识别 ' +
            SOURCES.length +
            ' 种:prime/loci/living/ltm/nebula/lingshu/mnemon/palace/jipika/hub/longterm/... )');
        return {
            ok: false,
            label: '未检测到记忆库',
            search: () => [],
            close: () => { },
        };
    }
    // 同时装了两三个记忆插件是常态:全部打开,检索时用 RRF 融合,
    // 而不是「第一个能读的赢者通吃」把别的库里的记忆白白丢掉。
    const opened = [];
    const failed = [];
    for (const spec of detected) {
        const store = spec.open(ctx);
        if (store.ok) {
            opened.push(store);
        }
        else {
            store.close();
            failed.push(spec.label);
        }
    }
    if (failed.length > 0) {
        logger.warn('[recall-rebuild] 已跳过不可用记忆源:' + failed.join(', '));
    }
    if (opened.length === 0) {
        logger.warn('[recall-rebuild] 检测到记忆插件但都读不出条目:' + failed.join(', '));
        return {
            ok: false,
            label: '记忆库读取失败(' + failed.join(', ') + ')',
            search: () => [],
            close: () => { },
        };
    }
    if (opened.length > 1) {
        logger.info('[recall-rebuild] 多源记忆库并行挂载:' + opened.map((s) => s.label).join(' | '));
    }
    return combineStores('多源记忆', opened, logger);
}
/** 诊断信息:每种源是否存在、能否打开(供 /recall-status 之类命令展示)。 */
export function describeSources(ctx) {
    return SOURCES.map((s) => {
        let present = false;
        try {
            present = s.probe(ctx);
        }
        catch {
            present = false;
        }
        return { id: s.id, label: s.label, present };
    });
}
/** node:sqlite 是否可用(诊断用)。 */
export function sqliteAvailable() {
    return sqliteCtor() !== null;
}
