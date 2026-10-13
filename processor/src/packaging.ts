export const QUALITIES = {
  P480: { width: 854, height: 480 },
  P720: { width: 1280, height: 720 },
  P1080: { width: 1920, height: 1080 },
} as const;
export type Quality = keyof typeof QUALITIES;
export type Profile = {
  policyVersion: string;
  qualities: Quality[];
  segmentDurationSeconds: number;
  codec: string;
  encoderPolicy: string;
  preset: string;
  crf: number;
  audioBitrateKbps: number;
  audioChannels: number;
  targetVideoBitrateKbps: Record<string, number>;
  passthroughTolerancePercent: number;
  allowUpscale: boolean;
};
export type Probe = {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  pixFmt: string;
  profile: string;
  fps: number;
  cfr: boolean;
  rotate: number;
  videoBitrate: number;
  audioCodec: string;
  audioChannels: number;
  audioBitrate: number;
};
export type PlanItem = {
  quality: Quality;
  width: number;
  height: number;
  mode: "COPY" | "ENCODE";
  targetKbps: number;
};
export function even(n: number) {
  return Math.max(2, Math.floor(n / 2) * 2);
}
export function crfValue(crf: number) {
  return crf <= 0 ? 1 : crf;
}
export function decidePlan(probe: Probe, profile: Profile): PlanItem[] {
  if (profile.allowUpscale)
    throw new Error("PROFILE_SUBSTITUTION_FORBIDDEN");
  if (profile.encoderPolicy !== "X264_EXACT" || profile.codec !== "h264")
    throw new Error("UNSUPPORTED_PROFILE");
  const requested = profile.qualities.filter(
    (q, i) => profile.qualities.indexOf(q) === i,
  );
  if (!requested.length) throw new Error("PROFILE_QUALITIES_REQUIRED");
  const items: PlanItem[] = [];
  for (const quality of requested) {
    const box = QUALITIES[quality];
    if (probe.height < box.height || probe.width < box.width) continue;
    items.push(planFor(quality, box.width, box.height, probe, profile));
  }
  if (!items.length) {
    const ceiling = requested
      .map((q) => QUALITIES[q])
      .sort((a, b) => b.height - a.height)[0];
    const height = even(Math.min(probe.height, ceiling.height));
    const width = even(
      Math.min(
        probe.width,
        Math.round((ceiling.width / ceiling.height) * height),
      ),
    );
    const quality = requested.sort(
      (a, b) => QUALITIES[b].height - QUALITIES[a].height,
    )[0];
    items.push(planFor(quality, width, height, probe, profile));
  }
  return items;
}
function planFor(
  quality: Quality,
  width: number,
  height: number,
  probe: Probe,
  profile: Profile,
): PlanItem {
  const targetKbps = profile.targetVideoBitrateKbps[quality];
  return {
    quality,
    width: even(width),
    height: even(height),
    mode: canCopy(probe, profile, width, height, targetKbps)
      ? "COPY"
      : "ENCODE",
    targetKbps,
  };
}
export function canCopy(
  probe: Probe,
  profile: Profile,
  width: number,
  height: number,
  targetKbps: number,
) {
  if (
    probe.videoCodec !== "h264" ||
    probe.pixFmt !== "yuv420p" ||
    probe.rotate !== 0 ||
    !probe.cfr ||
    probe.width !== width ||
    probe.height !== height
  )
    return false;
  const allowed = ["Constrained Baseline", "Baseline", "Main", "High", "high", "main", "baseline"];
  if (probe.profile && !allowed.some((p) => probe.profile.toLowerCase().includes(p.toLowerCase())))
    return false;
  const tolerance = profile.passthroughTolerancePercent / 100;
  if (targetKbps > 0 && probe.videoBitrate > 0) {
    const kbps = probe.videoBitrate / 1000;
    if (kbps > targetKbps * (1 + tolerance)) return false;
  }
  if (probe.audioCodec && probe.audioCodec !== "aac") return false;
  if (probe.audioChannels > profile.audioChannels) return false;
  if (
    probe.audioBitrate > 0 &&
    probe.audioBitrate > profile.audioBitrateKbps * 1000 * (1 + tolerance)
  )
    return false;
  return true;
}
export function parseProbe(raw: string): Probe {
  const info = JSON.parse(raw);
  const video = (info.streams || []).find((s: any) => s.codec_type === "video");
  const audio = (info.streams || []).find((s: any) => s.codec_type === "audio");
  if (!video) throw new Error("VIDEO_STREAM_REQUIRED");
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  const rotate = Number(video.tags?.rotate || 0) || displayRotate(video) || 0;
  return {
    duration: Number(info.format?.duration || video.duration || 0),
    width: Number(video.width),
    height: Number(video.height),
    videoCodec: String(video.codec_name || ""),
    pixFmt: String(video.pix_fmt || ""),
    profile: String(video.profile || ""),
    fps,
    cfr:
      Boolean(video.avg_frame_rate) &&
      video.avg_frame_rate === video.r_frame_rate &&
      video.avg_frame_rate !== "0/0",
    rotate,
    videoBitrate: Number(video.bit_rate || info.format?.bit_rate || 0),
    audioCodec: String(audio?.codec_name || ""),
    audioChannels: Number(audio?.channels || 0),
    audioBitrate: Number(audio?.bit_rate || 0),
  };
}
function parseRate(v: string) {
  if (!v || v === "0/0") return 0;
  const [a, b] = v.split("/").map(Number);
  return b ? a / b : Number(v) || 0;
}
function displayRotate(video: any) {
  const side = (video.side_data_list || []).find(
    (s: any) => s.rotation != null,
  );
  return side ? Math.abs(Number(side.rotation)) : 0;
}
export function masterPlaylist(items: { quality: string; bandwidth: number; playlist: string; width: number; height: number }[]) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const item of items) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${item.bandwidth},RESOLUTION=${item.width}x${item.height}`,
      item.playlist,
    );
  }
  return lines.join("\n") + "\n";
}
