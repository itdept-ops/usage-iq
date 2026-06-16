using System.Globalization;
using System.Runtime.InteropServices;

namespace Ccusage.Reporter;

/// <summary>
/// Friendly, colorized console output for the reporter, plus a live "tokens this session" counter
/// pinned to the top-right via a reserved (non-scrolling) status row. When stdout is redirected, it
/// drops the colors, the in-place "live" line, and the HUD so captured logs stay clean.
/// </summary>
public sealed class ReporterConsole : IDisposable
{
    private readonly bool _plain = Console.IsOutputRedirected;
    private bool _liveOpen;

    // ---- top-right token HUD (a reserved, non-scrolling status row) ----
    private bool _hud;
    private long _tokens;
    private nint _stdout;
    private uint _origMode;

    public ReporterConsole(bool enableHud = true)
    {
        if (_plain || !enableHud) return;
        try { StartHud(); } catch { _hud = false; }
    }

    private void StartHud()
    {
        // Enable VT processing on Windows so the scroll-region/SGR escapes render; other OSes do natively.
        if (OperatingSystem.IsWindows())
        {
            _stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            if (!GetConsoleMode(_stdout, out _origMode) || !SetConsoleMode(_stdout, _origMode | ENABLE_VT))
                return; // can't do VT — skip the HUD (plain output still works)
        }

        int h;
        try { h = Console.WindowHeight; } catch { return; }
        if (h < 6) return; // too short to spare a status row

        // Clear the screen first — otherwise our output draws OVER whatever was there (build output, a
        // prior run) and shorter lines leave stale tails. After this the reserved row stays clean.
        Console.Write("\x1b[3J\x1b[2J\x1b[H");
        Console.Write($"\x1b[2;{h}r"); // reserve row 1: scroll region becomes rows 2..h
        Console.Write("\x1b[2;1H");    // move below the status row so all output scrolls under it
        _hud = true;
        RenderHud();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ResetHud();
    }

    /// <summary>Add to the live "tokens this session" counter shown top-right.</summary>
    public void AddTokens(long delta)
    {
        _tokens += Math.Max(0, delta);
        if (_hud) RenderHud();
        try { Console.Title = $"Usage IQ · {FormatTokens(_tokens)} tokens"; } catch { /* not all hosts allow it */ }
    }

    private void RenderHud()
    {
        try
        {
            var w = Console.WindowWidth;
            var num = FormatTokens(_tokens);
            var visible = $"{num} tokens this session ";
            var col = Math.Max(1, w - visible.Length);
            Console.Write("\x1b7\x1b[1;1H\x1b[2K");                                  // save cursor, home row 1, clear
            Console.Write($"\x1b[1;{col}H");                                         // right-align in the status row
            Console.Write($"\x1b[92m{num}\x1b[0;90m tokens this session \x1b[0m");
            Console.Write("\x1b8");                                                  // restore cursor
        }
        catch { /* transient terminal hiccup — skip this frame */ }
    }

    private void ResetHud()
    {
        if (!_hud) return;
        _hud = false;
        try
        {
            Console.Write("\x1b[r"); // release the scroll region
            try { Console.Write($"\x1b[{Console.WindowHeight};1H"); } catch { /* ignore */ }
            Console.Write("\n");
            if (OperatingSystem.IsWindows() && _stdout != 0) SetConsoleMode(_stdout, _origMode);
        }
        catch { /* ignore */ }
    }

    public void Dispose() => ResetHud();

    /// <summary>Compact token formatting: 842, 12.3K, 4.21M, 1.05B.</summary>
    public static string FormatTokens(long n)
    {
        if (n < 1000) return n.ToString(CultureInfo.InvariantCulture);
        if (n < 1_000_000) return (n / 1000.0).ToString("0.#", CultureInfo.InvariantCulture) + "K";
        if (n < 1_000_000_000) return (n / 1_000_000.0).ToString("0.##", CultureInfo.InvariantCulture) + "M";
        return (n / 1_000_000_000.0).ToString("0.##", CultureInfo.InvariantCulture) + "B";
    }

    // ---- structured output ----

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

    // ---- Win32 VT enable ----
    private const int STD_OUTPUT_HANDLE = -11;
    private const uint ENABLE_VT = 0x0004;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetConsoleMode(nint handle, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleMode(nint handle, uint mode);
}
