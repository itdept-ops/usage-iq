using System.Windows;
using WinForms = System.Windows.Forms;
using UsageIq.Agent.Views;

namespace UsageIq.Agent.Services;

/// <summary>
/// The system-tray presence: a <see cref="WinForms.NotifyIcon"/> (the only WinForms UI in the app) with
/// a context menu — Open, Pause/Resume, Sync now, Settings, Quit — and a status tooltip that tracks the
/// agent state (e.g. "Usage IQ — synced 14.2M tokens"). All controller events arrive on a background
/// thread, so menu/tooltip updates are marshaled onto the WPF Dispatcher before touching UI.
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private readonly AgentController _controller;
    private readonly MainWindow _main;
    private readonly Action _quit;

    private readonly WinForms.NotifyIcon _icon;
    private readonly WinForms.ToolStripMenuItem _pauseResume;
    private readonly WinForms.ToolStripMenuItem _syncNow;

    public TrayIcon(AgentController controller, MainWindow main, Action quit)
    {
        _controller = controller;
        _main = main;
        _quit = quit;

        var menu = new WinForms.ContextMenuStrip();

        var open = new WinForms.ToolStripMenuItem("Open", null, (_, _) => OnUi(_main.ShowFromTray)) { Font = new System.Drawing.Font(WinForms.Control.DefaultFont, System.Drawing.FontStyle.Bold) };
        _pauseResume = new WinForms.ToolStripMenuItem("Pause", null, (_, _) => TogglePause());
        _syncNow = new WinForms.ToolStripMenuItem("Sync now", null, (_, _) => _controller.SyncNow());
        var settings = new WinForms.ToolStripMenuItem("Settings…", null, (_, _) => OnUi(_main.OpenSettings));
        var quitItem = new WinForms.ToolStripMenuItem("Quit", null, (_, _) => OnUi(_quit));

        menu.Items.Add(open);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add(_pauseResume);
        menu.Items.Add(_syncNow);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add(settings);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add(quitItem);

        _icon = new WinForms.NotifyIcon
        {
            Icon = BrandIcon.Load(),
            Text = "Usage IQ",
            Visible = true,
            ContextMenuStrip = menu,
        };
        // Double-click the tray icon opens the window (the familiar tray convention).
        _icon.DoubleClick += (_, _) => OnUi(_main.ShowFromTray);

        _controller.StatusChanged += OnStatusChanged;
    }

    private void TogglePause()
    {
        if (_controller.IsRunning) _controller.Pause();
        else _controller.Resume();
    }

    private void OnStatusChanged(AgentStatus status) => OnUi(() => Apply(status));

    /// <summary>Force the menu/tooltip to reflect the controller's current status.</summary>
    public void Refresh() => OnUi(() => Apply(_controller.Status));

    private void Apply(AgentStatus status)
    {
        _icon.Text = status.ToTooltip();

        var running = status.State is AgentState.Running or AgentState.Syncing;
        _pauseResume.Text = running ? "Pause" : "Resume";

        var configured = status.State != AgentState.Unconfigured;
        _pauseResume.Enabled = configured;
        _syncNow.Enabled = configured;
    }

    /// <summary>Marshal an action onto the WPF UI thread (NotifyIcon callbacks may arrive off it).</summary>
    private static void OnUi(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess()) action();
        else dispatcher.BeginInvoke(action);
    }

    public void Dispose()
    {
        _controller.StatusChanged -= OnStatusChanged;
        _icon.Visible = false;
        _icon.Dispose();
    }
}
