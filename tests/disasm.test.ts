// "Disassembler": inspect and patch binaries. Analysis/disassembly use Python (pefile + capstone);
// hex view and byte patching are plain file I/O. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';
import { hasDisasmLibs } from '../api/disasm.ts';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-disasm-'));
const pid = 'bin-proj';
let server: import('http').Server;
let base = '';
// node:test evaluates each test's skip option at registration (before before()), so detect now
const libs = hasDisasmLibs();

/** A minimal valid PE32+ (x64): one executable .text section holding "sub rsp,0x28 ; ret" and a marker string. */
function buildPE(): Buffer {
  const SECT_RVA = 0x1000,
    SECT_RAW = 0x200,
    FILE_ALIGN = 0x200,
    SECT_ALIGN = 0x1000;
  const code = Buffer.from('4883ec28c3', 'hex'); // sub rsp,0x28 ; ret
  const marker = Buffer.from('ScriptCraftDisasm\0', 'ascii');
  const raw = Buffer.alloc(SECT_RAW);
  code.copy(raw, 0);
  marker.copy(raw, code.length);

  const dos = Buffer.alloc(0x40);
  dos.write('MZ', 0, 'ascii');
  dos.writeUInt32LE(0x40, 0x3c); // e_lfanew -> PE header at 0x40

  const coff = Buffer.alloc(24); // "PE\0\0" (4) + file header (20)
  coff.write('PE\0\0', 0, 'ascii');
  coff.writeUInt16LE(0x8664, 4); // Machine x64
  coff.writeUInt16LE(1, 6); // NumberOfSections
  coff.writeUInt16LE(0xf0, 20); // SizeOfOptionalHeader (PE32+)
  coff.writeUInt16LE(0x22, 22); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

  const opt = Buffer.alloc(0xf0);
  opt.writeUInt16LE(0x20b, 0); // Magic PE32+
  opt.writeUInt32LE(code.length, 4); // SizeOfCode
  opt.writeUInt32LE(SECT_RVA, 16); // AddressOfEntryPoint
  opt.writeUInt32LE(SECT_RVA, 20); // BaseOfCode
  opt.writeBigUInt64LE(0x140000000n, 24); // ImageBase
  opt.writeUInt32LE(SECT_ALIGN, 32); // SectionAlignment
  opt.writeUInt32LE(FILE_ALIGN, 36); // FileAlignment
  opt.writeUInt16LE(6, 40); // MajorOSVersion
  opt.writeUInt16LE(6, 48); // MajorSubsystemVersion
  opt.writeUInt32LE(SECT_RVA + SECT_ALIGN, 56); // SizeOfImage
  opt.writeUInt32LE(0x200, 60); // SizeOfHeaders
  opt.writeUInt16LE(3, 68); // Subsystem = console
  opt.writeUInt32LE(16, 108); // NumberOfRvaAndSizes

  const sect = Buffer.alloc(40);
  sect.write('.text', 0, 'ascii');
  sect.writeUInt32LE(code.length + marker.length, 8); // VirtualSize
  sect.writeUInt32LE(SECT_RVA, 12); // VirtualAddress
  sect.writeUInt32LE(SECT_RAW, 16); // SizeOfRawData
  sect.writeUInt32LE(SECT_RAW, 20); // PointerToRawData
  sect.writeUInt32LE(0x60000020, 36); // CODE | EXECUTE | READ

  const headers = Buffer.concat([dos, coff, opt, sect]);
  const padded = Buffer.alloc(SECT_RAW);
  headers.copy(padded, 0);
  return Buffer.concat([padded, raw]);
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

before(async () => {
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, 'projects', pid), { recursive: true });
  // x64 machine code: sub rsp, 0x28 ; ret  — real instructions for capstone
  fs.writeFileSync(path.join(tmp, 'projects', pid, 'code.bin'), Buffer.from('4883ec28c3', 'hex'));
  // Known bytes for the hex view / patch tests
  fs.writeFileSync(path.join(tmp, 'projects', pid, 'data.bin'), Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]));
  // A tiny but valid PE32+ (x64) with one executable .text section — so the test is self-contained
  fs.writeFileSync(path.join(tmp, 'projects', pid, 'sample.exe'), buildPE());

  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', apiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('bad path / id are rejected', async () => {
  assert.equal((await api('POST', '/api/disasm/bytes', { projectId: pid, path: '../../secret' })).status, 400);
  assert.equal((await api('POST', '/api/disasm/bytes', { projectId: 'bad id!', path: 'data.bin' })).status, 400);
  assert.equal((await api('POST', '/api/disasm/bytes', { projectId: pid, path: 'missing.bin' })).status, 404);
});

test('hex view returns the requested byte range', async () => {
  const r = await api('POST', '/api/disasm/bytes', { projectId: pid, path: 'data.bin', offset: 2, length: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 8);
  assert.equal(r.data.offset, 2);
  assert.deepEqual([...Buffer.from(r.data.bytes, 'base64')], [0x22, 0x33, 0x44]);
});

test('patch: a backup is made, bytes change, size stays, out-of-range refused', async () => {
  const file = path.join(tmp, 'projects', pid, 'data.bin');
  // Refuse a patch that would run past the end
  assert.equal((await api('POST', '/api/disasm/patch', { projectId: pid, path: 'data.bin', edits: [{ offset: 7, hex: 'aabb' }] })).status, 400);
  assert.equal((await api('POST', '/api/disasm/patch', { projectId: pid, path: 'data.bin', edits: [{ offset: 0, hex: 'zz' }] })).status, 400);

  const r = await api('POST', '/api/disasm/patch', { projectId: pid, path: 'data.bin', edits: [{ offset: 1, hex: 'eeff' }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.patched, 1);
  assert.deepEqual([...fs.readFileSync(file)], [0x00, 0xee, 0xff, 0x33, 0x44, 0x55, 0x66, 0x77]);
  // Backup keeps the original and the size is unchanged
  assert.deepEqual([...fs.readFileSync(file + '.bak')], [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  assert.equal(fs.statSync(file).size, 8);
});

test('disassemble raw x64 machine code', { skip: !libs.capstone && 'capstone not installed' }, async () => {
  const r = await api('POST', '/api/disasm/disasm', { projectId: pid, path: 'code.bin', offset: 0, length: 5, vaddr: 0x1000, arch: 'x64' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ins = r.data.instructions;
  assert.equal(ins[0].mnemonic, 'sub');
  assert.equal(ins[0].op, 'rsp, 0x28');
  assert.equal(ins[0].addr, 0x1000);
  assert.ok(ins.some((i: any) => i.mnemonic === 'ret'));
});

test('analyze a PE: arch, sections, entry point, strings', { skip: !libs.pefile && 'needs pefile' }, async () => {
  const r = await api('POST', '/api/disasm/analyze', { projectId: pid, path: 'sample.exe' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.format, 'pe');
  assert.equal(r.data.arch, 'x64');
  assert.equal(r.data.imageBase, 0x140000000);
  assert.equal(r.data.entryPoint, 0x1000);
  assert.ok(r.data.sections.some((s: any) => s.name === '.text' && s.exec && s.read));
  assert.ok(r.data.strings.some((s: any) => s.text === 'ScriptCraftDisasm'));
  assert.ok(Array.isArray(r.data.imports));
});

test('disassemble the entry point of a PE via its .text section', { skip: (!libs.pefile || !libs.capstone) && 'needs pefile + capstone' }, async () => {
  const a = (await api('POST', '/api/disasm/analyze', { projectId: pid, path: 'sample.exe' })).data;
  const text = a.sections.find((s: any) => s.name === '.text');
  // entry file offset = section raw pointer + (entry RVA - section virtual address)
  const offset = text.rawPtr + (a.entryPoint - text.vaddr);
  const r = await api('POST', '/api/disasm/disasm', { projectId: pid, path: 'sample.exe', offset, length: 5, vaddr: a.imageBase + a.entryPoint, arch: a.arch });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.instructions[0].addr, 0x140001000);
  assert.equal(r.data.instructions[0].mnemonic, 'sub');
});

test('analyze a non-binary file reports an unknown format, not a crash', { skip: !libs.pefile && 'needs pefile' }, async () => {
  fs.writeFileSync(path.join(tmp, 'projects', pid, 'note.txt'), 'hello world this is plain text\n');
  const r = await api('POST', '/api/disasm/analyze', { projectId: pid, path: 'note.txt' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.format, 'unknown');
  assert.ok(r.data.strings.some((s: any) => s.text.includes('hello world')));
});
