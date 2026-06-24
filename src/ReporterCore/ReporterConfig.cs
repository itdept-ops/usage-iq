using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;

namespace Ccusage.Reporter.Core;

/// <summary>
/// Loads and saves the reporter's settings. The non-secret configuration lives in a JSON file at
/// <c>~/.usage-iq/config.json</c> (Url, IntervalSeconds, paths, machine override, batch size, and the
/// GUI-only StartMinimized/RunOnStartup flags). The ingest key is a secret and lives separately in
/// <c>~/.usage-iq/reporter.key</c> — it is never written into config.json.
///
/// Resolution precedence (lowest → highest): appsettings.json beside the exe → config.json →
/// reporter.key (key only) → REPORTER_* env vars → command-line switches. This preserves the original
/// console behavior (env/appsettings/CLI) while adding config.json as a persisted middle layer.
/// </summary>
public static class ReporterConfig
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>The Usage IQ settings directory, <c>~/.usage-iq</c>.</summary>
    public static string Dir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".usage-iq");

    /// <summary>Path to the non-secret JSON config, <c>~/.usage-iq/config.json</c>.</summary>
    public static string ConfigPath => Path.Combine(Dir, "config.json");

    /// <summary>Path to the secret ingest key file, <c>~/.usage-iq/reporter.key</c>.</summary>
    public static string KeyPath => Path.Combine(Dir, "reporter.key");

    // ---- switch mappings shared with the console's CLI parser ----
    public static readonly Dictionary<string, string> SwitchMappings = new()
    {
        ["--url"] = "Url", ["-u"] = "Url",
        ["--key"] = "Key", ["-k"] = "Key",
        ["--machine"] = "Machine", ["-m"] = "Machine",
        ["--claude-path"] = "ClaudePath",
        ["--codex-path"] = "CodexPath",
        ["--gemini-path"] = "GeminiPath",
        ["--state"] = "StatePath",
        ["--batch"] = "BatchSize",
        ["--interval"] = "IntervalSeconds",
    };

    /// <summary>
    /// Build the resolved <see cref="ReporterOptions"/> from every layer. <paramref name="valuedArgs"/>
    /// must already have bare flags (--once/--no-hud/…) stripped so the command-line binder never sees
    /// a flag where it expects a value. The ingest key is read from reporter.key if not otherwise set,
    /// and the raw key is never echoed.
    /// </summary>
    public static ReporterOptions Load(string[] valuedArgs)
    {
        var builder = new ConfigurationBuilder()
            .AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), optional: true)
            .AddJsonFile(ConfigPath, optional: true)
            .AddEnvironmentVariables("REPORTER_")
            .AddCommandLine(valuedArgs, SwitchMappings);

        var opt = builder.Build().Get<ReporterOptions>() ?? new ReporterOptions();

        // The key is a secret kept out of config.json; pull it from reporter.key when not supplied via
        // env/CLI. (env/CLI still win, so an explicit --key overrides the file.)
        if (string.IsNullOrWhiteSpace(opt.Key))
        {
            var fromFile = ReadKeyFile();
            if (!string.IsNullOrWhiteSpace(fromFile)) opt.Key = fromFile;
        }

        return opt;
    }

    /// <summary>Read the saved config.json (non-secret) if it exists, else a fresh defaults object.</summary>
    public static ReporterOptions LoadFile()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var loaded = JsonSerializer.Deserialize<ReporterOptions>(json, Json);
                if (loaded is not null) { loaded.Key = null; return loaded; } // never trust a key in config.json
            }
        }
        catch { /* unreadable/corrupt config → fall back to defaults */ }
        return new ReporterOptions();
    }

    /// <summary>
    /// Persist the non-secret settings to config.json (atomic write). The <see cref="ReporterOptions.Key"/>
    /// is explicitly cleared before serializing so the raw key can never land in the file.
    /// </summary>
    public static void Save(ReporterOptions options)
    {
        Directory.CreateDirectory(Dir);

        // Clone so we don't mutate the caller's live options, and strip the secret.
        var safe = new ReporterOptions
        {
            Url = options.Url,
            Key = null, // never persisted here
            Machine = options.Machine,
            ClaudePath = options.ClaudePath,
            CodexPath = options.CodexPath,
            GeminiPath = options.GeminiPath,
            StatePath = options.StatePath,
            BatchSize = options.BatchSize,
            IntervalSeconds = options.IntervalSeconds,
            StartMinimized = options.StartMinimized,
            RunOnStartup = options.RunOnStartup,
        };

        var tmp = ConfigPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(safe, Json));
        File.Move(tmp, ConfigPath, overwrite: true);
    }

    /// <summary>Read the raw ingest key from reporter.key, or null if absent/empty. Never logged.</summary>
    public static string? ReadKeyFile()
    {
        try
        {
            if (File.Exists(KeyPath))
            {
                var key = File.ReadAllText(KeyPath).Trim();
                return string.IsNullOrWhiteSpace(key) ? null : key;
            }
        }
        catch { /* unreadable → treat as absent */ }
        return null;
    }

    /// <summary>Write the ingest key to reporter.key (atomic, no trailing newline). Treat the file as a secret.</summary>
    public static void SaveKeyFile(string key)
    {
        Directory.CreateDirectory(Dir);
        var tmp = KeyPath + ".tmp";
        File.WriteAllText(tmp, key.Trim());
        File.Move(tmp, KeyPath, overwrite: true);
    }
}
