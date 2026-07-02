using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Ccusage.Api.Services.GoogleCalendarService;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F6b — DOODLE-STYLE PLAN POLLS (/api/family/polls), gated by <see cref="Permissions.FamilyUse"/>
/// on top of <c>.RequireAuthorization()</c>. A poll is a group decision owned by the caller's HOUSEHOLD; its
/// options are either candidate TIME slots (start/end) or free-text labels. Members vote for EVERY option
/// that works for them (re-voting replaces their prior votes for that poll), and the poll can be closed with
/// a winner (defaulting to the most-voted). A TIME option can then be BOOKED onto the caller's connected
/// calendar (reusing <see cref="GoogleCalendarService.CreateEventAsync"/>).
///
/// PRIVACY (enforced server-side): a caller only ever addresses their OWN household; a cross-household poll
/// id is a 404 (existence never leaked). Voters/creators are exposed by AppUser id + display name ONLY — an
/// email is NEVER on the wire. Booking degrades gracefully when the caller has no connected calendar (400),
/// never a 500.
/// </summary>
public static class FamilyPollsEndpoints
{
    // ---- Request DTOs ----
    public sealed record OptionInput(DateTime? StartUtc, DateTime? EndUtc, string? Label);
    public sealed record CreatePollRequest(string? Title, string? Kind, IReadOnlyList<OptionInput>? Options);
    public sealed record VoteRequest(long[]? OptionIds);
    public sealed record ClosePollRequest(long? WinningOptionId);
    public sealed record BookRequest(long OptionId);

    /// <summary>The "AI poll options" request: free-text prompt ("dinner out next weekend") + an optional
    /// <see cref="Kind"/> ("time"|"text") to force the option shape (null lets the model choose).
    /// <see cref="ReferenceDateUtc"/> anchors relative dates for time options; defaults to now.</summary>
    public sealed record PollOptionsAiRequest(string? Prompt, string? Kind, DateTime? ReferenceDateUtc);

    // ---- Response DTOs (people by userId + name; never email) ----
    public sealed record VoterDto(int UserId, string Name);
    public sealed record PollOptionDto(
        long Id, DateTime? StartUtc, DateTime? EndUtc, string? Label, int SortOrder,
        int VoteCount, IReadOnlyList<VoterDto> Voters);
    public sealed record PollDto(
        long Id, string Title, string Kind, bool Closed, long? WinningOptionId,
        int CreatedByUserId, string CreatedByName, DateTime CreatedUtc,
        IReadOnlyList<PollOptionDto> Options, IReadOnlyList<long> MyVotes);

    /// <summary>One AI-PROPOSED poll option (mirrors the create-poll <see cref="OptionInput"/> shape so the
    /// frontend can hand it straight back to POST /polls after the user edits). A time option carries a
    /// start/end; a text option carries a label; the unused fields are null.</summary>
    public sealed record ProposedOptionDto(DateTime? StartUtc, DateTime? EndUtc, string? Label);

    /// <summary>The "AI poll options" response: the resolved <see cref="Kind"/> ("time"|"text") + the proposed
    /// options for the user to EDIT before creating. Nothing is created — the frontend reviews then POSTs the
    /// confirmed set to /polls, which re-validates.</summary>
    public sealed record PollOptionsAiDto(string Kind, IReadOnlyList<ProposedOptionDto> Options);

    /// <summary>The "AI poll summary" response: a short read-only narrative of where the poll stands.
    /// <see cref="FellBackToPlain"/> is true when Gemini was unconfigured/errored and the deterministic plain
    /// summary was used instead. ALWAYS 200 — the plain text is the guaranteed floor (never a 503/500).</summary>
    public sealed record PollSummaryDto(string Summary, bool FellBackToPlain);

    private static readonly string[] Kinds = { "time", "text" };

    public static void MapFamilyPollsEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family/polls")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        // ---- GET /api/family/polls : the household's polls (newest first) ----
        g.MapGet("/", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var polls = await db.FamilyPlanPolls.AsNoTracking()
                .Where(p => p.HouseholdId == household.Id)
                .OrderByDescending(p => p.Id)
                .ToListAsync(ct);

            return Results.Ok(await BuildPollDtosAsync(db, polls, caller.Id, ct));
        });

        // ---- POST /api/family/polls : create a time/text poll with its options ----
        g.MapPost("/", async (
            CreatePollRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var title = (req.Title ?? "").Trim();
            if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A poll title is required." });
            if (title.Length > 200) title = title[..200];

            var kind = (req.Kind ?? "time").Trim().ToLowerInvariant();
            if (!Kinds.Contains(kind))
                return Results.BadRequest(new { message = "Poll kind must be \"time\" or \"text\"." });

            var inputs = req.Options ?? Array.Empty<OptionInput>();
            if (inputs.Count < 2)
                return Results.BadRequest(new { message = "A poll needs at least two options." });
            if (inputs.Count > 30)
                return Results.BadRequest(new { message = "A poll can have at most 30 options." });

            var options = new List<FamilyPlanPollOption>(inputs.Count);
            var sort = 0;
            foreach (var input in inputs)
            {
                if (kind == "time")
                {
                    if (input.StartUtc is not DateTime s || input.EndUtc is not DateTime en)
                        return Results.BadRequest(new { message = "Each time option needs a startUtc and endUtc." });
                    var start = DateTime.SpecifyKind(s, DateTimeKind.Utc);
                    var end = DateTime.SpecifyKind(en, DateTimeKind.Utc);
                    if (end <= start)
                        return Results.BadRequest(new { message = "A time option's end must be after its start." });
                    options.Add(new FamilyPlanPollOption { StartUtc = start, EndUtc = end, SortOrder = sort++ });
                }
                else
                {
                    var label = (input.Label ?? "").Trim();
                    if (label.Length == 0)
                        return Results.BadRequest(new { message = "Each text option needs a label." });
                    if (label.Length > 200) label = label[..200];
                    options.Add(new FamilyPlanPollOption { Label = label, SortOrder = sort++ });
                }
            }

            var poll = new FamilyPlanPoll
            {
                HouseholdId = household.Id,
                CreatedByUserId = caller.Id,
                Title = title,
                Kind = kind,
                Closed = false,
                CreatedUtc = DateTime.UtcNow,
                Options = options,
            };
            db.FamilyPlanPolls.Add(poll);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildPollDtoAsync(db, poll.Id, caller.Id, ct));
        });

        // ---- POST /api/family/polls/{id}/vote : replace the caller's votes for this poll ----
        g.MapPost("/{id:long}/vote", async (
            long id, VoteRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var poll = await db.FamilyPlanPolls.Include(p => p.Options)
                .FirstOrDefaultAsync(p => p.Id == id, ct);
            if (poll is null || poll.HouseholdId != household.Id) return NotFound();
            if (poll.Closed) return Results.BadRequest(new { message = "This poll is closed." });

            // Keep only ids that are actual options on THIS poll (ignore strays); de-dup.
            var validOptionIds = poll.Options.Select(o => o.Id).ToHashSet();
            var chosen = (req.OptionIds ?? Array.Empty<long>()).Distinct().Where(validOptionIds.Contains).ToList();

            // Replace: clear the caller's prior votes for this poll's options, then add the new set. The
            // self-committing ExecuteDeleteAsync + the Add/SaveChanges must be ONE atomic unit, so the old
            // votes are only removed if the new set commits (and the retry strategy re-runs the whole
            // replacement on a transient failure) — mirroring the re-date paths in TrackerEndpoints.
            var optionIds = poll.Options.Select(o => o.Id).ToList();
            var now = DateTime.UtcNow;
            var strategy = db.Database.CreateExecutionStrategy();
            await strategy.ExecuteAsync(async () =>
            {
                await using var tx = await db.Database.BeginTransactionAsync(ct);

                await db.FamilyPlanPollVotes
                    .Where(v => optionIds.Contains(v.OptionId) && v.UserId == caller.Id)
                    .ExecuteDeleteAsync(ct);

                foreach (var optionId in chosen)
                    db.FamilyPlanPollVotes.Add(new FamilyPlanPollVote
                    {
                        OptionId = optionId, UserId = caller.Id, CreatedUtc = now,
                    });
                await db.SaveChangesAsync(ct);

                await tx.CommitAsync(ct);
            });

            return Results.Ok(await BuildPollDtoAsync(db, poll.Id, caller.Id, ct));
        });

        // ---- POST /api/family/polls/{id}/close : close the poll, picking a winner (default most-voted) ----
        g.MapPost("/{id:long}/close", async (
            long id, ClosePollRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var poll = await db.FamilyPlanPolls.Include(p => p.Options)
                .FirstOrDefaultAsync(p => p.Id == id, ct);
            if (poll is null || poll.HouseholdId != household.Id) return NotFound();

            long? winner;
            if (req.WinningOptionId is long explicitWinner)
            {
                if (poll.Options.All(o => o.Id != explicitWinner))
                    return Results.BadRequest(new { message = "That winning option isn't on this poll." });
                winner = explicitWinner;
            }
            else
            {
                winner = await MostVotedOptionIdAsync(db, poll, ct);
            }

            poll.Closed = true;
            poll.WinningOptionId = winner;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildPollDtoAsync(db, poll.Id, caller.Id, ct));
        });

        // ---- POST /api/family/polls/{id}/book : book a TIME option onto the caller's calendar ----
        g.MapPost("/{id:long}/book", async (
            long id, BookRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var poll = await db.FamilyPlanPolls.Include(p => p.Options)
                .FirstOrDefaultAsync(p => p.Id == id, ct);
            if (poll is null || poll.HouseholdId != household.Id) return NotFound();

            var option = poll.Options.FirstOrDefault(o => o.Id == req.OptionId);
            if (option is null) return NotFound();

            // Only TIME options (with a real slot) can be booked onto a calendar.
            if (poll.Kind != "time" || option.StartUtc is not DateTime start || option.EndUtc is not DateTime end)
                return Results.BadRequest(new { message = "Only a time option can be booked onto a calendar." });

            var result = await cal.CreateEventAsync(
                caller.Id, poll.Title, DateTime.SpecifyKind(start, DateTimeKind.Utc),
                DateTime.SpecifyKind(end, DateTimeKind.Utc), allDay: false,
                location: null, description: "Booked from a family plan poll.", ct: ct);

            // Graceful: an unconnected/unconfigured caller gets a clear 400, never a 500.
            if (!result.Ok) return result.Status switch
            {
                CalendarStatus.NotConnected => Results.BadRequest(new
                {
                    message = "Connect your Google Calendar to book this time.", connected = false,
                }),
                CalendarStatus.NotConfigured => Results.BadRequest(new
                {
                    message = "Google Calendar isn't configured on this server.", configured = false,
                }),
                _ => Results.Json(new { message = "Google Calendar is temporarily unavailable. Please try again." },
                    statusCode: StatusCodes.Status502BadGateway),
            };

            var e = result.Value!;
            return Results.Ok(new EventDtoLite(e.Id, e.Title, e.StartUtc, e.EndUtc, e.HtmlLink));
        });

        // ---- POST /api/family/polls/ai/options : Gemini PROPOSES options for the user to edit ----
        // Creates NOTHING — returns proposed options the frontend reviews then POSTs to /polls (which
        // re-validates). Rate-limited (shared "ai" policy). Graceful: 400 empty prompt; 503 (never 500) when
        // Gemini is unconfigured or the call fails.
        g.MapPost("/ai/options", async (
            PollOptionsAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Prompt))
                return Results.BadRequest(new { message = "Type what the poll is about." });
            if (!gemini.IsConfigured)
                return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);

            // Anchor relative dates (for time options) to the supplied reference (or now); reject an absurd one.
            var reference = req.ReferenceDateUtc is { } r
                ? DateTime.SpecifyKind(r, DateTimeKind.Utc) : DateTime.UtcNow;
            if (reference < DateTime.UtcNow.AddYears(-2) || reference > DateTime.UtcNow.AddYears(2))
                reference = DateTime.UtcNow;

            var result = await gemini.PollOptionsAsync(req.Prompt, req.Kind, reference, tz, ct);
            if (result is null) return AiUnavailable();

            var options = result.Kind == "time"
                ? result.TimeOptions.Select(o => new ProposedOptionDto(o.StartUtc, o.EndUtc, null)).ToList()
                : result.TextOptions.Select(l => new ProposedOptionDto(null, null, l)).ToList();

            return Results.Ok(new PollOptionsAiDto(result.Kind, options));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- GET /api/family/polls/{id}/ai/summary : a short read-only narrative of where the poll stands ----
        // Built off the AUTHORITATIVE BuildPollDtoAsync data (options + vote counts + leader). ALWAYS 200 with
        // a deterministic PLAIN summary floor — Gemini only narrates; an unconfigured/errored model falls back
        // to the plain text (fellBackToPlain=true), NEVER a 503/500. 404 for a poll outside the caller's
        // household (existence never leaked). Rate-limited (shared "ai" policy).
        g.MapGet("/{id:long}/ai/summary", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, GeminiService gemini, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Honour the poll's household scope: a foreign/absent poll is a 404 (never leaked).
            var poll = await db.FamilyPlanPolls.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);
            if (poll is null || poll.HouseholdId != household.Id) return NotFound();

            // The AUTHORITATIVE poll DTO (per-option counts + the winner) is the source of truth.
            var dto = await BuildPollDtoAsync(db, poll.Id, caller.Id, ct);
            var plain = PlainPollSummary(dto);

            // Gemini only narrates the facts; any miss falls back to the deterministic plain floor (200). The
            // LLM is only called when the caller holds family.ai (the gated, token-spending capability) — a
            // family.use caller without family.ai always gets the deterministic plain summary.
            if (!caller.Permissions.Contains(Permissions.FamilyAi) || !gemini.IsConfigured)
                return Results.Ok(new PollSummaryDto(plain, FellBackToPlain: true));

            var narrative = await gemini.PollSummaryAsync(PollFacts(dto), ct);
            return string.IsNullOrWhiteSpace(narrative)
                ? Results.Ok(new PollSummaryDto(plain, FellBackToPlain: true))
                : Results.Ok(new PollSummaryDto(narrative!, FellBackToPlain: false));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- DELETE /api/family/polls/{id} ----
        g.MapDelete("/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var poll = await db.FamilyPlanPolls.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (poll is null || poll.HouseholdId != household.Id) return NotFound();

            db.FamilyPlanPolls.Remove(poll); // options + votes cascade
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    /// <summary>A slim booked-event payload (mirrors the calendar event, sans Google internals).</summary>
    public sealed record EventDtoLite(string Id, string Title, DateTime? StartUtc, DateTime? EndUtc, string? HtmlLink);

    // =====================================================================================
    // DTO assembly — per-option vote counts + voter names, my votes, winner (no email)
    // =====================================================================================

    /// <summary>The option id with the most votes on <paramref name="poll"/>; null when no votes exist. Ties
    /// resolve to the earliest option (lowest SortOrder, then id) so the default winner is deterministic.</summary>
    private static async Task<long?> MostVotedOptionIdAsync(UsageDbContext db, FamilyPlanPoll poll, CancellationToken ct)
    {
        var optionIds = poll.Options.Select(o => o.Id).ToList();
        if (optionIds.Count == 0) return null;

        var counts = await db.FamilyPlanPollVotes.AsNoTracking()
            .Where(v => optionIds.Contains(v.OptionId))
            .GroupBy(v => v.OptionId)
            .Select(grp => new { OptionId = grp.Key, Count = grp.Count() })
            .ToListAsync(ct);
        if (counts.Count == 0) return null;

        var max = counts.Max(c => c.Count);
        var topIds = counts.Where(c => c.Count == max).Select(c => c.OptionId).ToHashSet();
        // Break ties deterministically by the option's display order.
        return poll.Options
            .Where(o => topIds.Contains(o.Id))
            .OrderBy(o => o.SortOrder).ThenBy(o => o.Id)
            .Select(o => (long?)o.Id)
            .FirstOrDefault();
    }

    private static async Task<PollDto> BuildPollDtoAsync(UsageDbContext db, long pollId, int callerId, CancellationToken ct)
    {
        var poll = await db.FamilyPlanPolls.AsNoTracking().FirstAsync(p => p.Id == pollId, ct);
        return (await BuildPollDtosAsync(db, new[] { poll }, callerId, ct))[0];
    }

    /// <summary>
    /// Build the wire DTOs for a set of polls in a few batched queries: load their options, tally votes per
    /// option, resolve voter + creator display names (NEVER email), and mark the caller's own votes.
    /// </summary>
    private static async Task<IReadOnlyList<PollDto>> BuildPollDtosAsync(
        UsageDbContext db, IReadOnlyList<FamilyPlanPoll> polls, int callerId, CancellationToken ct)
    {
        if (polls.Count == 0) return Array.Empty<PollDto>();

        var pollIds = polls.Select(p => p.Id).ToList();

        var options = await db.FamilyPlanPollOptions.AsNoTracking()
            .Where(o => pollIds.Contains(o.PollId))
            .ToListAsync(ct);
        var optionsByPoll = options.GroupBy(o => o.PollId).ToDictionary(grp => grp.Key, grp => grp.ToList());
        var optionIds = options.Select(o => o.Id).ToList();

        var votes = optionIds.Count == 0
            ? new List<FamilyPlanPollVote>()
            : await db.FamilyPlanPollVotes.AsNoTracking()
                .Where(v => optionIds.Contains(v.OptionId))
                .ToListAsync(ct);
        var votesByOption = votes.GroupBy(v => v.OptionId).ToDictionary(grp => grp.Key, grp => grp.ToList());

        // Resolve every voter + every poll creator to a display name in one query (never email).
        var personIds = votes.Select(v => v.UserId)
            .Concat(polls.Select(p => p.CreatedByUserId))
            .Distinct().ToList();
        var names = await NamesAsync(db, personIds, ct);

        var result = new List<PollDto>(polls.Count);
        foreach (var poll in polls)
        {
            var pollOptions = (optionsByPoll.GetValueOrDefault(poll.Id) ?? new())
                .OrderBy(o => o.SortOrder).ThenBy(o => o.Id)
                .ToList();

            var optionDtos = new List<PollOptionDto>(pollOptions.Count);
            var myVotes = new List<long>();
            foreach (var o in pollOptions)
            {
                var optionVotes = votesByOption.GetValueOrDefault(o.Id) ?? new();
                var voters = optionVotes
                    .OrderBy(v => v.CreatedUtc).ThenBy(v => v.Id)
                    .Select(v => new VoterDto(v.UserId, Name(names, v.UserId)))
                    .ToList();
                if (optionVotes.Any(v => v.UserId == callerId)) myVotes.Add(o.Id);

                optionDtos.Add(new PollOptionDto(
                    o.Id, o.StartUtc, o.EndUtc, o.Label, o.SortOrder, optionVotes.Count, voters));
            }

            result.Add(new PollDto(
                poll.Id, poll.Title, poll.Kind, poll.Closed, poll.WinningOptionId,
                poll.CreatedByUserId, Name(names, poll.CreatedByUserId), poll.CreatedUtc,
                optionDtos, myVotes));
        }
        return result;
    }

    // =====================================================================================
    // Helpers
    // =====================================================================================

    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        // Centralized: each TARGET user's wire name applies their own DisplayNameMode/Nickname
        // (presence/chat/family/leaderboard all show the same chosen form). Never an email.
        return await DisplayName.ResolveNamesByIdAsync(db, userIds, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That poll doesn't exist." });

    /// <summary>503 (never 500) when an AI poll-options call can't run — Gemini unconfigured or the call
    /// failed. The poll SUMMARY never uses this (it always degrades to a plain text floor instead).</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI is not available.",
        detail: "AI suggestions aren't available right now. You can add the options manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    // =====================================================================================
    // AI poll summary — deterministic facts + plain-text floor (the AI text is commentary only)
    // =====================================================================================

    /// <summary>
    /// The GUARANTEED deterministic poll summary (the floor the AI never falls below): off the AUTHORITATIVE
    /// <paramref name="dto"/> (per-option vote counts + winner) — closed polls name the winner, open polls name
    /// the current leader (or a tie / no-votes-yet), never inventing anything.
    /// </summary>
    private static string PlainPollSummary(PollDto dto)
    {
        var totalVotes = dto.Options.Sum(o => o.VoteCount);

        if (dto.Closed)
        {
            var winner = dto.WinningOptionId is { } wid
                ? dto.Options.FirstOrDefault(o => o.Id == wid)
                : null;
            return winner is not null
                ? $"“{dto.Title}” is closed. The pick is {OptionLabel(winner)} ({winner.VoteCount} {Votes(winner.VoteCount)})."
                : $"“{dto.Title}” is closed.";
        }

        if (totalVotes == 0)
            return $"“{dto.Title}” is open with {dto.Options.Count} options and no votes yet.";

        var max = dto.Options.Max(o => o.VoteCount);
        var leaders = dto.Options.Where(o => o.VoteCount == max && max > 0).ToList();
        if (leaders.Count == 1)
        {
            var lead = leaders[0];
            return $"“{dto.Title}” is open. {OptionLabel(lead)} is leading with {lead.VoteCount} {Votes(lead.VoteCount)} of {totalVotes} cast.";
        }

        return $"“{dto.Title}” is open and tied between {leaders.Count} options at {max} {Votes(max)} each.";
    }

    /// <summary>
    /// Pre-format the AUTHORITATIVE poll facts for the AI narrator: the title, status, and EACH option's
    /// label/time + its vote count, plus the current leader. The model is told to narrate ONLY these facts
    /// (it never sees the DB), so it can't invent options or votes. NO email — only the deterministic tally.
    /// </summary>
    private static string PollFacts(PollDto dto)
    {
        var lines = new List<string>
        {
            $"title: {dto.Title}",
            $"status: {(dto.Closed ? "closed" : "open")}",
            $"total_votes: {dto.Options.Sum(o => o.VoteCount)}",
        };

        foreach (var o in dto.Options)
            lines.Add($"option: {OptionLabel(o)} — {o.VoteCount} {Votes(o.VoteCount)}");

        if (dto.Closed && dto.WinningOptionId is { } wid &&
            dto.Options.FirstOrDefault(o => o.Id == wid) is { } w)
            lines.Add($"winner: {OptionLabel(w)}");
        else if (!dto.Closed && dto.Options.Count > 0)
        {
            var max = dto.Options.Max(o => o.VoteCount);
            if (max > 0)
            {
                var leaders = dto.Options.Where(o => o.VoteCount == max).Select(OptionLabel).ToList();
                lines.Add(leaders.Count == 1 ? $"leader: {leaders[0]}" : $"tied: {string.Join(", ", leaders)}");
            }
        }

        return string.Join("\n", lines);
    }

    /// <summary>A human label for a poll option: the text label, or a compact UTC time range for a time
    /// option (the deterministic floor — the AI gets the same string, so it never invents a slot).</summary>
    private static string OptionLabel(PollOptionDto o)
    {
        if (!string.IsNullOrWhiteSpace(o.Label)) return o.Label!;
        if (o.StartUtc is { } s)
        {
            var start = $"{s:ddd MMM d, HH:mm} UTC";
            return o.EndUtc is { } e ? $"{start}–{e:HH:mm}" : start;
        }
        return "an option";
    }

    private static string Votes(int n) => n == 1 ? "vote" : "votes";
}
