/**
 * Runtime capability checks shared by packaged on-device inference providers.
 * API presence is only a hint; request a real adapter before selecting WebGPU.
 */

export async function detectRuntimeCapabilities({
  navigatorLike = globalThis.navigator,
  webAssembly = globalThis.WebAssembly
} = {}) {
  const wasm = Boolean(webAssembly && typeof webAssembly.instantiate === 'function');
  let webgpu = false;

  try {
    const gpu = navigatorLike?.gpu;
    if (gpu && typeof gpu.requestAdapter === 'function') {
      webgpu = Boolean(await gpu.requestAdapter());
    }
  } catch {
    // Feature detection is advisory; the provider will still fail closed if
    // neither execution path can initialize.
    webgpu = false;
  }

  const executionProviders = [
    ...(webgpu ? ['webgpu'] : []),
    ...(wasm ? ['wasm'] : [])
  ];

  return Object.freeze({
    webgpu,
    wasm,
    preferredExecutionProvider: executionProviders[0] || null,
    fallbackExecutionProviders: Object.freeze(executionProviders.slice(1)),
    executionProviders: Object.freeze(executionProviders)
  });
}
