import {extname} from 'node:path';
export const MAX_NATIVE_FILE_BYTES=20*1024*1024;
// A larger PDF may be snapshotted locally only when sending an explicit page range.
export const MAX_RANGED_PDF_SOURCE_BYTES=64*1024*1024;
const types=Object.freeze({
  '.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});
export const nativeFileMime=path=>types[extname(path).toLowerCase()]??null;
