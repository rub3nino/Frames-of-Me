/*
 * Browser-free sanity check of the resize worker's message protocol.
 * Run: node --import tsx --test apps/web/lib/resize.worker.test.ts
 * It stubs the worker globals (createImageBitmap / OffscreenCanvas / postMessage)
 * before importing the module, which registers its "message" listener on globalThis.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";

type Listener = (event: { data: unknown }) => void;
const listeners: Listener[] = [];
const posted: unknown[] = [];

let decodeSize = { width: 4000, height: 3000 };
let decodeFails = false;
let closed = 0;

const g = globalThis as Record<string, unknown>;
g.addEventListener = (type: string, listener: Listener) => {
  if (type === "message") listeners.push(listener);
};
g.postMessage = (message: unknown) => {
  posted.push(message);
};
g.createImageBitmap = async () => {
  if (decodeFails) throw new Error("bad image");
  return { ...decodeSize, close: () => { closed += 1; } };
};
g.OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() {
    return { drawImage: () => undefined };
  }
  async convertToBlob(options: { type: string; quality: number }) {
    assert.equal(options.type, "image/jpeg");
    assert.equal(options.quality, 0.8);
    return new Blob([`${this.width}x${this.height}`], { type: "image/jpeg" });
  }
};

// The web package is CJS for node, so the import happens in a hook rather than at top level.
let fitSize: typeof import("./resize.worker").fitSize;
let MAX_PIXELS: number;
let WEB_LONG_EDGE: number;
before(async () => {
  ({ fitSize, MAX_PIXELS, WEB_LONG_EDGE } = await import("./resize.worker"));
});

async function send(id: number): Promise<Record<string, unknown>> {
  const before = posted.length;
  for (const listener of listeners) listener({ data: { id, file: new File([], "x.jpg") } });
  while (posted.length === before) await new Promise((resolve) => setTimeout(resolve, 1));
  return posted[posted.length - 1] as Record<string, unknown>;
}

test("fitSize caps the long edge and never upscales", () => {
  assert.deepEqual(fitSize(4000, 3000), { width: WEB_LONG_EDGE, height: 1200 });
  assert.deepEqual(fitSize(3000, 4000), { width: 1200, height: WEB_LONG_EDGE });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitSize(1600, 1600), { width: 1600, height: 1600 });
});

test("worker registers a message listener", () => {
  assert.equal(listeners.length, 1);
});

test("ok response carries id, blob and resized dimensions; bitmap is closed", async () => {
  const response = await send(7);
  assert.equal(response.id, 7);
  assert.equal(response.ok, true);
  assert.equal(response.width, 1600);
  assert.equal(response.height, 1200);
  assert.ok(response.blob instanceof Blob);
  assert.equal(closed, 1);
});

test("decode failure answers { ok: false, code: 'unsupported' }", async () => {
  decodeFails = true;
  const response = await send(8);
  decodeFails = false;
  assert.deepEqual({ id: response.id, ok: response.ok, code: response.code }, { id: 8, ok: false, code: "unsupported" });
});

test("images above the 120 MP cap are refused as unsupported and still closed", async () => {
  decodeSize = { width: 12000, height: 10001 };
  assert.ok(decodeSize.width * decodeSize.height > MAX_PIXELS);
  const closedBefore = closed;
  const response = await send(9);
  decodeSize = { width: 4000, height: 3000 };
  assert.equal(response.ok, false);
  assert.equal(response.code, "unsupported");
  assert.equal(closed, closedBefore + 1);
});

test("messages without a numeric id are ignored", async () => {
  const before = posted.length;
  for (const listener of listeners) listener({ data: { nope: true } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(posted.length, before);
});
