/*
 * v6 C3 (agent C): browser-free unit test of the Polaroid composite.
 * Run: node --import tsx --test apps/web/lib/polaroid.test.ts
 *
 * It stubs `createImageBitmap` and `OffscreenCanvas` before importing the module, the same
 * way apps/web/lib/resize.worker.test.ts does, and checks the two things that can only go
 * wrong silently:
 *
 *  - dimensions: the photo area keeps the source aspect ratio, never upscales, and the frame
 *    is an even border on three sides with a wide one at the bottom;
 *  - EXIF orientation: decoding asks for `imageOrientation: "from-image"`, and a portrait
 *    photo stored as landscape bytes with orientation 6 comes out portrait — i.e. the frame
 *    is drawn around the rotated image, not across it.
 *
 * It also pins the frozen decisions: the filter is applied to the photo only (never to the
 * frame or the caption), and a video MIME type is refused.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";

type DrawCall =
  | { op: "fillRect"; x: number; y: number; width: number; height: number; filter: string }
  | { op: "drawImage"; x: number; y: number; width: number; height: number; filter: string }
  | { op: "fillText"; text: string; x: number; y: number; filter: string; font: string };

const g = globalThis as Record<string, unknown>;

/** The size `createImageBitmap` reports — i.e. AFTER EXIF rotation, as the real one does. */
let decoded = { width: 4032, height: 3024 };
let decodeFails = false;
let lastBitmapOptions: unknown = null;
let closed = 0;
let calls: DrawCall[] = [];
let canvasSize = { width: 0, height: 0 };

g.createImageBitmap = async (_source: unknown, options?: unknown) => {
  lastBitmapOptions = options;
  if (decodeFails) throw new Error("bad image");
  return {
    width: decoded.width,
    height: decoded.height,
    close: () => {
      closed += 1;
    },
  };
};

class StubCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {
    canvasSize = { width, height };
  }
  getContext() {
    const state = { filter: "none", fillStyle: "", font: "", textAlign: "", textBaseline: "" };
    return {
      get filter() {
        return state.filter;
      },
      set filter(value: string) {
        state.filter = value;
      },
      get fillStyle() {
        return state.fillStyle;
      },
      set fillStyle(value: string) {
        state.fillStyle = value;
      },
      get font() {
        return state.font;
      },
      set font(value: string) {
        state.font = value;
      },
      textAlign: "",
      textBaseline: "",
      fillRect(x: number, y: number, width: number, height: number) {
        calls.push({ op: "fillRect", x, y, width, height, filter: state.filter });
      },
      drawImage(_image: unknown, x: number, y: number, width: number, height: number) {
        calls.push({ op: "drawImage", x, y, width, height, filter: state.filter });
      },
      fillText(text: string, x: number, y: number) {
        calls.push({ op: "fillText", text, x, y, filter: state.filter, font: state.font });
      },
    };
  }
  async convertToBlob(options: { type: string; quality: number }) {
    assert.equal(options.type, "image/jpeg");
    return new Blob([`${this.width}x${this.height}`], { type: "image/jpeg" });
  }
}
g.OffscreenCanvas = StubCanvas;

let mod: typeof import("./polaroid");
before(async () => {
  mod = await import("./polaroid");
});

function reset(width: number, height: number): void {
  decoded = { width, height };
  decodeFails = false;
  calls = [];
  closed = 0;
}

function jpeg(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
}

test("polaroidSize caps the long edge, keeps the ratio and never upscales", () => {
  const { polaroidSize, POLAROID_LONG_EDGE } = mod;
  const landscape = polaroidSize(4032, 3024);
  assert.equal(landscape.photo.width, POLAROID_LONG_EDGE);
  assert.equal(landscape.photo.height, Math.round(3024 * (POLAROID_LONG_EDGE / 4032)));

  const portrait = polaroidSize(3024, 4032);
  assert.equal(portrait.photo.height, POLAROID_LONG_EDGE);
  assert.equal(portrait.photo.width, Math.round(3024 * (POLAROID_LONG_EDGE / 4032)));

  // A small source is framed at its own size: a Polaroid of upscaled mush is worse than a
  // small Polaroid.
  const small = polaroidSize(640, 480);
  assert.deepEqual(small.photo, { width: 640, height: 480 });
});

test("the frame is even on three sides and wide at the bottom", () => {
  const size = mod.polaroidSize(1600, 1200);
  assert.equal(size.canvas.width, size.photo.width + size.border * 2);
  assert.equal(size.canvas.height, size.photo.height + size.border + size.caption);
  assert.equal(size.offset.x, size.border);
  assert.equal(size.offset.y, size.border);
  assert.ok(size.caption > size.border, "the caption border must be the wide one");
  // Same visual weight for portrait and landscape: the border follows the long edge.
  assert.equal(mod.polaroidSize(1200, 1600).border, size.border);
});

test("decoding asks for EXIF orientation, and the frame follows the ROTATED size", async () => {
  // An iPhone shot stored as 4032x3024 bytes with orientation 6 decodes to 3024x4032.
  // `createImageBitmap(..., { imageOrientation: "from-image" })` is what applies it, and the
  // composite must be portrait as a result.
  reset(3024, 4032);
  const result = await mod.renderPolaroid(jpeg(), { caption: "Festa" });
  assert.deepEqual(lastBitmapOptions, { imageOrientation: "from-image" });
  assert.deepEqual(result.source, { width: 3024, height: 4032 });
  assert.ok(result.height > result.width, "a rotated portrait shot must come out portrait");
  const expected = mod.polaroidSize(3024, 4032);
  assert.equal(result.width, expected.canvas.width);
  assert.equal(result.height, expected.canvas.height);
  assert.equal(canvasSize.width, expected.canvas.width);
  assert.equal(canvasSize.height, expected.canvas.height);
  assert.equal(closed, 1, "the bitmap must be released");
});

test("the photo is drawn inside the frame at the computed size", async () => {
  reset(4032, 3024);
  await mod.renderPolaroid(jpeg(), {});
  const size = mod.polaroidSize(4032, 3024);
  const draw = calls.find((call) => call.op === "drawImage");
  assert.ok(draw && draw.op === "drawImage");
  assert.equal(draw.x, size.offset.x);
  assert.equal(draw.y, size.offset.y);
  assert.equal(draw.width, size.photo.width);
  assert.equal(draw.height, size.photo.height);
});

test("the filter applies to the photo only, never to the frame or the caption", async () => {
  reset(1600, 1200);
  await mod.renderPolaroid(jpeg(), {
    filter: "bianconero",
    caption: "Festa di Anna",
    subtitle: "7 ottobre 2026",
  });
  const background = calls.find((call) => call.op === "fillRect");
  const draw = calls.find((call) => call.op === "drawImage");
  const texts = calls.filter((call) => call.op === "fillText");
  assert.ok(background && draw);
  assert.equal(background.filter, "none", "the white frame is never filtered");
  assert.equal(draw.filter, mod.POLAROID_FILTERS.bianconero);
  assert.equal(texts.length, 2);
  for (const text of texts) assert.equal(text.filter, "none");
  assert.deepEqual(
    texts.map((call) => (call.op === "fillText" ? call.text : "")),
    ["Festa di Anna", "7 ottobre 2026"],
  );
  // Both lines sit in the wide bottom border, under the photo.
  const size = mod.polaroidSize(1600, 1200);
  for (const text of texts) {
    assert.ok(text.op === "fillText" && text.y > size.offset.y + size.photo.height);
    assert.ok(text.y < size.canvas.height);
  }
});

test("no caption means no fillText at all", async () => {
  reset(1600, 1200);
  await mod.renderPolaroid(jpeg(), { filter: "istantanea" });
  assert.equal(calls.filter((call) => call.op === "fillText").length, 0);
});

test("video is out of scope in v6: every video type is refused", async () => {
  reset(1600, 1200);
  for (const type of ["video/mp4", "video/quicktime", "video/webm", "VIDEO/MP4"]) {
    assert.equal(mod.isAcceptedImage(type), false, type);
    await assert.rejects(
      () => mod.renderPolaroid(new Blob([new Uint8Array([1])], { type }), {}),
      /solo immagini/,
    );
  }
  assert.equal(mod.isAcceptedImage("image/jpeg"), true);
  assert.equal(mod.isAcceptedImage("image/png"), true);
  assert.equal(mod.isAcceptedImage("image/jpeg; charset=binary"), true);
  assert.equal(mod.isAcceptedImage("image/heic"), false);
});

test("a source the browser cannot decode fails as `unsupported`", async () => {
  reset(1600, 1200);
  decodeFails = true;
  await assert.rejects(() => mod.renderPolaroid(jpeg(), {}), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "unsupported");
    return true;
  });
  decodeFails = false;
});

test("an absurdly large source is refused before it is drawn", async () => {
  reset(200_000, 200_000);
  await assert.rejects(() => mod.renderPolaroid(jpeg(), {}), /troppo grande/);
  assert.equal(calls.length, 0);
});

test("every filter is a canvas filter string and has an Italian label", () => {
  for (const [name, value] of Object.entries(mod.POLAROID_FILTERS)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
    assert.ok(mod.isPolaroidFilter(name));
    assert.ok(mod.POLAROID_FILTER_LABELS[name as keyof typeof mod.POLAROID_FILTERS].length > 0);
  }
  assert.equal(mod.isPolaroidFilter("nope"), false);
  // 3 looks plus the untouched original (C3 asks for 2-3 filters).
  assert.equal(Object.keys(mod.POLAROID_FILTERS).length, 4);
});
