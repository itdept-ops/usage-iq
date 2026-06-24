using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace UsageIq.Agent.Services;

/// <summary>Maps a <see cref="LogSeverity"/> to the brand brush used for its tag (SCAN/POST/OK/…).</summary>
public sealed class SeverityToBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var key = value is LogSeverity sev ? sev switch
        {
            LogSeverity.Scan => "SevScan",
            LogSeverity.Post => "SevPost",
            LogSeverity.Success => "SevSuccess",
            LogSeverity.Warning => "SevWarning",
            LogSeverity.Error => "SevError",
            _ => "SevInfo",
        } : "SevInfo";

        return Application.Current?.TryFindResource(key) as Brush ?? Brushes.Gray;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => Binding.DoNothing;
}

/// <summary>
/// Maps a source's "present on this machine" flag to its status-dot brush: brand green when the source's
/// path exists here (it can be scanned), muted grey when it doesn't (e.g. Gemini/Antigravity on a box
/// where ~/.gemini isn't present). Used by the main window's Data Sources panel.
/// </summary>
public sealed class PresentToBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var key = value is true ? "SevSuccess" : "TextMuted";
        return Application.Current?.TryFindResource(key) as Brush ?? Brushes.Gray;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => Binding.DoNothing;
}

/// <summary>
/// Maps a <see cref="LogSeverity"/> to the message text brush. Warnings/errors keep their accent color;
/// everything else uses primary/secondary text so the log stays readable, not a rainbow.
/// </summary>
public sealed class SeverityToTextConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var key = value is LogSeverity sev ? sev switch
        {
            LogSeverity.Warning => "SevWarning",
            LogSeverity.Error => "SevError",
            LogSeverity.Success => "SevSuccess",
            LogSeverity.Post => "TextPrimary",
            _ => "TextSecondary",
        } : "TextSecondary";

        return Application.Current?.TryFindResource(key) as Brush ?? Brushes.LightGray;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => Binding.DoNothing;
}
