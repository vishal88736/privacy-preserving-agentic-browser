/** Capability boundary for local and future perception implementations. */
export class PerceptionProvider {
  async analyzeScreenshot() {
    throw new Error('PerceptionProvider.analyzeScreenshot() must be implemented by a provider.');
  }
}
