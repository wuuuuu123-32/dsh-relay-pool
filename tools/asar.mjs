// 极简 ASAR 读取器：不依赖 @electron/asar。
// 用法：
//   node asar.mjs list <asar> [正则]           列出路径
//   node asar.mjs read <asar> <内部路径>        打印文件内容
//   node asar.mjs size <asar> <内部路径>        打印字节数
import fs from 'node:fs';

const cmd = process.argv[2];
const ASAR = process.argv[3];

function loadHeader(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const a = b.readUInt32LE(0);
  let hdrStart, hdrLen;
  // Electron asar: | u32=4 | u32 total | u32 len+4 | u32 len | JSON |
  if (a === 4) { hdrStart = 16; hdrLen = b.readUInt32LE(12); }
  else { hdrStart = 4; hdrLen = a; }
  const hb = Buffer.alloc(hdrLen);
  fs.readSync(fd, hb, 0, hdrLen, hdrStart);
  fs.closeSync(fd);
  return { header: JSON.parse(hb.toString('utf8')), dataStart: hdrStart + hdrLen };
}

function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (v.files) walk(v, p, out);
    else out.push({ path: p, size: v.size || 0, offset: v.offset, unpacked: !!v.unpacked });
  }
}

const { header, dataStart } = loadHeader(ASAR);
const files = [];
walk(header, '', files);

if (cmd === 'list') {
  const re = process.argv[4] ? new RegExp(process.argv[4]) : null;
  for (const f of files) if (!re || re.test(f.path)) console.log(f.size + '\t' + f.path);
} else if (cmd === 'read') {
  const want = process.argv[4];
  const f = files.find(x => x.path === want || x.path === want.replace(/^\//, ''));
  if (!f) { console.error('NOT FOUND: ' + want); process.exit(1); }
  if (f.unpacked) { console.error('UNPACKED: ' + f.path); process.exit(2); }
  const fd = fs.openSync(ASAR, 'r');
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, dataStart + Number(f.offset));
  fs.closeSync(fd);
  process.stdout.write(buf);
} else if (cmd === 'size') {
  const want = process.argv[4];
  const f = files.find(x => x.path === want);
  console.log(f ? f.size : -1);
} else {
  console.error('usage: node asar.mjs list|read|size <asar> [arg]');
  process.exit(1);
}
