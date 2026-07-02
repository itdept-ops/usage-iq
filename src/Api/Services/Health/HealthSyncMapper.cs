using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services.Health;

/// <summary>
/// PROGRAM-2 #1 — maps a provider's normalized <see cref="HealthDaySignals"/> into the EXISTING tracker
/// entities, OWNER-SCOPED and idempotent. The two correctness invariants live here:
///
/// <list type="bullet">
///   <item>NO-CLOBBER-MANUAL: a synced write only ever upserts/overwrites a <see cref="SourceKind.Watch"/>
///   row. If the owner already typed a Manual row for that day/record, the sync SKIPS it — it never
///   overwrites owner-authored data.</item>
///   <item>DE-DUP: every imported record is recorded in <see cref="HealthImportLog"/> keyed by
///   (UserEmail, Provider, SignalKind, SourceRef). A re-pull of the same day/record finds the log row and
///   UPDATES the same Watch row in place rather than inserting a duplicate.</item>
/// </list>
///
/// PRIVACY: writes ONLY the owner's own rows (UserEmail). Sleep + resting-HR are sensitive and stay owner-
/// only — the sync never writes another user's rows and never surfaces HR/sleep to coach/family overlays
/// (the existing owner-only read gating in the tracker is unchanged).
/// </summary>
public sealed class HealthSyncMapper(UsageDbContext db)
{
    /// <summary>Per-signal counts the manual sync-now endpoint surfaces.</summary>
    public sealed record SignalResult(int Imported, int Updated, int Skipped)
    {
        public static readonly SignalResult Empty = new(0, 0, 0);
        public SignalResult Add(SignalResult o) => new(Imported + o.Imported, Updated + o.Updated, Skipped + o.Skipped);
    }

    /// <summary>The roll-up of one day's mapping across all four signal kinds.</summary>
    public sealed record DayResult(SignalResult Steps, SignalResult Sleep, SignalResult HeartRate, SignalResult Workouts)
    {
        public static readonly DayResult Empty = new(SignalResult.Empty, SignalResult.Empty, SignalResult.Empty, SignalResult.Empty);
        public DayResult Add(DayResult o) => new(
            Steps.Add(o.Steps), Sleep.Add(o.Sleep), HeartRate.Add(o.HeartRate), Workouts.Add(o.Workouts));
    }

    /// <summary>
    /// Map one day's signals for the connection's owner. Honours the per-signal toggles, de-dups via
    /// <see cref="HealthImportLog"/>, and NEVER overwrites a Manual row. Saves within its own transaction.
    /// </summary>
    public async Task<DayResult> MapDayAsync(HealthConnection conn, HealthDaySignals signals, CancellationToken ct = default)
    {
        var email = conn.UserEmail.Trim().ToLowerInvariant();
        var provider = conn.Provider;
        var date = signals.LocalDate;

        var steps = SignalResult.Empty;
        var sleep = SignalResult.Empty;
        var hr = SignalResult.Empty;
        var workouts = SignalResult.Empty;

        // ---- Day-keyed activity: steps/distance/active-cal (Steps signal) + resting HR (HeartRate signal) ----
        // Both live on the single DailyActivity (UserEmail, LocalDate) row. The day's date string is the
        // SourceRef for each day-keyed signal.
        if (signals.Activity is { } a)
        {
            var dayRef = date.ToString("yyyy-MM-dd");
            var existingActivity = await db.DailyActivities
                .FirstOrDefaultAsync(x => x.UserEmail == email && x.LocalDate == date, ct);

            // NO-CLOBBER: a Manual DailyActivity row is owner-authored — skip the whole day's activity write.
            if (existingActivity is { Source: SourceKind.Manual })
            {
                if (conn.SyncSteps && (a.Steps is not null || a.DistanceMeters is not null || a.ActiveCalories is not null))
                    steps = steps.Add(new SignalResult(0, 0, 1));
                if (conn.SyncHeartRate && a.RestingHeartRate is not null)
                    hr = hr.Add(new SignalResult(0, 0, 1));
            }
            else
            {
                var hadRow = existingActivity is not null;
                var row = existingActivity ?? new DailyActivity
                {
                    UserEmail = email,
                    LocalDate = date,
                    Source = SourceKind.Watch,
                    CalorieMode = ActivityCalorieMode.Add,
                    CreatedUtc = DateTime.UtcNow,
                };
                row.Source = SourceKind.Watch;
                row.UpdatedUtc = DateTime.UtcNow;

                var changedSteps = false;
                if (conn.SyncSteps && (a.Steps is not null || a.DistanceMeters is not null || a.ActiveCalories is not null))
                {
                    row.Steps = a.Steps;
                    row.DistanceMeters = a.DistanceMeters;
                    row.ActiveCalories = a.ActiveCalories;
                    changedSteps = true;
                }
                var changedHr = false;
                if (conn.SyncHeartRate && a.RestingHeartRate is not null)
                {
                    row.RestingHeartRate = a.RestingHeartRate;
                    changedHr = true;
                }

                if (changedSteps || changedHr)
                {
                    var skipRace = false;
                    if (!hadRow) db.DailyActivities.Add(row);
                    try
                    {
                        await db.SaveChangesAsync(ct);
                    }
                    catch (DbUpdateException ex) when (!hadRow && IsUniqueViolation(ex))
                    {
                        // RACE: a concurrent sync inserted the (UserEmail, LocalDate) DailyActivity row first.
                        // Drop our losing insert, re-read the committed row and re-apply our mapped values to
                        // it as an in-place update (never a duplicate). Skip if the winner is a Manual row.
                        db.ChangeTracker.Clear();
                        var winner = await db.DailyActivities
                            .FirstOrDefaultAsync(x => x.UserEmail == email && x.LocalDate == date, ct);
                        if (winner is null || winner.Source == SourceKind.Manual)
                        {
                            if (changedSteps) steps = steps.Add(new SignalResult(0, 0, 1));
                            if (changedHr) hr = hr.Add(new SignalResult(0, 0, 1));
                            skipRace = true;
                        }
                        else
                        {
                            winner.Source = SourceKind.Watch;
                            winner.UpdatedUtc = DateTime.UtcNow;
                            if (changedSteps)
                            {
                                winner.Steps = a.Steps;
                                winner.DistanceMeters = a.DistanceMeters;
                                winner.ActiveCalories = a.ActiveCalories;
                            }
                            if (changedHr) winner.RestingHeartRate = a.RestingHeartRate;
                            await db.SaveChangesAsync(ct);
                            row = winner;
                        }
                    }

                    if (!skipRace)
                    {
                        if (changedSteps)
                            steps = steps.Add(await RecordDayKeyedAsync(
                                email, provider, date, HealthSignalKind.Steps, dayRef, row.Id, ct));
                        if (changedHr)
                            hr = hr.Add(await RecordDayKeyedAsync(
                                email, provider, date, HealthSignalKind.HeartRate, dayRef, row.Id, ct));
                    }
                }
            }
        }

        // ---- Record-keyed sleep (one SleepEntry per vendor sleep logId) ----
        if (conn.SyncSleep)
            foreach (var s in signals.Sleeps)
                sleep = sleep.Add(await MapSleepAsync(email, provider, date, s, ct));

        // ---- Record-keyed workouts (one ExerciseEntry per vendor activity logId) ----
        if (conn.SyncWorkouts)
            foreach (var w in signals.Workouts)
                workouts = workouts.Add(await MapWorkoutAsync(email, provider, date, w, ct));

        return new DayResult(steps, sleep, hr, workouts);
    }

    /// <summary>Whether a day-keyed signal (steps / resting HR) is already logged for (owner, provider,
    /// date); used to classify the DailyActivity upsert as an import vs an update without inserting a dup.</summary>
    private async Task<SignalResult> RecordDayKeyedAsync(
        string email, HealthProvider provider, DateOnly date, HealthSignalKind kind, string sourceRef,
        long trackerEntityId, CancellationToken ct)
    {
        var log = await db.HealthImportLogs.FirstOrDefaultAsync(
            l => l.UserEmail == email && l.Provider == provider && l.SignalKind == kind && l.SourceRef == sourceRef, ct);
        if (log is null)
        {
            db.HealthImportLogs.Add(new HealthImportLog
            {
                UserEmail = email, Provider = provider, LocalDate = date, SignalKind = kind,
                SourceRef = sourceRef, TrackerEntityId = trackerEntityId, CreatedUtc = DateTime.UtcNow,
            });
            try { await db.SaveChangesAsync(ct); return new SignalResult(1, 0, 0); }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex)) { db.ChangeTracker.Clear(); return new SignalResult(0, 1, 0); }
        }
        // Already imported → the DailyActivity row was overwritten in place: an update, not a duplicate.
        log.TrackerEntityId = trackerEntityId;
        await db.SaveChangesAsync(ct);
        return new SignalResult(0, 1, 0);
    }

    private async Task<SignalResult> MapSleepAsync(
        string email, HealthProvider provider, DateOnly date, SleepRecord s, CancellationToken ct)
    {
        var log = await db.HealthImportLogs.FirstOrDefaultAsync(
            l => l.UserEmail == email && l.Provider == provider && l.SignalKind == HealthSignalKind.Sleep && l.SourceRef == s.LogId, ct);

        if (log is not null)
        {
            // Re-sync: UPDATE the same Watch row in place (never a duplicate). Defensive: if the mapped row
            // is gone or somehow a Manual row, skip rather than clobber.
            var row = await db.SleepEntries.FirstOrDefaultAsync(x => x.Id == log.TrackerEntityId, ct);
            if (row is null || row.Source == SourceKind.Manual) return new SignalResult(0, 0, 1);
            row.Hours = s.Hours; row.Quality = s.Quality; row.BedTime = s.BedTime; row.WakeTime = s.WakeTime;
            await db.SaveChangesAsync(ct);
            return new SignalResult(0, 1, 0);
        }

        // NO-CLOBBER: if the owner has a MANUAL sleep row on this wake date, don't add a competing Watch row.
        var hasManual = await db.SleepEntries.AnyAsync(
            x => x.UserEmail == email && x.LocalDate == date && x.Source == SourceKind.Manual, ct);
        if (hasManual) return new SignalResult(0, 0, 1);

        var entry = new SleepEntry
        {
            UserEmail = email, LocalDate = date, Hours = s.Hours, Quality = s.Quality,
            BedTime = s.BedTime, WakeTime = s.WakeTime, Source = SourceKind.Watch, CreatedUtc = DateTime.UtcNow,
        };
        // Add the de-dup log ALONGSIDE the entry in a SINGLE SaveChanges so the log's unique index
        // arbitrates the race: a concurrent import trips UniqueViolation and the whole transaction rolls
        // back, so the losing writer never commits a duplicate SleepEntry (which has no unique key of its own).
        return await CommitNewImportAsync(
            db.SleepEntries, entry, e => e.Id, email, provider, date, HealthSignalKind.Sleep, s.LogId, ct);
    }

    private async Task<SignalResult> MapWorkoutAsync(
        string email, HealthProvider provider, DateOnly date, WorkoutRecord w, CancellationToken ct)
    {
        var log = await db.HealthImportLogs.FirstOrDefaultAsync(
            l => l.UserEmail == email && l.Provider == provider && l.SignalKind == HealthSignalKind.Workout && l.SourceRef == w.LogId, ct);

        if (log is not null)
        {
            var row = await db.ExerciseEntries.FirstOrDefaultAsync(x => x.Id == log.TrackerEntityId, ct);
            if (row is null || row.Source == SourceKind.Manual) return new SignalResult(0, 0, 1);
            row.Name = w.Name; row.DurationMin = w.DurationMin; row.CaloriesBurned = w.CaloriesBurned;
            await db.SaveChangesAsync(ct);
            return new SignalResult(0, 1, 0);
        }

        var entry = new ExerciseEntry
        {
            UserEmail = email, LocalDate = date, Name = w.Name, DurationMin = w.DurationMin,
            CaloriesBurned = w.CaloriesBurned, Source = SourceKind.Watch, CreatedUtc = DateTime.UtcNow,
        };
        // Add the de-dup log ALONGSIDE the entry in a SINGLE SaveChanges so the log's unique index
        // arbitrates the race: a concurrent import trips UniqueViolation and the whole transaction rolls
        // back, so the losing writer never commits a duplicate ExerciseEntry (which has no unique key of its own).
        return await CommitNewImportAsync(
            db.ExerciseEntries, entry, e => e.Id, email, provider, date, HealthSignalKind.Workout, w.LogId, ct);
    }

    /// <summary>Commit a freshly-mapped record-keyed entry TOGETHER WITH its de-dup log in a single
    /// transaction, so the log's unique index gates the entry: a concurrent sync trips a unique-violation and
    /// the whole SaveChanges rolls back, so neither the duplicate entry NOR its log commits (the entry has no
    /// unique key of its own to reject it). A unique-violation is therefore counted as an update, not a dup.</summary>
    private async Task<SignalResult> CommitNewImportAsync<TEntry>(
        DbSet<TEntry> set, TEntry entry, Func<TEntry, long> idOf, string email, HealthProvider provider,
        DateOnly date, HealthSignalKind kind, string sourceRef, CancellationToken ct)
        where TEntry : class
    {
        set.Add(entry);
        var log = new HealthImportLog
        {
            UserEmail = email, Provider = provider, LocalDate = date, SignalKind = kind,
            SourceRef = sourceRef, TrackerEntityId = 0, CreatedUtc = DateTime.UtcNow,
        };
        db.HealthImportLogs.Add(log);
        try
        {
            // One SaveChanges = one transaction: the log insert and the entry insert commit or roll back
            // together, so a losing concurrent writer never persists an orphan duplicate entry.
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            db.ChangeTracker.Clear();
            return new SignalResult(0, 1, 0);
        }
        // Backfill the entry's now-assigned key onto the log (both rows are already committed).
        log.TrackerEntityId = idOf(entry);
        await db.SaveChangesAsync(ct);
        return new SignalResult(1, 0, 0);
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
