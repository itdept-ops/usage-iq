using System.Windows;
using UsageIq.Agent.Services;
using UsageIq.Agent.Views;

namespace UsageIq.Agent;

/// <summary>
/// App entry point. Uses <c>OnExplicitShutdown</c> so the app keeps living in the tray after the main
/// window is closed (closing only hides it). A single-instance mutex prevents a second copy fighting
/// over the tray / state file. The <c>--tray</c> argument (used by the run-at-logon entry) starts the
/// app hidden; a <c>StartMinimized</c> config flag does the same.
/// </summary>
public partial class App : Application
{
    private static Mutex? _singleInstance;

    private AgentController _controller = null!;
    private TrayIcon _tray = null!;
    private MainWindow _main = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // ---- single instance ----
        _singleInstance = new Mutex(initiallyOwned: true, "UsageIqAgent.SingleInstance", out var isNew);
        if (!isNew)
        {
            MessageBox.Show("Usage IQ Agent is already running (look in the system tray).",
                "Usage IQ Agent", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        var args = e.Args ?? Array.Empty<string>();
        var trayFlag = args.Any(a => string.Equals(a, "--tray", StringComparison.OrdinalIgnoreCase));

        // ---- core: controller + window + tray ----
        _controller = new AgentController();
        _main = new MainWindow(_controller);
        _tray = new TrayIcon(_controller, _main, ShutdownApp);

        // Load config and (if it validates) start watching automatically.
        var opt = _controller.Reload();
        var startMinimized = trayFlag || opt.StartMinimized;

        if (opt.Validate() is null)
            _controller.Start();

        if (startMinimized)
            _main.HideToTray(); // stay in the tray; user opens from the menu
        else
            _main.ShowFromTray();

        // Reflect initial state in the tray tooltip/menu.
        _tray.Refresh();
    }

    /// <summary>Clean teardown: stop the engine, remove the tray icon, then exit the process.</summary>
    public void ShutdownApp()
    {
        try { _main?.AllowClose(); } catch { /* ignore */ }
        try { _controller?.Stop(); } catch { /* ignore */ }
        try { _tray?.Dispose(); } catch { /* ignore */ }
        try { _controller?.Dispose(); } catch { /* ignore */ }
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _singleInstance?.ReleaseMutex(); } catch { /* not owned */ }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
