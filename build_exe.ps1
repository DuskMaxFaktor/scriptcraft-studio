$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$csharpCode = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace ScriptCraft {
    public class Program {
        const string Url = "http://localhost:3000";
        static NotifyIcon tray;
        static Process serverProcess;
        static string logPath;

        [STAThread]
        public static void Main() {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "ScriptCraftStudioLauncher", out createdNew)) {
                try {
                    // Another launcher is already running: just open the window
                    if (!createdNew) {
                        OpenAppWindow(Url);
                        return;
                    }

                    string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                    logPath = Path.Combine(baseDir, "studio.log");

                    // Server started elsewhere (e.g. start_studio.bat): just open the window
                    if (IsPortOpen("127.0.0.1", 3000)) {
                        OpenAppWindow(Url);
                        return;
                    }

                    string bat = Path.Combine(baseDir, "start_studio.bat");
                    if (!File.Exists(bat)) {
                        MessageBox.Show("Не найден start_studio.bat в папке:\n" + baseDir, "ScriptCraft Studio", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }

                    // Run the server fully hidden; output goes to studio.log, "< nul" makes pause return
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
                        "/c \"\"" + bat + "\" nobrowser < nul > \"" + logPath + "\" 2>&1\"");
                    psi.WorkingDirectory = baseDir;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    serverProcess = Process.Start(psi);

                    SetupTray();

                    Thread waiter = new Thread(WaitForServer);
                    waiter.IsBackground = true;
                    waiter.Start();

                    Application.Run();
                } catch (Exception ex) {
                    MessageBox.Show("Ошибка запуска: " + ex.Message, "ScriptCraft Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    StopServer();
                }
            }
        }

        static void SetupTray() {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Открыть ScriptCraft Studio", null, delegate { OpenAppWindow(Url); });
            menu.Items.Add("Показать лог сервера", null, delegate {
                if (File.Exists(logPath)) Process.Start("notepad.exe", "\"" + logPath + "\"");
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Выход (остановить сервер)", null, delegate { ExitApp(); });

            tray = new NotifyIcon();
            // Use the icon embedded into the exe (app.ico); fall back to the default one
            try { tray.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { tray.Icon = System.Drawing.SystemIcons.Application; }
            tray.Text = "ScriptCraft Studio — запуск...";
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenAppWindow(Url); };
            tray.Visible = true;
        }

        static void WaitForServer() {
            // First run may need npm install, so wait up to ~2 minutes
            for (int i = 0; i < 400; i++) {
                if (serverProcess != null && serverProcess.HasExited) break;
                if (IsPortOpen("127.0.0.1", 3000)) {
                    tray.Text = "ScriptCraft Studio — работает";
                    OpenAppWindow(Url);
                    return;
                }
                Thread.Sleep(300);
            }
            MessageBox.Show("Сервер не запустился на порту 3000.\nПодробности в файле:\n" + logPath, "ScriptCraft Studio", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            ExitApp();
        }

        static void StopServer() {
            try {
                if (serverProcess != null && !serverProcess.HasExited) {
                    ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/PID " + serverProcess.Id + " /T /F");
                    kill.UseShellExecute = false;
                    kill.CreateNoWindow = true;
                    Process.Start(kill).WaitForExit(5000);
                }
            } catch { }
        }

        static void CloseAppWindow() {
            try {
                string electron = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"node_modules\electron\dist\electron.exe");
                foreach (Process p in Process.GetProcessesByName("electron")) {
                    try {
                        if (string.Equals(p.MainModule.FileName, electron, StringComparison.OrdinalIgnoreCase)) {
                            if (p.MainWindowHandle != IntPtr.Zero) p.CloseMainWindow(); else p.Kill();
                        }
                    } catch { }
                }
            } catch { }
        }

        static void ExitApp() {
            CloseAppWindow();
            StopServer();
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            Application.Exit();
        }

        static bool IsPortOpen(string host, int port) {
            try {
                using (var client = new TcpClient()) {
                    var result = client.BeginConnect(host, port, null, null);
                    var success = result.AsyncWaitHandle.WaitOne(400);
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            } catch {
                return false;
            }
        }

        static void OpenAppWindow(string url) {
            try {
                // Own window (Electron, node_modules\electron); a second launch just focuses it
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string electron = Path.Combine(baseDir, @"node_modules\electron\dist\electron.exe");
                string mainJs = Path.Combine(baseDir, @"electron\main.cjs");
                if (File.Exists(electron) && File.Exists(mainJs)) {
                    ProcessStartInfo epsi = new ProcessStartInfo(electron, "\"" + mainJs + "\" --url=" + url);
                    epsi.WorkingDirectory = baseDir;
                    epsi.UseShellExecute = false;
                    epsi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                    Process.Start(epsi);
                    return;
                }

                // Try Edge App Mode (native window without browser frame)
                string[] possibleEdge = new string[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                    // Chrome supports the same --app mode
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
                };

                foreach (string p in possibleEdge) {
                    if (File.Exists(p)) {
                        Process.Start(p, "--app=\"" + url + "\" --window-size=1360,860");
                        return;
                    }
                }

                // Fallback to default browser
                ProcessStartInfo psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
            } catch {
                Process.Start(url);
            }
        }
    }
}
"@

$outputExe = Join-Path $ScriptDir "ScriptCraftStudio.exe"

Write-Host "Compiling standalone ScriptCraftStudio.exe..." -ForegroundColor Cyan

$iconPath = Join-Path $ScriptDir "app.ico"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }

if (Test-Path $csc) {
    # csc.exe (part of .NET Framework on every Windows) can embed the icon into the exe
    $srcFile = Join-Path $env:TEMP "ScriptCraftLauncher.cs"
    [System.IO.File]::WriteAllText($srcFile, $csharpCode, (New-Object System.Text.UTF8Encoding($true)))
    $cscArgs = @("/nologo", "/target:winexe", "/optimize+", "/codepage:65001", "/out:$outputExe",
                 "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll")
    if (Test-Path $iconPath) { $cscArgs += "/win32icon:$iconPath" } else { Write-Host "app.ico not found - building without icon" -ForegroundColor Yellow }
    $cscArgs += $srcFile
    if (Test-Path $outputExe) { Remove-Item $outputExe -Force }
    & $csc @cscArgs
    Remove-Item $srcFile -ErrorAction SilentlyContinue
} else {
    Write-Host "csc.exe not found - building without icon" -ForegroundColor Yellow
    Add-Type -TypeDefinition $csharpCode -Language CSharp -OutputAssembly $outputExe -OutputType WindowsApplication -ReferencedAssemblies "System.Windows.Forms","System.Drawing"
}

if (Test-Path $outputExe) {
    . (Join-Path $ScriptDir "scripts\sign_exe.ps1")
    Sign-ScriptCraftExe -Path $outputExe
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Green
    Write-Host " [SUCCESS] ScriptCraftStudio.exe compiled successfully!" -ForegroundColor Green
    Write-Host " File: $outputExe" -ForegroundColor Green
    Write-Host " Double-click it anytime to launch as a standalone app!" -ForegroundColor Green
    Write-Host "===========================================================" -ForegroundColor Green
} else {
    Write-Host "Compilation failed." -ForegroundColor Red
}
