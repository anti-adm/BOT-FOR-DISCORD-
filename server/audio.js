import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import OpusScript from 'opusscript';
export const RATE = 16000;
export const CHUNK_MS = 2000;

// Read-only adapter for the bot's existing rolling Opus buffer. Never opens a writer.
export function renderChunk(directory, start, end) {
  const samples = new Float32Array(Math.round((end - start) * RATE / 1000));
  const decoders = new Map();
  let packets = 0;
  let files;
  try { files = readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return { pcm: Buffer.alloc(samples.length * 2), packets }; throw error; }
  files = files.filter(name => /^\d+-\d+\.bin$/.test(name))
    .filter(name => { const bucket = Number(name.split('-')[0]) * 1000; return bucket >= start - 1000 && bucket <= end + 1000; })
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]));
  try {
    for (const file of files) {
      let bytes;
      try { bytes = readFileSync(join(directory, file)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (let offset = 0; offset + 18 <= bytes.length;) {
        const timestamp = bytes.readDoubleLE(offset);
        const id = bytes.readBigUInt64LE(offset + 8).toString();
        const size = bytes.readUInt16LE(offset + 16);
        offset += 18;
        // A file may still be receiving its final packet. Ignore a partial tail.
        if (!size || size > 4096 || offset + size > bytes.length) break;
        const packet = bytes.subarray(offset, offset + size); offset += size;
        if (!Number.isFinite(timestamp) || timestamp < start - 1000 || timestamp >= end) continue;
        let decoder = decoders.get(id);
        if (!decoder) { decoder = new OpusScript(RATE, 1, OpusScript.Application.AUDIO); decoders.set(id, decoder); }
        let pcm;
        try { pcm = decoder.decode(packet); } catch { continue; }
        const base = Math.round((timestamp - start) * RATE / 1000);
        const first = Math.max(0, -base), last = Math.min(pcm.length / 2, samples.length - base);
        if (last > first) packets++;
        for (let i = first; i < last; i++) samples[base + i] += pcm.readInt16LE(i * 2) / 32768;
      }
    }
  } finally { for (const decoder of decoders.values()) decoder.delete(); }
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return { pcm, packets };
}
