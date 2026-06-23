using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F1 — shared NOTES and LISTS (/api/family/notes, /api/family/lists). Everything is gated
/// by <see cref="Permissions.FamilyUse"/> on top of <c>.RequireAuthorization()</c> (the existing
/// /api/family group), and obeys the Family Hub privacy rules:
///
/// <list type="bullet">
///   <item>Items are private to the owning HOUSEHOLD; every member can see and edit them.</item>
///   <item>An item may be selectively SHARED to specific contacts (by AppUser id) via
///   <see cref="FamilyShare"/>. VISIBILITY = (caller is a household member) OR (a share row exists for
///   the caller). EDIT = (member) OR (a share with CanEdit=true). A caller who is neither a member nor
///   shared gets 404 — existence is never leaked. A canEdit=false shared user gets 403 on writes.</item>
///   <item>MANAGING shares (add/remove) = the item's creator OR any household member ("owner-ish") — a
///   shared-in contact may never re-share. A share target must be a real, enabled user that is one of
///   the caller's chat contacts (resolved to AppUser id; otherwise rejected).</item>
///   <item>People are exposed by AppUser id + display name (+ picture where relevant) ONLY — an email
///   is NEVER put on the wire.</item>
/// </list>
/// </summary>
public static class FamilyNotesListsEndpoints
{
    // ---- DTOs (people by userId + name; never email) ----

    /// <summary>A person an item is shared with (only populated for items the caller manages).</summary>
    public sealed record ShareTargetDto(int UserId, string Name, bool CanEdit);

    public sealed record NoteDto(
        long Id, string Title, string Body, bool Pinned,
        int CreatedByUserId, string CreatedByName, DateTime UpdatedUtc,
        bool IsMine, bool CanEdit, IReadOnlyList<ShareTargetDto> SharedWith);

    public sealed record ListItemDto(
        long Id, string Text, bool Done,
        int? DoneByUserId, string? DoneByName,
        int? AssignedToUserId, string? AssignedToName, int SortOrder);

    public sealed record ListDto(
        long Id, string Name, string Kind,
        int CreatedByUserId, string CreatedByName,
        bool IsMine, bool CanEdit, IReadOnlyList<ShareTargetDto> SharedWith,
        IReadOnlyList<ListItemDto> Items);

    public sealed record NoteUpsertRequest(string? Title, string? Body, bool Pinned);
    public sealed record ListCreateRequest(string? Name, string? Kind);
    public sealed record ListRenameRequest(string? Name);
    public sealed record ListItemCreateRequest(string? Text, int? AssignedToUserId);
    public sealed record ListItemPatchRequest(string? Text, bool? Done, int? AssignedToUserId);
    public sealed record ShareRequest(int UserId, bool CanEdit);

    // ---- AI-assist DTOs (slice 2: lists quick-add, notes draft/rewrite, notes summarize) ----

    /// <summary>"Quick-add with AI" request: a free-text blob ("milk, eggs, bread" or a pasted recipe). The
    /// optional <see cref="Kind"/> ("shopping"|"todo") nudges interpretation; it doesn't have to match the
    /// destination list. Nothing is created — the frontend confirms then POSTs each item to /lists/{id}/items.</summary>
    public sealed record ListItemsAiRequest(string? Text, string? Kind);

    /// <summary>"Quick-add with AI" response: a clean, de-duped, capped list of item names + an optional short note.</summary>
    public sealed record ListItemsAiDto(IReadOnlyList<string> Items, string? Notes);

    /// <summary>"Draft/rewrite with AI" request: the <see cref="Prompt"/> drives the change. When
    /// <see cref="CurrentBody"/> is present the note is REWRITTEN per the prompt; otherwise a fresh note is
    /// drafted. Saves nothing — the editor shows the draft with Use / Try-again.</summary>
    public sealed record NoteDraftAiRequest(string? Prompt, string? CurrentTitle, string? CurrentBody);

    /// <summary>"Draft/rewrite with AI" response: a title + markdown body (to be RENDERED, never executed) + an
    /// optional short note about an assumption.</summary>
    public sealed record NoteDraftAiDto(string Title, string Body, string? Note);

    /// <summary>One action item from "Summarize with AI". <see cref="DuePhrase"/> is a natural-time phrase the
    /// frontend can feed into the slice-1 reminder parser ("make reminders"), or null when no time was implied.</summary>
    public sealed record NoteActionItemDto(string Text, string? DuePhrase);

    /// <summary>"Summarize with AI" response: a short summary + 0+ action items.</summary>
    public sealed record NoteSummaryAiDto(string Summary, IReadOnlyList<NoteActionItemDto> ActionItems);

    // ---- AI-assist DTOs (round 2: ask your notes, transform a note, list "what am I missing") ----

    /// <summary>"Ask your notes" request: a free-text question answered ONLY from the caller's household notes.</summary>
    public sealed record AskNotesAiRequest(string? Question);

    /// <summary>"Ask your notes" response: a plain-text answer (drawn only from the notes, or "I couldn't find
    /// that in your notes.") + the ids of the notes actually used (for the UI to link back).</summary>
    public sealed record AskNotesAiDto(string Answer, IReadOnlyList<long> UsedNoteIds);

    /// <summary>"Transform with AI" request: an editor <see cref="Action"/> ("continue"|"checklist"|"shorten"|
    /// "translate") applied to the in-editor <see cref="Body"/>; <see cref="Lang"/> is used by "translate".
    /// Saves nothing — the editor applies the returned body with Use / Try-again.</summary>
    public sealed record NoteTransformAiRequest(string? Body, string? Action, string? Lang);

    /// <summary>"Transform with AI" response: the transformed markdown body (to be RENDERED, never executed).</summary>
    public sealed record NoteTransformAiDto(string Body);

    /// <summary>List "What am I missing" request: a free-text goal ("a kids birthday party", "taco night") the
    /// assistant proposes ADDITIONAL items for, given the list's current items.</summary>
    public sealed record ListSuggestAiRequest(string? Goal);

    /// <summary>List "What am I missing" response: 0+ proposed additional item names (not already on the list).</summary>
    public sealed record ListSuggestAiDto(IReadOnlyList<string> Items);

    private const string NoteType = "note";
    private const string ListType = "list";

    public static void MapFamilyNotesListsEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        MapNotes(g);
        MapLists(g);
    }

    // =====================================================================================
    // NOTES
    // =====================================================================================

    private static void MapNotes(RouteGroupBuilder g)
    {
        // ---- GET /notes : household notes + notes shared-with-me ----
        g.MapGet("/notes", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            // Notes the caller can see: in their household, OR shared directly to them.
            var sharedNoteIds = await SharedItemIdsAsync(db, NoteType, caller.Id, ct);
            var notes = await db.FamilyNotes.AsNoTracking()
                .Where(n => n.HouseholdId == householdId || sharedNoteIds.Contains(n.Id))
                .ToListAsync(ct);

            var shares = await SharesForItemsAsync(db, NoteType, notes.Select(n => n.Id), ct);
            var names = await NamesAsync(db,
                notes.Select(n => n.CreatedByUserId)
                    .Concat(shares.Select(s => s.SharedWithUserId)), ct);

            var dtos = notes
                .OrderByDescending(n => n.Pinned).ThenByDescending(n => n.UpdatedUtc)
                .Take(500)
                .Select(n => ToNoteDto(n, caller.Id, householdId, shares, names))
                .ToList();
            return Results.Ok(dtos);
        });

        // ---- POST /notes ----
        g.MapPost("/notes", async (
            NoteUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var now = DateTime.UtcNow;
            var note = new FamilyNote
            {
                HouseholdId = household.Id,
                CreatedByUserId = caller.Id,
                Title = Clamp(req.Title, 200),
                Body = Clamp(req.Body, 8000),
                Pinned = req.Pinned,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.FamilyNotes.Add(note);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleNoteDtoAsync(db, note, caller.Id, household.Id, ct));
        });

        // ---- PUT /notes/{id} (edit: member or canEdit-share) ----
        g.MapPut("/notes/{id:long}", async (
            long id, NoteUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var note = await db.FamilyNotes.FirstOrDefaultAsync(n => n.Id == id, ct);
            var access = await ResolveAccessAsync(db, NoteType, note?.Id ?? 0, note?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (note is null || !access.CanView) return NotFound();
            if (!access.CanEdit) return Forbidden("You can only view this note.");

            note.Title = Clamp(req.Title, 200);
            note.Body = Clamp(req.Body, 8000);
            note.Pinned = req.Pinned;
            note.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleNoteDtoAsync(db, note, caller.Id, householdId, ct));
        });

        // ---- DELETE /notes/{id} (creator or household member) ----
        g.MapDelete("/notes/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var note = await db.FamilyNotes.FirstOrDefaultAsync(n => n.Id == id, ct);
            var access = await ResolveAccessAsync(db, NoteType, note?.Id ?? 0, note?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (note is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can delete this note.");

            db.FamilyNotes.Remove(note);
            await db.FamilyShares.Where(s => s.ItemType == NoteType && s.ItemId == id).ExecuteDeleteAsync(ct);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /notes/{id}/share (manage: creator or member) ----
        g.MapPost("/notes/{id:long}/share", async (
            long id, ShareRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var note = await db.FamilyNotes.AsNoTracking().FirstOrDefaultAsync(n => n.Id == id, ct);
            var access = await ResolveAccessAsync(db, NoteType, note?.Id ?? 0, note?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (note is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can share this note.");

            var problem = await AddShareAsync(db, NoteType, id, req, caller, householdId, ct);
            if (problem is not null) return problem;

            return Results.Ok(await SingleNoteDtoAsync(db, note, caller.Id, householdId, ct));
        });

        // ---- DELETE /notes/{id}/share/{userId} (manage) ----
        g.MapDelete("/notes/{id:long}/share/{userId:int}", async (
            long id, int userId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var note = await db.FamilyNotes.AsNoTracking().FirstOrDefaultAsync(n => n.Id == id, ct);
            var access = await ResolveAccessAsync(db, NoteType, note?.Id ?? 0, note?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (note is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can manage sharing.");

            await db.FamilyShares
                .Where(s => s.ItemType == NoteType && s.ItemId == id && s.SharedWithUserId == userId)
                .ExecuteDeleteAsync(ct);
            return Results.Ok(await SingleNoteDtoAsync(db, note, caller.Id, householdId, ct));
        });

        // ---- POST /notes/ai/draft : Gemini DRAFTS a fresh note, or REWRITES the supplied body per the prompt ----
        // Operates on editor content only — it touches NO stored note, so no access check beyond family.use is
        // needed. Saves NOTHING; the editor shows the draft (Use / Try-again). Rate-limited + NOT cached.
        // Graceful: 503 (never 500) when Gemini is unconfigured or the call fails; 400 for an empty prompt. The
        // returned body is markdown to be RENDERED (never executed) by the existing safe renderer.
        g.MapPost("/notes/ai/draft", async (
            NoteDraftAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Prompt))
                return Results.BadRequest(new { message = "Tell the assistant what to write." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.DraftNoteAsync(req.Prompt, req.CurrentTitle, req.CurrentBody, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new NoteDraftAiDto(result.Title, result.Body, result.Note));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /notes/{id}/ai/summarize : summarise a note + pull action items (with optional due phrases) ----
        // Reuses ResolveAccessAsync: 404 if the caller can't VIEW the note (existence never leaked). Creates
        // NOTHING — action items' duePhrase can be fed into the slice-1 reminder parser if the user chooses.
        // Rate-limited + NOT cached. Graceful: 503 (never 500) when Gemini is unconfigured or the call fails.
        g.MapPost("/notes/{id:long}/ai/summarize", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var note = await db.FamilyNotes.AsNoTracking().FirstOrDefaultAsync(n => n.Id == id, ct);
            var access = await ResolveAccessAsync(db, NoteType, note?.Id ?? 0, note?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (note is null || !access.CanView) return NotFound();

            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.SummarizeNoteAsync(note.Title, note.Body, ct);
            if (result is null) return AiUnavailable();

            var actions = result.ActionItems
                .Select(a => new NoteActionItemDto(a.Text, a.DuePhrase)).ToList();
            return Results.Ok(new NoteSummaryAiDto(result.Summary, actions));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /notes/ai/ask : read-only Q&A over the caller's HOUSEHOLD notes (round 2) ----
        // Loads the caller's OWN household's notes (title+body, newest-first, capped ~24k chars) and answers the
        // question STRICTLY from them (says "I couldn't find that in your notes" otherwise; never invents). The
        // model's usedNoteIds are intersected with the supplied notes server-side. Read-only — creates/saves
        // NOTHING. Rate-limited + NOT cached. Graceful: 503 (never 500) when Gemini is unconfigured or the call
        // fails; 400 for an empty question.
        g.MapPost("/notes/ai/ask", async (
            AskNotesAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Question))
                return Results.BadRequest(new { message = "Ask a question about your notes." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            // The HOUSEHOLD's own notes, newest-first (UpdatedUtc) — the service caps the total chars fed in.
            var notes = await db.FamilyNotes.AsNoTracking()
                .Where(n => n.HouseholdId == householdId)
                .OrderByDescending(n => n.UpdatedUtc)
                .Take(200)
                .Select(n => new { n.Id, n.Title, n.Body })
                .ToListAsync(ct);

            var result = await gemini.AskNotesAsync(
                req.Question, notes.Select(n => (n.Id, n.Title, n.Body)).ToList(), ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new AskNotesAiDto(result.Answer, result.UsedNoteIds));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /notes/ai/transform : transform in-editor markdown (round 2) ----
        // Operates on editor content only — it touches NO stored note, so no access check beyond family.use is
        // needed. SAVES NOTHING; the editor applies the returned body (Use / Try-again). Rate-limited + NOT
        // cached. Graceful: 503 (never 500) when Gemini is unconfigured or the call fails; 400 for an empty body
        // or an unknown action. The returned body is markdown to be RENDERED (never executed) by the safe renderer.
        g.MapPost("/notes/ai/transform", async (
            NoteTransformAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Body))
                return Results.BadRequest(new { message = "There's nothing to transform yet." });
            if (!IsTransformAction(req.Action))
                return Results.BadRequest(new { message = "Action must be continue, checklist, shorten, or translate." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.TransformNoteAsync(req.Body, req.Action, req.Lang, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new NoteTransformAiDto(result.Body));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>The transform actions the note transformer accepts (mirrors GeminiService.TransformActions).</summary>
    private static readonly string[] TransformActions = { "continue", "checklist", "shorten", "translate" };

    private static bool IsTransformAction(string? action) =>
        TransformActions.Contains((action ?? "").Trim().ToLowerInvariant());

    // =====================================================================================
    // LISTS
    // =====================================================================================

    private static void MapLists(RouteGroupBuilder g)
    {
        // ---- GET /lists : household + shared-with-me lists, with their items ----
        g.MapGet("/lists", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var sharedListIds = await SharedItemIdsAsync(db, ListType, caller.Id, ct);
            var lists = await db.FamilyLists.AsNoTracking()
                .Where(l => l.HouseholdId == householdId || sharedListIds.Contains(l.Id))
                .ToListAsync(ct);
            var listIds = lists.Select(l => l.Id).ToList();
            var items = await db.FamilyListItems.AsNoTracking()
                .Where(i => listIds.Contains(i.ListId))
                .ToListAsync(ct);

            var shares = await SharesForItemsAsync(db, ListType, listIds, ct);
            var names = await NamesAsync(db,
                lists.Select(l => l.CreatedByUserId)
                    .Concat(shares.Select(s => s.SharedWithUserId))
                    .Concat(items.Where(i => i.DoneByUserId is not null).Select(i => i.DoneByUserId!.Value))
                    .Concat(items.Where(i => i.AssignedToUserId is not null).Select(i => i.AssignedToUserId!.Value)), ct);

            var dtos = lists
                .OrderByDescending(l => l.UpdatedUtc)
                .Take(500)
                .Select(l => ToListDto(l, items, caller.Id, householdId, shares, names))
                .ToList();
            return Results.Ok(dtos);
        });

        // ---- POST /lists ----
        g.MapPost("/lists", async (
            ListCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var name = (req.Name ?? "").Trim();
            if (string.IsNullOrEmpty(name)) return Results.BadRequest(new { message = "A list name is required." });

            var now = DateTime.UtcNow;
            var list = new FamilyList
            {
                HouseholdId = household.Id,
                CreatedByUserId = caller.Id,
                Name = name.Length > 200 ? name[..200] : name,
                Kind = NormalizeKind(req.Kind),
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.FamilyLists.Add(list);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- PUT /lists/{id} (rename; edit access) ----
        g.MapPut("/lists/{id:long}", async (
            long id, ListRenameRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanEdit) return Forbidden("You can only view this list.");

            var name = (req.Name ?? "").Trim();
            if (string.IsNullOrEmpty(name)) return Results.BadRequest(new { message = "A list name is required." });
            list.Name = name.Length > 200 ? name[..200] : name;
            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleListDtoAsync(db, list.Id, caller.Id, householdId, ct));
        });

        // ---- DELETE /lists/{id} (creator or household member) ----
        g.MapDelete("/lists/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can delete this list.");

            db.FamilyLists.Remove(list); // items cascade
            await db.FamilyShares.Where(s => s.ItemType == ListType && s.ItemId == id).ExecuteDeleteAsync(ct);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /lists/{id}/items (edit access) ----
        g.MapPost("/lists/{id:long}/items", async (
            long id, ListItemCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanEdit) return Forbidden("You can only view this list.");

            var text = (req.Text ?? "").Trim();
            if (string.IsNullOrEmpty(text)) return Results.BadRequest(new { message = "Item text is required." });

            // An assignee must be a household member or someone the list is shared with.
            int? assignee = null;
            if (req.AssignedToUserId is int aId)
            {
                if (!await IsItemPersonAsync(db, ListType, id, list.HouseholdId, aId, ct))
                    return Results.BadRequest(new { message = "That person isn't part of this list." });
                assignee = aId;
            }

            var maxSort = await db.FamilyListItems.Where(i => i.ListId == id)
                .Select(i => (int?)i.SortOrder).MaxAsync(ct) ?? -1;
            db.FamilyListItems.Add(new FamilyListItem
            {
                ListId = id,
                Text = text.Length > 500 ? text[..500] : text,
                AssignedToUserId = assignee,
                SortOrder = maxSort + 1,
                CreatedUtc = DateTime.UtcNow,
            });
            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleListDtoAsync(db, id, caller.Id, householdId, ct));
        });

        // ---- PATCH /lists/{id}/items/{itemId} (edit access) ----
        g.MapPatch("/lists/{id:long}/items/{itemId:long}", async (
            long id, long itemId, ListItemPatchRequest req, CurrentUserAccessor me,
            CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanEdit) return Forbidden("You can only view this list.");

            var item = await db.FamilyListItems.FirstOrDefaultAsync(i => i.Id == itemId && i.ListId == id, ct);
            if (item is null) return NotFound();

            if (req.Text is not null)
            {
                var text = req.Text.Trim();
                if (string.IsNullOrEmpty(text)) return Results.BadRequest(new { message = "Item text is required." });
                item.Text = text.Length > 500 ? text[..500] : text;
            }
            if (req.Done is bool done)
            {
                item.Done = done;
                // Toggling done stamps the caller; clearing wipes the stamp.
                item.DoneByUserId = done ? caller.Id : null;
            }
            if (req.AssignedToUserId is int aId)
            {
                if (!await IsItemPersonAsync(db, ListType, id, list.HouseholdId, aId, ct))
                    return Results.BadRequest(new { message = "That person isn't part of this list." });
                item.AssignedToUserId = aId;
            }
            // Omitting assignedToUserId means "no change" (the minimal contract has no explicit unassign).

            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleListDtoAsync(db, id, caller.Id, householdId, ct));
        });

        // ---- DELETE /lists/{id}/items/{itemId} (edit access) ----
        g.MapDelete("/lists/{id:long}/items/{itemId:long}", async (
            long id, long itemId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanEdit) return Forbidden("You can only view this list.");

            await db.FamilyListItems.Where(i => i.Id == itemId && i.ListId == id).ExecuteDeleteAsync(ct);
            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(await SingleListDtoAsync(db, id, caller.Id, householdId, ct));
        });

        // ---- POST /lists/{id}/share (manage) ----
        g.MapPost("/lists/{id:long}/share", async (
            long id, ShareRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.AsNoTracking().FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can share this list.");

            var problem = await AddShareAsync(db, ListType, id, req, caller, householdId, ct);
            if (problem is not null) return problem;

            return Results.Ok(await SingleListDtoAsync(db, id, caller.Id, householdId, ct));
        });

        // ---- DELETE /lists/{id}/share/{userId} (manage) ----
        g.MapDelete("/lists/{id:long}/share/{userId:int}", async (
            long id, int userId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.AsNoTracking().FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();
            if (!access.CanManage) return Forbidden("Only a family member can manage sharing.");

            await db.FamilyShares
                .Where(s => s.ItemType == ListType && s.ItemId == id && s.SharedWithUserId == userId)
                .ExecuteDeleteAsync(ct);
            return Results.Ok(await SingleListDtoAsync(db, id, caller.Id, householdId, ct));
        });

        // ---- POST /lists/ai/parse-items : Gemini turns free text into PROPOSED item names the user confirms ----
        // Creates NOTHING — the frontend confirms then adds each item via the existing POST /lists/{id}/items.
        // Rate-limited (the shared "ai" policy) because it spends model tokens, and NOT cached. Graceful: a 503
        // (never a 500) when Gemini is unconfigured or the call fails; a 400 for empty text.
        g.MapPost("/lists/ai/parse-items", async (
            ListItemsAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Type or paste what you'd like to add." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.ParseListItemsAsync(req.Text, req.Kind, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new ListItemsAiDto(result.Items, result.Notes));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /lists/{id}/ai/suggest : "What am I missing" — propose ADDITIONAL items (round 2) ----
        // Reuses ResolveAccessAsync: 404 if the caller can't VIEW the list (existence never leaked). Given the
        // list's CURRENT items + a free-text goal, proposes items not already on it (de-duped server-side).
        // Creates NOTHING — the frontend confirms then POSTs each via the existing POST /lists/{id}/items.
        // Rate-limited + NOT cached. Graceful: 503 (never 500) when Gemini is unconfigured or the call fails;
        // 400 for an empty goal.
        g.MapPost("/lists/{id:long}/ai/suggest", async (
            long id, ListSuggestAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Goal))
                return Results.BadRequest(new { message = "Tell the assistant what the list is for." });

            var caller = (await me.GetUserAsync(ct))!;
            var householdId = await households.GetOrCreateForCallerAsync(caller, ct) is { } hh ? hh.Id : 0;

            var list = await db.FamilyLists.AsNoTracking().FirstOrDefaultAsync(l => l.Id == id, ct);
            var access = await ResolveAccessAsync(db, ListType, list?.Id ?? 0, list?.HouseholdId ?? -1, caller.Id, householdId, ct);
            if (list is null || !access.CanView) return NotFound();

            if (!gemini.IsConfigured) return AiUnavailable();

            // The list's current item texts (the "don't repeat these" set) — server-read, never trusted from client.
            var currentItems = await db.FamilyListItems.AsNoTracking()
                .Where(i => i.ListId == id)
                .Select(i => i.Text)
                .ToListAsync(ct);

            var result = await gemini.SuggestListAdditionsAsync(req.Goal, list.Kind, currentItems, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new ListSuggestAiDto(result.Items));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    // =====================================================================================
    // ACCESS RULES (the shared visibility/edit helper used by every handler)
    // =====================================================================================

    /// <summary>The caller's relationship to a single family item.</summary>
    private readonly record struct Access(bool CanView, bool CanEdit, bool CanManage);

    /// <summary>
    /// Resolve the caller's access to an item: VIEW = member of the item's household OR has a share row;
    /// EDIT = member OR a CanEdit share; MANAGE (delete / share) = household member (owner-ish). A
    /// shared-in non-member never manages. Pass the item's household id (or -1 when the item is missing).
    /// </summary>
    private static async Task<Access> ResolveAccessAsync(
        UsageDbContext db, string itemType, long itemId, int itemHouseholdId,
        int callerId, int callerHouseholdId, CancellationToken ct)
    {
        var isMember = itemHouseholdId > 0 && itemHouseholdId == callerHouseholdId;
        if (isMember) return new Access(true, true, true);

        if (itemId <= 0) return default;
        var share = await db.FamilyShares.AsNoTracking()
            .Where(s => s.ItemType == itemType && s.ItemId == itemId && s.SharedWithUserId == callerId)
            .Select(s => (bool?)s.CanEdit)
            .FirstOrDefaultAsync(ct);
        if (share is null) return default; // neither member nor shared → no view (404)
        return new Access(true, share.Value, false); // shared-in: view always, edit per flag, never manage
    }

    /// <summary>
    /// Validate + persist a share. The target must be a real, ENABLED user that is one of the caller's
    /// chat contacts (resolved to AppUser id). Idempotent: re-sharing updates CanEdit. A target who is
    /// already a household member of the item is rejected (nothing to share).
    /// </summary>
    private static async Task<IResult?> AddShareAsync(
        UsageDbContext db, string itemType, long itemId, ShareRequest req,
        CurrentUserAccessor.CurrentUser caller, int callerHouseholdId, CancellationToken ct)
    {
        if (req.UserId == caller.Id)
            return Results.BadRequest(new { message = "You can't share an item with yourself." });

        var target = await db.Users.AsNoTracking()
            .Where(u => u.Id == req.UserId)
            .Select(u => new
            {
                u.Id,
                u.IsEnabled,
                u.Email,
                HasFamily = u.Permissions.Any(p => p.Permission == Permissions.FamilyUse),
            })
            .FirstOrDefaultAsync(ct);
        if (target is null || !target.IsEnabled)
            return Results.BadRequest(new { message = "That person doesn't exist or is disabled." });

        // The /api/family group is gated by family.use, so a target without it could never open the
        // shared item — reject the dead share up front (consistent with adding a household member).
        if (!target.HasFamily)
            return Results.BadRequest(new { message = "That person needs family access before you can share with them." });

        // The target must be one of the caller's mutual chat contacts.
        var isContact = await ContactGraph.IsContactAsync(db, caller.Email, target.Email, ct);
        if (!isContact)
            return Results.BadRequest(new { message = "You can only share with one of your contacts." });

        // No point sharing to someone who is already a member of the item's household.
        if (await db.HouseholdMembers.AsNoTracking()
                .AnyAsync(m => m.HouseholdId == callerHouseholdId && m.UserId == req.UserId, ct))
            return Results.BadRequest(new { message = "That person is already in your family." });

        var existing = await db.FamilyShares
            .FirstOrDefaultAsync(s => s.ItemType == itemType && s.ItemId == itemId && s.SharedWithUserId == req.UserId, ct);
        if (existing is null)
        {
            db.FamilyShares.Add(new FamilyShare
            {
                ItemType = itemType,
                ItemId = itemId,
                SharedWithUserId = req.UserId,
                CanEdit = req.CanEdit,
                CreatedByUserId = caller.Id,
                CreatedUtc = DateTime.UtcNow,
            });
        }
        else
        {
            existing.CanEdit = req.CanEdit;
        }

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            db.ChangeTracker.Clear(); // a concurrent identical share won the race — that's fine
        }
        return null;
    }

    // =====================================================================================
    // SHARED LOOKUPS / DTO PROJECTION
    // =====================================================================================

    /// <summary>Ids of items of a type that are shared directly with the caller.</summary>
    private static async Task<List<long>> SharedItemIdsAsync(
        UsageDbContext db, string itemType, int callerId, CancellationToken ct) =>
        await db.FamilyShares.AsNoTracking()
            .Where(s => s.ItemType == itemType && s.SharedWithUserId == callerId)
            .Select(s => s.ItemId)
            .ToListAsync(ct);

    /// <summary>All shares for a set of items of a type.</summary>
    private static async Task<List<FamilyShare>> SharesForItemsAsync(
        UsageDbContext db, string itemType, IEnumerable<long> itemIds, CancellationToken ct)
    {
        var ids = itemIds.Distinct().ToList();
        if (ids.Count == 0) return new List<FamilyShare>();
        return await db.FamilyShares.AsNoTracking()
            .Where(s => s.ItemType == itemType && ids.Contains(s.ItemId))
            .ToListAsync(ct);
    }

    /// <summary>Resolve a set of userIds to display names (email is never read). Missing → "Unknown user".</summary>
    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<int, string>();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(
                u => u.Id,
                u => string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    /// <summary>True when the user is a member of the item's household OR the item is shared with them —
    /// the set of people who may be an assignee on a list item.</summary>
    private static async Task<bool> IsItemPersonAsync(
        UsageDbContext db, string itemType, long itemId, int itemHouseholdId, int userId, CancellationToken ct)
    {
        if (await db.HouseholdMembers.AsNoTracking()
                .AnyAsync(m => m.HouseholdId == itemHouseholdId && m.UserId == userId, ct))
            return true;
        return await db.FamilyShares.AsNoTracking()
            .AnyAsync(s => s.ItemType == itemType && s.ItemId == itemId && s.SharedWithUserId == userId, ct);
    }

    private static NoteDto ToNoteDto(
        FamilyNote n, int callerId, int callerHouseholdId,
        List<FamilyShare> allShares, Dictionary<int, string> names)
    {
        // Membership is per-ITEM: the caller is a member of THIS note's household (not merely of some
        // household). A shared-in caller from another household is never treated as a member.
        var isMember = callerHouseholdId > 0 && n.HouseholdId == callerHouseholdId;
        var canEdit = isMember || allShares.Any(s => s.ItemId == n.Id && s.SharedWithUserId == callerId && s.CanEdit);
        // sharedWith is only populated for items the caller manages (a household member).
        var sharedWith = isMember
            ? allShares.Where(s => s.ItemId == n.Id)
                .Select(s => new ShareTargetDto(s.SharedWithUserId, Name(names, s.SharedWithUserId), s.CanEdit))
                .ToList()
            : new List<ShareTargetDto>();
        return new NoteDto(
            n.Id, n.Title, n.Body, n.Pinned,
            n.CreatedByUserId, Name(names, n.CreatedByUserId), n.UpdatedUtc,
            IsMine: n.CreatedByUserId == callerId, CanEdit: canEdit, SharedWith: sharedWith);
    }

    private static ListDto ToListDto(
        FamilyList l, List<FamilyListItem> allItems, int callerId, int callerHouseholdId,
        List<FamilyShare> allShares, Dictionary<int, string> names)
    {
        var isMember = callerHouseholdId > 0 && l.HouseholdId == callerHouseholdId;
        var canEdit = isMember || allShares.Any(s => s.ItemId == l.Id && s.SharedWithUserId == callerId && s.CanEdit);
        var sharedWith = isMember
            ? allShares.Where(s => s.ItemId == l.Id)
                .Select(s => new ShareTargetDto(s.SharedWithUserId, Name(names, s.SharedWithUserId), s.CanEdit))
                .ToList()
            : new List<ShareTargetDto>();
        var items = allItems.Where(i => i.ListId == l.Id)
            .OrderBy(i => i.SortOrder).ThenBy(i => i.Id)
            .Select(i => new ListItemDto(
                i.Id, i.Text, i.Done,
                i.DoneByUserId, i.DoneByUserId is int d ? Name(names, d) : null,
                i.AssignedToUserId, i.AssignedToUserId is int a ? Name(names, a) : null,
                i.SortOrder))
            .ToList();
        return new ListDto(
            l.Id, l.Name, l.Kind,
            l.CreatedByUserId, Name(names, l.CreatedByUserId),
            IsMine: l.CreatedByUserId == callerId, CanEdit: canEdit, SharedWith: sharedWith, Items: items);
    }

    /// <summary>Re-project a single note (after a mutation) using the caller's household for access.</summary>
    private static async Task<NoteDto> SingleNoteDtoAsync(
        UsageDbContext db, FamilyNote note, int callerId, int callerHouseholdId, CancellationToken ct)
    {
        var shares = await SharesForItemsAsync(db, NoteType, new[] { note.Id }, ct);
        var names = await NamesAsync(db,
            new[] { note.CreatedByUserId }.Concat(shares.Select(s => s.SharedWithUserId)), ct);
        return ToNoteDto(note, callerId, callerHouseholdId, shares, names);
    }

    /// <summary>
    /// Re-load + project a single list into the F1 <see cref="ListDto"/> shape, as seen by the given caller
    /// in the given household. Public so sibling Family endpoints (e.g. F4 meals → grocery list) can return
    /// the exact same list DTO without duplicating the projection.
    /// </summary>
    public static Task<ListDto> LoadListDtoAsync(
        UsageDbContext db, long listId, int callerId, int callerHouseholdId, CancellationToken ct) =>
        SingleListDtoAsync(db, listId, callerId, callerHouseholdId, ct);

    /// <summary>Re-load + project a single list (after a mutation) using the caller's household for access.</summary>
    private static async Task<ListDto> SingleListDtoAsync(
        UsageDbContext db, long listId, int callerId, int callerHouseholdId, CancellationToken ct)
    {
        var list = await db.FamilyLists.AsNoTracking().FirstAsync(l => l.Id == listId, ct);
        var items = await db.FamilyListItems.AsNoTracking().Where(i => i.ListId == listId).ToListAsync(ct);
        var shares = await SharesForItemsAsync(db, ListType, new[] { listId }, ct);
        var names = await NamesAsync(db,
            new[] { list.CreatedByUserId }
                .Concat(shares.Select(s => s.SharedWithUserId))
                .Concat(items.Where(i => i.DoneByUserId is not null).Select(i => i.DoneByUserId!.Value))
                .Concat(items.Where(i => i.AssignedToUserId is not null).Select(i => i.AssignedToUserId!.Value)), ct);
        return ToListDto(list, items, callerId, callerHouseholdId, shares, names);
    }

    // =====================================================================================
    // SMALL HELPERS
    // =====================================================================================

    private static string Clamp(string? s, int max)
    {
        s = (s ?? "").Trim();
        return s.Length > max ? s[..max] : s;
    }

    private static string NormalizeKind(string? kind) =>
        string.Equals(kind?.Trim(), "shopping", StringComparison.OrdinalIgnoreCase) ? "shopping" : "todo";

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That item doesn't exist." });

    /// <summary>503 (never 500) when an AI-assist call can't run — Gemini unconfigured or the call failed. One
    /// consistent degraded path the frontend shows as "AI isn't available right now; do it manually".</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI assistance is not available.",
        detail: "AI assistance is not available right now. You can do this manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    private static IResult Forbidden(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status403Forbidden);

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
