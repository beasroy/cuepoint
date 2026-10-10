// The upload's SHA-256 is the job id and the folder name, so hashing it while it streams must give
// exactly what hashing the finished file gives. If these ever disagree, re-uploading a video stops
// reusing its cached stages and silently pays for transcription again.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hashFile } from "../src/lib/hash";
import { uploadStorage, type HashedFile } from "../src/lib/uploads";

/** Drives the storage engine the way multer does, and returns what it reports back. */
function store(bytes: Buffer): Promise<Partial<HashedFile>> {
  return new Promise((resolve, reject) => {
    const file = { stream: Readable.from([bytes]) } as unknown as Express.Multer.File;
    uploadStorage._handleFile({} as never, file, (err, info) => (err ? reject(err) : resolve(info as Partial<HashedFile>)));
  });
}

describe("uploadStorage", () => {
  it("hashes while streaming to exactly what hashing the written file gives", async () => {
    // Spans several chunks, so the pass-through is exercised more than once.
    const bytes = crypto.randomBytes(5 * 1024 * 1024);
    const info = await store(bytes);
    try {
      expect(info.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
      expect(info.sha256).toBe(await hashFile(info.path!)); // the old two-pass answer
      expect(info.size).toBe(bytes.length);
      expect((await fsp.readFile(info.path!)).equals(bytes)).toBe(true); // nothing lost in the tap
    } finally {
      await fsp.rm(info.path!, { force: true });
    }
  });

  it("handles an empty upload without inventing bytes", async () => {
    const info = await store(Buffer.alloc(0));
    try {
      expect(info.size).toBe(0);
      expect(info.sha256).toBe(crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
    } finally {
      await fsp.rm(info.path!, { force: true });
    }
  });

  it("reports a read failure instead of writing a truncated file", async () => {
    const boom = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw new Error("connection reset");
    })());
    const file = { stream: boom } as unknown as Express.Multer.File;
    await expect(
      new Promise((resolve, reject) =>
        uploadStorage._handleFile({} as never, file, (err, info) => (err ? reject(err) : resolve(info))),
      ),
    ).rejects.toThrow(/connection reset/);
  });
});
