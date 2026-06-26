using System.Text.Json;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Resume Builder API (<c>/api/resume</c>), gated by <see cref="Permissions.ResumeUse"/>. Identity comes from
/// the JWT; every row is OWNER-SCOPED by the lower-cased caller email (mirrors <see cref="RecipeEndpoints"/>).
///
/// Model: ONE master <see cref="Resume"/> per owner (PUT upserts), plus N per-job <see cref="ResumeApplication"/>
/// variants. The whole structured <see cref="ResumeDataDto"/> is stored as a JSON document in
/// <c>DataJson</c> / <c>TailoredDataJson</c> (round-tripped via <see cref="Serialize"/> / <see cref="Deserialize"/>,
/// defaulting to <see cref="ResumeDataDto.Empty"/> on null/blank). The headshot bytes live on the master and are
/// served by a dedicated endpoint (never on the JSON wire — <see cref="ResumeDto.HasHeadshot"/> just flags it).
///
/// AI (parse / tailor / cover-letter / refine / chat) is delegated to <see cref="GeminiService"/>; the AI +
/// parse + application-create routes are additionally rate-limited (the shared "ai" policy) and return a 503 when
/// Gemini is unconfigured (mirrors <see cref="AiEndpoints"/>). Document export is delegated to
/// <see cref="ResumeDocumentService"/>.
/// </summary>
public static class ResumeEndpoints
{
    private const int MaxTitleLen = 200;

    /// <summary>Allowed headshot image mime types (mirrors the multimodal photo routes' allow-set).</summary>
    private static readonly IReadOnlySet<string> AllowedHeadshotMimeTypes =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "image/jpeg", "image/png", "image/webp" };

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public static void MapResumeEndpoints(this WebApplication app)
    {
        // The page + base API gate. Read/write of the master + applications rides this alone.
        var g = app.MapGroup("/api/resume")
            .RequireAuthorization()
            .RequirePermission(Permissions.ResumeUse);

        // The AI + parse + application-create routes ALSO carry the shared AI rate-limit (token-spend cap).
        var ai = app.MapGroup("/api/resume")
            .RequireAuthorization()
            .RequirePermission(Permissions.ResumeUse)
            .RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ============================ State (master + applications) ============================

        // ---- The caller's whole Resume Builder state: master (null until first save) + all applications ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var master = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
            var apps = master is null
                ? new List<ResumeApplication>()
                : await db.ResumeApplications.AsNoTracking()
                    .Where(a => a.OwnerEmail == caller.Email && a.ResumeId == master.Id)
                    .OrderByDescending(a => a.Id)
                    .ToListAsync(ct);

            return Results.Ok(new ResumeStateDto(
                master is null ? null : ToDto(master),
                apps.Select(ToDto).ToList()));
        });

        // ---- Upsert the SINGLE master resume for the owner ----
        g.MapPut("/", async (
            ResumeSaveRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (req is null) return Results.BadRequest(new { message = "A resume body is required." });

            var now = DateTime.UtcNow;
            var master = await db.Resumes
                .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
            if (master is null)
            {
                master = new Resume { OwnerEmail = caller.Email, CreatedUtc = now };
                db.Resumes.Add(master);
            }

            master.Title = Clamp(req.Title ?? "", MaxTitleLen);
            master.DataJson = Serialize(req.Data ?? ResumeDataDto.Empty);
            master.ShareWithContacts = req.ShareWithContacts;
            master.UpdatedUtc = now;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(master));
        });

        // ---- Delete the master (cascade removes its applications + headshot) ----
        g.MapDelete("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // Cascade the applications first (no FK cascade is relied on here — explicit + owner-scoped).
            await db.ResumeApplications.Where(a => a.OwnerEmail == caller.Email).ExecuteDeleteAsync(ct);
            await db.Resumes.Where(r => r.OwnerEmail == caller.Email).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });

        // ============================ Parse (AI, rate-limited) ============================

        // ---- Parse an uploaded file OR pasted text into structured ResumeData (503 if Gemini unconfigured) ----
        ai.MapPost("/parse", async (
            ParseResumeRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (req is null) return Results.BadRequest(new { message = "Supply a file or pasted text." });
            if (!gemini.IsConfigured) return Unconfigured();

            ResumeDataDto? data;
            var hasFile = !string.IsNullOrWhiteSpace(req.FileBase64);
            if (hasFile)
            {
                // Validate the upload (jpeg/png/webp/pdf, size cap) before any upstream call.
                if (!TryValidateResumeFile(req.FileBase64, req.Mime, out var base64, out var mime, out var bad))
                    return bad;
                data = await gemini.ParseResumeFileAsync(base64, mime, ct);
            }
            else if (!string.IsNullOrWhiteSpace(req.Text))
            {
                data = await gemini.ParseResumeTextAsync(req.Text, ct);
            }
            else
            {
                return Results.BadRequest(new { message = "Supply a file or pasted text." });
            }

            // Parse failed (quota/unreadable) -> the same degraded 503 path the rest of the AI surface uses.
            if (data is null) return Unavailable();
            return Results.Ok(new { data, aiUsed = true });
        });

        // ============================ Headshot (master, owner-scoped) ============================

        // ---- Upload/replace the headshot image on the master ----
        g.MapPost("/headshot", async (
            HeadshotRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (!TryValidateImage(req?.ImageBase64, req?.Mime, out var base64, out var mime, out var bad))
                return bad;

            var master = await db.Resumes
                .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
            if (master is null)
                return Results.BadRequest(new { message = "Save your resume before adding a headshot." });

            byte[] bytes;
            try { bytes = Convert.FromBase64String(base64); }
            catch (FormatException) { return bad; }

            master.HeadshotBytes = bytes;
            master.HeadshotMime = mime;
            master.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { ok = true });
        });

        // ---- Fetch the stored headshot bytes (or 404) ----
        g.MapGet("/headshot", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var row = await db.Resumes.AsNoTracking()
                .Where(r => r.OwnerEmail == caller.Email)
                .Select(r => new { r.HeadshotBytes, r.HeadshotMime })
                .FirstOrDefaultAsync(ct);
            if (row?.HeadshotBytes is null || row.HeadshotBytes.Length == 0)
                return Results.NotFound();
            return Results.File(row.HeadshotBytes, row.HeadshotMime ?? "application/octet-stream");
        });

        // ---- Remove the headshot ----
        g.MapDelete("/headshot", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var master = await db.Resumes
                .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
            if (master is not null && master.HeadshotBytes is not null)
            {
                master.HeadshotBytes = null;
                master.HeadshotMime = null;
                master.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }
            return Results.NoContent();
        });

        // ============================ Applications ============================

        // ---- Start a new tailored application off the master (AI tailor + cover letter; rate-limited) ----
        ai.MapPost("/applications", async (
            NewApplicationRequest req, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (req is null || string.IsNullOrWhiteSpace(req.JobTitle))
                return Results.BadRequest(new { message = "A target job title is required." });

            var master = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
            if (master is null)
                return Results.BadRequest(new { message = "Save your master resume first." });

            var masterData = Deserialize(master.DataJson);
            var jobDesc = req.JobDescription ?? "";

            // AI tailor + cover letter off the master. When Gemini is unconfigured/fails we still create the
            // application (a manual starting point): tailored data falls back to the master, cover letter to "".
            var tailored = masterData;
            var coverLetter = "";
            if (gemini.IsConfigured)
            {
                var t = await gemini.TailorResumeAsync(masterData, jobDesc, ct);
                if (t is not null) tailored = t;
                var cl = await gemini.GenerateCoverLetterAsync(
                    tailored, req.JobTitle ?? "", req.Company ?? "", jobDesc, ct);
                if (!string.IsNullOrWhiteSpace(cl)) coverLetter = cl;
            }

            var now = DateTime.UtcNow;
            var entity = new ResumeApplication
            {
                ResumeId = master.Id,
                OwnerEmail = caller.Email,
                JobTitle = Clamp(req.JobTitle ?? "", MaxTitleLen),
                Company = Clamp(req.Company ?? "", MaxTitleLen),
                JobDescription = jobDesc,
                TailoredDataJson = Serialize(tailored),
                CoverLetter = coverLetter,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.ResumeApplications.Add(entity);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(entity));
        });

        // ---- Save an application's edits (owner-scoped; foreign/missing -> 404) ----
        g.MapPut("/applications/{id:long}", async (
            long id, ApplicationSaveRequest req, CurrentUserAccessor me, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (req is null) return Results.BadRequest(new { message = "An application body is required." });

            var entity = await db.ResumeApplications
                .FirstOrDefaultAsync(a => a.Id == id && a.OwnerEmail == caller.Email, ct);
            if (entity is null) return Results.NotFound();

            entity.JobTitle = Clamp(req.JobTitle ?? "", MaxTitleLen);
            entity.Company = Clamp(req.Company ?? "", MaxTitleLen);
            entity.JobDescription = req.JobDescription ?? "";
            entity.TailoredDataJson = Serialize(req.Data ?? ResumeDataDto.Empty);
            entity.CoverLetter = req.CoverLetter ?? "";
            entity.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(entity));
        });

        // ---- Delete an application (owner-scoped; foreign/missing -> 404) ----
        g.MapDelete("/applications/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var deleted = await db.ResumeApplications
                .Where(a => a.Id == id && a.OwnerEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        });

        // ============================ AI proposals (rate-limited; persist nothing) ============================

        // ---- Tailor the supplied data toward a job description (proposal only) ----
        ai.MapPost("/ai/tailor", async (
            TailorRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (req is null) return Results.BadRequest(new { message = "Supply resume data + a job description." });
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.TailorResumeAsync(req.Data ?? ResumeDataDto.Empty, req.JobDescription ?? "", ct);
            return result is null ? Unavailable() : Results.Ok(new { data = result });
        });

        // ---- Draft a cover letter for a job from the supplied data ----
        ai.MapPost("/ai/cover-letter", async (
            CoverLetterRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (req is null) return Results.BadRequest(new { message = "Supply resume data + the target job." });
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.GenerateCoverLetterAsync(
                req.Data ?? ResumeDataDto.Empty, req.JobTitle ?? "", req.Company ?? "", req.JobDescription ?? "", ct);
            return string.IsNullOrWhiteSpace(result) ? Unavailable() : Results.Ok(new { coverLetter = result });
        });

        // ---- Refine one section's content under a free-text instruction (the whole data as context) ----
        ai.MapPost("/ai/refine", async (
            RefineRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (req is null) return Results.BadRequest(new { message = "Supply the section, content + instruction." });
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.RefineResumeSectionAsync(
                req.Section ?? "", req.Content ?? "", req.Instruction ?? "", req.Data ?? ResumeDataDto.Empty, ct);
            return string.IsNullOrWhiteSpace(result) ? Unavailable() : Results.Ok(new { result });
        });

        // ---- Resume-assistant chat (conversation + optional data/job context) ----
        ai.MapPost("/ai/chat", async (
            ResumeChatRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (req is null || req.Messages is null || req.Messages.Count == 0)
                return Results.BadRequest(new { message = "Say something to the assistant." });
            if (!gemini.IsConfigured) return Unconfigured();
            var reply = await gemini.ResumeChatAsync(req.Messages, req.Data, req.JobContext, ct);
            return string.IsNullOrWhiteSpace(reply) ? Unavailable() : Results.Ok(new { reply });
        });

        // ============================ Export (PDF / DOCX) ============================

        // ---- Build a downloadable resume or cover-letter document from the master or an application ----
        g.MapGet("/export", async (
            string? source, long? id, string? kind, string? format, string? style,
            CurrentUserAccessor me, ResumeDocumentService docs, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            var isApplication = string.Equals(source, "application", StringComparison.OrdinalIgnoreCase);
            var isCover = string.Equals(kind, "cover", StringComparison.OrdinalIgnoreCase);
            var isDocx = string.Equals(format, "docx", StringComparison.OrdinalIgnoreCase);
            var designed = string.Equals(style, "designed", StringComparison.OrdinalIgnoreCase);

            // Resolve the data + cover letter source (master, or a specific owned application).
            ResumeDataDto data;
            string coverLetter;
            byte[]? headshot = null;
            string? headshotMime = null;

            if (isApplication)
            {
                if (id is not long appId)
                    return Results.BadRequest(new { message = "An application id is required." });
                var appRow = await db.ResumeApplications.AsNoTracking()
                    .FirstOrDefaultAsync(a => a.Id == appId && a.OwnerEmail == caller.Email, ct);
                if (appRow is null) return Results.NotFound();
                data = Deserialize(appRow.TailoredDataJson);
                coverLetter = appRow.CoverLetter ?? "";

                // The designed style still uses the OWNER's stored headshot (it lives on the master).
                if (designed)
                {
                    var hs = await db.Resumes.AsNoTracking()
                        .Where(r => r.OwnerEmail == caller.Email)
                        .Select(r => new { r.HeadshotBytes, r.HeadshotMime })
                        .FirstOrDefaultAsync(ct);
                    headshot = hs?.HeadshotBytes;
                    headshotMime = hs?.HeadshotMime;
                }
            }
            else
            {
                var master = await db.Resumes.AsNoTracking()
                    .FirstOrDefaultAsync(r => r.OwnerEmail == caller.Email, ct);
                if (master is null) return Results.NotFound();
                data = Deserialize(master.DataJson);
                coverLetter = "";
                if (designed)
                {
                    headshot = master.HeadshotBytes;
                    headshotMime = master.HeadshotMime;
                }
            }

            var contentType = isDocx
                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                : "application/pdf";
            var ext = isDocx ? "docx" : "pdf";

            byte[] bytes;
            string fileName;
            if (isCover)
            {
                if (string.IsNullOrWhiteSpace(coverLetter))
                    return Results.NotFound();
                bytes = isDocx
                    ? docs.BuildCoverLetterDocx(coverLetter, data.Contact)
                    : docs.BuildCoverLetterPdf(coverLetter, data.Contact);
                fileName = $"{FileSlug(data.Contact.FullName)}_Cover_Letter.{ext}";
            }
            else
            {
                bytes = isDocx
                    ? docs.BuildResumeDocx(data, designed, headshot, headshotMime)
                    : docs.BuildResumePdf(data, designed, headshot, headshotMime);
                fileName = $"{FileSlug(data.Contact.FullName)}_Resume.{ext}";
            }

            return Results.File(bytes, contentType, fileName);
        });
    }

    // ===================================================================================
    // DataJson (de)serialize helper — round-trips the stored JSON document <-> ResumeDataDto
    // ===================================================================================

    /// <summary>Serialize a <see cref="ResumeDataDto"/> to the JSON document stored in
    /// <c>Resume.DataJson</c> / <c>ResumeApplication.TailoredDataJson</c>.</summary>
    private static string Serialize(ResumeDataDto data) => JsonSerializer.Serialize(data, JsonOpts);

    /// <summary>Deserialize a stored DataJson string back to a <see cref="ResumeDataDto"/>, defaulting to
    /// <see cref="ResumeDataDto.Empty"/> on null/blank/malformed JSON (never throws into the request path).</summary>
    private static ResumeDataDto Deserialize(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return ResumeDataDto.Empty;
        try { return JsonSerializer.Deserialize<ResumeDataDto>(json, JsonOpts) ?? ResumeDataDto.Empty; }
        catch (JsonException) { return ResumeDataDto.Empty; }
    }

    // ===================================================================================
    // Mappers
    // ===================================================================================

    private static ResumeDto ToDto(Resume r) => new(
        Id: r.Id,
        Title: r.Title,
        Data: Deserialize(r.DataJson),
        HasHeadshot: r.HeadshotBytes is { Length: > 0 },
        ShareWithContacts: r.ShareWithContacts,
        UpdatedUtc: r.UpdatedUtc);

    private static ResumeApplicationDto ToDto(ResumeApplication a) => new(
        Id: a.Id,
        ResumeId: a.ResumeId,
        JobTitle: a.JobTitle,
        Company: a.Company,
        JobDescription: a.JobDescription,
        Data: Deserialize(a.TailoredDataJson),
        CoverLetter: a.CoverLetter,
        UpdatedUtc: a.UpdatedUtc);

    // ===================================================================================
    // Helpers
    // ===================================================================================

    /// <summary>Validate a headshot image (jpeg/png/webp, &lt;=5 MB): a known mime + a decodable payload under
    /// the size cap. On failure <paramref name="bad"/> is a 400. Mirrors the multimodal photo routes' checks
    /// (note the Resume DTOs use <c>Mime</c>, not the <c>MimeType</c> of <see cref="ImageRequest"/>).</summary>
    private static bool TryValidateImage(
        string? imageBase64, string? mimeType, out string base64, out string mime, out IResult bad)
    {
        base64 = "";
        mime = "";
        bad = Results.BadRequest(new { message = "A valid image (jpeg/png/webp) under 5 MB is required." });

        var m = (mimeType ?? "").Trim();
        var data = (imageBase64 ?? "").Trim();
        if (m.Length == 0 || data.Length == 0) return false;
        if (!AllowedHeadshotMimeTypes.Contains(m)) return false;

        // Strip an optional data-URL prefix ("data:image/png;base64,...") before decoding.
        var comma = data.IndexOf(',');
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
            data = data[(comma + 1)..];

        // Cheap length bound before decode (base64 ≈ 4/3 expansion).
        if ((long)data.Length / 4 * 3 > GeminiService.MaxImageBytes) return false;

        byte[] decoded;
        try { decoded = Convert.FromBase64String(data); }
        catch (FormatException) { return false; }
        if (decoded.Length == 0 || decoded.Length > GeminiService.MaxImageBytes) return false;

        base64 = data;
        mime = m;
        return true;
    }

    /// <summary>Validate an uploaded resume file for the multimodal parse path: an image (jpeg/png/webp) OR a
    /// PDF, base64 present + decodable, decoded payload under the size cap. On failure <paramref name="bad"/>
    /// is a 400.</summary>
    private static bool TryValidateResumeFile(
        string? fileBase64, string? mimeType, out string base64, out string mime, out IResult bad)
    {
        base64 = "";
        mime = "";
        bad = Results.BadRequest(new { message = "A valid PDF or image (jpeg/png/webp) under 5 MB is required." });

        var m = (mimeType ?? "").Trim();
        var data = (fileBase64 ?? "").Trim();
        if (m.Length == 0 || data.Length == 0) return false;

        var allowed = AllowedHeadshotMimeTypes.Contains(m)
            || string.Equals(m, "application/pdf", StringComparison.OrdinalIgnoreCase);
        if (!allowed) return false;

        // Strip an optional data-URL prefix before decoding.
        var comma = data.IndexOf(',');
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
            data = data[(comma + 1)..];

        if ((long)data.Length / 4 * 3 > GeminiService.MaxImageBytes) return false;

        byte[] decoded;
        try { decoded = Convert.FromBase64String(data); }
        catch (FormatException) { return false; }
        if (decoded.Length == 0 || decoded.Length > GeminiService.MaxImageBytes) return false;

        base64 = data;
        mime = m;
        return true;
    }

    /// <summary>A filesystem-safe slug for the download filename from the contact name (e.g. "Jane Doe" ->
    /// "Jane_Doe"); falls back to "Resume" when the name is blank.</summary>
    private static string FileSlug(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0) return "Resume";
        var chars = n.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray();
        var slug = new string(chars).Trim('_');
        // Collapse runs of underscores for a tidier name.
        while (slug.Contains("__")) slug = slug.Replace("__", "_");
        if (slug.Length > 60) slug = slug[..60];
        return slug.Length == 0 ? "Resume" : slug;
    }

    private static string Clamp(string s, int max) => s.Length <= max ? s : s[..max];

    // ===================================================================================
    // 503 helpers (mirror AiEndpoints' degraded path)
    // ===================================================================================

    /// <summary>503 when no Gemini key is configured.</summary>
    private static IResult Unconfigured() => Results.Problem(
        title: "AI assistance is not configured.",
        detail: "AI assistance is not configured.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>503 when Gemini is configured but the call failed (quota/parse) — same degraded path.</summary>
    private static IResult Unavailable() => Results.Problem(
        title: "AI assistance is unavailable, try again.",
        detail: "AI assistance is unavailable, try again.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
