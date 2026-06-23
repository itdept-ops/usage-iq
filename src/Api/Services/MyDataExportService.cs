using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Builds the "My Data" personal export: a single streamed ZIP of EVERYTHING one caller owns across every
/// domain (their attributed usage, the whole food/fitness tracker, 75-Hard, their own bills, profile, own
/// contacts, and their activity events). It is the per-person counterpart to the global dashboard
/// <c>records.csv</c> — but every query here is OWNER-SCOPED to the caller's email/id, so even an admin only
/// ever exports their OWN rows.
///
/// <para>PRIVACY — this exports a person's life, so the rules are strict and enforced HERE (not at the call
/// site):</para>
/// <list type="bullet">
///   <item>ONLY the caller's own rows: every query filters by the caller email/id.</item>
///   <item>NO secrets ever leave: bill share-token hash/ciphertext (<see cref="Bill.ShareTokenHash"/>/
///   <see cref="Bill.ShareTokenEnc"/>), ingest-key secrets/hashes, AES/TokenProtector material, Discord
///   webhook URLs, JWT/refresh/session tokens — none of these domains are read, and the bill writer omits the
///   token columns explicitly.</item>
///   <item>NO other person's email: the caller's own email is simply dropped (it's redundant in their own
///   export); where a row references ANOTHER person (a bill item assigned/claimed by a contact, a chat
///   contact) it is reduced to a <see cref="DisplayName"/> only — never an email, never an AppUser id that
///   could be reversed to one.</item>
///   <item>NO other-household-private data: cycle, others' notes, finances, etc. are not owned by the caller
///   and are never queried.</item>
/// </list>
///
/// <para>Streamed via <see cref="ZipArchive"/> directly over the response body (mirrors
/// <see cref="UsageQueries.WriteRecordsCsvAsync"/>), so nothing is buffered to a temp file.</para>
/// </summary>
public sealed class MyDataExportService(UsageDbContext db)
{
    /// <summary>The dated download filename, e.g. <c>usage-iq-export-2026-06-23.zip</c>.</summary>
    public static string FileName(DateTime utcNow) => $"usage-iq-export-{utcNow:yyyy-MM-dd}.zip";

    /// <summary>
    /// Writes the caller's full personal export as a ZIP to <paramref name="output"/>. Every entry is scoped
    /// to <paramref name="caller"/>'s own data. <paramref name="output"/> (the response body) is left open.
    ///
    /// <para>The ZIP is assembled into a pooled <see cref="MemoryStream"/> first, then copied to the body with
    /// a single async copy. <see cref="ZipArchive.Dispose"/> writes the central directory with SYNCHRONOUS
    /// stream writes, which Kestrel forbids on the response body (AllowSynchronousIO is off) — building into
    /// memory keeps every write to the response itself async. A personal export is small (one person's rows),
    /// so the transient buffer is bounded.</para>
    /// </summary>
    public async Task WriteExportAsync(
        CurrentUserAccessor.CurrentUser caller, Stream output, CancellationToken ct)
    {
        var email = caller.Email; // already lower-cased by the accessor
        var nowUtc = DateTime.UtcNow;

        using var buffer = new MemoryStream();
        await BuildZipAsync(buffer, caller, email, nowUtc, ct);
        buffer.Position = 0;
        await buffer.CopyToAsync(output, ct);
    }

    private async Task BuildZipAsync(
        Stream target, CurrentUserAccessor.CurrentUser caller, string email, DateTime nowUtc, CancellationToken ct)
    {
        // leaveOpen: true so the MemoryStream survives Dispose; Dispose writes the central directory.
        using var zip = new ZipArchive(target, ZipArchiveMode.Create, leaveOpen: true);

        // ---- manifest.json (no email — the caller's DisplayName only) ----
        await WriteJsonAsync(zip, "manifest.json", new
        {
            export = "usage-iq-mydata",
            generatedUtc = nowUtc,
            owner = DisplayName.Format(caller.Name, caller.DisplayNameMode, caller.Nickname),
            note = "Your personal data export. Contains only your own rows. No passwords, tokens, "
                + "webhooks, or other people's email addresses are included; where a row references "
                + "another person, only their display name is shown.",
            files = new[]
            {
                "usage_records.csv", "food.csv", "exercise.csv", "hydration.csv", "coffee.csv",
                "weight.csv", "supplement.csv", "sleep.csv", "watch_activity.csv",
                "my_foods.csv", "my_exercises.csv", "hard_challenge.json", "bills.json",
                "tracker_profile.json", "contacts.csv", "activity_events.csv",
            },
        }, ct);

        // ---- UsageRecords (the caller's own attributed usage; their own attribution email dropped) ----
        await WriteCsvAsync(zip, "usage_records.csv",
            "date,source,model,project,type,version,machine,git_branch,input,output,cache_read,cache_5m,cache_1h,total,cost_usd",
            db.UsageRecords.AsNoTracking()
                .Where(r => r.ReportedByUser == email)
                .OrderBy(r => r.TimestampUtc)
                .Select(r => new
                {
                    r.LocalDate, r.Source, r.Model, Project = r.Project!.Name, r.IsSidechain, r.Version,
                    r.MachineName, r.GitBranch, r.InputTokens, r.OutputTokens, r.CacheReadTokens,
                    r.CacheCreation5mTokens, r.CacheCreation1hTokens, r.CostUsd,
                }),
            r =>
            {
                var total = (long)r.InputTokens + r.OutputTokens + r.CacheReadTokens
                    + r.CacheCreation5mTokens + r.CacheCreation1hTokens;
                return Row(D(r.LocalDate), r.Source, r.Model, r.Project, r.IsSidechain ? "subagent" : "main",
                    r.Version ?? "", r.MachineName, r.GitBranch ?? "",
                    N(r.InputTokens), N(r.OutputTokens), N(r.CacheReadTokens),
                    N(r.CacheCreation5mTokens), N(r.CacheCreation1hTokens), N(total), Money(r.CostUsd));
            }, ct);

        // ---- Food ----
        await WriteCsvAsync(zip, "food.csv",
            "date,meal,fdc_id,description,brand,quantity,serving,calories,protein_g,carb_g,fat_g,created_utc",
            db.FoodEntries.AsNoTracking().Where(f => f.UserEmail == email).OrderBy(f => f.LocalDate).ThenBy(f => f.Id),
            f => Row(D(f.LocalDate), f.Meal.ToString(), f.FdcId?.ToString() ?? "", f.Description, f.Brand ?? "",
                Num(f.Quantity), f.ServingDesc ?? "", N(f.Calories), Num(f.ProteinG), Num(f.CarbG), Num(f.FatG),
                T(f.CreatedUtc)), ct);

        // ---- Exercise ----
        await WriteCsvAsync(zip, "exercise.csv",
            "date,name,duration_min,calories_burned,created_utc",
            db.ExerciseEntries.AsNoTracking().Where(e => e.UserEmail == email).OrderBy(e => e.LocalDate).ThenBy(e => e.Id),
            e => Row(D(e.LocalDate), e.Name, e.DurationMin?.ToString() ?? "", N(e.CaloriesBurned), T(e.CreatedUtc)), ct);

        // ---- Hydration ----
        await WriteCsvAsync(zip, "hydration.csv",
            "date,amount_ml,label,created_utc",
            db.HydrationEntries.AsNoTracking().Where(h => h.UserEmail == email).OrderBy(h => h.LocalDate).ThenBy(h => h.Id),
            h => Row(D(h.LocalDate), N(h.AmountMl), h.Label ?? "", T(h.CreatedUtc)), ct);

        // ---- Coffee ----
        await WriteCsvAsync(zip, "coffee.csv",
            "date,cups,caffeine_mg,label,created_utc",
            db.CoffeeEntries.AsNoTracking().Where(c => c.UserEmail == email).OrderBy(c => c.LocalDate).ThenBy(c => c.Id),
            c => Row(D(c.LocalDate), N(c.Cups), c.CaffeineMg?.ToString() ?? "", c.Label ?? "", T(c.CreatedUtc)), ct);

        // ---- Weight (owner-only) ----
        await WriteCsvAsync(zip, "weight.csv",
            "date,slot,weight_kg,created_utc",
            db.WeightEntries.AsNoTracking().Where(w => w.UserEmail == email).OrderBy(w => w.LocalDate).ThenBy(w => w.Id),
            w => Row(D(w.LocalDate), w.Slot.ToString(), Num(w.WeightKg), T(w.CreatedUtc)), ct);

        // ---- Supplement (the caller's own medication/supplement names — fine in their own export) ----
        await WriteCsvAsync(zip, "supplement.csv",
            "date,name,dose,kind,calories,protein_g,carb_g,fat_g,created_utc",
            db.SupplementEntries.AsNoTracking().Where(s => s.UserEmail == email).OrderBy(s => s.LocalDate).ThenBy(s => s.Id),
            s => Row(D(s.LocalDate), s.Name, s.Dose ?? "", s.Kind.ToString(), N(s.Calories),
                Dec(s.ProteinG), Dec(s.CarbG), Dec(s.FatG), T(s.CreatedUtc)), ct);

        // ---- Sleep (owner-only) ----
        await WriteCsvAsync(zip, "sleep.csv",
            "date,hours,quality,bed_time,wake_time,note,created_utc",
            db.SleepEntries.AsNoTracking().Where(s => s.UserEmail == email).OrderBy(s => s.LocalDate).ThenBy(s => s.Id),
            s => Row(D(s.LocalDate), Dec(s.Hours), N(s.Quality),
                s.BedTime?.ToString("HH:mm") ?? "", s.WakeTime?.ToString("HH:mm") ?? "", s.Note ?? "",
                T(s.CreatedUtc)), ct);

        // ---- Watch / Activity ----
        await WriteCsvAsync(zip, "watch_activity.csv",
            "date,steps,distance_m,active_calories,calorie_mode,created_utc,updated_utc",
            db.DailyActivities.AsNoTracking().Where(a => a.UserEmail == email).OrderBy(a => a.LocalDate).ThenBy(a => a.Id),
            a => Row(D(a.LocalDate), a.Steps?.ToString() ?? "", a.DistanceMeters?.ToString() ?? "",
                a.ActiveCalories?.ToString() ?? "", a.CalorieMode.ToString(), T(a.CreatedUtc), T(a.UpdatedUtc)), ct);

        // ---- My foods (library) ----
        await WriteCsvAsync(zip, "my_foods.csv",
            "description,brand,serving,calories,protein_g,carb_g,fat_g,use_count,created_utc,last_used_utc",
            db.CustomFoods.AsNoTracking().Where(f => f.UserEmail == email).OrderByDescending(f => f.UseCount).ThenBy(f => f.Id),
            f => Row(f.Description, f.Brand, f.ServingDesc, N(f.Calories), Num(f.ProteinG), Num(f.CarbG), Num(f.FatG),
                N(f.UseCount), T(f.CreatedUtc), T(f.LastUsedUtc)), ct);

        // ---- My exercises (library) ----
        await WriteCsvAsync(zip, "my_exercises.csv",
            "name,default_calories_burned,default_duration_min,use_count,created_utc,last_used_utc",
            db.CustomExercises.AsNoTracking().Where(e => e.UserEmail == email).OrderByDescending(e => e.UseCount).ThenBy(e => e.Id),
            e => Row(e.Name, e.DefaultCaloriesBurned?.ToString() ?? "", e.DefaultDurationMin?.ToString() ?? "",
                N(e.UseCount), T(e.CreatedUtc), T(e.LastUsedUtc)), ct);

        // ---- 75-Hard (challenge + tasks + days + day-tasks, nested) ----
        await WriteHardChallengeAsync(zip, email, ct);

        // ---- Bills (own; tokens stripped, assignees/claimers as DisplayName) ----
        await WriteBillsAsync(zip, email, ct);

        // ---- TrackerProfile / prefs ----
        await WriteTrackerProfileAsync(zip, email, ct);

        // ---- Own contacts (DisplayName only — never the contact's email) ----
        await WriteContactsAsync(zip, email, ct);

        // ---- ActivityEvents (own; ActorEmail never emitted) ----
        await WriteCsvAsync(zip, "activity_events.csv",
            "kind,created_utc,int_value,label",
            db.ActivityEvents.AsNoTracking().Where(e => e.ActorEmail == email).OrderBy(e => e.CreatedUtc).ThenBy(e => e.Id),
            e => Row(e.Kind, T(e.CreatedUtc), e.IntValue?.ToString() ?? "", e.Label ?? ""), ct);
    }

    // ---------------------------------------------------------------- nested/JSON domains

    private async Task WriteHardChallengeAsync(ZipArchive zip, string email, CancellationToken ct)
    {
        var challenges = await db.HardChallenges.AsNoTracking()
            .Where(h => h.UserEmail == email)
            .Include(h => h.Tasks)
            .OrderBy(h => h.Id)
            .ToListAsync(ct);

        var days = await db.HardChallengeDays.AsNoTracking()
            .Where(d => d.UserEmail == email)
            .OrderBy(d => d.LocalDate)
            .ToListAsync(ct);

        var dayTasks = await db.HardChallengeDayTasks.AsNoTracking()
            .Where(dt => dt.UserEmail == email)
            .OrderBy(dt => dt.LocalDate)
            .ToListAsync(ct);

        var payload = challenges.Select(h => new
        {
            startDate = D(h.StartDate),
            ruleset = h.Ruleset.ToString(),
            status = h.Status.ToString(),
            completedDays = h.CompletedDays,
            currentStreak = h.CurrentStreak,
            longestStreak = h.LongestStreak,
            confessionsUsed = h.ConfessionsUsed,
            createdUtc = h.CreatedUtc,
            updatedUtc = h.UpdatedUtc,
            tasks = h.Tasks.OrderBy(t => t.SortOrder).Select(t => new
            {
                key = t.Key,
                label = t.Label,
                autoSource = t.AutoSource.ToString(),
                targetValue = t.TargetValue,
                minMinutes = t.MinMinutes,
                activeCalPerWorkout = t.ActiveCalPerWorkout,
                unit = t.Unit,
                pointValue = t.PointValue,
                partialCredit = t.PartialCredit,
                enabled = t.Enabled,
                sortOrder = t.SortOrder,
            }),
            days = days.Where(d => d.ChallengeId == h.Id).Select(d => new
            {
                date = D(d.LocalDate),
                dietOverride = d.DietOverride,
                dayPoints = d.DayPoints,
                noAlcohol = d.NoAlcohol,
                confession = d.Confession, // the caller's OWN private text — fine in their own export
                isCheatDay = d.IsCheatDay,
                createdUtc = d.CreatedUtc,
                updatedUtc = d.UpdatedUtc,
            }),
            dayTasks = dayTasks.Where(dt => dt.ChallengeId == h.Id).Select(dt => new
            {
                date = D(dt.LocalDate),
                taskId = dt.TaskId,
                value = dt.Value,
                done = dt.Done,
                createdUtc = dt.CreatedUtc,
                updatedUtc = dt.UpdatedUtc,
            }),
        });

        await WriteJsonAsync(zip, "hard_challenge.json", payload, ct);
    }

    private async Task WriteBillsAsync(ZipArchive zip, string email, CancellationToken ct)
    {
        var bills = await db.Bills.AsNoTracking()
            .Where(b => b.OwnerEmail == email)
            .Include(b => b.Items)
            .OrderBy(b => b.Id)
            .ToListAsync(ct);

        // Resolve every assignee/claimer AppUser id referenced on an item to a DisplayName (never an email).
        var ids = bills.SelectMany(b => b.Items)
            .SelectMany(i => new[] { i.AssignedToUserId, i.ClaimedByUserId })
            .Where(id => id is > 0).Select(id => id!.Value);
        var names = await DisplayName.ResolveNamesByIdAsync(db, ids, ct);

        string? NameOf(int? id) => id is > 0
            ? (names.TryGetValue(id.Value, out var n) ? n : DisplayName.Unknown)
            : null;

        // Deliberately OMITS ShareTokenHash, ShareTokenEnc, ShareEnabled, OwnerEmail, OwnerUserId and every
        // assignee/claimer AppUser id — only the bill facts + a DisplayName for any referenced person.
        var payload = bills.Select(b => new
        {
            title = b.Title,
            createdUtc = b.CreatedUtc,
            taxAmount = b.TaxAmount,
            tipAmount = b.TipAmount,
            status = b.Status,
            items = b.Items.OrderBy(i => i.Id).Select(i => new
            {
                name = i.Name,
                amount = i.Amount,
                assignedTo = NameOf(i.AssignedToUserId),
                // A logged-in claimer resolves to a DisplayName; a logged-out claimer's self-entered name
                // (ClaimedByName) is the public claim label they chose — not an email — so it is kept as-is.
                claimedBy = NameOf(i.ClaimedByUserId) ?? i.ClaimedByName,
                claimedUtc = i.ClaimedUtc,
                settled = i.Settled,
            }),
        });

        await WriteJsonAsync(zip, "bills.json", payload, ct);
    }

    private async Task WriteTrackerProfileAsync(ZipArchive zip, string email, CancellationToken ct)
    {
        var p = await db.TrackerProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.UserEmail == email, ct);
        object payload = p is null ? new { } : new
        {
            goal = p.Goal.ToString(),
            weightKg = p.WeightKg,
            dateOfBirth = p.DateOfBirth is { } dob ? D(dob) : null,
            heightCm = p.HeightCm,
            sex = p.Sex.ToString(),
            activityLevel = p.ActivityLevel.ToString(),
            goalWeightKg = p.GoalWeightKg,
            unitSystem = p.UnitSystem.ToString(),
            dailyCalorieGoal = p.DailyCalorieGoal,
            proteinGoalG = p.ProteinGoalG,
            carbGoalG = p.CarbGoalG,
            fatGoalG = p.FatGoalG,
            hydrationGoalMl = p.HydrationGoalMl,
            coffeeGoalCups = p.CoffeeGoalCups,
            stepGoal = p.StepGoal,
            shareWithContacts = p.ShareWithContacts,
            updatedUtc = p.UpdatedUtc,
        };
        await WriteJsonAsync(zip, "tracker_profile.json", payload, ct);
    }

    private async Task WriteContactsAsync(ZipArchive zip, string email, CancellationToken ct)
    {
        // Mirror ContactsEndpoints: join the contact email to its AppUser, expose ONLY the DisplayName +
        // when it was added. The contact's email (ContactEmail) and the admin who added it (AddedByEmail)
        // are NEVER emitted.
        var rows = await db.ChatContacts.AsNoTracking()
            .Where(c => c.OwnerEmail == email)
            .Join(db.Users.AsNoTracking(), c => c.ContactEmail, u => u.Email, (c, u) => new
            {
                u.Name, u.DisplayNameMode, u.Nickname, c.CreatedUtc,
            })
            .ToListAsync(ct);

        var lines = rows
            .Select(r => (name: DisplayName.Format(r.Name, r.DisplayNameMode, r.Nickname), r.CreatedUtc))
            .OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase)
            .Select(x => Row(x.name, T(x.CreatedUtc)));

        await WriteCsvRowsAsync(zip, "contacts.csv", "contact,added_utc", lines, ct);
    }

    // ---------------------------------------------------------------- writers

    /// <summary>Stream one CSV entry: header line + one row per source element (true streaming, no buffering).</summary>
    private static async Task WriteCsvAsync<T>(
        ZipArchive zip, string name, string header, IQueryable<T> source,
        Func<T, string> row, CancellationToken ct)
        => await WriteCsvAsync(zip, name, header, source.AsAsyncEnumerable(), row, ct);

    private static async Task WriteCsvAsync<T>(
        ZipArchive zip, string name, string header, IAsyncEnumerable<T> source,
        Func<T, string> row, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        await using var es = entry.Open();
        await using var w = new StreamWriter(es, new UTF8Encoding(false));
        await w.WriteLineAsync(header);
        await foreach (var item in source.WithCancellation(ct))
            await w.WriteLineAsync(row(item));
        await w.FlushAsync(ct);
    }

    /// <summary>Write one CSV entry from already-rendered row strings (for the few domains materialized in-memory).</summary>
    private static async Task WriteCsvRowsAsync(
        ZipArchive zip, string name, string header, IEnumerable<string> rows, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        await using var es = entry.Open();
        await using var w = new StreamWriter(es, new UTF8Encoding(false));
        await w.WriteLineAsync(header);
        foreach (var line in rows)
        {
            ct.ThrowIfCancellationRequested();
            await w.WriteLineAsync(line);
        }
        await w.FlushAsync(ct);
    }

    private static async Task WriteJsonAsync(ZipArchive zip, string name, object payload, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        await using var es = entry.Open();
        await JsonSerializer.SerializeAsync(es, payload, JsonOpts, ct);
    }

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    // ---------------------------------------------------------------- cell helpers

    /// <summary>Join CSV cells, escaping each (mirrors the <c>Csv()</c> idiom in <see cref="UsageQueries"/>).</summary>
    private static string Row(params string[] cells) => string.Join(',', cells.Select(Csv));

    private static string Csv(string s) =>
        s.Contains(',') || s.Contains('"') || s.Contains('\n') || s.Contains('\r')
            ? "\"" + s.Replace("\"", "\"\"") + "\""
            : s;

    private static string D(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static string T(DateTime t) => t.ToString("o", CultureInfo.InvariantCulture);
    private static string N(long n) => n.ToString(CultureInfo.InvariantCulture);
    private static string Num(double n) => n.ToString(CultureInfo.InvariantCulture);
    private static string Dec(decimal n) => n.ToString(CultureInfo.InvariantCulture);
    private static string Money(decimal n) => n.ToString(CultureInfo.InvariantCulture);
}
