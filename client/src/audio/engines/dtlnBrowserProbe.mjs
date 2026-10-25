/**
 * Reusable in-page acceptance probe. Import from the Vite origin and invoke
 * through the approved browser tool's page.evaluate(). No browser launcher,
 * microphone, permission prompt, credentials, or external service is used.
 */
export async function probeDtlnEngine() {
  const { createDtlnEngine } = await import("./dtlnEngine.ts");
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const engines = [];
  const sources = [];
  const errors = [];
  try {
    await ctx.resume();
    const start = performance.now();
    engines.push(await createDtlnEngine(ctx, { onError: (error) => errors.push(error.message) }));
    // Keep call and test alive simultaneously with independent recurrent state.
    engines.push(await createDtlnEngine(ctx, { onError: (error) => errors.push(error.message) }));
    const loadMs = performance.now() - start;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);
    const analysers = [];
    for (const [index, engine] of engines.entries()) {
      const source = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, 48000, 48000);
      const samples = buffer.getChannelData(0);
      const fundamental = index === 0 ? 150 : 270;
      for (let i = 0; i < samples.length; i++) {
        const t = i / 48000;
        const envelope = 0.4 + 0.6 * Math.sin(Math.PI * 4 * t) ** 2;
        samples[i] = envelope * (0.12 * Math.sin(2 * Math.PI * fundamental * t) +
          0.05 * Math.sin(2 * Math.PI * fundamental * 2 * t) + 0.025 * Math.sin(2 * Math.PI * fundamental * 3 * t));
      }
      source.buffer = buffer;
      source.loop = true;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(engine.input);
      engine.output.connect(analyser);
      analyser.connect(silent);
      source.start();
      analysers.push(analyser);
      sources.push(source);
    }
    const rms = [[], []];
    const scratch = new Float32Array(1024);
    for (let tick = 0; tick < 60; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (let n = 0; n < analysers.length; n++) {
        analysers[n].getFloatTimeDomainData(scratch);
        rms[n].push(Math.sqrt(scratch.reduce((sum, value) => sum + value * value, 0) / scratch.length));
      }
    }
    const channels = rms.map((values) => ({
      maxRms: Math.max(...values), finite: values.every(Number.isFinite),
      nonzeroFrames: values.filter((value) => value > 1e-7).length,
    }));
    return { sampleRate: ctx.sampleRate, loadMs, errors, channels,
      passed: errors.length === 0 && channels.every((channel) => channel.finite && channel.nonzeroFrames >= 45) };
  } finally {
    for (const source of sources) source.stop();
    await Promise.all(engines.map((engine) => engine.dispose()));
    await ctx.close();
  }
}
