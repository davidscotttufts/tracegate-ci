// Jest test environment: `testEnvironment: 'tracegate-ci/jest-environment'`.
//
// Jest builds one environment per test file, in the worker's own realm, and
// calls setup() before the file's modules are evaluated and teardown() after
// its tests. Those are the recorder's two points: reads are cleared at setup,
// and the footprint is taken at teardown. The recorder sees Jest's module
// code through `vm.compileFunction`, which Jest 30 looks up on node:vm at
// call time (recorder.mjs). It extends the project's own jest-environment-node
// and does nothing extra unless `TRACEGATE_RECORD=<dir>` is set.
import { createRequire } from 'node:module';
import path from 'node:path';
import { laneTarget } from './config.mjs';
import { recorderState, takeFootprint } from './recorder.mjs';

const req = createRequire(path.join(process.cwd(), 'package.json'));
const mod = req('jest-environment-node');
const NodeEnvironment = mod.TestEnvironment ?? mod.default ?? mod;

export default class TracegateEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.tracegateTestPath = context.testPath;
  }
  async setup() {
    await super.setup();
    if (!process.env.TRACEGATE_RECORD) return;
    // Jest reuses compiled scripts across a worker's test files: call counts (recorder.mjs).
    this.tracegate = await recorderState({ ...laneTarget(), callCount: true });
    this.tracegate.reads.clear();
  }
  async teardown() {
    if (this.tracegate) await takeFootprint(this.tracegate, this.tracegateTestPath);
    await super.teardown();
  }
}
