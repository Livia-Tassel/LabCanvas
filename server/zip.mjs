import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';

/** Without the ZIP64 extension an archive holds at most 4 GB; stay clear of it. */
export const MAX_ARCHIVE = 3.9 * 1024 ** 3;

const dosTime = date => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
});

async function checksum(file) {
  let value = 0;
  for await (const chunk of createReadStream(file)) value = crc32(chunk, value);
  return value >>> 0;
}

/**
 * Writes the files to `output` as an uncompressed ZIP archive. Research files are mostly
 * images and already compact, and storing them keeps the export fast.
 */
export async function writeZip(output, files) {
  const stamp = dosTime(new Date());
  const central = [];
  let offset = 0;
  const write = buffer => new Promise((resolve, reject) => {
    offset += buffer.length;
    output.write(buffer, error => (error ? reject(error) : resolve()));
  });
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = await checksum(file.path);
    const start = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // file names are UTF-8
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.size, 18);
    header.writeUInt32LE(file.size, 22);
    header.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([header, name]));
    for await (const chunk of createReadStream(file.path)) await write(chunk);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    // "Made on Unix": extractors then take the name bytes as they are instead of converting from a DOS code page.
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(file.size, 20);
    record.writeUInt32LE(file.size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(start, 42);
    central.push(Buffer.concat([record, name]));
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(Buffer.concat([directory, end]));
}
