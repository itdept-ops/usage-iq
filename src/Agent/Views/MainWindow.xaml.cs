using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows;
using System.Windows.Threading;
using UsageIq.Agent.Services;

namespace UsageIq.Agent.Views;

/// <summary>
/// The transparency-first main window: a live, scrolling, timestamped log bound to the engine's events,
/// a status header (connection state, session tokens/cost, next-run countdown), and Pause/Resume +
/// Sync-now controls. All controller callbacks arrive on a background thread and are marshaled onto the
/// Dispatcher before they touch any UI. Closing the window hides it to the tray instead of exiting.
/// </summary>
public partial class MainWindow : Window
{
    private const int MaxLogLines = 1000; // keep the live view bounded so a long backfill can't grow unbounded

    private readonly AgentController _controller;
    private readonly ObservableCollection<LogLine> _log = new();
    private readonly DispatcherTimer _countdown;

    private DateTime? _nextRunAt;
    private AgentState _state = AgentState.Unconfigured;
    private bool _reallyClosing;
    private SettingsWindow? _settings;

    public MainWindow(AgentController controller)
    {
        _controller = controller;
        InitializeComponent();

        Icon = BrandIcon.LoadImage();
        LogList.ItemsSource = _log;

        // Subscribe; events fire on a background thread, so each handler marshals to the Dispatcher.
        _controller.Log += OnLog;
        _controller.StatusChanged += OnStatus;

        // 1s countdown ticker for the "next scan in …" header (purely cosmetic; engine drives the rest).
        _countdown = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _countdown.Tick += (_, _) => UpdateCountdown();
        _countdown.Start();

        OnStatus(_controller.Status); // paint initial state
    }

    // ---- controller events (background thread → Dispatcher) ----

    private void OnLog(LogLine line)
    {
        Dispatcher.BeginInvoke(() =>
        {
            _log.Add(line);
            while (_log.Count > MaxLogLines) _log.RemoveAt(0);

            // Auto-scroll to the newest line so the view stays "live".
            if (_log.Count > 0) LogList.ScrollIntoView(_log[^1]);
        });
    }

    private void OnStatus(AgentStatus status) => Dispatcher.BeginInvoke(() => ApplyStatus(status));

    private void ApplyStatus(AgentStatus status)
    {
        _state = status.State;
        _nextRunAt = status.NextRunAt;

        (StateText.Text, StateDot.Fill) = status.State switch
        {
            AgentState.Unconfigured => ("Not configured — open Settings", Brush("TextMuted")),
            AgentState.Paused => ("Paused", Brush("SevWarning")),
            AgentState.Running => ("Connected — watching", Brush("SevSuccess")),
            AgentState.Syncing => ("Syncing…", Brush("BrandBlue")),
            AgentState.Error => ("Error", Brush("SevError")),
            _ => ("—", Brush("TextMuted")),
        };

        ServerText.Text = string.IsNullOrWhiteSpace(status.ServerUrl) ? "" : $"· {status.ServerUrl} · {status.Machine}";
        TokensValue.Text = AgentStatus.FormatTokens(status.SessionTokens);
        RowsValue.Text = status.SessionRows.ToString("N0", System.Globalization.CultureInfo.InvariantCulture);

        LastSyncText.Text = status.State == AgentState.Error && status.LastError is { } err
            ? $"⚠ {err}"
            : status.LastSyncAt is { } at
                ? $"Last sync {at:HH:mm:ss}" + (status.SessionCost > 0 ? $"  ·  est. ${status.SessionCost:0.00} this session" : "")
                : "No sync yet";

        var running = status.State is AgentState.Running or AgentState.Syncing;
        PauseButton.Content = running ? "Pause" : "Resume";
        PauseButton.IsEnabled = status.State != AgentState.Unconfigured;
        SyncButton.IsEnabled = status.State != AgentState.Unconfigured;

        UpdateCountdown();
    }

    private void UpdateCountdown()
    {
        if (_state is AgentState.Unconfigured or AgentState.Error)
        {
            NextRunValue.Text = "—";
            NextRunLabel.Text = _state == AgentState.Error ? "stopped" : "next scan";
            return;
        }

        if (_state == AgentState.Syncing)
        {
            NextRunValue.Text = "now";
            NextRunLabel.Text = "scanning";
            return;
        }

        if (_nextRunAt is { } next)
        {
            var remaining = next - DateTime.Now;
            if (remaining < TimeSpan.Zero) remaining = TimeSpan.Zero;
            NextRunValue.Text = remaining.TotalHours >= 1
                ? $"{(int)remaining.TotalMinutes}m"
                : $"{(int)remaining.TotalMinutes:00}:{remaining.Seconds:00}";
            NextRunLabel.Text = "next scan";
        }
        else
        {
            NextRunValue.Text = "—";
            NextRunLabel.Text = "next scan";
        }
    }

    private static Brush Brush(string key) => Application.Current?.TryFindResource(key) as Brush ?? Brushes.Gray;

    // ---- buttons ----

    private void OnPauseResume(object sender, RoutedEventArgs e)
    {
        if (_controller.IsRunning) _controller.Pause();
        else _controller.Resume();
    }

    private void OnSyncNow(object sender, RoutedEventArgs e) => _controller.SyncNow();

    private void OnSettings(object sender, RoutedEventArgs e) => OpenSettings();

    // ---- tray / window lifecycle ----

    /// <summary>Open (or focus) the Settings window. On save it triggers a controller reload.</summary>
    public void OpenSettings()
    {
        ShowFromTray();
        if (_settings is { IsVisible: true })
        {
            _settings.Activate();
            return;
        }

        _settings = new SettingsWindow(_controller) { Owner = this };
        _settings.Closed += (_, _) => _settings = null;
        _settings.ShowDialog();
    }

    /// <summary>Restore the window from the tray and bring it to the front.</summary>
    public void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        ShowInTaskbar = true;
        Activate();
        Topmost = true; Topmost = false; // nudge to foreground without staying pinned
        Focus();
    }

    /// <summary>Hide the window into the tray (no taskbar button); the app keeps running.</summary>
    public void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;
    }

    /// <summary>Permit the next <see cref="OnClosing"/> to actually close (used by the tray "Quit").</summary>
    public void AllowClose() => _reallyClosing = true;

    /// <summary>Minimizing drops to the tray rather than the taskbar.</summary>
    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        if (WindowState == WindowState.Minimized) HideToTray();
    }

    /// <summary>Closing the window hides it to the tray; the app quits only via the tray "Quit" menu.</summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_reallyClosing)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        _controller.Log -= OnLog;
        _controller.StatusChanged -= OnStatus;
        _countdown.Stop();
        base.OnClosing(e);
    }
}
