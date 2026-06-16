using System.Windows.Media.Imaging;

namespace UsageIq.Agent.Services;

/// <summary>
/// Loads the embedded Usage IQ brand icon (Assets/usage-iq.ico, marked as a WPF Resource) for both the
/// WinForms tray <c>NotifyIcon</c> (a <see cref="System.Drawing.Icon"/>) and the WPF window chrome (a
/// <see cref="BitmapFrame"/>). Falling back to the system application icon keeps the tray usable even if
/// the resource somehow can't be opened.
/// </summary>
public static class BrandIcon
{
    private const string Pack = "pack://application:,,,/Assets/usage-iq.ico";

    /// <summary>The tray/window icon as a <see cref="System.Drawing.Icon"/> (multi-size .ico preserved).</summary>
    public static System.Drawing.Icon Load()
    {
        try
        {
            var info = System.Windows.Application.GetResourceStream(new Uri(Pack));
            if (info is not null)
            {
                using var s = info.Stream;
                return new System.Drawing.Icon(s);
            }
        }
        catch { /* fall through */ }
        return System.Drawing.SystemIcons.Application;
    }

    /// <summary>The same icon as a WPF <see cref="BitmapFrame"/> for <c>Window.Icon</c>.</summary>
    public static BitmapFrame? LoadImage()
    {
        try { return BitmapFrame.Create(new Uri(Pack)); }
        catch { return null; }
    }
}
