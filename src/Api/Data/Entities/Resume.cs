namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One user's MASTER resume — the single canonical, structured profile the Resume Builder works from.
/// OWNER-SCOPED by the lower-cased <see cref="OwnerEmail"/>: a caller only ever sees/edits their own
/// resume; a foreign or missing id is a 404 (existence never leaked).
///
/// The whole structured "ResumeData" shape (contact, summary, experience, education, skills, projects,
/// certifications) is serialized to JSON and stored in <see cref="DataJson"/> — kept as one document so
/// the AI parse/tailor flows can round-trip it without a wide relational schema. An optional
/// <see cref="HeadshotBytes"/> (with its <see cref="HeadshotMime"/>) is the private headshot used by
/// doc-generation.
///
/// SHARING mirrors the recipe pattern: an owner-scoped <see cref="ShareWithContacts"/> boolean gates
/// read access for the owner's mutual chat contacts. No email is ever put on the wire — a shared resume
/// carries only the owner's user id + display name.
/// </summary>
public class Resume
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the identity/ownership key.</summary>
    public string OwnerEmail { get; set; } = "";

    public string Title { get; set; } = "";

    /// <summary>The structured ResumeData (contact/summary/experience/…) serialized as a JSON document.</summary>
    public string DataJson { get; set; } = "";

    /// <summary>The private headshot image bytes (optional; null = none).</summary>
    public byte[]? HeadshotBytes { get; set; }

    /// <summary>The headshot's MIME type (e.g. "image/png"); null when there is no headshot.</summary>
    public string? HeadshotMime { get; set; }

    /// <summary>When true, the owner's mutual chat contacts may view (read-only) this resume.</summary>
    public bool ShareWithContacts { get; set; }

    public DateTime CreatedUtc { get; set; }

    public DateTime UpdatedUtc { get; set; }
}

/// <summary>
/// A per-job TAILORED variant of a <see cref="Resume"/> — one application. Pins the target job
/// (<see cref="JobTitle"/>/<see cref="Company"/>/<see cref="JobDescription"/>), a tailored copy of the
/// ResumeData (<see cref="TailoredDataJson"/>, same JSON shape as <see cref="Resume.DataJson"/>), and the
/// generated <see cref="CoverLetter"/>. OWNER-SCOPED by <see cref="OwnerEmail"/>; cascade-deleted with its
/// parent resume.
/// </summary>
public class ResumeApplication
{
    public long Id { get; set; }

    /// <summary>FK to the parent <see cref="Resume"/> this application was tailored from.</summary>
    public long ResumeId { get; set; }

    /// <summary>Owner email, stored lower-cased; the identity/ownership key.</summary>
    public string OwnerEmail { get; set; } = "";

    public string JobTitle { get; set; } = "";

    public string Company { get; set; } = "";

    /// <summary>The pasted target job description the variant was tailored against (free text).</summary>
    public string JobDescription { get; set; } = "";

    /// <summary>The tailored ResumeData serialized as JSON (same shape as <see cref="Resume.DataJson"/>).</summary>
    public string TailoredDataJson { get; set; } = "";

    /// <summary>The generated cover letter (free text); "" when none yet.</summary>
    public string CoverLetter { get; set; } = "";

    public DateTime CreatedUtc { get; set; }

    public DateTime UpdatedUtc { get; set; }

    public Resume? Resume { get; set; }
}
