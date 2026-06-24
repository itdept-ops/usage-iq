using System.Diagnostics;
using System.Windows;
using Ccusage.Reporter.Core;
using UsageIq.Agent.Services;

namespace UsageIq.Agent.Views;

/// <summary>
/// Settings editor bound to the JSON config (~/.usage-iq/config.json) plus the separate secret key file
/// (~/.usage-iq/reporter.key). The key field is masked and only written when the user actually types a
/// new value — it is never read back into the UI. Saving persists the non-secret config, writes the key
/// file if changed, toggles the run-at-logon registry entry, then asks the controller to reload (which
/// rebuilds the engine with the new settings).
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly AgentController _controller;
    private bool _keyExists;
    private bool _revealed;

    public SettingsWindow(AgentController controller)
    {
        _controller = controller;
        InitializeComponent();
        Icon = BrandIcon.LoadImage();
        Load();
    }

    private void Load()
    {
        var opt = ReporterConfig.LoadFile(); // non-secret only; never trusts a key in config.json

        UrlBox.Text = opt.Url ?? "";
        MachineBox.Text = opt.Machine ?? "";
        IntervalBox.Text = opt.IntervalSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        ClaudeBox.Text = opt.ClaudePath ?? "";
        CodexBox.Text = opt.CodexPath ?? "";
        GeminiBox.Text = opt.GeminiPath ?? "";
        StartMinimizedCheck.IsChecked = opt.StartMinimized;
        RunOnStartupCheck.IsChecked = StartupRegistry.IsEnabled();

        // The key is never shown. Just indicate whether one is already on file.
        _keyExists = !string.IsNullOrWhiteSpace(ReporterConfig.ReadKeyFile());
        KeyHint.Text = _keyExists
            ? "A key is already saved. Leave this blank to keep it, or type a new key to replace it."
            : "No key saved yet. Paste your ingest key here.";
    }

    private void OnToggleReveal(object sender, RoutedEventArgs e)
    {
        _revealed = !_revealed;
        if (_revealed)
        {
            KeyPlain.Text = KeyBox.Password;
            KeyPlain.Visibility = Visibility.Visible;
            KeyBox.Visibility = Visibility.Collapsed;
            RevealButton.Content = "Hide";
        }
        else
        {
            KeyBox.Password = KeyPlain.Text;
            KeyBox.Visibility = Visibility.Visible;
            KeyPlain.Visibility = Visibility.Collapsed;
            RevealButton.Content = "Show";
        }
    }

    /// <summary>The currently-entered key (from whichever field is visible). Empty means "unchanged".</summary>
    private string EnteredKey => (_revealed ? KeyPlain.Text : KeyBox.Password).Trim();

    private void OnOpenReporterPage(object sender, RoutedEventArgs e)
    {
        var baseUrl = UrlBox.Text.Trim().TrimEnd('/');
        var target = string.IsNullOrWhiteSpace(baseUrl) ? "https://usageiq.online" : baseUrl;
        // The self-service ingest-key page lives at /reporter on the dashboard.
        OpenUrl($"{target}/reporter");
    }

    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { /* no default browser / blocked — nothing else to do */ }
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        var url = UrlBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(url))
        {
            StatusText.Text = "Server URL is required.";
            return;
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https"))
        {
            StatusText.Text = "Server URL must be an absolute http(s) URL.";
            return;
        }

        if (!int.TryParse(IntervalBox.Text.Trim(), out var interval))
        {
            StatusText.Text = "Interval must be a whole number of seconds.";
            return;
        }
        interval = Math.Clamp(interval, 5, 3600);

        var enteredKey = EnteredKey;
        if (!_keyExists && string.IsNullOrWhiteSpace(enteredKey))
        {
            StatusText.Text = "An ingest key is required the first time. Paste one from the Reporter page.";
            return;
        }

        // ---- persist non-secret config ----
        var opt = new ReporterOptions
        {
            Url = url,
            Machine = NullIfBlank(MachineBox.Text),
            ClaudePath = NullIfBlank(ClaudeBox.Text),
            CodexPath = NullIfBlank(CodexBox.Text),
            GeminiPath = NullIfBlank(GeminiBox.Text),
            IntervalSeconds = interval,
            StartMinimized = StartMinimizedCheck.IsChecked == true,
            RunOnStartup = RunOnStartupCheck.IsChecked == true,
        };

        try { ReporterConfig.Save(opt); }
        catch (Exception ex) { StatusText.Text = $"Could not save config: {ex.Message}"; return; }

        // ---- persist the secret key only if the user typed a new one ----
        if (!string.IsNullOrWhiteSpace(enteredKey))
        {
            try { ReporterConfig.SaveKeyFile(enteredKey); }
            catch (Exception ex) { StatusText.Text = $"Could not save the key file: {ex.Message}"; return; }
        }

        // ---- run-at-logon registry toggle (best-effort; soft-warn on failure) ----
        var wantStartup = RunOnStartupCheck.IsChecked == true;
        if (!StartupRegistry.Set(wantStartup))
            StatusText.Text = "Saved, but the run-at-logon setting could not be applied.";

        // ---- rebuild the engine with the new settings, and resume watching if it now validates ----
        var reloaded = _controller.Reload();
        if (reloaded.Validate() is null)
            _controller.Start();

        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
