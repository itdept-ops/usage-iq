using Microsoft.Win32;

namespace UsageIq.Agent.Services;

/// <summary>
/// Toggles the "run at user logon" registry entry under
/// <c>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</c>. Per-user (HKCU) so it needs no admin
/// rights and never affects other accounts. The value points at the current executable with the
/// <c>--tray</c> flag so a logon launch starts minimized to the tray.
/// </summary>
public static class StartupRegistry
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "UsageIqAgent";

    /// <summary>The command line we register: the agent exe, quoted, with the tray flag.</summary>
    private static string LaunchCommand
    {
        get
        {
            var exe = Environment.ProcessPath
                      ?? System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName
                      ?? "";
            return $"\"{exe}\" --tray";
        }
    }

    /// <summary>True if the agent is currently registered to launch at logon.</summary>
    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(ValueName) is string s && !string.IsNullOrWhiteSpace(s);
        }
        catch { return false; }
    }

    /// <summary>
    /// Register or unregister the logon entry. Returns true on success; failures (locked-down policy,
    /// roaming hive quirks) are swallowed and reported as false so the UI can surface a soft warning
    /// rather than crashing.
    /// </summary>
    public static bool Set(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            if (key is null) return false;

            if (enabled)
                key.SetValue(ValueName, LaunchCommand, RegistryValueKind.String);
            else if (key.GetValue(ValueName) is not null)
                key.DeleteValue(ValueName, throwOnMissingValue: false);

            return true;
        }
        catch { return false; }
    }
}
