import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntimeCapabilities } from '../../extension/runtime/capability-detection.js';
import { PackagedOnnxRuntime, TransformersOnnxInferenceProvider } from '../../extension/runtime/model-runtime.js';

const modelSpec = {
  task: 'object-detection',
  modelId: 'Xenova/yolos-tiny',
  revision: 'e2f9c7673f0fa61849efe2b56a0d7774779ebb9d',
  dtype: 'q4'
};

function extensionApi() {
  return { runtime: { getURL: (path) => `moz-extension://privagent/${path}` } };
}

test('capability detection selects WebGPU only after receiving a real adapter', async () => {
  const capabilities = await detectRuntimeCapabilities({
    navigatorLike: { gpu: { requestAdapter: async () => ({ name: 'adapter' }) } },
    webAssembly: { instantiate() {} }
  });
  assert.equal(capabilities.webgpu, true);
  assert.equal(capabilities.preferredExecutionProvider, 'webgpu');
  assert.deepEqual(capabilities.fallbackExecutionProviders, ['wasm']);
});

test('Firefox-like environments without WebGPU retain the WASM provider', async () => {
  const capabilities = await detectRuntimeCapabilities({ navigatorLike: {}, webAssembly: { instantiate() {} } });
  assert.equal(capabilities.webgpu, false);
  assert.equal(capabilities.preferredExecutionProvider, 'wasm');
  assert.deepEqual(capabilities.executionProviders, ['wasm']);
});

test('an unavailable WebGPU adapter and a rejected request both fall back to WASM', async () => {
  for (const gpu of [
    { requestAdapter: async () => null },
    { requestAdapter: async () => { throw new Error('adapter unavailable'); } }
  ]) {
    const capabilities = await detectRuntimeCapabilities({
      navigatorLike: { gpu }, webAssembly: { instantiate() {} }
    });
    assert.equal(capabilities.preferredExecutionProvider, 'wasm');
  }
});

test('packaged ONNX runtime tries WebGPU first and falls back to WASM on initialization failure', async () => {
  const calls = [];
  const runtime = new PackagedOnnxRuntime({
    api: extensionApi(),
    detectCapabilities: async () => ({
      preferredExecutionProvider: 'webgpu', fallbackExecutionProviders: ['wasm']
    }),
    loadPipeline: async (_task, model, options) => {
      calls.push({ model, ...options });
      if (options.device === 'webgpu') throw new Error('unsupported WebGPU op');
      return async () => [];
    }
  });

  const handle = await runtime.loadModel(modelSpec);
  assert.deepEqual(calls.map((call) => call.device), ['webgpu', 'wasm']);
  assert.equal(calls[0].revision, modelSpec.revision);
  assert.equal(handle.backend, 'wasm');
  assert.equal(runtime.backendUsed, 'wasm');
  assert.equal(runtime.environment.allowRemoteModels, false);
  assert.equal(runtime.environment.useBrowserCache, false);
  assert.match(runtime.environment.localModelPath, /^moz-extension:\/\/privagent\/models\/$/);
});

test('a successful WebGPU load avoids unnecessary WASM initialization', async () => {
  const calls = [];
  const runtime = new PackagedOnnxRuntime({
    api: extensionApi(),
    detectCapabilities: async () => ({
      preferredExecutionProvider: 'webgpu', fallbackExecutionProviders: ['wasm']
    }),
    loadPipeline: async (_task, _model, options) => {
      calls.push(options.device);
      return async () => [];
    }
  });

  const handle = await runtime.loadModel(modelSpec);
  assert.deepEqual(calls, ['webgpu']);
  assert.equal(handle.backend, 'webgpu');
});

test('runtime rejects unsupported environments without attempting remote model fetches', async () => {
  let pipelineCalls = 0;
  const runtime = new PackagedOnnxRuntime({
    api: extensionApi(),
    detectCapabilities: async () => ({ preferredExecutionProvider: null, fallbackExecutionProviders: [] }),
    loadPipeline: async () => { pipelineCalls += 1; return async () => []; }
  });

  await assert.rejects(() => runtime.loadModel(modelSpec), /No supported local inference execution provider/);
  assert.equal(pipelineCalls, 0);
});

test('inference provider caches one packaged model handle and uses it for local inference', async () => {
  let loads = 0;
  const runtime = new PackagedOnnxRuntime({
    api: extensionApi(),
    detectCapabilities: async () => ({ preferredExecutionProvider: 'wasm', fallbackExecutionProviders: [] }),
    loadPipeline: async () => { loads += 1; return async (input) => ({ input }); }
  });
  const provider = new TransformersOnnxInferenceProvider(runtime);

  const [first, second] = await Promise.all([provider.loadModel(modelSpec), provider.loadModel(modelSpec)]);
  assert.equal(first, second);
  assert.equal(loads, 1);
  assert.deepEqual(await provider.infer('local-image'), { input: 'local-image' });
  assert.equal(provider.backendUsed, 'wasm');
});
