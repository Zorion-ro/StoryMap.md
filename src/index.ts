/**
 * StoryMap.md as a library.
 *
 * The `storymap` executable is the product; this entry point exists so a
 * project can drive the same reader, validator and server from its own
 * scripts without shelling out.
 */
export * from './core';
export { createApp, compareStories } from './server';
export { computeCoverage, groupBy } from './coverage';
export type { Bucket, BucketKey, Coverage } from './coverage';
export * from './project/discover';
export * from './project/config';
export { VERSION } from './cli';
