// ScriptCraft Studio installer / uninstaller (built by make_installer.ps1 with the csc.exe of .NET Framework 4.x).
//
// ScriptCraftStudio-Setup.exe = this program + the portable ZIP appended + a trailer (8-byte payload length, "SCSETUP1").
// Installs for the current user (no admin rights): %LOCALAPPDATA%\Programs\ScriptCraftStudio, Start menu and
// desktop shortcuts, an entry in "Installed apps". Updating over an existing install keeps the user's data:
// projects\, settings.json, .env, studio.log, tools\.
// The same program without a payload is Uninstall.exe in the install folder.
//
// Command line:
//   /S                 silent (a small progress window only), used by the studio's auto-update
//   /D=<folder>        install folder
//   /launch            start the studio when done
//   /uninstall         uninstall (Uninstall.exe runs this mode without arguments too)
//   /deletedata        uninstall: also delete projects, keys and settings (asked in the interactive mode)
//   /regkey=<subkey>   tests: register under HKCU\<subkey> instead of the "Installed apps" list
//   /shortcutdir=<d>   tests: put both shortcuts into this folder
//   /noshortcuts       no shortcuts
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ScriptCraftSetup {
    public static class Program {
        const string Version = "__VERSION__";
        const string AppName = "ScriptCraft Studio";
        const string Magic = "SCSETUP1";
        const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ScriptCraftStudio";
        // Folders and files of the program itself; replaced on update. Everything else in the folder is the user's.
        static readonly string[] AppDirs = { "api", "dist", "electron", "node_modules", "runtime", "public", "scripts", "src", "tests" };
        static readonly string[] UserData = { "projects", "settings.json", ".env", "studio.log", "tools" };

        static bool silent, launch, uninstall, deleteData, noShortcuts;
        static string installDir, regKey = UninstallRoot, shortcutDir;
        static int parentPid;
        static string logPath = Path.Combine(Path.GetTempPath(), "ScriptCraftSetup.log");

        [STAThread]
        public static int Main(string[] args) {
            Application.EnableVisualStyles();
            foreach (string a in args) {
                string l = a.ToLowerInvariant();
                if (l == "/s") silent = true;
                else if (l == "/launch") launch = true;
                else if (l == "/uninstall") uninstall = true;
                else if (l == "/deletedata") deleteData = true;
                else if (l == "/noshortcuts") noShortcuts = true;
                else if (l.StartsWith("/d=")) installDir = Path.GetFullPath(a.Substring(3).Trim('"'));
                else if (l.StartsWith("/regkey=")) regKey = a.Substring(8);
                else if (l.StartsWith("/shortcutdir=")) shortcutDir = a.Substring(13).Trim('"');
                else if (l.StartsWith("/parent=")) int.TryParse(a.Substring(8), out parentPid);
            }
            try {
                long payloadOffset, payloadLength;
                bool hasPayload = FindPayload(out payloadOffset, out payloadLength);
                if (uninstall || !hasPayload) return Uninstall();
                if (installDir == null) installDir = ExistingInstall() ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\ScriptCraftStudio");
                if (silent) return RunWithProgress(T("Обновление ScriptCraft Studio…"), p => Install(payloadOffset, payloadLength, p));
                using (var form = new SetupForm(payloadOffset, payloadLength)) Application.Run(form);
                return 0;
            } catch (Exception e) {
                Log("FATAL " + e);
                if (!silent) MessageBox.Show(e.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        static string T(string s) { return s; }

        public static void Log(string s) {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + s + Environment.NewLine, Encoding.UTF8); } catch { }
        }

        // ---------- payload ----------
        static bool FindPayload(out long offset, out long length) {
            offset = length = 0;
            string self = Assembly.GetExecutingAssembly().Location;
            using (var fs = File.OpenRead(self)) {
                if (fs.Length < 16) return false;
                fs.Seek(-16, SeekOrigin.End);
                var trailer = new byte[16];
                fs.Read(trailer, 0, 16);
                if (Encoding.ASCII.GetString(trailer, 8, 8) != Magic) return false;
                length = BitConverter.ToInt64(trailer, 0);
                offset = fs.Length - 16 - length;
                return offset > 0;
            }
        }

        static string ExistingInstall() {
            try {
                using (var k = Registry.CurrentUser.OpenSubKey(regKey)) {
                    var loc = k == null ? null : k.GetValue("InstallLocation") as string;
                    return string.IsNullOrEmpty(loc) ? null : loc;
                }
            } catch { return null; }
        }

        // ---------- running studio ----------
        /** Processes started from the install folder (launcher, server node.exe, Electron window). */
        static List<Process> RunningFrom(string dir) {
            var list = new List<Process>();
            string prefix = dir.TrimEnd('\\') + "\\";
            int me = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcesses()) {
                if (p.Id == me) continue;
                try {
                    string f = p.MainModule.FileName;
                    if (f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) list.Add(p);
                } catch { }
            }
            return list;
        }

        static void StopStudio(string dir) {
            for (int attempt = 0; attempt < 3; attempt++) {
                var procs = RunningFrom(dir);
                if (procs.Count == 0) return;
                foreach (var p in procs) {
                    try { Log("stopping " + p.ProcessName + " " + p.Id); p.Kill(); } catch { }
                }
                foreach (var p in procs) { try { p.WaitForExit(5000); } catch { } }
                Thread.Sleep(300);
            }
        }

        // ---------- install ----------
        public static void Install(long offset, long length, Action<int, string> progress) {
            Log("install " + Version + " -> " + installDir);
            progress(2, T("Закрываю запущенную студию…"));
            StopStudio(installDir);
            Directory.CreateDirectory(installDir);

            progress(5, T("Распаковываю…"));
            string tmpZip = Path.Combine(Path.GetTempPath(), "ScriptCraftSetup-" + Guid.NewGuid().ToString("N") + ".zip");
            try {
                string self = Assembly.GetExecutingAssembly().Location;
                using (var src = File.OpenRead(self))
                using (var dst = File.Create(tmpZip)) {
                    src.Seek(offset, SeekOrigin.Begin);
                    var buf = new byte[1 << 20];
                    long left = length;
                    while (left > 0) {
                        int n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) throw new IOException("Установщик повреждён (архив обрезан)");
                        dst.Write(buf, 0, n);
                        left -= n;
                    }
                }

                // Old program files go away (stale files of an older version must not stay); user data stays
                progress(10, T("Удаляю старую версию…"));
                foreach (string d in AppDirs) {
                    string p = Path.Combine(installDir, d);
                    if (Directory.Exists(p)) DeleteDir(p);
                }

                using (var zip = ZipFile.OpenRead(tmpZip)) {
                    int total = zip.Entries.Count, done = 0;
                    string full = Path.GetFullPath(installDir).TrimEnd('\\') + "\\";
                    foreach (var e in zip.Entries) {
                        done++;
                        if (done % 200 == 0) progress(10 + (int)(85L * done / total), T("Копирую файлы…"));
                        // The archive holds one top folder (ScriptCraftStudio\...)
                        string name = e.FullName.Replace('/', '\\');
                        int slash = name.IndexOf('\\');
                        if (slash < 0) continue;
                        name = name.Substring(slash + 1);
                        if (name.Length == 0) continue;
                        string target = Path.GetFullPath(Path.Combine(installDir, name));
                        if (!target.StartsWith(full, StringComparison.OrdinalIgnoreCase)) continue; // "..\" in an entry
                        if (name.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                        string top = name.Split('\\')[0];
                        if (Array.IndexOf(UserData, top) >= 0 && File.Exists(target)) continue; // keys, settings: the user's
                        if (top == ".portable-build") continue; // installed, not portable
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        e.ExtractToFile(target, true);
                    }
                }
            } finally {
                try { File.Delete(tmpZip); } catch { }
            }
            File.WriteAllText(Path.Combine(installDir, ".installed"), Version, Encoding.ASCII);

            progress(96, T("Ярлыки и регистрация…"));
            // Uninstall.exe: this program without the payload
            string self2 = Assembly.GetExecutingAssembly().Location;
            using (var src = File.OpenRead(self2))
            using (var dst = File.Create(Path.Combine(installDir, "Uninstall.exe"))) {
                var buf = new byte[1 << 16];
                long left = offset;
                while (left > 0) {
                    int n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (n <= 0) break;
                    dst.Write(buf, 0, n);
                    left -= n;
                }
            }
            string exe = Path.Combine(installDir, "ScriptCraftStudio.exe");
            if (!noShortcuts) {
                CreateShortcut(Path.Combine(StartMenuDir(), AppName + ".lnk"), exe);
                if (SetupForm.DesktopShortcut) CreateShortcut(Path.Combine(DesktopDir(), AppName + ".lnk"), exe);
            }
            Register(exe);
            progress(100, T("Готово"));
            Log("installed");
            if (launch) StartStudio(exe);
        }

        public static void StartStudio(string exe) {
            try {
                var psi = new ProcessStartInfo(exe);
                psi.WorkingDirectory = Path.GetDirectoryName(exe);
                psi.UseShellExecute = true;
                Process.Start(psi);
            } catch (Exception e) { Log("launch failed " + e.Message); }
        }

        static string StartMenuDir() { return shortcutDir ?? Environment.GetFolderPath(Environment.SpecialFolder.Programs); }
        static string DesktopDir() { return shortcutDir ?? Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory); }

        static void CreateShortcut(string lnkPath, string target) {
            try {
                Directory.CreateDirectory(Path.GetDirectoryName(lnkPath));
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { AppName });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            } catch (Exception e) { Log("shortcut failed " + lnkPath + " " + e.Message); }
        }

        static void Register(string exe) {
            using (var k = Registry.CurrentUser.CreateSubKey(regKey)) {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", Version);
                k.SetValue("Publisher", "ScriptCraft");
                k.SetValue("InstallLocation", installDir);
                k.SetValue("DisplayIcon", exe + ",0");
                string un = "\"" + Path.Combine(installDir, "Uninstall.exe") + "\"";
                k.SetValue("UninstallString", un);
                k.SetValue("QuietUninstallString", un + " /S");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                try {
                    long bytes = 0;
                    foreach (var f in new DirectoryInfo(installDir).EnumerateFiles("*", SearchOption.AllDirectories)) bytes += f.Length;
                    k.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
                } catch { }
            }
        }

        static void DeleteDir(string dir) {
            for (int i = 0; i < 5; i++) {
                try {
                    // Read-only files (git objects in node_modules...) would stop Directory.Delete
                    foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories))
                        if ((f.Attributes & FileAttributes.ReadOnly) != 0) f.Attributes = FileAttributes.Normal;
                    Directory.Delete(dir, true);
                    return;
                } catch (Exception e) {
                    if (i == 4) throw new IOException("Не удалось удалить " + dir + ": " + e.Message);
                    Thread.Sleep(500);
                }
            }
        }

        // ---------- uninstall ----------
        static int Uninstall() {
            if (installDir == null) {
                // Uninstall.exe in the install folder
                string here = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                installDir = File.Exists(Path.Combine(here, ".installed")) ? here : ExistingInstall();
            }
            if (installDir == null || !File.Exists(Path.Combine(installDir, ".installed"))) {
                if (!silent) MessageBox.Show("ScriptCraft Studio не найдена.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }
            // Uninstall.exe cannot delete itself while it runs: continue from a copy in TEMP
            string self = Assembly.GetExecutingAssembly().Location;
            if (self.StartsWith(installDir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) {
                string copy = Path.Combine(Path.GetTempPath(), "ScriptCraftUninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(self, copy);
                var args = new StringBuilder("/uninstall /D=\"" + installDir + "\" /parent=" + Process.GetCurrentProcess().Id);
                if (silent) args.Append(" /S");
                if (deleteData) args.Append(" /deletedata");
                if (regKey != UninstallRoot) args.Append(" /regkey=" + regKey);
                if (shortcutDir != null) args.Append(" /shortcutdir=\"" + shortcutDir + "\"");
                var psi = new ProcessStartInfo(copy, args.ToString());
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Path.GetTempPath();
                // Exit right away: the copy waits for this process, then deletes Uninstall.exe too
                Process.Start(psi);
                return 0;
            }
            if (parentPid > 0) {
                try { Process.GetProcessById(parentPid).WaitForExit(15000); } catch { }
            }
            if (!silent) {
                var r = MessageBox.Show("Удалить ScriptCraft Studio?", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes) return 2;
                var d = MessageBox.Show(
                    "Удалить также ваши проекты, ключи (.env) и настройки?\n\nНет — они останутся в папке:\n" + installDir,
                    AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                deleteData = d == DialogResult.Yes;
            }
            Log("uninstall " + installDir + (deleteData ? " (with data)" : ""));
            StopStudio(installDir);
            foreach (string lnk in new[] { Path.Combine(StartMenuDir(), AppName + ".lnk"), Path.Combine(DesktopDir(), AppName + ".lnk") }) {
                try { if (File.Exists(lnk)) File.Delete(lnk); } catch { }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(regKey, false); } catch { }
            if (deleteData) DeleteDir(installDir);
            else {
                foreach (var entry in Directory.GetFileSystemEntries(installDir)) {
                    if (Array.IndexOf(UserData, Path.GetFileName(entry)) >= 0) continue;
                    if (Directory.Exists(entry)) DeleteDir(entry); else { File.SetAttributes(entry, FileAttributes.Normal); File.Delete(entry); }
                }
            }
            if (!silent) MessageBox.Show(deleteData ? "ScriptCraft Studio удалена." : "ScriptCraft Studio удалена. Ваши проекты остались в папке:\n" + installDir, AppName);
            // Remove this temporary copy shortly after exit
            try {
                var del = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + Assembly.GetExecutingAssembly().Location + "\"");
                del.CreateNoWindow = true;
                del.UseShellExecute = false;
                Process.Start(del);
            } catch { }
            return 0;
        }

        // ---------- UI ----------
        public static readonly Color Bg = Color.FromArgb(17, 19, 26), Panel = Color.FromArgb(26, 29, 39), Fg = Color.FromArgb(226, 232, 240),
            Muted = Color.FromArgb(148, 163, 184), Accent = Color.FromArgb(99, 102, 241);

        static int RunWithProgress(string title, Action<Action<int, string>> work) {
            int code = 0;
            using (var f = new Form()) {
                f.Text = AppName;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.MaximizeBox = f.MinimizeBox = false;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.ClientSize = new Size(380, 96);
                f.BackColor = Bg;
                f.ForeColor = Fg;
                f.Font = new Font("Segoe UI", 9f);
                try { f.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
                var lbl = new Label { Text = title, Left = 16, Top = 14, Width = 348, Height = 20 };
                var bar = new ProgressBar { Left = 16, Top = 40, Width = 348, Height = 14 };
                var st = new Label { Left = 16, Top = 62, Width = 348, Height = 20, ForeColor = Muted };
                f.Controls.AddRange(new Control[] { lbl, bar, st });
                f.Shown += (s, e) => {
                    var th = new Thread(() => {
                        try {
                            work((pct, text) => f.BeginInvoke((Action)(() => { bar.Value = Math.Max(0, Math.Min(100, pct)); st.Text = text; })));
                        } catch (Exception ex) {
                            Log("FAILED " + ex);
                            code = 1;
                            f.BeginInvoke((Action)(() => MessageBox.Show(f, "Не удалось обновить: " + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error)));
                        }
                        f.BeginInvoke((Action)(() => f.Close()));
                    });
                    th.IsBackground = true;
                    th.Start();
                };
                Application.Run(f);
            }
            return code;
        }

        class SetupForm : Form {
            public static bool DesktopShortcut = true;
            readonly long offset, length;
            readonly TextBox dirBox;
            readonly CheckBox desktop, runAfter;
            readonly ProgressBar bar;
            readonly Label status;
            readonly Button installBtn, cancelBtn, browseBtn;

            public SetupForm(long offset, long length) {
                this.offset = offset;
                this.length = length;
                bool update = File.Exists(Path.Combine(installDir, ".installed"));
                Text = (update ? "Обновление " : "Установка ") + AppName + " " + Version;
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = MinimizeBox = false;
                StartPosition = FormStartPosition.CenterScreen;
                ClientSize = new Size(500, 250);
                BackColor = Bg;
                ForeColor = Fg;
                Font = new Font("Segoe UI", 9.5f);
                try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

                var title = new Label { Text = AppName + " " + Version, Left = 20, Top = 16, Width = 460, Height = 28, Font = new Font("Segoe UI Semibold", 13f) };
                var sub = new Label {
                    Text = update ? "Найдена установленная версия: она обновится, проекты и ключи останутся." : "Среда для скриптов и программ с ИИ-помощником. Права администратора не нужны.",
                    Left = 20, Top = 46, Width = 460, Height = 20, ForeColor = Muted
                };
                var dirLbl = new Label { Text = "Папка установки:", Left = 20, Top = 80, Width = 200, Height = 18, ForeColor = Muted };
                dirBox = new TextBox { Text = installDir, Left = 20, Top = 100, Width = 370, BackColor = Panel, ForeColor = Fg, BorderStyle = BorderStyle.FixedSingle };
                browseBtn = MakeButton("Обзор…", 398, 98, 82, false);
                browseBtn.Click += (s, e) => {
                    using (var d = new FolderBrowserDialog()) {
                        d.SelectedPath = dirBox.Text;
                        if (d.ShowDialog(this) == DialogResult.OK) dirBox.Text = Path.Combine(d.SelectedPath, "ScriptCraftStudio");
                    }
                };
                desktop = new CheckBox { Text = "Ярлык на рабочем столе", Left = 20, Top = 134, Width = 230, Checked = true };
                runAfter = new CheckBox { Text = "Запустить после установки", Left = 255, Top = 134, Width = 230, Checked = true };
                bar = new ProgressBar { Left = 20, Top = 170, Width = 460, Height = 12, Visible = false };
                status = new Label { Left = 20, Top = 188, Width = 460, Height = 18, ForeColor = Muted };
                installBtn = MakeButton(update ? "Обновить" : "Установить", 290, 210, 110, true);
                cancelBtn = MakeButton("Отмена", 406, 210, 74, false);
                cancelBtn.Click += (s, e) => Close();
                installBtn.Click += (s, e) => Start();
                AcceptButton = installBtn;
                CancelButton = cancelBtn;
                Controls.AddRange(new Control[] { title, sub, dirLbl, dirBox, browseBtn, desktop, runAfter, bar, status, installBtn, cancelBtn });
            }

            static Button MakeButton(string text, int x, int y, int w, bool primary) {
                var b = new Button { Text = text, Left = x, Top = y, Width = w, Height = 28, FlatStyle = FlatStyle.Flat, BackColor = primary ? Accent : Panel, ForeColor = Fg };
                b.FlatAppearance.BorderColor = primary ? Accent : Color.FromArgb(51, 65, 85);
                return b;
            }

            void Start() {
                try { installDir = Path.GetFullPath(dirBox.Text.Trim()); } catch { MessageBox.Show(this, "Неверная папка", AppName); return; }
                DesktopShortcut = desktop.Checked;
                if (RunningFrom(installDir).Count > 0 &&
                    MessageBox.Show(this, "ScriptCraft Studio сейчас запущена — закрыть её и продолжить?", AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
                    return;
                installBtn.Enabled = cancelBtn.Enabled = browseBtn.Enabled = dirBox.Enabled = desktop.Enabled = runAfter.Enabled = false;
                bar.Visible = true;
                bool run = runAfter.Checked;
                var th = new Thread(() => {
                    try {
                        Install(offset, length, (pct, text) => BeginInvoke((Action)(() => { bar.Value = Math.Max(0, Math.Min(100, pct)); status.Text = text; })));
                        BeginInvoke((Action)(() => {
                            if (run) StartStudio(Path.Combine(installDir, "ScriptCraftStudio.exe"));
                            else MessageBox.Show(this, "Готово! ScriptCraft Studio есть в меню «Пуск».", AppName);
                            Close();
                        }));
                    } catch (Exception ex) {
                        Log("FAILED " + ex);
                        BeginInvoke((Action)(() => {
                            MessageBox.Show(this, "Установка не удалась: " + ex.Message + "\n\nЖурнал: " + logPath, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                            cancelBtn.Enabled = true;
                        }));
                    }
                });
                th.IsBackground = true;
                th.Start();
            }
        }
    }
}
