using System.Globalization;

namespace Ccusage.Reporter;

/// <summary>
/// Friendly, colorized console output for the reporter. When stdout is redirected (piped to a file
/// or captured), it drops the colors and the in-place "live" line so the captured log stays clean.
/// </summary>
public sealed class ReporterConsole
{
    private readonly bool _plain = Console.IsOutputRedirected;
    private bool _liveOpen;

    private static string Now() => DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture);

    public void Banner(string version)
    {
        WriteLine();
        Write("  Usage IQ", ConsoleColor.White);
        Write(" Reporter", ConsoleColor.Cyan);
        WriteLine($"   {version}", ConsoleColor.DarkGray);
        Rule();
    }

    public void Config(string label, string value)
    {
        Write("  " + label.PadRight(9), ConsoleColor.DarkGray);
        WriteLine(value, ConsoleColor.Gray);
    }

    public void Rule() => WriteLine("  " + new string('─', 54), ConsoleColor.DarkGray);

    public void Stamp(string text, ConsoleColor? color = null)
    {
        EndLive();
        Write("  " + Now() + "  ", ConsoleColor.DarkGray);
        WriteLine(text, color ?? ConsoleColor.Gray);
    }

    /// <summary>An indented sub-line under a stamp (e.g. a per-source breakdown).</summary>
    public void Detail(string label, string value)
    {
        EndLive();
        Write("            " + label.PadRight(8), ConsoleColor.DarkGray);
        WriteLine(value, ConsoleColor.Gray);
    }

    /// <summary>In-place progress (interactive terminals only; ignored when redirected).</summary>
    public void Live(string text)
    {
        if (_plain) return;
        int w;
        try { w = Console.BufferWidth; } catch { return; }
        if (w < 12) return;
        var line = "  " + Now() + "  " + text;
        if (line.Length > w - 1) line = line[..(w - 1)];
        Console.Write("\r" + line.PadRight(w - 1));
        _liveOpen = true;
    }

    public void EndLive()
    {
        if (!_liveOpen) return;
        try { Console.Write("\r" + new string(' ', Console.BufferWidth - 1) + "\r"); } catch { /* ignore */ }
        _liveOpen = false;
    }

    public void Summary(IEnumerable<(string label, string value, ConsoleColor color)> rows)
    {
        WriteLine();
        foreach (var (label, value, color) in rows)
        {
            Write("     " + label.PadRight(13), ConsoleColor.DarkGray);
            WriteLine(value, color);
        }
        Rule();
    }

    public void Watching(DateTime nextScan)
    {
        Write("  watching for changes…  ", ConsoleColor.DarkGray);
        WriteLine("next scan " + nextScan.ToString("HH:mm:ss", CultureInfo.InvariantCulture), ConsoleColor.Gray);
    }

    public void Warn(string text) { EndLive(); WriteLine("  ! " + text, ConsoleColor.Yellow); }
    public void Error(string text) { EndLive(); WriteLine("  x " + text, ConsoleColor.Red); }

    // ---- low-level ----
    private void Write(string s, ConsoleColor? c)
    {
        if (!_plain && c.HasValue)
        {
            var prev = Console.ForegroundColor;
            Console.ForegroundColor = c.Value;
            Console.Write(s);
            Console.ForegroundColor = prev;
        }
        else
        {
            Console.Write(s);
        }
    }

    private void WriteLine(string s = "", ConsoleColor? c = null) { Write(s, c); Console.WriteLine(); }
}
