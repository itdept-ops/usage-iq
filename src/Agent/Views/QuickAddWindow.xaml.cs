using System.Windows;
using System.Windows.Input;
using Ccusage.Reporter.Core;
using UsageIq.Agent.Services;

namespace UsageIq.Agent.Views;

/// <summary>
/// A tiny, single-field "Quick add" window for the desktop agent. The user types one line; on submit it
/// POSTs <c>{ text, kind:"auto" }</c> to <c>/api/family/quick-add</c> using the agent's already-configured
/// server URL + ingest key (the same credentials it uses to report usage — read fresh from
/// <c>~/.usage-iq</c> so a key/URL change in Settings is picked up without a restart). The server resolves
/// the acting user from the key's owner and files the text as a list item / reminder / note.
///
/// On success the window closes and reports a short summary back through <paramref name="notify"/> (the tray
/// shows it as a balloon). Errors stay inline so the user can fix the text and retry. If the agent isn't
/// configured yet (no URL or key), it explains that and offers no network call.
/// </summary>
public partial class QuickAddWindow : Window
{
    private readonly Action<string, bool> _notify;
    private bool _busy;

    /// <param name="notify">Callback (message, success) used to surface the outcome as a tray notification.</param>
    public QuickAddWindow(Action<string, bool> notify)
    {
        _notify = notify;
        InitializeComponent();
        Icon = BrandIcon.LoadImage();
        Loaded += (_, _) => TextInput.Focus();
    }

    private void OnInputChanged(object sender, System.Windows.Controls.TextChangedEventArgs e) => ClearStatus();

    private void OnInputKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { e.Handled = true; _ = SubmitAsync(); }
        else if (e.Key == Key.Escape) { e.Handled = true; Close(); }
    }

    private void OnAdd(object sender, RoutedEventArgs e) => _ = SubmitAsync();

    private void OnCancel(object sender, RoutedEventArgs e) => Close();

    private async Task SubmitAsync()
    {
        if (_busy) return;

        var text = TextInput.Text.Trim();
        if (string.IsNullOrEmpty(text)) { ShowStatus("Type something to add first."); return; }

        // Resolve the SAME config the reporter uses: URL from config.json, key from the secret key file.
        var opt = ReporterConfig.LoadFile();           // non-secret (URL, machine, paths…)
        var url = opt.Url?.Trim();
        var key = ReporterConfig.ReadKeyFile();        // the secret ingest key

        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(key))
        {
            ShowStatus("Set your server URL and ingest key in Settings first.");
            return;
        }

        // The ingest key is a bearer secret; over plain http to a non-local host it travels in cleartext.
        // Match the console/PowerShell guard (Reporter/Program.cs): warn — don't refuse — so an http URL still works.
        if (Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Scheme == "http" && !parsed.IsLoopback)
            _notify("Server URL is http:// to a non-local host — the ingest key is sent in cleartext. Use https.", false);

        SetBusy(true);
        try
        {
            using var client = new QuickAddClient(url, key);
            using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(35));
            var result = await client.AddAsync(text, cts.Token);

            // Success: report the server's warm summary via the tray balloon and close.
            _notify(result.Summary, true);
            Close();
        }
        catch (QuickAddException ex)
        {
            // Expected, user-facing failure (bad key, no permission, offline, busy) — keep the window open.
            SetBusy(false);
            ShowStatus(ex.Message);
        }
        catch (Exception ex)
        {
            SetBusy(false);
            ShowStatus($"Couldn't add that: {ex.Message}");
        }
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        AddButton.IsEnabled = !busy;
        CancelButton.IsEnabled = !busy;
        TextInput.IsEnabled = !busy;
        AddButton.Content = busy ? "Adding…" : "Add";
    }

    private void ShowStatus(string message)
    {
        StatusText.Text = message;
        StatusText.Visibility = Visibility.Visible;
    }

    private void ClearStatus()
    {
        StatusText.Text = "";
        StatusText.Visibility = Visibility.Collapsed;
    }
}
