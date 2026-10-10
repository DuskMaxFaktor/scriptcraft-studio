# One-shot binary analyzer for the studio's "Disassembler" (like Ghidra's basics).
# Reads a JSON request on stdin, writes a JSON reply on stdout. Never changes the file.
#   {"cmd":"analyze","file":"..."}                              -> PE / ELF / Mach-O headers, sections, imports, exports, strings
#   {"cmd":"disasm","file":"...","offset":N,"length":N,"arch":"x64","vaddr":N} -> instructions
# Patching bytes is done in Node (plain file writes), not here.
import json
import struct
import sys

MACHINES = {0x14c: ("x86", "x86"), 0x8664: ("x64", "x86-64"), 0xAA64: ("arm64", "ARM64"), 0x1c0: ("arm", "ARM"), 0x1c4: ("thumb", "ARMv7 Thumb")}


def read_file(path, cap=64 * 1024 * 1024):
    with open(path, "rb") as f:
        data = f.read(cap + 1)
    if len(data) > cap:
        raise ValueError("File is too large to analyze (over 64 MB)")
    return data


def extract_strings(data, min_len=4, limit=4000):
    out = []
    # ASCII runs
    cur = bytearray()
    start = 0
    for i, b in enumerate(data):
        if 32 <= b < 127:
            if not cur:
                start = i
            cur.append(b)
        else:
            if len(cur) >= min_len:
                out.append({"offset": start, "enc": "ascii", "text": cur.decode("ascii")})
                if len(out) >= limit:
                    return out
            cur = bytearray()
    if len(cur) >= min_len:
        out.append({"offset": start, "enc": "ascii", "text": cur.decode("ascii")})
    # UTF-16LE runs (common in PE resources / wide strings)
    i = 0
    n = len(data) - 1
    while i < n and len(out) < limit:
        if 32 <= data[i] < 127 and data[i + 1] == 0:
            start = i
            chars = []
            while i < n and 32 <= data[i] < 127 and data[i + 1] == 0:
                chars.append(chr(data[i]))
                i += 2
            if len(chars) >= min_len:
                out.append({"offset": start, "enc": "utf16", "text": "".join(chars)})
        else:
            i += 1
    return out


def _cstr(data, off):
    end = data.find(b"\x00", off)
    return data[off:end if end != -1 else len(data)].decode("latin-1", "replace")


def analyze_elf(data, info):
    """ELF (Linux, Android...): sections, entry point, needed libraries, dynamic imports / exports."""
    info["format"] = "elf"
    is64 = data[4] == 2
    e = "<" if data[5] == 1 else ">"
    machine = struct.unpack_from(e + "H", data, 18)[0]
    info["arch"] = {0x3e: "x64", 0x03: "x86", 0xb7: "arm64", 0x28: "arm"}.get(machine)
    info["archName"] = {0x3e: "x86-64", 0x03: "x86", 0xb7: "ARM64", 0x28: "ARM"}.get(machine, "0x%x" % machine)
    info["elfType"] = {1: "relocatable", 2: "executable", 3: "shared object", 4: "core"}.get(struct.unpack_from(e + "H", data, 16)[0], "other")
    if is64:
        entry, shoff = struct.unpack_from(e + "Q", data, 24)[0], struct.unpack_from(e + "Q", data, 40)[0]
        shentsize, shnum, shstrndx = struct.unpack_from(e + "HHH", data, 58)
        sh_fmt, sym_fmt, sym_size = e + "IIQQQQIIQQ", e + "IBBHQQ", 24
    else:
        entry, shoff = struct.unpack_from(e + "I", data, 24)[0], struct.unpack_from(e + "I", data, 32)[0]
        shentsize, shnum, shstrndx = struct.unpack_from(e + "HHH", data, 46)
        sh_fmt, sym_fmt, sym_size = e + "IIIIIIIIII", e + "IIIBBH", 16
    # Addresses in ELF are absolute: imageBase 0, the entry point is a virtual address
    info["imageBase"] = 0
    info["entryPoint"] = int(entry)
    if not shoff or shnum == 0 or shoff + shnum * shentsize > len(data):
        return
    raw = []
    for i in range(shnum):
        f = struct.unpack_from(sh_fmt, data, shoff + i * shentsize)
        # name, type, flags, addr, offset, size, link, info, addralign, entsize
        raw.append({"name_off": f[0], "type": f[1], "flags": f[2], "addr": f[3], "offset": f[4], "size": f[5], "link": f[6]})
    strtab = raw[shstrndx]["offset"] if 0 <= shstrndx < len(raw) else None
    for s in raw:
        s["name"] = _cstr(data, strtab + s["name_off"]) if strtab is not None else ""
    for s in raw[1:]:
        if not s["name"]:
            continue
        nobits = s["type"] == 8  # .bss: no bytes in the file
        info["sections"].append({
            "name": s["name"],
            "vaddr": int(s["addr"]),
            "vsize": int(s["size"]),
            "rawPtr": 0 if nobits else int(s["offset"]),
            "rawSize": 0 if nobits else int(s["size"]),
            "read": bool(s["flags"] & 2),
            "write": bool(s["flags"] & 1),
            "exec": bool(s["flags"] & 4),
        })
    # Dynamic symbols: undefined ones are imports, defined global functions are exports
    dynsym = next((s for s in raw if s["type"] == 11), None)  # SHT_DYNSYM
    if dynsym and 0 <= dynsym["link"] < len(raw):
        dynstr = raw[dynsym["link"]]["offset"]
        imports, exports = [], []
        for k in range(1, min(dynsym["size"] // sym_size, 20000)):
            off = dynsym["offset"] + k * sym_size
            if off + sym_size > len(data):
                break
            v = struct.unpack_from(sym_fmt, data, off)
            if is64:
                name_off, st_info, _o, shndx, value = v[0], v[1], v[2], v[3], v[4]
            else:
                name_off, value, _sz, st_info, _o, shndx = v
            name = _cstr(data, dynstr + name_off)
            if not name:
                continue
            bind, kind = st_info >> 4, st_info & 0xF
            if shndx == 0:
                imports.append(name)
            elif bind in (1, 2) and kind == 2:  # GLOBAL/WEAK FUNC
                exports.append({"name": name, "rva": int(value), "ordinal": k})
        needed = []
        dynamic = next((s for s in raw if s["type"] == 6), None)  # SHT_DYNAMIC
        if dynamic:
            ent = 16 if is64 else 8
            for k in range(dynamic["size"] // ent):
                tag, val = struct.unpack_from(e + ("qQ" if is64 else "iI"), data, dynamic["offset"] + k * ent)
                if tag == 0:
                    break
                if tag == 1:  # DT_NEEDED
                    needed.append(_cstr(data, dynstr + val))
        if imports or needed:
            info["imports"].append({"dll": ", ".join(needed) or "(dynamic)", "functions": sorted(set(imports))})
        info["exports"] = exports


MACHO_CPU = {0x01000007: ("x64", "x86-64"), 0x0100000C: ("arm64", "ARM64"), 7: ("x86", "x86"), 12: ("arm", "ARM")}


def analyze_macho(data, info):
    """Mach-O (macOS, iOS): segments and their sections, entry point (LC_MAIN)."""
    info["format"] = "macho"
    magic = data[:4]
    if magic in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        info["format"] = "macho-fat"  # a universal binary holds several programs; not split here
        return
    is64 = magic in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf")
    e = "<" if magic in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe") else ">"
    cputype, _sub, filetype, ncmds, _size, _flags = struct.unpack_from(e + "iiIIII", data, 4)
    arch, name = MACHO_CPU.get(cputype & 0xFFFFFFFF, (None, "0x%x" % (cputype & 0xFFFFFFFF)))
    info["arch"], info["archName"] = arch, name
    info["machoType"] = {1: "object", 2: "executable", 6: "dylib", 8: "bundle"}.get(filetype, "other")
    info["imageBase"] = 0
    off = 32 if is64 else 28
    text_vmaddr, entryoff, libs = None, None, []
    for _ in range(min(ncmds, 2000)):
        if off + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack_from(e + "II", data, off)
        if cmdsize < 8:
            break
        if cmd in (0x19, 0x1):  # LC_SEGMENT_64 / LC_SEGMENT
            if is64:
                segname, vmaddr, vmsize, fileoff, filesize, _mp, _ip, nsects, _f = struct.unpack_from(e + "16sQQQQiiII", data, off + 8)
                sect_off, sect_size, sect_fmt = off + 72, 80, e + "16s16sQQIIIIIIII"
            else:
                segname, vmaddr, vmsize, fileoff, filesize, _mp, _ip, nsects, _f = struct.unpack_from(e + "16sIIIIiiII", data, off + 8)
                sect_off, sect_size, sect_fmt = off + 56, 68, e + "16s16sIIIIIIIII"
            seg = segname.rstrip(b"\x00").decode("latin-1", "replace")
            if seg == "__TEXT":
                text_vmaddr = vmaddr
            for k in range(min(nsects, 500)):
                s = struct.unpack_from(sect_fmt, data, sect_off + k * sect_size)
                sname = s[0].rstrip(b"\x00").decode("latin-1", "replace")
                addr, size, offset, flags = s[2], s[3], s[4], s[8]
                zerofill = (flags & 0xFF) in (1, 12)  # S_ZEROFILL, S_GB_ZEROFILL: no bytes in the file
                info["sections"].append({
                    "name": "%s,%s" % (seg, sname),
                    "vaddr": int(addr),
                    "vsize": int(size),
                    "rawPtr": 0 if zerofill else int(offset),
                    "rawSize": 0 if zerofill else int(size),
                    "read": True,
                    "write": seg == "__DATA",
                    "exec": bool(flags & 0x80000400),  # pure / some instructions
                })
        elif cmd == 0x80000028:  # LC_MAIN
            entryoff = struct.unpack_from(e + "Q", data, off + 8)[0]
        elif cmd in (0xC, 0x80000018, 0x8000001F):  # LC_LOAD_DYLIB / WEAK / REEXPORT
            name_off = struct.unpack_from(e + "I", data, off + 8)[0]
            libs.append(_cstr(data, off + name_off))
        off += cmdsize
    if entryoff is not None and text_vmaddr is not None:
        info["entryPoint"] = int(text_vmaddr + entryoff)
    if libs:
        info["imports"].append({"dll": ", ".join(libs), "functions": []})


def analyze(req):
    path = req["file"]
    data = read_file(path)
    info = {"size": len(data), "format": "unknown", "arch": None, "archName": None,
            "entryPoint": None, "imageBase": None, "sections": [], "imports": [], "exports": [], "strings": []}

    if data[:2] == b"MZ":
        info["format"] = "pe"
        try:
            import pefile
        except Exception:
            raise ValueError("pefile is not installed") from None
        pe = pefile.PE(data=data, fast_load=True)
        pe.parse_data_directories(directories=[
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"],
        ])
        machine = pe.FILE_HEADER.Machine
        arch, arch_name = MACHINES.get(machine, (None, "0x%04x" % machine))
        info["arch"] = arch
        info["archName"] = arch_name
        info["imageBase"] = int(pe.OPTIONAL_HEADER.ImageBase)
        info["entryPoint"] = int(pe.OPTIONAL_HEADER.AddressOfEntryPoint)
        info["subsystem"] = int(getattr(pe.OPTIONAL_HEADER, "Subsystem", 0))
        info["dll"] = bool(pe.FILE_HEADER.Characteristics & 0x2000)
        info["timestamp"] = int(pe.FILE_HEADER.TimeDateStamp)
        for s in pe.sections:
            ch = s.Characteristics
            info["sections"].append({
                "name": s.Name.rstrip(b"\x00").decode("latin-1", "replace"),
                "vaddr": int(s.VirtualAddress),
                "vsize": int(s.Misc_VirtualSize),
                "rawPtr": int(s.PointerToRawData),
                "rawSize": int(s.SizeOfRawData),
                "read": bool(ch & 0x40000000),
                "write": bool(ch & 0x80000000),
                "exec": bool(ch & 0x20000000),
            })
        if hasattr(pe, "DIRECTORY_ENTRY_IMPORT"):
            for entry in pe.DIRECTORY_ENTRY_IMPORT:
                dll = (entry.dll or b"").decode("latin-1", "replace")
                funcs = []
                for imp in entry.imports:
                    if imp.name:
                        funcs.append(imp.name.decode("latin-1", "replace"))
                    elif imp.ordinal is not None:
                        funcs.append("Ordinal %d" % imp.ordinal)
                info["imports"].append({"dll": dll, "functions": funcs})
        if hasattr(pe, "DIRECTORY_ENTRY_EXPORT"):
            for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
                info["exports"].append({
                    "name": exp.name.decode("latin-1", "replace") if exp.name else "Ordinal %d" % exp.ordinal,
                    "rva": int(exp.address),
                    "ordinal": int(exp.ordinal),
                })
        pe.close()
    elif data[:4] == b"\x7fELF" and len(data) >= 64:
        analyze_elf(data, info)
    elif data[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        analyze_macho(data, info)

    info["strings"] = extract_strings(data)
    return info


def disasm(req):
    try:
        import capstone
    except Exception:
        raise ValueError("capstone is not installed") from None
    arch = req.get("arch") or "x64"
    modes = {
        "x86": (capstone.CS_ARCH_X86, capstone.CS_MODE_32),
        "x64": (capstone.CS_ARCH_X86, capstone.CS_MODE_64),
        "arm": (capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM),
        "thumb": (capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB),
        "arm64": (capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM),
    }
    if arch not in modes:
        raise ValueError("Unsupported architecture: %s" % arch)
    a, m = modes[arch]
    md = capstone.Cs(a, m)
    md.skipdata = True
    offset = int(req.get("offset", 0))
    length = min(int(req.get("length", 4096)), 256 * 1024)
    vaddr = int(req.get("vaddr", offset))
    with open(req["file"], "rb") as f:
        f.seek(offset)
        code = f.read(length)
    out = []
    for ins in md.disasm(code, vaddr):
        out.append({
            "addr": ins.address,
            "offset": offset + (ins.address - vaddr),
            "bytes": ins.bytes.hex(),
            "mnemonic": ins.mnemonic,
            "op": ins.op_str,
        })
        if len(out) >= 20000:
            break
    return {"instructions": out, "arch": arch}


def assemble(req):
    """Assembly text -> bytes at the given address (Keystone). Lines are assembled one by one, so an error
    names its line; jumps are relative to the address each line lands at."""
    try:
        import keystone
    except Exception:
        raise ValueError("keystone is not installed") from None
    arch = req.get("arch") or "x64"
    modes = {
        "x86": (keystone.KS_ARCH_X86, keystone.KS_MODE_32),
        "x64": (keystone.KS_ARCH_X86, keystone.KS_MODE_64),
        "arm": (keystone.KS_ARCH_ARM, keystone.KS_MODE_ARM),
        "thumb": (keystone.KS_ARCH_ARM, keystone.KS_MODE_THUMB),
        "arm64": (keystone.KS_ARCH_ARM64, keystone.KS_MODE_LITTLE_ENDIAN),
    }
    if arch not in modes:
        raise ValueError("Unsupported architecture: %s" % arch)
    ks = keystone.Ks(*modes[arch])
    addr = int(req.get("addr", 0))
    code = str(req.get("code", ""))
    if len(code) > 4000:
        raise ValueError("Too much code")
    lines = []
    out = b""
    for n, raw in enumerate(code.replace(";", "\n").split("\n"), 1):
        text = raw.split("#")[0].strip()
        if not text:
            continue
        try:
            enc, _ = ks.asm(text, addr + len(out))
        except keystone.KsError as e:
            raise ValueError("line %d (%s): %s" % (n, text, e)) from None
        b = bytes(enc or [])
        if not b:
            raise ValueError("line %d (%s): nothing assembled" % (n, text))
        lines.append({"text": text, "addr": addr + len(out), "bytes": b.hex()})
        out += b
    return {"bytes": out.hex(), "size": len(out), "lines": lines}


def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
        cmd = req.get("cmd")
        if cmd == "analyze":
            result = analyze(req)
        elif cmd == "disasm":
            result = disasm(req)
        elif cmd == "assemble":
            result = assemble(req)
        else:
            raise ValueError("Unknown command: %s" % cmd)
        sys.stdout.write(json.dumps({"ok": True, "result": result}))
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    main()
