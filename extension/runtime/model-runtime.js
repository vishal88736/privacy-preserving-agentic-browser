/**
 * Runtime boundary for packaged inference assets.
 *
 * This module never downloads models. It loads only extension-packaged model
 * files and exposes WebGPU-first / WASM-fallback execution for local vision.
 */

import { detectRuntimeCapabilities } from './capability-detection.js';

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

export class ModelRuntime {
  async loadModel() {
    throw new Error('ModelRuntime.loadModel() must be implemented by a runtime provider.');
  }
}

export class InferenceProvider {
  async loadModel() {
    throw new Error('InferenceProvider.loadModel() must be implemented by a provider.');
  }

  async infer() {
    throw new Error('InferenceProvider.infer() must be implemented by a provider.');
  }
}

export class PackagedOnnxRuntime extends ModelRuntime {
  constructor({ api = extensionApi(), loadPipeline = null, detectCapabilities = detectRuntimeCapabilities } = {}) {
    super();
    this.api = api;
    this.loadPipeline = loadPipeline;
    this.detectCapabilities = detectCapabilities;
    this.backendUsed = null;
  }

  _configurePackagedAssets(env) {
    if (!this.api?.runtime?.getURL) {
      throw new Error('The extension runtime is unavailable for packaged model loading.');
    }
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = this.api.runtime.getURL('models/');
    env.useBrowserCache = false;
    env.logLevel = 40;
    env.backends = env.backends || {};
    env.backends.onnx = env.backends.onnx || {};
    env.backends.onnx.wasm = env.backends.onnx.wasm || {};
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    // The vendored ORT bundle resolves its WASM binary relative to itself.
    // A directory override triggers an extension-incompatible dynamic import.
    delete env.backends.onnx.wasm.wasmPaths;
  }

  async loadModel({ task, modelId, revision, dtype = 'q4' } = {}) {
    if (!task || !modelId || !revision) {
      throw new TypeError('Packaged model loading requires task, modelId, and pinned revision.');
    }

    const imported = this.loadPipeline
      ? { env: {}, pipeline: this.loadPipeline }
      : await import('../vendor/transformers/transformers.web.min.js');
    this._configurePackagedAssets(imported.env);
    // Kept for support diagnostics/tests; contains paths and toggles only.
    this.environment = imported.env;

    const capabilities = await this.detectCapabilities();
    const candidates = [
      capabilities.preferredExecutionProvider,
      ...capabilities.fallbackExecutionProviders
    ].filter(Boolean);
    if (!candidates.length) {
      throw new Error('No supported local inference execution provider is available.');
    }

    let lastError = null;
    for (const device of candidates) {
      try {
        const model = await imported.pipeline(task, modelId, {
          device,
          dtype,
          revision,
          progress_callback: () => {}
        });
        this.backendUsed = device;
        return Object.freeze({ model, backend: device, modelId, revision });
      } catch (error) {
        lastError = error;
      }
    }

    this.backendUsed = null;
    const failure = new Error('Packaged local model failed to initialize on the available execution providers.');
    failure.cause = lastError;
    throw failure;
  }
}

/** Transformers.js pipeline adapter used by local screenshot perception. */
export class TransformersOnnxInferenceProvider extends InferenceProvider {
  constructor(runtime = new PackagedOnnxRuntime()) {
    super();
    this.runtime = runtime;
    this.modelHandle = null;
    this.loadPromise = null;
  }

  get backendUsed() {
    return this.modelHandle?.backend || this.runtime.backendUsed || null;
  }

  async loadModel(specification) {
    if (this.modelHandle) return this.modelHandle;
    if (!this.loadPromise) {
      this.loadPromise = this.runtime.loadModel(specification)
        .then((handle) => {
          this.modelHandle = handle;
          return handle;
        })
        .catch((error) => {
          this.loadPromise = null;
          throw error;
        });
    }
    return this.loadPromise;
  }

  async infer(input, options = {}) {
    if (!this.modelHandle) throw new Error('Local inference model has not been loaded.');
    return this.modelHandle.model(input, options);
  }
}
