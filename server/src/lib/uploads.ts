import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, pipeline } from "node:stream";
import type { StorageEngine } from "multer";
import { config } from "../config";

/** Where multipart uploads land before they are moved into place. */
export const uploadDir = path.join(config.dataDir, "_uploads");

/** What the engine below adds to `req.file`: the SHA-256 of the bytes it just wrote. */
export type HashedFile = Express.Multer.File & { sha256?: string };

/**
 * Disk storage that hashes the bytes as they stream past, instead of reading the finished file
 * back to hash it.
 *
 * The upload's SHA-256 is the job id and the folder name, so it has to exist before the request
 * can be answered. Computing it here is free — the bytes are already passing through. Computing it
 * afterwards means a second full pass over the file, and on a network-attached volume (Railway,
 * Fly) that read is the slowest thing in the request: a 226 MB episode is 226 MB written and then
 * 226 MB read back, while the browser sits at 100% with nothing to show.
 *
 * It also (re)creates the upload folder for every file, so deleting data/ while the server runs
 * never breaks the next upload with ENOENT.
 */
export const uploadStorage: StorageEngine = {
  _handleFile(_req, file, cb) {
    fs.mkdir(uploadDir, { recursive: true }, (mkErr) => {
      if (mkErr) return cb(mkErr);
      const filename = crypto.randomUUID();
      const target = path.join(uploadDir, filename);
      const hash = crypto.createHash("sha256");
      let size = 0;
      // A pass-through rather than a `data` listener: piping and listening at once is a race over
      // which attaches first, and pipeline cleans up every stream if any of them fails.
      const tap = new Transform({
        transform(chunk, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      pipeline(file.stream, tap, fs.createWriteStream(target), (err) => {
        if (err) return cb(err);
        cb(null, { destination: uploadDir, filename, path: target, size, sha256: hash.digest("hex") } as Partial<HashedFile>);
      });
    });
  },
  _removeFile(_req, file, cb) {
    fs.unlink(file.path, cb);
  },
};
