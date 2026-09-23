declare module "foliate-js/mobi.js" {
  export class MOBI {
    constructor(opts: { unzlib: (data: Uint8Array) => Promise<Uint8Array> });
    /** Trả về sách MOBI6 hoặc KF8: metadata, sections[{ load(): Promise<blobUrl>, linear? }], getCover() */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    open(file: Blob): Promise<any>;
  }
}
