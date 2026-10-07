/*
 * v6 C3 (agent C): the Polaroid composite.
 *
 * The filter and the frame are drawn on a canvas AFTER the shot, never as a live preview
 * effect. That is a frozen decision, and it is not about taste: a CSS `filter` on a live
 * `<video>` repaints every frame on iOS Safari and on low-end Android, which drops the
 * preview to single-digit fps and heats the device, while `canvas.filter` applied once to a
 * still frame costs a few milliseconds and gives the identical pixels. The preview stays a
 * plain, untouched `<video>`.
 *
 * EXIF orientation is handled exactly once, by decoding through
 * `createImageBitmap(source, { imageOrientation: "from-image" })`. From that point the
 * bitmap's own width/height are the display orientation, nothing else rotates, and the
 * portrait/landscape decision below reads the already-rotated size. A camera File from
 * `<input capture>` on iOS routinely carries orientation 6 (90° CW); without this the frame
 * would be drawn across a sideways photo.
 *
 * Video is out of scope for v6 (decision 4, frozen): {@link isAcceptedImage} refuses every
 * `video/*` type, and the camera component refuses the same before it ever reaches here.
 */

/** Long edge of the photo area inside the frame. A 1600 px print is plenty for a phone. */
export const POLAROID_LONG_EDGE = 1600;
/** Side and top border, as a fraction of the photo area's long edge. */
export const POLAROID_BORDER_RATIO = 0.055;
/** The wide bottom border a Polaroid has, as a fraction of the long edge. */
export const POLAROID_CAPTION_RATIO = 0.17;
export const POLAROID_JPEG_QUALITY = 0.86;
/** 120 megapixels, same guard as the resize worker: refused before decoding. */
export const MAX_PIXELS = 120_000_000;

/** The 3 filters of C3, as canvas filter strings. `none` is the untouched shot. */
export const POLAROID_FILTERS = {
  none: "none",
  /** Warm, slightly faded: the classic instant-film look. */
  istantanea: "saturate(1.15) contrast(1.08) sepia(0.18) brightness(1.03)",
  /** Cool and crisp, for indoor tungsten light. */
  notte: "saturate(0.92) contrast(1.18) brightness(0.96) hue-rotate(-8deg)",
  /** Black and white. */
  bianconero: "grayscale(1) contrast(1.12)",
} as const;

export type PolaroidFilter = keyof typeof POLAROID_FILTERS;

export const POLAROID_FILTER_LABELS: Record<PolaroidFilter, string> = {
  none: "Originale",
  istantanea: "Istantanea",
  notte: "Notte",
  bianconero: "Bianco e nero",
};

export function isPolaroidFilter(value: string): value is PolaroidFilter {
  return Object.prototype.hasOwnProperty.call(POLAROID_FILTERS, value);
}

export type PolaroidOptions = {
  /** Drawn in the wide bottom border, e.g. the event name. */
  caption?: string;
  /** Drawn under the caption, e.g. the event date. Already formatted. */
  subtitle?: string;
  filter?: PolaroidFilter;
  /** Long edge of the photo area; the frame is sized from it. */
  longEdge?: number;
};

export type PolaroidSize = {
  /** The photo area, inside the frame. */
  photo: { width: number; height: number };
  /** The whole composite, frame included. */
  canvas: { width: number; height: number };
  /** Where the photo area starts inside the canvas. */
  offset: { x: number; y: number };
  border: number;
  caption: number;
};

/**
 * Geometry of the composite for a source of `width` × `height` **in display orientation**
 * (i.e. after EXIF rotation). The photo area keeps the source's aspect ratio with its long
 * edge capped at `longEdge`, never upscaled; the frame is an even border on three sides and
 * a wide one at the bottom.
 */
export function polaroidSize(
  width: number,
  height: number,
  longEdge: number = POLAROID_LONG_EDGE,
): PolaroidSize {
  const longest = Math.max(width, height);
  const scale = longest > longEdge ? longEdge / longest : 1;
  const photoWidth = Math.max(1, Math.round(width * scale));
  const photoHeight = Math.max(1, Math.round(height * scale));
  // The border is a fraction of the photo's own long edge, so a portrait and a landscape
  // shot get a frame of the same visual weight.
  const reference = Math.max(photoWidth, photoHeight);
  const border = Math.max(1, Math.round(reference * POLAROID_BORDER_RATIO));
  const caption = Math.max(border, Math.round(reference * POLAROID_CAPTION_RATIO));
  return {
    photo: { width: photoWidth, height: photoHeight },
    canvas: { width: photoWidth + border * 2, height: photoHeight + border + caption },
    offset: { x: border, y: border },
    border,
    caption,
  };
}

/** What the camera accepts: photos only. Every `video/*` type is refused (decision 4). */
export function isAcceptedImage(type: string): boolean {
  const normalised = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalised === "image/jpeg" || normalised === "image/png";
}

type Bitmap = { width: number; height: number; close?: () => void };

type Canvas2d = {
  filter: string;
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: unknown, x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
};

export type PolaroidResult = {
  blob: Blob;
  width: number;
  height: number;
  /** The decoded source size, after EXIF rotation. Exposed so the caller can log it. */
  source: { width: number; height: number };
};

/**
 * Decodes `source` (a camera File, or a frame already grabbed from the video), applies the
 * chosen filter to the pixels, and draws the white Polaroid frame with its caption. The
 * returned JPEG is what gets uploaded; the caller keeps the untouched `source` as the
 * original so the frame can be re-rendered later.
 */
export async function renderPolaroid(
  source: Blob,
  options: PolaroidOptions = {},
): Promise<PolaroidResult> {
  if (source.type && !isAcceptedImage(source.type)) {
    throw Object.assign(new Error("solo immagini JPEG o PNG"), { code: "unsupported" as const });
  }
  let bitmap: Bitmap;
  try {
    // The ONLY place orientation is handled: from here on, width/height are display order.
    bitmap = (await createImageBitmap(source as Blob, {
      imageOrientation: "from-image",
    })) as unknown as Bitmap;
  } catch (cause) {
    throw Object.assign(new Error(cause instanceof Error ? cause.message : "decode failed"), {
      code: "unsupported" as const,
    });
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      throw Object.assign(new Error("immagine troppo grande"), { code: "unsupported" as const });
    }
    const size = polaroidSize(bitmap.width, bitmap.height, options.longEdge);
    const canvas = new OffscreenCanvas(size.canvas.width, size.canvas.height);
    const context = canvas.getContext("2d") as unknown as Canvas2d | null;
    if (!context) throw new Error("no 2d context");
    drawPolaroid(context, bitmap, size, options);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: POLAROID_JPEG_QUALITY,
    });
    return {
      blob,
      width: size.canvas.width,
      height: size.canvas.height,
      source: { width: bitmap.width, height: bitmap.height },
    };
  } finally {
    bitmap.close?.();
  }
}

/**
 * The drawing itself, split out so it can be exercised against a recording stub: white
 * frame, then the filtered photo, then the caption. The filter is set only while the photo
 * is drawn — leaving it on would tint the frame and the text too.
 */
export function drawPolaroid(
  context: Canvas2d,
  bitmap: Bitmap,
  size: PolaroidSize,
  options: PolaroidOptions = {},
): void {
  context.filter = "none";
  context.fillStyle = "#fffdf7";
  context.fillRect(0, 0, size.canvas.width, size.canvas.height);
  context.filter = POLAROID_FILTERS[options.filter ?? "none"];
  context.drawImage(
    bitmap,
    size.offset.x,
    size.offset.y,
    size.photo.width,
    size.photo.height,
  );
  context.filter = "none";
  const caption = options.caption?.trim();
  const subtitle = options.subtitle?.trim();
  if (!caption && !subtitle) return;
  const captionTop = size.offset.y + size.photo.height;
  const centre = size.canvas.width / 2;
  context.textAlign = "center";
  context.textBaseline = "middle";
  if (caption) {
    const titleSize = Math.round(size.caption * 0.34);
    context.font = `600 ${titleSize}px ui-sans-serif, system-ui, sans-serif`;
    context.fillStyle = "#1c1917";
    context.fillText(caption, centre, captionTop + size.caption * (subtitle ? 0.38 : 0.5));
  }
  if (subtitle) {
    const subtitleSize = Math.round(size.caption * 0.24);
    context.font = `400 ${subtitleSize}px ui-sans-serif, system-ui, sans-serif`;
    context.fillStyle = "#57534e";
    context.fillText(subtitle, centre, captionTop + size.caption * (caption ? 0.7 : 0.5));
  }
}
