import {
  FileData,
  logger,
  NxJsonConfiguration,
  NxJsonProjectConfiguration,
  NxPlugin,
  ProjectConfiguration,
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphBuilder,
  ProjectGraphNode,
  ProjectGraphProcessorContext,
  readJsonFile,
  WorkspaceJsonConfiguration,
} from '@nrwl/devkit';
import { appRootPath } from '@nrwl/tao/src/utils/app-root';
import { extname, join } from 'path';
import { performance } from 'perf_hooks';
import { assertWorkspaceValidity } from '../assert-workspace-validity';
import {
  createProjectFileMap,
  readNxJson,
  readWorkspaceJson,
} from '../file-utils';
import { normalizeNxJson } from '../normalize-nx-json';
import {
  createCache,
  extractCachedFileData,
  ProjectGraphCache,
  readCache,
  shouldRecomputeWholeGraph,
  writeCache,
} from '../nx-deps/nx-deps-cache';
import { buildImplicitProjectDependencies } from './build-dependencies';
import {
  buildNpmPackageNodes,
  buildWorkspaceProjectNodes,
} from './build-nodes';
import { existsSync } from 'fs';
import * as os from 'os';
import { buildExplicitTypescriptAndPackageJsonDependencies } from './build-dependencies/build-explicit-typescript-and-package-json-dependencies';

export async function buildProjectGraph(projectGraphVersion: string = '3.0') {
  const workspaceJson = readWorkspaceJson();
  const { projectFileMap, allWorkspaceFiles } =
    createProjectFileMap(workspaceJson);

  const cacheEnabled = process.env.NX_CACHE_PROJECT_GRAPH !== 'false';
  let cache = cacheEnabled ? readCache() : null;

  return (
    await buildProjectGraphUsingProjectFileMap(
      workspaceJson,
      projectFileMap,
      allWorkspaceFiles,
      cache,
      cacheEnabled,
      projectGraphVersion
    )
  ).projectGraph;
}

export async function buildProjectGraphUsingProjectFileMap(
  workspaceJson: WorkspaceJsonConfiguration,
  projectFileMap: ProjectFileMap,
  allWorkspaceFiles: FileData[],
  cache: ProjectGraphCache | null,
  shouldWriteCache: boolean,
  projectGraphVersion?: string
): Promise<{
  projectGraph: ProjectGraph;
  projectGraphCache: ProjectGraphCache;
}> {
  projectGraphVersion = projectGraphVersion || '3.0';
  const nxJson = readNxJson();
  assertWorkspaceValidity(workspaceJson, nxJson);
  const normalizedNxJson = normalizeNxJson(nxJson);
  const packageJsonDeps = readCombinedDeps();
  const rootTsConfig = readRootTsConfig();

  let filesToProcess = projectFileMap;
  let cachedFileData = {};
  if (
    cache &&
    (cache.version === '3.0' || cache.version === '4.0') &&
    !shouldRecomputeWholeGraph(
      cache,
      packageJsonDeps,
      workspaceJson,
      normalizedNxJson,
      rootTsConfig
    )
  ) {
    const fromCache = extractCachedFileData(projectFileMap, cache);
    filesToProcess = fromCache.filesToProcess;
    cachedFileData = fromCache.cachedFileData;
  }
  const context = createContext(
    workspaceJson,
    normalizedNxJson,
    projectFileMap,
    filesToProcess
  );
  let projectGraph = await buildProjectGraphUsingContext(
    context,
    cachedFileData,
    projectGraphVersion
  );
  if (cache && cache.version && projectGraphVersion !== cache.version) {
    projectGraph =
      projectGraphVersion === '3.0'
        ? projectGraphCompat4to3(projectGraph)
        : projectGraphMigrate3to4(projectGraph);
  }

  const projectGraphCache = createCache(
    nxJson,
    packageJsonDeps,
    projectGraph,
    rootTsConfig
  );
  if (shouldWriteCache) {
    writeCache(projectGraphCache);
  }
  projectGraph.allWorkspaceFiles = allWorkspaceFiles;
  return {
    projectGraph,
    projectGraphCache,
  };
}

/**
 * Migrate project graph from v3 to v4
 * @param {ProjectGraph} projectGraph
 */
export function projectGraphMigrate3to4(
  projectGraph: ProjectGraph
): ProjectGraph {
  const nodes: Record<string, ProjectGraphNode> = {};
  Object.entries(projectGraph.nodes).forEach(([name, node]) => {
    const files = node.data.files.map(({ file, hash, deps }) => ({
      file,
      hash,
      ...(deps && { deps }),
    }));
    nodes[name] = {
      ...node,
      data: {
        ...node.data,
        files,
      },
    };
  });

  return {
    ...projectGraph,
    nodes,
    version: '4.0',
  };
}

/**
 * Backwards compatibility adapter for project Nodes
 * @param {ProjectGraph} projectGraph
 * @returns {ProjectGraph}
 */
export function projectGraphCompat4to3(
  projectGraph: ProjectGraph
): ProjectGraph {
  const nodes: Record<string, ProjectGraphNode> = {};
  Object.entries(projectGraph.nodes).forEach(([name, node]) => {
    const files = node.data.files.map(({ file, hash, ext, deps }) => ({
      file,
      hash,
      ext: ext || extname(file),
      ...(deps && { deps }),
    }));
    nodes[name] = {
      ...node,
      data: {
        ...node.data,
        files,
      },
    };
  });

  return {
    ...projectGraph,
    nodes,
    version: '3.0',
  };
}

function readCombinedDeps() {
  const json = readJsonFile(join(appRootPath, 'package.json'));
  return { ...json.dependencies, ...json.devDependencies };
}

async function buildProjectGraphUsingContext(
  ctx: ProjectGraphProcessorContext,
  cachedFileData: { [project: string]: { [file: string]: FileData } },
  projectGraphVersion: string
) {
  performance.mark('build project graph:start');

  const builder = new ProjectGraphBuilder();

  buildWorkspaceProjectNodes(ctx, builder);
  buildNpmPackageNodes(builder);
  for (const proj of Object.keys(cachedFileData)) {
    for (const f of builder.graph.nodes[proj].data.files) {
      const cached = cachedFileData[proj][f.file];
      if (cached) {
        f.deps = cached.deps;
      }
    }
  }

  await buildExplicitDependencies(ctx, builder);

  buildImplicitProjectDependencies(ctx, builder);
  builder.setVersion(projectGraphVersion);
  const initProjectGraph = builder.getUpdatedProjectGraph();

  const r = updateProjectGraphWithPlugins(ctx, initProjectGraph);

  performance.mark('build project graph:end');
  performance.measure(
    'build project graph',
    'build project graph:start',
    'build project graph:end'
  );

  return r;
}

async function buildExplicitDependencies(
  ctx: ProjectGraphProcessorContext,
  builder: ProjectGraphBuilder
) {
  let totalNumOfFilesToProcess = totalNumberOfFilesToProcess(ctx);
  // using workers has an overhead, so we only do it when the number of
  // files we need to process is >= 100
  if (totalNumOfFilesToProcess < 100) {
    return buildExplicitDependenciesWithoutWorkers(ctx, builder);
  } else {
    return buildExplicitDependenciesUsingWorkers(
      ctx,
      totalNumOfFilesToProcess,
      builder
    );
  }
}

function totalNumberOfFilesToProcess(ctx: ProjectGraphProcessorContext) {
  let totalNumOfFilesToProcess = 0;
  Object.values(ctx.filesToProcess).forEach(
    (t) => (totalNumOfFilesToProcess += t.length)
  );
  return totalNumOfFilesToProcess;
}

function splitFilesIntoBins(
  ctx: ProjectGraphProcessorContext,
  totalNumOfFilesToProcess: number,
  numberOfWorkers: number
) {
  // we want to have numberOfWorkers * 5 bins
  const filesPerBin =
    Math.round(totalNumOfFilesToProcess / numberOfWorkers / 5) + 1;
  const bins: ProjectFileMap[] = [];
  let currentProjectFileMap = {};
  let currentNumberOfFiles = 0;
  for (const source of Object.keys(ctx.filesToProcess)) {
    for (const f of Object.values(ctx.filesToProcess[source])) {
      if (!currentProjectFileMap[source]) currentProjectFileMap[source] = [];
      currentProjectFileMap[source].push(f);
      currentNumberOfFiles++;

      if (currentNumberOfFiles >= filesPerBin) {
        bins.push(currentProjectFileMap);
        currentProjectFileMap = {};
        currentNumberOfFiles = 0;
      }
    }
  }
  bins.push(currentProjectFileMap);
  return bins;
}

function createWorkerPool(numberOfWorkers: number) {
  const res = [];
  for (let i = 0; i < numberOfWorkers; ++i) {
    res.push(
      new (require('worker_threads').Worker)(
        join(__dirname, './project-graph-worker.js'),
        {
          env: process.env,
        }
      )
    );
  }
  return res;
}

function buildExplicitDependenciesWithoutWorkers(
  ctx: ProjectGraphProcessorContext,
  builder: ProjectGraphBuilder
) {
  buildExplicitTypescriptAndPackageJsonDependencies(
    ctx.workspace,
    builder.graph,
    ctx.filesToProcess
  ).forEach((r) => {
    builder.addExplicitDependency(
      r.sourceProjectName,
      r.sourceProjectFile,
      r.targetProjectName
    );
  });
}

function buildExplicitDependenciesUsingWorkers(
  ctx: ProjectGraphProcessorContext,
  totalNumOfFilesToProcess: number,
  builder: ProjectGraphBuilder
) {
  const numberOfWorkers = os.cpus().length - 1;
  const bins = splitFilesIntoBins(
    ctx,
    totalNumOfFilesToProcess,
    numberOfWorkers
  );
  const workers = createWorkerPool(numberOfWorkers);
  let numberOfExpectedResponses = bins.length;

  return new Promise((res, reject) => {
    for (let w of workers) {
      w.on('message', (explicitDependencies) => {
        explicitDependencies.forEach((r) => {
          builder.addExplicitDependency(
            r.sourceProjectName,
            r.sourceProjectFile,
            r.targetProjectName
          );
        });
        if (bins.length > 0) {
          w.postMessage({ filesToProcess: bins.shift() });
        }
        // we processed all the bins
        if (--numberOfExpectedResponses === 0) {
          for (let w of workers) {
            w.terminate();
          }
          res(null);
        }
      });
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Unable to complete project graph creation. Worker stopped with exit code: ${code}`
            )
          );
        }
      });
      w.postMessage({
        workspace: ctx.workspace,
        projectGraph: builder.graph,
      });
      w.postMessage({ filesToProcess: bins.shift() });
    }
  });
}

function createContext(
  workspaceJson: WorkspaceJsonConfiguration,
  nxJson: NxJsonConfiguration,
  fileMap: ProjectFileMap,
  filesToProcess: ProjectFileMap
): ProjectGraphProcessorContext {
  const projects: Record<
    string,
    ProjectConfiguration & NxJsonProjectConfiguration
  > = Object.keys(workspaceJson.projects).reduce((map, projectName) => {
    map[projectName] = {
      ...workspaceJson.projects[projectName],
      ...nxJson.projects[projectName],
    };
    return map;
  }, {});
  return {
    workspace: {
      ...workspaceJson,
      ...nxJson,
      projects,
    },
    fileMap,
    filesToProcess,
  };
}

function updateProjectGraphWithPlugins(
  context: ProjectGraphProcessorContext,
  initProjectGraph: ProjectGraph
) {
  return (context.workspace.plugins || []).reduce((graph, path) => {
    try {
      const pluginPath = require.resolve(path, {
        paths: [appRootPath],
      });

      const pluginModule = require(pluginPath) as NxPlugin;

      if (!pluginModule.processProjectGraph) {
        return graph;
      }

      return pluginModule.processProjectGraph(graph, context);
    } catch (e) {
      const message = `Failed to process the project graph with "${path}". This will error in the future!`;
      if (process.env.NX_VERBOSE_LOGGING === 'true') {
        console.error(e);
        logger.error(message);
        return graph;
      } else {
        logger.warn(message);
        logger.warn(`Run with NX_VERBOSE_LOGGING=true to see the error.`);
      }
      return graph;
    }
  }, initProjectGraph);
}

function readRootTsConfig() {
  for (const tsConfigName of ['tsconfig.base.json', 'tsconfig.json']) {
    const tsConfigPath = join(appRootPath, tsConfigName);
    if (existsSync(tsConfigPath)) {
      return readJsonFile(tsConfigPath);
    }
  }
}