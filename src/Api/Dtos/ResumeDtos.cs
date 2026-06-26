namespace Ccusage.Api.Dtos;

// ===================================================================================
// Resume Builder — the shared contract (data model + persistence/response + request DTOs).
//
// CANONICAL "ResumeData" shape (reused verbatim across backend + frontend): contact, summary,
// experience, education, skills, projects, certifications. All strings default ""; arrays default
// empty; dates are FREE TEXT ("2021", "Jun 2021"). This file is the source of truth the endpoint,
// AI, and doc-generation phases build on.
// ===================================================================================

// ---- ResumeData shape ----

/// <summary>One labelled external link on the contact block (e.g. {"LinkedIn", "https://…"}).</summary>
public sealed record ResumeLinkDto(string Label, string Url);

/// <summary>The contact/header block: name, headline, the usual contact fields, and labelled links.</summary>
public sealed record ResumeContactDto(
    string FullName,
    string Headline,
    string Email,
    string Phone,
    string Location,
    IReadOnlyList<ResumeLinkDto> Links);

/// <summary>One work-experience entry. <see cref="Current"/> true ⇒ <see cref="EndDate"/> is ignored
/// ("Present"). Dates are free text. <see cref="Bullets"/> are the achievement lines.</summary>
public sealed record ResumeExperienceDto(
    string Company,
    string Title,
    string Location,
    string StartDate,
    string EndDate,
    bool Current,
    IReadOnlyList<string> Bullets);

/// <summary>One education entry. All fields free text (dates included); <see cref="Details"/> is a free-text
/// note line.</summary>
public sealed record ResumeEducationDto(
    string School,
    string Degree,
    string Field,
    string Location,
    string StartDate,
    string EndDate,
    string Gpa,
    string Details);

/// <summary>One project entry with an optional <see cref="Link"/> and achievement <see cref="Bullets"/>.</summary>
public sealed record ResumeProjectDto(
    string Name,
    string Description,
    string Link,
    IReadOnlyList<string> Bullets);

/// <summary>One certification entry. Date is free text.</summary>
public sealed record ResumeCertificationDto(string Name, string Issuer, string Date);

/// <summary>The whole structured resume document. This is what gets serialized into
/// <c>Resume.DataJson</c> / <c>ResumeApplication.TailoredDataJson</c>. Use <see cref="Empty"/> as the
/// all-empty fallback.</summary>
public sealed record ResumeDataDto(
    ResumeContactDto Contact,
    string Summary,
    IReadOnlyList<ResumeExperienceDto> Experience,
    IReadOnlyList<ResumeEducationDto> Education,
    IReadOnlyList<string> Skills,
    IReadOnlyList<ResumeProjectDto> Projects,
    IReadOnlyList<ResumeCertificationDto> Certifications)
{
    /// <summary>An EMPTY ResumeData — empty contact, blank summary, and empty arrays. The fallback later
    /// phases use when there is no stored data yet (or a parse yields nothing).</summary>
    public static readonly ResumeDataDto Empty = new(
        new ResumeContactDto("", "", "", "", "", Array.Empty<ResumeLinkDto>()),
        "",
        Array.Empty<ResumeExperienceDto>(),
        Array.Empty<ResumeEducationDto>(),
        Array.Empty<string>(),
        Array.Empty<ResumeProjectDto>(),
        Array.Empty<ResumeCertificationDto>());
}

// ---- Persistence / response DTOs ----

/// <summary>The owner's MASTER resume (mirrors <c>Resume</c>). <see cref="HasHeadshot"/> reports whether a
/// headshot is stored WITHOUT putting the bytes on the wire (fetched via a dedicated endpoint).</summary>
public sealed record ResumeDto(
    long Id,
    string Title,
    ResumeDataDto Data,
    bool HasHeadshot,
    bool ShareWithContacts,
    DateTime UpdatedUtc);

/// <summary>A per-job tailored variant (mirrors <c>ResumeApplication</c>): the pinned target job, the
/// tailored <see cref="Data"/>, and the generated <see cref="CoverLetter"/>.</summary>
public sealed record ResumeApplicationDto(
    long Id,
    long ResumeId,
    string JobTitle,
    string Company,
    string JobDescription,
    ResumeDataDto Data,
    string CoverLetter,
    DateTime UpdatedUtc);

/// <summary>The caller's whole Resume Builder state: their master resume (null until first save) and all
/// of its tailored applications.</summary>
public sealed record ResumeStateDto(
    ResumeDto? Master,
    IReadOnlyList<ResumeApplicationDto> Applications);

// ---- Request DTOs ----

/// <summary>Create/update the master resume (owner-scoped).</summary>
public sealed record ResumeSaveRequest(string Title, ResumeDataDto Data, bool ShareWithContacts);

/// <summary>Parse an existing resume into structured <see cref="ResumeDataDto"/>. Supply EITHER an uploaded
/// file (<see cref="FileBase64"/> + <see cref="Mime"/>, e.g. a PDF/DOCX) OR raw pasted <see cref="Text"/>.</summary>
public sealed record ParseResumeRequest(string? FileBase64, string? Mime, string? Text);

/// <summary>Upload/replace the headshot image (owner-scoped). Base64-encoded bytes + its MIME type.</summary>
public sealed record HeadshotRequest(string ImageBase64, string Mime);

/// <summary>Start a new tailored application from the master resume for a target job.</summary>
public sealed record NewApplicationRequest(string JobTitle, string Company, string JobDescription);

/// <summary>Save an application's edits (owner-scoped): the job pin, the tailored data, and the cover letter.</summary>
public sealed record ApplicationSaveRequest(
    string JobTitle,
    string Company,
    string JobDescription,
    ResumeDataDto Data,
    string CoverLetter);

/// <summary>Ask the AI to TAILOR the supplied <see cref="Data"/> toward a job description. Returns tailored
/// <see cref="ResumeDataDto"/> (a proposal — nothing is persisted by the AI call).</summary>
public sealed record TailorRequest(string JobDescription, ResumeDataDto Data);

/// <summary>Ask the AI to draft a COVER LETTER for a job from the supplied resume data.</summary>
public sealed record CoverLetterRequest(string JobTitle, string Company, string JobDescription, ResumeDataDto Data);

/// <summary>Ask the AI to REFINE one section's content under a free-text <see cref="Instruction"/>, with the
/// whole <see cref="Data"/> as context. <see cref="Section"/> names the section (e.g. "summary",
/// "experience"); <see cref="Content"/> is the current text being refined.</summary>
public sealed record RefineRequest(string Section, string Content, string Instruction, ResumeDataDto Data);

/// <summary>One turn in a resume-assistant chat. <see cref="Role"/> is "user" | "assistant".</summary>
public sealed record ResumeChatMessage(string Role, string Content);

/// <summary>A resume-assistant chat turn: the conversation so far, the resume <see cref="Data"/> as context
/// (optional), and an optional <see cref="JobContext"/> (e.g. the target job description).</summary>
public sealed record ResumeChatRequest(
    IReadOnlyList<ResumeChatMessage> Messages,
    ResumeDataDto? Data,
    string? JobContext);
