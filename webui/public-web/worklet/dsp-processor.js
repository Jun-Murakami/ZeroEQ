/**
 * ZeroEQ WASM AudioWorkletProcessor.
 * すべてのオーディオ処理（再生・EQ・アナライザ・メーター）は C++ WASM に委譲。
 */

const INITIAL_RENDER_FRAMES = 2048;
const METER_FLOATS = 13;

class DspProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.wasmReady = false;
    this.wasmMemory = null;

    this.outLPtr = 0;
    this.outRPtr = 0;
    this.meterBufPtr = 0;
    this.specPrePtr  = 0;
    this.specPostPtr = 0;
    this.spectrumBins = 256;
    this.renderBufferFrames = 0;
    this.heapF32 = null;

    this.updateCounter = 0;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'init-wasm':
        this.initWasm(msg.wasmBytes);
        break;

      case 'load-source': {
        if (!this.wasm) break;
        const { left, right, numSamples, sourceSampleRate } = msg;
        if (!Number.isFinite(numSamples) || numSamples <= 0) break;
        const L = new Float32Array(left);
        const R = new Float32Array(right);
        const lPtr = this.wasm.dsp_alloc_buffer(numSamples);
        const rPtr = this.wasm.dsp_alloc_buffer(numSamples);
        this.refreshHeapView();
        const heap = this.heapF32;
        if (!lPtr || !rPtr || !heap) {
          if (lPtr) this.wasm.dsp_free_buffer(lPtr);
          if (rPtr) this.wasm.dsp_free_buffer(rPtr);
          break;
        }
        heap.set(L, lPtr / 4);
        heap.set(R, rPtr / 4);
        this.wasm.dsp_load_source(lPtr, rPtr, numSamples, sourceSampleRate);
        this.wasm.dsp_free_buffer(lPtr);
        this.wasm.dsp_free_buffer(rPtr);
        this.refreshHeapView();
        break;
      }

      case 'clear-source':
        if (this.wasm) this.wasm.dsp_clear_source();
        break;

      case 'set-playing':
        if (this.wasm) this.wasm.dsp_set_playing(msg.value ? 1 : 0);
        break;

      case 'set-loop':
        if (this.wasm) this.wasm.dsp_set_loop(msg.value ? 1 : 0);
        break;

      case 'seek-normalised':
        if (this.wasm) this.wasm.dsp_seek_normalised(msg.value);
        break;

      case 'set-band': {
        if (!this.wasm) break;
        const { index, field, value } = msg;
        if (field === 'on')    this.wasm.dsp_set_band_on   (index, value ? 1 : 0);
        else if (field === 'type')  this.wasm.dsp_set_band_type (index, value | 0);
        else if (field === 'freq')  this.wasm.dsp_set_band_freq (index, value);
        else if (field === 'gain')  this.wasm.dsp_set_band_gain (index, value);
        else if (field === 'q')     this.wasm.dsp_set_band_q    (index, value);
        else if (field === 'slope') this.wasm.dsp_set_band_slope(index, value | 0);
        break;
      }

      case 'set-param': {
        if (!this.wasm) break;
        const p = msg.param, v = msg.value;
        if (p === 'bypass')             this.wasm.dsp_set_bypass(v ? 1 : 0);
        else if (p === 'output_gain_db') this.wasm.dsp_set_output_gain_db(v);
        else if (p === 'analyzer_mode')  this.wasm.dsp_set_analyzer_mode(v | 0);
        else if (p === 'metering_mode')  this.wasm.dsp_set_metering_mode(v | 0);
        else if (p === 'reset_momentary') this.wasm.dsp_reset_momentary();
        break;
      }
    }
  }

  async initWasm(wasmBytes) {
    try {
      const module = await WebAssembly.compile(wasmBytes);
      const importObject = {
        env: { emscripten_notify_memory_growth: () => {} },
      };
      const instance = await WebAssembly.instantiate(module, importObject);
      if (instance.exports._initialize) instance.exports._initialize();

      this.wasm = instance.exports;
      this.wasmMemory = instance.exports.memory;

      this.wasm.dsp_init(sampleRate, INITIAL_RENDER_FRAMES);

      this.meterBufPtr = this.wasm.dsp_alloc_buffer(METER_FLOATS);
      this.spectrumBins = this.wasm.dsp_spectrum_bins();
      this.specPrePtr  = this.wasm.dsp_alloc_buffer(this.spectrumBins);
      this.specPostPtr = this.wasm.dsp_alloc_buffer(this.spectrumBins);

      if (!this.ensureRenderBufferCapacity(INITIAL_RENDER_FRAMES) || !this.meterBufPtr || !this.specPrePtr || !this.specPostPtr) {
        throw new Error('WASM audio buffer allocation failed');
      }

      this.refreshHeapView();

      this.wasmReady = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (err) {
      this.port.postMessage({ type: 'wasm-error', error: String(err) });
    }
  }

  refreshHeapView() {
    if (!this.wasmMemory) return false;
    if (!this.heapF32 || this.heapF32.buffer !== this.wasmMemory.buffer) {
      this.heapF32 = new Float32Array(this.wasmMemory.buffer);
    }
    return true;
  }

  ensureRenderBufferCapacity(frameCount) {
    if (!this.wasm || frameCount <= 0) return false;
    if (frameCount <= this.renderBufferFrames && this.refreshHeapView()) return true;

    const nextFrames = Math.max(frameCount, INITIAL_RENDER_FRAMES);
    const nextL = this.wasm.dsp_alloc_buffer(nextFrames);
    const nextR = this.wasm.dsp_alloc_buffer(nextFrames);
    if (!nextL || !nextR) {
      if (nextL) this.wasm.dsp_free_buffer(nextL);
      if (nextR) this.wasm.dsp_free_buffer(nextR);
      return false;
    }
    if (this.outLPtr) this.wasm.dsp_free_buffer(this.outLPtr);
    if (this.outRPtr) this.wasm.dsp_free_buffer(this.outRPtr);
    this.outLPtr = nextL;
    this.outRPtr = nextR;
    this.renderBufferFrames = nextFrames;
    return this.refreshHeapView();
  }

  process(inputs, outputs) {
    if (!this.wasmReady) return true;
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0], outR = output[1];
    const n = outL.length;
    if (!this.ensureRenderBufferCapacity(n)) { outL.fill(0); outR.fill(0); return true; }

    this.wasm.dsp_process_block(this.outLPtr, this.outRPtr, n);
    this.refreshHeapView();
    const heap = this.heapF32;
    const lBase = this.outLPtr / 4, rBase = this.outRPtr / 4;
    for (let i = 0; i < n; ++i) {
      outL[i] = heap[lBase + i];
      outR[i] = heap[rBase + i];
    }

    // ~60Hz でメインスレッドへ state + meter + spectrum を送る
    const interval = Math.max(1, Math.round(sampleRate / (n * 60)));
    if (++this.updateCounter >= interval) {
      this.updateCounter = 0;

      const stoppedAtEnd = this.wasm.dsp_consume_stopped_at_end();
      this.wasm.dsp_get_meter_data(this.meterBufPtr);
      const specFlags = this.wasm.dsp_drain_spectrum(this.specPrePtr, this.specPostPtr);
      this.refreshHeapView();

      const mo = this.meterBufPtr / 4;
      const mh = this.heapF32;

      let prePayload = null, postPayload = null;
      if (specFlags & 1) {
        const v = new Float32Array(this.wasmMemory.buffer, this.specPrePtr, this.spectrumBins);
        prePayload = Array.from(v);
      }
      if (specFlags & 2) {
        const v = new Float32Array(this.wasmMemory.buffer, this.specPostPtr, this.spectrumBins);
        postPayload = Array.from(v);
      }

      this.port.postMessage({
        type: 'state-update',
        position: this.wasm.dsp_get_position(),
        duration: this.wasm.dsp_get_duration(),
        isPlaying: !!this.wasm.dsp_is_playing(),
        stoppedAtEnd: !!stoppedAtEnd,
        meter: {
          mode:           mh[mo + 0],
          inPeakLeft:     mh[mo + 1],
          inPeakRight:    mh[mo + 2],
          inRmsLeft:      mh[mo + 3],
          inRmsRight:     mh[mo + 4],
          inMomentary:    mh[mo + 5],
          outPeakLeft:    mh[mo + 6],
          outPeakRight:   mh[mo + 7],
          outRmsLeft:     mh[mo + 8],
          outRmsRight:    mh[mo + 9],
          outMomentary:   mh[mo + 10],
        },
        spectrum: (prePayload || postPayload) ? {
          numBins: this.spectrumBins,
          pre:  prePayload  || undefined,
          post: postPayload || undefined,
        } : null,
      });
    }

    return true;
  }
}

registerProcessor('dsp-processor', DspProcessor);
