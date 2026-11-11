/**
 * One decoded picture of a film, for the seek bar — made with libav.js on the
 * device, from ranged reads of the film itself.
 *
 * This is deliberately NOT the remuxer: a keyframe preview seeks backward
 * through the input, and an output muxer cannot follow that. A thumbnailer has
 * no muxer — only a demuxer, a video decoder and a scaler — so asking it for a
 * frame of a moment nobody has downloaded cannot damage the film that is
 * playing. See `devicePreview.ts` for why it is allowed to read at all.
 *
 * The decoding happens in WebAssembly, so it works on films whose picture the
 * browser itself could never decode (MPEG-4 part 2, VC-1, …) — which is the
 * whole reason a seek bar can still have pictures on them.
 */
import {
  attachReader, isNoPts, STILLS, toNumber, type LibAV, type StreamInfo,
} from './libavRemux.ts';

export interface ThumbOptions {
  libav: LibAV;
  length: number;
  bufferSize: number;
  read: (offset: number, size: number) => Promise<ArrayBuffer>;
}

export interface Thumbnailer {
  init: () => Promise<{ duration?: number }>;
  /** An encoded image (JPEG) of the keyframe at or before `t` seconds. */
  readKeyframe: (t: number) => Promise<ArrayBuffer>;
  destroy: () => Promise<void> | void;
}

/** Width of a preview, in pixels. */
const WIDTH = 320;
/** Give up on a keyframe after this many video packets: something is wrong with it. */
const MAX_PACKETS = 400;
const AVSEEK_FLAG_BACKWARD = 1;

class LibavThumbnailer implements Thumbnailer {
  private readonly L: LibAV;

  private readonly o: ThumbOptions;

  private dead = false;

  private fmt = 0;

  private pkt = 0;

  private video: StreamInfo | null = null;

  private decoder: { ctx: number; pkt: number; frame: number } | null = null;

  private graph: { src: number; sink: number; frame: number; format: number; w: number; h: number } | null = null;

  constructor(o: ThumbOptions) {
    this.o = o;
    this.L = o.libav;
  }

  async init(): Promise<{ duration?: number }> {
    const L = this.L;
    await L.av_log_set_level(16);
    await attachReader(L, 'film', this.o, () => this.dead);
    const [fmt, streams] = await L.ff_init_demuxer_file('film');
    this.fmt = fmt;
    this.pkt = await L.av_packet_alloc();
    for (const s of streams as Record<string, number>[]) {
      if (s['codec_type'] !== L.AVMEDIA_TYPE_VIDEO) continue;
      const name = String(await L.avcodec_get_name(s['codec_id']));
      if (STILLS.has(name)) continue;
      this.video = {
        index: s['index']!, codecpar: s['codecpar']!, type: s['codec_type']!, codecId: s['codec_id']!, name,
        tbNum: s['time_base_num']!, tbDen: s['time_base_den']!, language: '', title: '',
      };
      break;
    }
    if (this.video === null) throw new Error('this file has no picture');
    const [, ctx, pkt, frame] = await L.ff_init_decoder(this.video.codecId, {
      codecpar: this.video.codecpar, time_base: [this.video.tbNum, this.video.tbDen],
    });
    this.decoder = { ctx, pkt, frame };
    const duration = toNumber(L, await L.AVFormatContext_duration(fmt), await L.AVFormatContext_durationhi(fmt));
    return isNoPts(duration) ? {} : { duration: duration / 1e6 };
  }

  async readKeyframe(t: number): Promise<ArrayBuffer> {
    const L = this.L;
    const v = this.video;
    const dec = this.decoder;
    if (v === null || dec === null || this.dead) throw new Error('Cancelled');
    const [lo, hi] = L.f64toi64(Math.round((Math.max(0, t) * v.tbDen) / v.tbNum));
    const sought = await L.av_seek_frame(this.fmt, v.index, lo, hi, AVSEEK_FLAG_BACKWARD);
    if (sought < 0) throw new Error(`could not move to ${Math.round(t)}s`);
    await L.avcodec_flush_buffers(dec.ctx);

    let seen = 0;
    let frame: Record<string, unknown> | null = null;
    while (frame === null && seen < MAX_PACKETS) {
      // eslint-disable-next-line no-await-in-loop
      const [res, byStream] = await L.ff_read_frame_multi(this.fmt, this.pkt, { limit: 128 * 1024, unify: true });
      const packets = ((byStream as Record<number, Record<string, unknown>[]>)[0] ?? [])
        .filter((p) => p['stream_index'] === v.index)
        .map((p) => ({ ...p, side_data: null }));
      if (packets.length > 0) {
        seen += packets.length;
        // eslint-disable-next-line no-await-in-loop
        const frames = await L.ff_decode_multi(dec.ctx, dec.pkt, dec.frame, packets, { ignoreErrors: true });
        if (frames.length > 0) frame = frames[0] as Record<string, unknown>;
      }
      if (res < 0 && res !== -L.EAGAIN) break;
    }
    if (frame === null) {
      /* Nothing came out yet: the decoder is holding frames back. Make it let go. */
      const rest = await L.ff_decode_multi(dec.ctx, dec.pkt, dec.frame, [], { fin: true, ignoreErrors: true });
      if (rest.length > 0) frame = rest[0] as Record<string, unknown>;
    }
    if (frame === null) throw new Error('no picture there');
    return this.encode(frame);
  }

  /** Scale one decoded frame down, convert it to RGBA, and make a JPEG of it. */
  private async encode(frame: Record<string, unknown>): Promise<ArrayBuffer> {
    const L = this.L;
    const format = frame['format'] as number;
    const w = frame['width'] as number;
    const h = frame['height'] as number;
    let g = this.graph;
    if (g === null || g.format !== format || g.w !== w || g.h !== h) {
      if (g !== null) this.graph = null;
      const v = this.video!;
      const [, src, sink] = await L.ff_init_filter_graph(`scale=${WIDTH}:-2`, {
        type: L.AVMEDIA_TYPE_VIDEO, width: w, height: h, pix_fmt: format, time_base: [v.tbNum, v.tbDen],
      }, {
        type: L.AVMEDIA_TYPE_VIDEO, pix_fmt: L.AV_PIX_FMT_RGBA,
      });
      g = { src, sink, frame: await L.av_frame_alloc(), format, w, h };
      this.graph = g;
    }
    const out = await L.ff_filter_multi(g.src, g.sink, g.frame, [frame], { copyoutFrame: 'video_packed' });
    if (out.length === 0) throw new Error('the picture could not be scaled');
    const f = out[0] as { data: Uint8Array; width: number; height: number };
    /* A copy onto a plain ArrayBuffer: ImageData will not take a view the type
       system cannot tell is not shared. */
    const rgba = new Uint8ClampedArray(f.width * f.height * 4);
    rgba.set(f.data.subarray(0, rgba.length));
    return toJpeg(new ImageData(rgba, f.width, f.height));
  }

  async destroy(): Promise<void> {
    this.dead = true;
    try { await this.L.terminate?.(); } catch { /* already gone */ }
  }
}

async function toJpeg(image: ImageData): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no canvas');
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    return blob.arrayBuffer();
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no canvas');
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((done) => { canvas.toBlob(done, 'image/jpeg', 0.72); });
  if (blob === null) throw new Error('the picture could not be encoded');
  return blob.arrayBuffer();
}

export async function makeThumbnailer(o: ThumbOptions): Promise<Thumbnailer> {
  return new LibavThumbnailer(o);
}
