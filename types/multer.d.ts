// Types only — nothing here is imported at runtime and nothing is compiled.
//
// multer ships no type declarations at all, and there is no @types/multer
// installed. With no declaration to read, TypeScript infers the module from its
// JavaScript: `module.exports = multer` gives a bare `(options: any) => any`,
// and the three properties assigned to it on the following lines
// (`module.exports.diskStorage = …`) are not carried across — so `multer(...)`
// checks fine while `multer.diskStorage(...)` is reported as a mistake.
//
// Declared rather than cast at the call site, for the same reason
// socket-io.d.ts is: this describes what the library actually is, once, instead
// of silencing the symptom wherever it surfaces. It covers only what this
// application uses — the file's value is that everything in it is load-
// bearing. (`memoryStorage` joined when the profile picture upload began to
// use it: routes/routersAuth.js.)
//
// Deliberately NOT `any`. The reason for typing routes/routersMedia.js at all is
// that its storage callbacks are easy to get wrong — `cb(null, path)` versus
// `cb(err)` — and a blanket any would check the import and nothing else.

declare module "multer" {
  import type { RequestHandler } from "express";

  namespace multer {
    /** One uploaded part, as multer hands it to a callback or to `req.file`. */
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      /** Set by diskStorage: the directory it chose. */
      destination: string;
      /** Set by diskStorage: the generated name on disk. */
      filename: string;
      /** Set by diskStorage: destination + filename. */
      path: string;
      /** Set by memoryStorage: the whole file. */
      buffer?: Buffer;
    }

    /**
     * The node-style callback both diskStorage handlers answer through. The two
     * arguments are exclusive in practice: an error, or a value.
     */
    type StorageCallback = (error: Error | null, value?: string) => void;

    interface DiskStorageOptions {
      destination: (req: unknown, file: File, cb: StorageCallback) => void;
      filename: (req: unknown, file: File, cb: StorageCallback) => void;
    }

    interface Options {
      storage?: unknown;
      limits?: { fileSize?: number; files?: number; fields?: number };
      /** `cb(null, true)` accepts, `cb(null, false)` skips, `cb(err)` rejects. */
      fileFilter?: (
        req: unknown,
        file: File,
        cb: (error: Error | null, acceptFile?: boolean) => void
      ) => void;
    }

    interface Instance {
      single(fieldname: string): RequestHandler;
      array(fieldname: string, maxCount?: number): RequestHandler;
      none(): RequestHandler;
    }
  }

  function multer(options?: multer.Options): multer.Instance;

  namespace multer {
    function diskStorage(options: DiskStorageOptions): unknown;
    function memoryStorage(): unknown;
    class MulterError extends Error {
      code: string;
      field?: string;
    }
  }

  export = multer;
}
