/**
 * ONNX Runtime session management for the Quran phoneme recognition model.
 * Runs inference on mel spectrogram features using the WASM backend.
 */

import * as ort from 'onnxruntime-web/wasm';

let session: ort.InferenceSession | null = null;

/**
 * Create an ONNX InferenceSession with WASM backend.
 * @param modelBuffer - ArrayBuffer containing the ONNX model
 * @param basePath - Base URL for WASM files (e.g., "/quran/")
 */
export async function initSession(
  modelBuffer: ArrayBuffer,
  basePath: string,
): Promise<void> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = basePath || '/quran/';

  session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
  });
}

/**
 * Run inference on mel spectrogram features.
 * @param features - Float32Array of mel features (flattened [1, melBins, timeFrames])
 * @param melBins - Number of mel frequency bins (typically 80)
 * @param timeFrames - Number of time frames in the spectrogram
 * @returns logprobs, timeSteps, and vocabSize from the model output
 */
export async function runInference(
  features: Float32Array,
  melBins: number,
  timeFrames: number,
): Promise<{
  logprobs: Float32Array;
  timeSteps: number;
  vocabSize: number;
}> {
  if (!session) throw new Error('Session not initialized');

  const inputTensor = new ort.Tensor('float32', features, [1, melBins, timeFrames]);
  const lengthTensor = new ort.Tensor(
    'int64',
    BigInt64Array.from([BigInt(timeFrames)]),
    [1],
  );

  const inputNames = session.inputNames;
  const feeds: Record<string, ort.Tensor> = {
    [inputNames[0]]: inputTensor,
    [inputNames[1]]: lengthTensor,
  };

  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  const [, outTimeSteps, vocabSize] = output.dims;

  return {
    logprobs: output.data as Float32Array,
    timeSteps: outTimeSteps,
    vocabSize,
  };
}
