/**
 * Simple client-side uncompressed (Store) ZIP file creator.
 * Avoids loading large external libraries.
 */

// CRC32 table cache
let crcTable = null;

function makeCRCTable() {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

function crc32(uint8Array) {
  if (!crcTable) {
    crcTable = makeCRCTable();
  }
  let crc = -1;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// Convert MS-DOS date/time
function getDosTime(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  const dosTime = ((hours << 11) | (minutes << 5) | (seconds >> 1)) & 0xFFFF;
  const dosDate = (((year - 1980) << 9) | (month << 5) | day) & 0xFFFF;

  return { dosTime, dosDate };
}

/**
 * Creates a Zip file Blob from a list of files
 * @param {Array<{name: string, content: string|Uint8Array}>} files
 * @returns {Blob} The generated ZIP file blob
 */
export function createZipBlob(files) {
  const textEncoder = new TextEncoder();
  const fileDataList = [];
  let totalLocalSize = 0;
  let centralDirSize = 0;

  const now = new Date();
  const { dosTime, dosDate } = getDosTime(now);

  // 1. Process files and compile local headers + data
  for (const file of files) {
    const filenameBytes = textEncoder.encode(file.name);
    const dataBytes = typeof file.content === 'string' ? textEncoder.encode(file.content) : file.content;
    const fileCrc = crc32(dataBytes);

    // Local file header structure (30 bytes)
    const localHeader = new ArrayBuffer(30);
    const view = new DataView(localHeader);

    view.setUint32(0, 0x04034b50, true); // signature
    view.setUint16(4, 10, true); // version needed (1.0)
    view.setUint16(6, 0, true); // general purpose bit flag
    view.setUint16(8, 0, true); // compression method (0 = store)
    view.setUint16(10, dosTime, true); // last mod time
    view.setUint16(12, dosDate, true); // last mod date
    view.setUint32(14, fileCrc, true); // crc-32
    view.setUint32(18, dataBytes.length, true); // compressed size
    view.setUint32(22, dataBytes.length, true); // uncompressed size
    view.setUint16(26, filenameBytes.length, true); // file name length
    view.setUint16(28, 0, true); // extra field length

    const offset = totalLocalSize;
    const parts = [new Uint8Array(localHeader), filenameBytes, dataBytes];
    const size = 30 + filenameBytes.length + dataBytes.length;
    totalLocalSize += size;

    fileDataList.push({
      name: file.name,
      filenameBytes,
      crc: fileCrc,
      length: dataBytes.length,
      offset,
      parts
    });
  }

  // 2. Build Central Directory headers
  const centralDirParts = [];
  for (const file of fileDataList) {
    // Central directory file header structure (46 bytes)
    const cdHeader = new ArrayBuffer(46);
    const view = new DataView(cdHeader);

    view.setUint32(0, 0x02014b50, true); // signature
    view.setUint16(4, 20, true); // version made by (2.0)
    view.setUint16(6, 10, true); // version needed (1.0)
    view.setUint16(8, 0, true); // general purpose bit flag
    view.setUint16(10, 0, true); // compression method (0 = store)
    view.setUint16(12, dosTime, true); // last mod time
    view.setUint16(14, dosDate, true); // last mod date
    view.setUint32(16, file.crc, true); // crc-32
    view.setUint32(20, file.length, true); // compressed size
    view.setUint32(24, file.length, true); // uncompressed size
    view.setUint16(28, file.filenameBytes.length, true); // file name length
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // file comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal file attributes
    view.setUint32(38, 0, true); // external file attributes
    view.setUint32(42, file.offset, true); // local header offset

    centralDirParts.push(new Uint8Array(cdHeader));
    centralDirParts.push(file.filenameBytes);
    centralDirSize += 46 + file.filenameBytes.length;
  }

  // 3. Build End of Central Directory record (22 bytes)
  const eocd = new ArrayBuffer(22);
  const view = new DataView(eocd);

  view.setUint32(0, 0x06054b50, true); // signature
  view.setUint16(4, 0, true); // number of this disk
  view.setUint16(6, 0, true); // disk where central directory starts
  view.setUint16(8, files.length, true); // number of central directory records on this disk
  view.setUint16(10, files.length, true); // total number of central directory records
  view.setUint32(12, centralDirSize, true); // size of central directory
  view.setUint32(16, totalLocalSize, true); // offset of start of central directory
  view.setUint16(20, 0, true); // comment length

  // Combine all parts into single blob
  const blobParts = [];
  // Local headers + data
  for (const file of fileDataList) {
    blobParts.push(...file.parts);
  }
  // Central directory
  blobParts.push(...centralDirParts);
  // End of Central Directory
  blobParts.push(new Uint8Array(eocd));

  return new Blob(blobParts, { type: 'application/zip' });
}
