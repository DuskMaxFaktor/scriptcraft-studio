# One-shot binary analyzer for the studio's "Disassembler" (like Ghidra's basics).
# Reads a JSON request on stdin, writes a JSON reply on stdout. Never changes the file.
#   {"cmd":"analyze","file":"..."}                              -> PE headers, sections, imports, exports, strings
#   {"cmd":"disasm","file":"...","offset":N,"length":N,"arch":"x64","vaddr":N} -> instructions
# Patching bytes is done in Node (plain file writes), not here.
import sys, json, struct

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
            raise ValueError("pefile is not installed")
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
    elif data[:4] == b"\x7fELF":
        info["format"] = "elf"
        is64 = data[4] == 2
        little = data[5] == 1
        machine = struct.unpack_from("<H" if little else ">H", data, 18)[0]
        info["arch"] = {0x3e: "x64", 0x03: "x86", 0xb7: "arm64", 0x28: "arm"}.get(machine)
        info["archName"] = {0x3e: "x86-64", 0x03: "x86", 0xb7: "ARM64", 0x28: "ARM"}.get(machine, "0x%x" % machine)
    elif data[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        info["format"] = "macho"

    info["strings"] = extract_strings(data)
    return info


def disasm(req):
    try:
        import capstone
    except Exception:
        raise ValueError("capstone is not installed")
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
        raise ValueError("keystone is not installed")
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
            raise ValueError("line %d (%s): %s" % (n, text, e))
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
