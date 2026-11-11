/**
 * The device's remuxer: a film taken apart with libav.js and put back together
 * as fragmented MP4, which a Media Source takes.
 *
 * libav.js (https://github.com/Yahweasel/libav.js, LGPL-2.1) is FFmpeg compiled
 * to WebAssembly and nothing more — it has no "remux this file for MSE" call.
 * What it gives is the pieces, and this file assembles them:
 *
 *   ranged read ──▶ demuxer (Matroska, AVI, MP4, TS, …) ──▶ packets
 *   video packets ───────────────────────────────────────▶ MP4 muxer ──▶ fragments
 *   audio packets ──▶ copied if AAC, otherwise decoded ──▶ AAC encoder ──▶ MP4 muxer
 *   subtitle packets ──▶ text lines for `filmSubs.ts`
 *
 * ── where it runs ──
 *
 * libav.js starts its OWN worker and does every call there; this module only
 * sequences the calls and moves bytes. Demuxing, decoding, encoding and
 * muxing all happen off the UI thread, and the UI thread never holds more of
 * the film than the piece in flight.
 *
 * ── what it keeps from the library this replaced ──
 *
 * The shape `deviceFilm.ts` was written against: `init` names the codecs and
 * the soundtracks, `read` returns the next fragment, `seek(t)` RETURNS the
 * first fragment of the new pass, and the film's clock and the muxer's clock
 * are different things (see `mp4Time.ts`) — every pass starts its muxer at
 * zero and says, in `pts`, where in the film that zero is.
 *
 * ── what is, and is not, re-encoded ──
 *
 * The picture is never touched: H.264, H.265, VP9 and AV1 go through as they
 * are. Sound is copied when it is AAC and re-encoded to AAC-LC when it is
 * anything else — AC-3, E-AC-3, DTS, TrueHD, Vorbis, Opus, FLAC, MP3, PCM —
 * because those are what browsers cannot play. A picture no browser decodes
 * (MPEG-2, MPEG-4 part 2, VC-1, …) is refused by name from `init`.
 */
import { fragmentStart, trackTimescales } from './mp4Time.ts';
import type { FilmDialogue } from './filmSubs.ts';

/* libav.js is a plain-JS API with ~900 members; typing the ones used here
   would be a second copy of its declaration file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LibAV = any;

export interface RemuxChunk {
  data: Uint8Array;
  /** Where in the FILM this fragment starts, seconds. */
  pts: number;
  duration: number;
  finished?: boolean;
  /** The first fragment of a pass: the muxer's clock restarted here. */
  restart?: boolean;
  subtitles?: FilmDialogue[];
}

export interface RemuxInit {
  data: Uint8Array;
  info: {
    input: { duration: number };
    output: { videoMimeType: string; audioMimeType: string; duration: number };
  };
  subtitles: { streamIndex: number; language: string; title: string }[];
  audioStreams: { streamIndex: number; language: string; title: string }[];
}

export interface RemuxOptions {
  libav: LibAV;
  /** The film's size in bytes. */
  length: number;
  /** The most a single read should ask for. */
  bufferSize: number;
  /** One ranged read of the film. May answer with less than asked. */
  read: (offset: number, size: number) => Promise<ArrayBuffer>;
  /** Which soundtrack to carry; the file's first when absent. */
  audioStreamIndex?: number;
}

export interface Remuxer {
  init: () => Promise<RemuxInit>;
  read: () => Promise<RemuxChunk | null>;
  seek: (at: number) => Promise<RemuxChunk | null>;
  destroy: () => Promise<void> | void;
}

/** What to ask the demuxer for per call, in bytes of output. */
const BATCH_BYTES = 192 * 1024;

/** FFmpeg's `AV_LOG_ERROR`: warnings about a file's quirks are not for a console. */
const LOG_ERROR = 16;

const AVSEEK_FLAG_BACKWARD = 1;
const AV_PKT_FLAG_KEY = 1;
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Subtitle codecs whose packets are text this app can show. */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'text']);
/** Codecs that are a cover picture, not the film. */
export const STILLS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp']);

export const toNumber = (L: LibAV, lo: number | undefined, hi: number | undefined): number => (
  L.i64tof64(lo ?? 0, hi ?? 0)
);
/** `AV_NOPTS_VALUE` arrives as -2^63, which is far below anything real. */
export const isNoPts = (v: number): boolean => !Number.isFinite(v) || v < -9e18;

export interface StreamInfo {
  index: number;
  codecpar: number;
  type: number;
  codecId: number;
  name: string;
  tbNum: number;
  tbDen: number;
  language: string;
  title: string;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/**
 * The `avc1.PPCCLL` codec string, from an `avcC` record or Annex-B parameter
 * sets, or null when neither carries one.
 */
export function avcCodec(extra: Uint8Array | null, profile: number, level: number): string {
  if (extra !== null && extra.length >= 4 && extra[0] === 1) {
    return `avc1.${hex2(extra[1]!)}${hex2(extra[2]!)}${hex2(extra[3]!)}`;
  }
  if (extra !== null) {
    /* Annex B: find the SPS (NAL type 7) and read profile, constraints, level
       straight after its one header byte. */
    for (let i = 0; i + 4 < extra.length; i += 1) {
      const start3 = extra[i] === 0 && extra[i + 1] === 0 && extra[i + 2] === 1;
      if (!start3) continue;
      if ((extra[i + 3]! & 0x1f) === 7) {
        return `avc1.${hex2(extra[i + 4]!)}${hex2(extra[i + 5] ?? 0)}${hex2(extra[i + 6] ?? 0)}`;
      }
    }
  }
  return `avc1.${hex2(profile > 0 ? profile & 0xff : 100)}00${hex2(level > 0 ? level & 0xff : 40)}`;
}

/** The `hvc1.…` codec string from an `hvcC` record. */
export function hevcCodec(extra: Uint8Array | null, profile: number, level: number): string {
  if (extra !== null && extra.length >= 13 && extra[0] === 1) {
    const space = ['', 'A', 'B', 'C'][(extra[1]! >> 6) & 3]!;
    const tier = (extra[1]! & 0x20) !== 0 ? 'H' : 'L';
    const idc = extra[1]! & 0x1f;
    /* The compatibility flags are written bit-reversed in the string. */
    let compat = 0;
    const flags = ((extra[2]! << 24) | (extra[3]! << 16) | (extra[4]! << 8) | extra[5]!) >>> 0;
    for (let b = 0; b < 32; b += 1) if ((flags & (1 << b)) !== 0) compat |= 1 << (31 - b);
    const constraints = [...extra.slice(6, 12)];
    while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
    return `hvc1.${space}${idc}.${(compat >>> 0).toString(16)}.${tier}${extra[12]!}`
      + `.${constraints.map((c) => c.toString(16).toUpperCase()).join('.')}`;
  }
  return `hvc1.${profile > 0 ? profile : 1}.6.L${level > 0 ? level : 120}.B0`;
}

/** The `av01.…` codec string from an `av1C` record. */
export function av1Codec(extra: Uint8Array | null): string {
  if (extra !== null && extra.length >= 4 && (extra[0]! & 0x80) !== 0) {
    const profile = extra[1]! >> 5;
    const level = extra[1]! & 0x1f;
    const tier = (extra[2]! & 0x80) !== 0 ? 'H' : 'M';
    const bits = (extra[2]! & 0x40) !== 0 ? ((extra[2]! & 0x20) !== 0 ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(bits).padStart(2, '0')}`;
  }
  return 'av01.0.08M.08';
}

/** A two-byte AAC-LC `AudioSpecificConfig`, since FFmpeg's encoder will not make one here. */
export function aacConfig(sampleRate: number, channels: number): Uint8Array {
  const idx = Math.max(0, AAC_RATES.indexOf(sampleRate));
  const cfg = channels >= 8 ? 7 : channels;
  /* 5 bits object type (2 = LC), 4 bits rate index, 4 bits channel config. */
  const bits = (2 << 11) | (idx << 7) | (cfg << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}

/** Does this box sequence contain a whole fragment (`moof` then `mdat`)? */
function boxes(data: Uint8Array): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 8 <= data.length) {
    let size = dv.getUint32(at);
    const type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
    if (size === 1 && at + 16 <= data.length) size = Number(dv.getBigUint64(at + 8));
    if (size < 8 || at + size > data.length) break;
    out.push({ type, start: at, end: at + size });
    at += size;
  }
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * Present the film to libav as a file of `length` bytes, read on demand.
 *
 * A block reader device: libav asks for a position and a length, and this
 * answers with a ranged read. Nothing is downloaded that libav did not ask
 * for, and a seek is only a different position in the next question.
 */
export async function attachReader(
  L: LibAV,
  name: string,
  o: { length: number; bufferSize: number; read: (offset: number, size: number) => Promise<ArrayBuffer> },
  dead: () => boolean,
): Promise<void> {
  await L.mkblockreaderdev(name, o.length);
  L.onblockread = async (file: string, pos: number, len: number): Promise<void> => {
    if (dead()) throw new Error('Cancelled');
    const room = Math.max(0, o.length - pos);
    const want = Math.min(room, Math.max(len, o.bufferSize));
    const got = await o.read(pos, want);
    if (dead()) throw new Error('Cancelled');
    /* An empty answer inside the file is a line that gave up. Handing libav
       nothing would ask again for ever; an error ends the call instead. */
    if (got.byteLength === 0) throw new Error('the line stopped sending the film');
    await L.ff_block_reader_dev_send(file, pos, new Uint8Array(got));
  };
}

/** The audio half of one pass: decode → format → encode, or nothing when copying. */
interface AudioChain {
  decoder: number;
  decPkt: number;
  decFrame: number;
  /** Built from the first decoded frame, whose format is the only truth. */
  graph: { graph: number; src: number; sink: number; frame: number } | null;
  encoder: number;
  encPkt: number;
  encFrame: number;
  frameSize: number;
  nextPts: number;
  started: boolean;
  /** The rate frames leave the encoder at, and the rate the decoder's come in at. */
  rate: number;
  inRate: number;
}

interface Pass {
  oc: number;
  pb: number;
  out: Uint8Array[];
  packet: number;
  /** Film seconds that the muxer's zero stands for; null until the first video packet. */
  t0: number | null;
  held: Record<string, unknown>[];
  /** Video packets whose decode time is not known yet, in file order. */
  lead: Record<string, unknown>[];
  /** The last decode time handed to the muxer, in the video stream's ticks. */
  lastDts: number | null;
  audio: AudioChain | null;
  subs: FilmDialogue[];
  ready: RemuxChunk[];
  eof: boolean;
  finished: boolean;
  /** A new pass says so on its first fragment. */
  restart: boolean;
  device: string;
}

class LibavRemuxer implements Remuxer {
  private readonly L: LibAV;

  private readonly o: RemuxOptions;

  private readonly inName = 'film';

  private fmt = 0;

  private readPkt = 0;

  private video: StreamInfo | null = null;

  private audio: StreamInfo | null = null;

  private subs = new Map<number, StreamInfo>();

  private audioList: StreamInfo[] = [];

  private pass: Pass | null = null;

  /** What each output device has been written so far, by device name. */
  private readonly sinks = new Map<string, Uint8Array[]>();

  private dead = false;

  private passes = 0;

  private scales = new Map<number, number>();

  /** An audio stream carrying AAC with its own config can be copied as it is. */
  private copyAudio = false;

  private audioChannels = 2;

  private audioRate = 48000;

  private videoExtra: Uint8Array | null = null;

  private audioExtra: Uint8Array | null = null;

  private videoCodecString = '';

  constructor(o: RemuxOptions) {
    this.o = o;
    this.L = o.libav;
  }

  async init(): Promise<RemuxInit> {
    const L = this.L;
    await L.av_log_set_level(LOG_ERROR);
    await attachReader(L, this.inName, this.o, () => this.dead);
    L.onwrite = (name: string, _pos: number, data: Int8Array | Uint8Array) => {
      /* In a worker the library has already copied this out of its heap; run
         without one it is a view INTO the heap and must be copied here. Either
         way it is an Int8Array, which `appendBuffer` and `concat` would take as
         bytes only by luck. */
      const whole = data.byteLength === data.buffer.byteLength;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sinks.get(name)?.push(whole ? bytes : bytes.slice());
    };

    let streams: Record<string, unknown>[];
    [this.fmt, streams] = await L.ff_init_demuxer_file(this.inName);
    this.readPkt = await L.av_packet_alloc();

    const infos: StreamInfo[] = [];
    for (const s of streams) {
      const md = (s['metadata'] ?? {}) as Record<string, string>;
      infos.push({
        index: s['index'] as number,
        codecpar: s['codecpar'] as number,
        type: s['codec_type'] as number,
        codecId: s['codec_id'] as number,
        // eslint-disable-next-line no-await-in-loop
        name: String(await L.avcodec_get_name(s['codec_id'])),
        tbNum: s['time_base_num'] as number,
        tbDen: s['time_base_den'] as number,
        language: md['language'] ?? '',
        title: md['title'] ?? '',
      });
    }
    this.video = infos.find((s) => s.type === L.AVMEDIA_TYPE_VIDEO && !STILLS.has(s.name)) ?? null;
    if (this.video === null) throw new Error('this file has no picture the player can use');
    this.audioList = infos.filter((s) => s.type === L.AVMEDIA_TYPE_AUDIO);
    this.audio = this.audioList.find((s) => s.index === this.o.audioStreamIndex) ?? this.audioList[0] ?? null;
    for (const s of infos) {
      if (s.type === L.AVMEDIA_TYPE_SUBTITLE && TEXT_SUBS.has(s.name)) this.subs.set(s.index, s);
    }

    const videoMime = await this.describeVideo(this.video);
    const audioMime = this.audio === null ? '' : await this.describeAudio(this.audio);

    const lo = await L.AVFormatContext_duration(this.fmt);
    const hi = await L.AVFormatContext_durationhi(this.fmt);
    let duration = isNoPts(toNumber(L, lo, hi)) ? 0 : toNumber(L, lo, hi) / 1e6;
    if (!(duration > 0)) {
      for (const s of streams) {
        const d = s['duration'] as number;
        if (Number.isFinite(d) && d > duration) duration = d;
      }
    }

    /* The init segment comes from a throwaway pass: the muxer writes it with
       the header, before any packet, and it is the same for every pass. */
    const first = await this.startPass(true);
    const data = concat(first.out.splice(0));
    this.scales = trackTimescales(data);
    this.pass = first;

    return {
      data,
      info: {
        input: { duration },
        output: { videoMimeType: videoMime, audioMimeType: audioMime, duration: 0 },
      },
      subtitles: [...this.subs.values()].map((s) => ({ streamIndex: s.index, language: s.language, title: s.title })),
      audioStreams: this.audioList.map((s) => ({ streamIndex: s.index, language: s.language, title: s.title })),
    };
  }

  private async extradata(par: number): Promise<Uint8Array | null> {
    const L = this.L;
    const size = await L.AVCodecParameters_extradata_size(par);
    if (!(size > 0)) return null;
    const ptr = await L.AVCodecParameters_extradata(par);
    return new Uint8Array(await L.copyout_u8(ptr, size));
  }

  private async describeVideo(s: StreamInfo): Promise<string> {
    const L = this.L;
    const extra = await this.extradata(s.codecpar);
    this.videoExtra = extra;
    const profile = await L.AVCodecParameters_profile(s.codecpar);
    const level = await L.AVCodecParameters_level(s.codecpar);
    switch (s.name) {
      case 'h264':
        if (extra === null) throw new Error('this film carries no H.264 parameters a browser can be given');
        return avcCodec(extra, profile, level);
      case 'hevc':
        if (extra === null) throw new Error('this film carries no H.265 parameters a browser can be given');
        return hevcCodec(extra, profile, level);
      case 'vp9': return 'vp09.00.40.08';
      case 'av1': return av1Codec(extra);
      default:
        throw new Error(`the picture (${s.name}) is one no browser decodes`);
    }
  }

  private async describeAudio(s: StreamInfo): Promise<string> {
    const L = this.L;
    const extra = await this.extradata(s.codecpar);
    this.audioExtra = extra;
    this.audioRate = (await L.AVCodecParameters_sample_rate(s.codecpar)) || 48000;
    const channels = (await L.AVCodecParameters_channels(s.codecpar))
      || (await L.AVCodecParameters_ch_layout_nb_channels(s.codecpar)) || 2;
    this.audioChannels = channels;
    if (s.name === 'aac' && extra !== null && extra.length >= 2) {
      this.copyAudio = true;
      return `mp4a.40.${extra[0]! >> 3}`;
    }
    this.copyAudio = false;
    return 'mp4a.40.2';
  }

  /** What the AAC encoder will be given: its rate, and one of the layouts it takes. */
  private encoderShape(): { rate: number; channels: number; layout: number; name: string } {
    const rate = AAC_RATES.includes(this.audioRate) ? this.audioRate : 48000;
    if (this.audioChannels === 1) return { rate, channels: 1, layout: 4, name: 'mono' };
    if (this.audioChannels >= 6) return { rate, channels: 6, layout: 63, name: '5.1' };
    return { rate, channels: 2, layout: 3, name: 'stereo' };
  }

  /** Begin a muxer and, when sound is re-encoded, the chain that feeds it. */
  private async startPass(restart: boolean): Promise<Pass> {
    const L = this.L;
    const video = this.video!;
    this.passes += 1;
    const device = `out${this.passes}.mp4`;
    await L.mkwriterdev(device);
    const sink: Uint8Array[] = [];
    this.sinks.set(device, sink);

    let par = 0;
    const pars = [[video.codecpar, video.tbNum, video.tbDen]];
    let audioPar = 0;
    let shape: ReturnType<LibavRemuxer['encoderShape']> | null = null;
    if (this.audio !== null) {
      if (this.copyAudio) {
        pars.push([this.audio.codecpar, this.audio.tbNum, this.audio.tbDen]);
      } else {
        shape = this.encoderShape();
        par = await L.avcodec_parameters_alloc();
        audioPar = par;
        await L.ff_copyin_codecpar(audioPar, {
          codec_type: L.AVMEDIA_TYPE_AUDIO,
          codec_id: await L.AVCodecDescriptor_id(await L.avcodec_descriptor_get_by_name('aac')),
          format: L.AV_SAMPLE_FMT_FLTP,
          sample_rate: shape.rate,
          channels: shape.channels,
          channel_layoutmask: shape.layout,
          bit_rate: shape.channels === 1 ? 96000 : shape.channels === 2 ? 160000 : 384000,
          profile: 1,
          extradata: aacConfig(shape.rate, shape.channels),
        });
        pars.push([audioPar, 1, shape.rate]);
      }
    }
    const [oc, , pb] = await L.ff_init_muxer(
      { format_name: 'mp4', filename: device, open: true, codecpars: true }, pars,
    );
    if (par !== 0) await L.avcodec_parameters_free_js(par);
    if (video.name === 'hevc') {
      const st = await L.AVFormatContext_streams_a(oc, 0);
      const vpar = await L.AVStream_codecpar(st);
      /* `hvc1`, to match the codec string handed to the Media Source. */
      await L.AVCodecParameters_codec_tag_s(vpar, 0x31637668);
    }
    await L.av_opt_set(
      oc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_trailer', L.AV_OPT_SEARCH_CHILDREN,
    );
    await L.av_opt_set(oc, 'frag_duration', '4000000', L.AV_OPT_SEARCH_CHILDREN);
    const wrote = await L.avformat_write_header(oc, 0);
    if (wrote < 0) throw new Error(`could not start the output: ${await L.ff_error(wrote)}`);
    await L.avio_flush(pb);

    const pass: Pass = {
      oc, pb, out: sink, packet: await L.av_packet_alloc(), t0: null, held: [], lead: [], lastDts: null, audio: null,
      subs: [], ready: [], eof: false, finished: false, restart, device,
    };
    if (this.audio !== null && !this.copyAudio && shape !== null) {
      pass.audio = await this.startAudio(this.audio, shape);
    }
    return pass;
  }

  private async startAudio(
    s: StreamInfo, shape: { rate: number; channels: number; layout: number; name: string },
  ): Promise<AudioChain> {
    const L = this.L;
    const [, decoder, decPkt, decFrame] = await L.ff_init_decoder(s.codecId, {
      codecpar: s.codecpar, time_base: [s.tbNum, s.tbDen],
    });
    const [, encoder, encFrame, encPkt, frameSize] = await L.ff_init_encoder('aac', {
      ctx: {
        bit_rate: shape.channels === 1 ? 96000 : shape.channels === 2 ? 160000 : 384000,
        sample_fmt: L.AV_SAMPLE_FMT_FLTP,
        sample_rate: shape.rate,
        channel_layout: shape.layout,
        channels: shape.channels,
      },
      time_base: [1, shape.rate],
    });
    return {
      decoder, decPkt, decFrame, graph: null, encoder, encPkt, encFrame,
      frameSize: frameSize > 0 ? frameSize : 1024, nextPts: 0, started: false, rate: shape.rate, inRate: 0,
    };
  }

  private async endPass(p: Pass | null): Promise<void> {
    if (p === null) return;
    const L = this.L;
    this.sinks.delete(p.device);
    try {
      if (p.audio !== null) {
        const a = p.audio;
        await L.ff_free_decoder(a.decoder, a.decPkt, a.decFrame);
        await L.ff_free_encoder(a.encoder, a.encFrame, a.encPkt);
        if (a.graph !== null) {
          await L.avfilter_graph_free_js(a.graph.graph);
          await L.av_frame_free_js(a.graph.frame);
        }
      }
      await L.av_packet_free_js(p.packet);
      await L.ff_free_muxer(p.oc, p.pb);
      await L.unlink(p.device);
    } catch { /* a pass being thrown away is not worth reporting */ }
  }

  private tick(seconds: number, s: StreamInfo): number {
    return Math.round((seconds * s.tbDen) / s.tbNum);
  }

  private seconds(ticks: number, s: StreamInfo): number {
    return (ticks * s.tbNum) / s.tbDen;
  }

  /** Read one batch from the demuxer and push it through the muxer. */
  private async step(p: Pass): Promise<void> {
    const L = this.L;
    const [res, byStream] = await L.ff_read_frame_multi(this.fmt, this.readPkt, { limit: BATCH_BYTES, unify: true });
    const packets: Record<string, unknown>[] = (byStream as Record<number, Record<string, unknown>[]>)[0] ?? [];
    const toWrite: Record<string, unknown>[] = [];
    for (const pk of packets) await this.handle(p, pk, toWrite);
    if (toWrite.length > 0) await L.ff_write_multi(p.oc, p.packet, toWrite, true);
    if (res === L.AVERROR_EOF || (res < 0 && res !== -L.EAGAIN)) {
      if (res !== L.AVERROR_EOF) {
        throw new Error(`the film could not be read (${await L.ff_error(res)})`);
      }
      await this.finish(p);
    } else {
      await L.avio_flush(p.pb);
    }
    await this.collect(p);
  }

  private async handle(p: Pass, pk: Record<string, unknown>, out: Record<string, unknown>[]): Promise<void> {
    const idx = pk['stream_index'] as number;
    if (this.video !== null && idx === this.video.index) {
      await this.videoPacket(p, pk, out);
    } else if (this.audio !== null && idx === this.audio.index) {
      if (p.t0 === null) p.held.push(pk);
      else await this.audioPacket(p, pk, out);
    } else if (this.subs.has(idx)) {
      this.subtitle(p, pk, this.subs.get(idx)!);
    }
  }

  /**
   * Give the muxer a video packet with a decode time it can accept.
   *
   * Matroska stores presentation times only. FFmpeg works decode times out
   * once it has seen enough frames to know the reorder delay, so the first
   * packets of a film with B-frames arrive with NO decode time, and the ones
   * after it already carry real, smaller ones:
   *
   *     pts 0 dts N/A | pts 120 dts N/A | pts 40 dts 0 | pts 80 dts 40 …
   *
   * Taking pts for dts, the easy answer, hands the MP4 muxer a decode time
   * that goes backwards ("non monotonically increasing dts"). So the leading
   * packets wait for the first real decode time and are counted back from it
   * at one frame each; and one that goes missing later follows its neighbour.
   */
  private async videoPacket(p: Pass, pk: Record<string, unknown>, out: Record<string, unknown>[]): Promise<void> {
    const L = this.L;
    const v = this.video!;
    const keyed = ((pk['flags'] as number) & AV_PKT_FLAG_KEY) !== 0;
    /* A pass begins at a keyframe: nothing before one can be decoded. */
    if (p.lastDts === null && p.lead.length === 0 && !keyed) return;
    p.lead.push(pk);
    const known = !isNoPts(toNumber(L, pk['dts'] as number, pk['dtshi'] as number));
    if (p.lastDts === null && !known) return;
    const queue = p.lead;
    p.lead = [];
    const stamp = (x: Record<string, unknown>, ticks: number): void => {
      const [lo, hi] = L.f64toi64(ticks);
      x['dts'] = lo;
      x['dtshi'] = hi;
    };
    if (p.lastDts === null) {
      /* The frame time to count back in: the packet's own duration, else the
         smallest step between presentation times seen so far. */
      let dur = toNumber(L, pk['duration'] as number, pk['durationhi'] as number);
      if (!(dur > 0)) {
        const pts = queue.map((x) => toNumber(L, x['pts'] as number, x['ptshi'] as number)).filter((x) => !isNoPts(x))
          .sort((a, b) => a - b);
        for (let i = 1; i < pts.length; i += 1) {
          const d = pts[i]! - pts[i - 1]!;
          if (d > 0 && (!(dur > 0) || d < dur)) dur = d;
        }
      }
      if (!(dur > 0)) dur = this.tick(1 / 25, v);
      const last = queue.length - 1;
      const d = toNumber(L, pk['dts'] as number, pk['dtshi'] as number);
      for (let i = 0; i < last; i += 1) stamp(queue[i]!, d - (last - i) * dur);
    }
    for (const x of queue) {
      let dts = toNumber(L, x['dts'] as number, x['dtshi'] as number);
      if (isNoPts(dts)) {
        const dur = toNumber(L, x['duration'] as number, x['durationhi'] as number);
        dts = (p.lastDts ?? 0) + (dur > 0 ? dur : this.tick(1 / 25, v));
      }
      /* Strictly rising, whatever the file said. */
      if (p.lastDts !== null && dts <= p.lastDts) dts = p.lastDts + 1;
      p.lastDts = dts;
      stamp(x, dts);
      if (p.t0 === null) {
        p.t0 = this.seconds(dts, v);
        for (const held of p.held) await this.audioPacket(p, held, out);
        p.held = [];
      }
      out.push(this.retime(x, v, 0, p.t0));
    }
  }

  /** A packet with the pass's zero taken off, and the stream renumbered for the muxer. */
  private retime(pk: Record<string, unknown>, s: StreamInfo, outIndex: number, t0: number): Record<string, unknown> {
    const L = this.L;
    const off = this.tick(t0, s);
    const pts = toNumber(L, pk['pts'] as number, pk['ptshi'] as number);
    const dts = toNumber(L, pk['dts'] as number, pk['dtshi'] as number);
    const nPts = isNoPts(pts) ? (isNoPts(dts) ? 0 : dts - off) : pts - off;
    const nDts = isNoPts(dts) ? nPts : dts - off;
    const [pl, ph] = L.f64toi64(nPts);
    const [dl, dh] = L.f64toi64(nDts);
    return {
      ...pk, pts: pl, ptshi: ph, dts: dl, dtshi: dh, stream_index: outIndex, side_data: null,
      time_base_num: s.tbNum, time_base_den: s.tbDen,
    };
  }

  private async audioPacket(p: Pass, pk: Record<string, unknown>, out: Record<string, unknown>[]): Promise<void> {
    const s = this.audio!;
    const t0 = p.t0 ?? 0;
    const pts = toNumber(this.L, pk['pts'] as number, pk['ptshi'] as number);
    /* Before the picture starts: nothing to hear it against. */
    if (!isNoPts(pts) && this.seconds(pts, s) < t0 - 0.001) return;
    if (p.audio === null) {
      out.push(this.retime(pk, s, 1, t0));
      return;
    }
    await this.transcode(p, p.audio, pk, t0, out);
  }

  /** AC-3, DTS, … in; AAC out. */
  private async transcode(
    p: Pass, a: AudioChain, pk: Record<string, unknown>, t0: number, out: Record<string, unknown>[],
  ): Promise<void> {
    const L = this.L;
    const s = this.audio!;
    const frames = await L.ff_decode_multi(a.decoder, a.decPkt, a.decFrame, [{ ...pk, side_data: null }], {
      ignoreErrors: true,
    });
    if (frames.length === 0) return;
    if (!a.started) {
      const f0 = frames[0] as Record<string, number>;
      const sec = (toNumber(L, f0['pts'], f0['ptshi']) * s.tbNum) / s.tbDen;
      /* The encoder's own delay is one frame; starting there keeps every
         timestamp the muxer sees at or above zero. */
      a.inRate = f0['sample_rate'] ?? a.rate;
      a.nextPts = Math.max(0, Math.round((sec - t0) * a.inRate)) + Math.round((a.frameSize * a.inRate) / a.rate);
      a.started = true;
      await this.buildGraph(a, f0);
    }
    for (const f of frames as Record<string, unknown>[]) {
      const n = f['nb_samples'] as number;
      const [lo, hi] = L.f64toi64(a.nextPts);
      f['pts'] = lo;
      f['ptshi'] = hi;
      f['time_base_num'] = 1;
      f['time_base_den'] = a.inRate;
      a.nextPts += n;
    }
    const filtered = await L.ff_filter_multi(a.graph!.src, a.graph!.sink, a.graph!.frame, frames);
    if (filtered.length === 0) return;
    const encoded: Record<string, unknown>[] = await L.ff_encode_multi(a.encoder, a.encFrame, a.encPkt, filtered);
    for (const e of encoded) {
      e['stream_index'] = 1;
      e['time_base_num'] = 1;
      e['time_base_den'] = a.rate;
      e['side_data'] = null;
      out.push(e);
    }
    void p;
  }

  private async buildGraph(a: AudioChain, f0: Record<string, number>): Promise<void> {
    const L = this.L;
    const shape = this.encoderShape();
    const inLayout = L.ff_channel_layout(f0);
    const [graph, src, sink] = await L.ff_init_filter_graph('anull', {
      sample_rate: f0['sample_rate'],
      sample_fmt: f0['format'],
      channel_layout: inLayout,
      time_base: [1, a.inRate],
    }, {
      sample_rate: shape.rate,
      sample_fmt: L.AV_SAMPLE_FMT_FLTP,
      channel_layout: shape.layout,
    });
    /* AAC wants exactly one frame's worth at a time; AC-3 hands over 1536. */
    await L.av_buffersink_set_frame_size(sink, a.frameSize);
    a.graph = { graph, src, sink, frame: await L.av_frame_alloc() };
  }

  private subtitle(p: Pass, pk: Record<string, unknown>, s: StreamInfo): void {
    const L = this.L;
    const pts = toNumber(L, pk['pts'] as number, pk['ptshi'] as number);
    if (isNoPts(pts)) return;
    const dur = toNumber(L, pk['duration'] as number, pk['durationhi'] as number);
    const start = Math.round(this.seconds(pts, s) * 1000);
    const end = start + Math.round(this.seconds(Number.isFinite(dur) && dur > 0 ? dur : 0, s) * 1000);
    const text = new TextDecoder('utf-8').decode(pk['data'] as Uint8Array);
    p.subs.push({ streamIndex: s.index, start, end, content: text });
  }

  /** Everything is read: flush the encoder and close the last fragment. */
  private async finish(p: Pass): Promise<void> {
    const L = this.L;
    if (p.finished) return;
    p.finished = true;
    p.eof = true;
    const extra: Record<string, unknown>[] = [];
    if (p.audio !== null && p.audio.graph !== null) {
      const a = p.audio;
      const tail = await L.ff_filter_multi(a.graph!.src, a.graph!.sink, a.graph!.frame, [], true);
      const encoded: Record<string, unknown>[] = await L.ff_encode_multi(a.encoder, a.encFrame, a.encPkt, tail, true);
      for (const e of encoded) {
        e['stream_index'] = 1;
        e['time_base_num'] = 1;
        e['time_base_den'] = a.rate;
        e['side_data'] = null;
        extra.push(e);
      }
    }
    if (extra.length > 0) await L.ff_write_multi(p.oc, p.packet, extra, true);
    await L.av_write_trailer(p.oc);
    await L.avio_flush(p.pb);
  }

  /** Turn whatever the muxer has written into fragments. */
  private async collect(p: Pass): Promise<void> {
    if (p.out.length === 0 && !p.finished) return;
    const data = concat(p.out.splice(0));
    if (data.length === 0 && !p.finished) return;
    /* Only whole fragments leave: anything cut mid-box waits for the rest. */
    const found = boxes(data);
    let cut = 0;
    for (const b of found) cut = b.end;
    const whole = data.subarray(0, cut);
    if (cut < data.length) p.out.push(data.slice(cut));
    const subs = p.subs;
    p.subs = [];
    if (whole.length > 0) {
      const at = fragmentStart(whole, this.scales);
      let pts = (p.t0 ?? 0);
      if (at !== null) {
        this.scales = at.scales;
        pts += at.seconds;
      }
      p.ready.push({
        data: whole, pts, duration: 0, restart: p.restart, ...(subs.length > 0 ? { subtitles: subs } : {}),
      });
      p.restart = false;
    } else if (subs.length > 0) {
      /* Lines with no fragment to ride on go with the next one. */
      p.subs = subs;
    }
  }

  async read(): Promise<RemuxChunk | null> {
    if (this.dead) throw new Error('Cancelled');
    let p = this.pass;
    if (p === null) {
      p = await this.startPass(true);
      p.out.length = 0;
      this.pass = p;
    }
    for (;;) {
      const next = p.ready.shift();
      if (next !== undefined) return next;
      if (p.eof) {
        const tail = p.subs;
        p.subs = [];
        return { data: new Uint8Array(0), pts: 0, duration: 0, finished: true, ...(tail.length > 0 ? { subtitles: tail } : {}) };
      }
      // eslint-disable-next-line no-await-in-loop
      await this.step(p);
      if (this.dead) throw new Error('Cancelled');
    }
  }

  async seek(at: number): Promise<RemuxChunk | null> {
    if (this.dead) throw new Error('Cancelled');
    const L = this.L;
    const v = this.video!;
    const old = this.pass;
    this.pass = null;
    await this.endPass(old);
    const [lo, hi] = L.f64toi64(this.tick(Math.max(0, at), v));
    const ret = await L.av_seek_frame(this.fmt, v.index, lo, hi, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) throw new Error(`could not move to ${Math.round(at)}s (${await L.ff_error(ret)})`);
    const p = await this.startPass(true);
    p.out.length = 0;
    this.pass = p;
    return this.read();
  }

  async destroy(): Promise<void> {
    this.dead = true;
    const p = this.pass;
    this.pass = null;
    try { await this.L.terminate?.(); } catch { /* already gone */ }
    void p;
  }
}

export async function makeRemuxer(o: RemuxOptions): Promise<Remuxer> {
  return new LibavRemuxer(o);
}
